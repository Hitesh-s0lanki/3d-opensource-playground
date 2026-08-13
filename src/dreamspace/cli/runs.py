"""Reassemble what the pipeline left on disk into runs.

`dreamspace-room` scatters one job across four places - the photo in inputs/,
the crops and per-object meshes under outputs/<name>/, the placement in
scene.json and the finished GLB at outputs/<name>.glb - and nothing on disk
links them except the naming convention. This module walks that convention back
into a single structure per run, so the viewer can show a result next to the
patch of photograph it came from.

Nothing here is part of the pipeline. It only reads.
"""

from __future__ import annotations

import json
from pathlib import Path

IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp")
MESH_EXT = (".glb", ".gltf")

# Where recovered crop rectangles are cached, next to the run they describe.
SIDECAR = ".provenance.json"


# ---------------------------------------------------------------------------
# locating a crop inside the photo it was cut from
# ---------------------------------------------------------------------------
# The detector's boxes are recorded in scene.json for runs made after this was
# added (see SourceSpec). Earlier runs have none, and re-running costs a GPU and
# several minutes - so for those the rectangle is recovered from the images
# themselves. `segment.crop` writes an exact, unresampled sub-rectangle of the
# source, which makes this an exact template match rather than a similarity
# search: find the one offset where the pixels agree.

def _grey(path: Path, scale: int = 1):
    from PIL import Image
    import numpy as np

    img = Image.open(path).convert("L")
    if scale > 1:
        img = img.resize((max(1, img.width // scale), max(1, img.height // scale)))
    return np.asarray(img, dtype="float32")


def _best_offset(photo, patch, samples: int = 8):
    """Offset of `patch` within `photo`, plus how badly it disagrees there."""
    import numpy as np

    ph, pw = photo.shape
    th, tw = patch.shape
    if th > ph or tw > pw:
        return None
    rows = np.linspace(0, th - 1, min(th, samples)).astype(int)
    cols = np.linspace(0, tw - 1, min(tw, samples)).astype(int)

    # Score every candidate offset at once, one sampled pixel at a time: each
    # term is a whole-array subtraction, so the loop runs `samples**2` times
    # rather than once per offset.
    span_h, span_w = ph - th + 1, pw - tw + 1
    error = np.zeros((span_h, span_w), dtype="float32")
    for r in rows:
        for c in cols:
            error += np.abs(photo[r:r + span_h, c:c + span_w] - patch[r, c])

    flat = int(np.argmin(error))
    y, x = divmod(flat, span_w)
    return x, y, float(error[y, x]) / (len(rows) * len(cols))


def locate_crop(photo_path: Path, crop_path: Path) -> tuple | None:
    """Pixel box of `crop_path` inside `photo_path`, or None if it isn't there."""
    import numpy as np

    try:
        # Half resolution first. The search cost is quadratic in image size and
        # the answer only has to be close enough to refine from.
        coarse = _best_offset(_grey(photo_path, 2), _grey(crop_path, 2))
        if coarse is None:
            return None

        photo, patch = _grey(photo_path), _grey(crop_path)
        th, tw = patch.shape
        rows = np.linspace(0, th - 1, min(th, 8)).astype(int)
        cols = np.linspace(0, tw - 1, min(tw, 8)).astype(int)
        grid = patch[np.ix_(rows, cols)]

        # Refine: the true offset is within a pixel or two of twice the coarse
        # one, so only that neighbourhood needs checking at full resolution.
        best, best_err = None, float("inf")
        for dy in range(-3, 4):
            for dx in range(-3, 4):
                y, x = coarse[1] * 2 + dy, coarse[0] * 2 + dx
                if y < 0 or x < 0 or y + th > photo.shape[0] or x + tw > photo.shape[1]:
                    continue
                err = float(np.abs(photo[np.ix_(rows + y, cols + x)] - grid).mean())
                if err < best_err:
                    best, best_err = (x, y), err

        # An exact sub-rectangle agrees to the last bit. Anything above a couple
        # of grey levels is a coincidence, not the source of this crop.
        if best is None or best_err > 2.0:
            return None
        return (best[0], best[1], best[0] + tw, best[1] + th)
    except Exception:
        # Provenance is a nicety. A missing dependency or an unreadable image
        # must not take the file listing down with it.
        return None


def recover_boxes(work_dir: Path, photo: Path, crops: dict[str, Path]) -> dict:
    """Crop rectangles for a run, computed once and cached beside it."""
    cache_path = work_dir / SIDECAR
    cache = {}
    if cache_path.is_file():
        try:
            cache = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            cache = {}

    key = f"{photo.name}:{photo.stat().st_mtime_ns}"
    entries = cache.get(key) if isinstance(cache.get(key), dict) else None
    if entries is None:
        entries = {}

    missing = [n for n in crops if n not in entries]
    for name in missing:
        box = locate_crop(photo, crops[name])
        entries[name] = list(box) if box else None

    if missing:
        try:
            cache_path.write_text(json.dumps({key: entries}, indent=1), encoding="utf-8")
        except OSError:
            pass          # a read-only outputs/ still gets working provenance
    return {n: b for n, b in entries.items() if b}


# ---------------------------------------------------------------------------
# discovery
# ---------------------------------------------------------------------------
def _stat(path: Path) -> dict | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return {"bytes": st.st_size, "mtime": st.st_mtime}


def _url(root: Path, path: Path) -> str | None:
    """A URL the viewer can fetch, or None for anything outside the served tree."""
    try:
        rel = path.resolve().relative_to(root)
    except ValueError:
        return None
    return "/" + "/".join(rel.parts)


def _image_info(path: Path, url: str) -> dict | None:
    info = _stat(path)
    if info is None:
        return None
    info.update(name=path.name, url=url)
    try:
        from PIL import Image

        with Image.open(path) as img:
            info["width"], info["height"] = img.size
    except Exception:
        pass          # dimensions are only needed to draw boxes over it
    return info


def find_photo(inputs: Path, stem: str) -> Path | None:
    for ext in IMAGE_EXT:
        candidate = inputs / f"{stem}{ext}"
        if candidate.is_file():
            return candidate
    return None


def _read_spec(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _build_room_run(root: Path, inputs: Path, work_dir: Path,
                    spec_path: Path, spec: dict) -> dict:
    stem = work_dir.name
    crops_dir, objects_dir = work_dir / "crops", work_dir / "objects"
    crops = {p.stem: p for p in sorted(crops_dir.glob("*"))
             if p.suffix.lower() in IMAGE_EXT}
    meshes = {p.stem: p for p in sorted(objects_dir.glob("*"))
             if p.suffix.lower() in MESH_EXT}

    photo = find_photo(inputs, stem)
    # Prefer whatever the detector recorded; fall back to matching the crops
    # back into the photo for runs made before that was written down.
    recorded = {}
    for entry in spec.get("objects", []):
        src = entry.get("source") or {}
        if src.get("box"):
            recorded[entry.get("name")] = src
    recovered = ({} if recorded or not photo or not crops
                 else recover_boxes(work_dir, photo, crops))

    items, placed = [], set()
    for entry in spec.get("objects", []):
        name = entry.get("name", "?")
        placed.add(name)
        kind = entry.get("kind", "mesh")
        src = recorded.get(name, {})
        box = list(src["box"]) if src.get("box") else recovered.get(name)
        items.append({
            "name": name,
            "kind": kind,
            "status": "placed",
            "crop": (_image_info(crops[name], _url(root, crops[name]))
                     if name in crops else None),
            "mesh": ({**_stat(meshes[name]), "url": _url(root, meshes[name]),
                      "name": meshes[name].name}
                     if name in meshes and _stat(meshes[name]) else None),
            "position": entry.get("position"),
            "size": entry.get("size"),
            "rotation_z": entry.get("rotation_z", 0.0),
            "auto_orient": entry.get("auto_orient", True),
            "box": box,
            "box_from": "detector" if src.get("box") else ("matched" if box else None),
            "score": src.get("score"),
            "label": src.get("label"),
        })

    # Detected, reconstructed, then left out - a mesh too degenerate to place,
    # or an object edited out of the spec by hand. Invisible in the final GLB,
    # so the viewer is the only place it can be accounted for.
    for name in sorted(set(crops) | set(meshes)):
        if name in placed:
            continue
        items.append({
            "name": name,
            "kind": "mesh",
            "status": "dropped",
            "crop": (_image_info(crops[name], _url(root, crops[name]))
                     if name in crops else None),
            "mesh": ({**_stat(meshes[name]), "url": _url(root, meshes[name]),
                      "name": meshes[name].name}
                     if name in meshes and _stat(meshes[name]) else None),
            "position": None, "size": None, "rotation_z": 0.0,
            "auto_orient": None, "box": recovered.get(name), "score": None,
            "box_from": "matched" if recovered.get(name) else None,
            "label": None,
        })

    glb = root / f"{stem}.glb"
    return {
        "id": stem,
        "kind": "room",
        "photo": (_image_info(photo, f"/_inputs/{photo.name}") if photo else None),
        "render": ({**_stat(glb), "url": _url(root, glb),
                    "path": glb.relative_to(root).as_posix()}
                   if glb.is_file() else None),
        "spec": {"url": _url(root, spec_path),
                 "path": spec_path.relative_to(root).as_posix(),
                 "room": spec.get("room", {})},
        "items": items,
    }


def _build_spec_run(root: Path, inputs: Path, spec_path: Path, spec: dict) -> dict:
    """A scene.json sitting beside its GLB, with no crops - usually hand-written."""
    stem = spec_path.name[: -len(".scene.json")]
    items = []
    for entry in spec.get("objects", []):
        mesh_path = Path(entry.get("mesh", ""))
        if not mesh_path.is_absolute():
            mesh_path = (root.parent / mesh_path)
        info = _stat(mesh_path)
        src = entry.get("source") or {}
        items.append({
            "name": entry.get("name", "?"),
            "kind": entry.get("kind", "mesh"),
            "status": "placed",
            "crop": None,
            "mesh": ({**info, "url": _url(root, mesh_path), "name": mesh_path.name}
                     if info else None),
            "position": entry.get("position"),
            "size": entry.get("size"),
            "rotation_z": entry.get("rotation_z", 0.0),
            "auto_orient": entry.get("auto_orient", True),
            "box": list(src["box"]) if src.get("box") else None,
            "box_from": "detector" if src.get("box") else None,
            "score": src.get("score"),
            "label": src.get("label"),
        })

    photo = find_photo(inputs, stem)
    glb = root / f"{stem}.glb"
    return {
        "id": stem,
        "kind": "scene",
        "photo": (_image_info(photo, f"/_inputs/{photo.name}") if photo else None),
        "render": ({**_stat(glb), "url": _url(root, glb),
                    "path": glb.relative_to(root).as_posix()}
                   if glb.is_file() else None),
        "spec": {"url": _url(root, spec_path),
                 "path": spec_path.relative_to(root).as_posix(),
                 "room": spec.get("room", {})},
        "items": items,
    }


def _build_object_run(root: Path, inputs: Path, glb: Path) -> dict:
    """One image in, one mesh out - the dreamspace-generate case."""
    stem = glb.stem
    photo = find_photo(inputs, stem)
    return {
        "id": glb.relative_to(root).as_posix(),
        "kind": "object",
        "photo": (_image_info(photo, f"/_inputs/{photo.name}") if photo else None),
        "render": {**_stat(glb), "url": _url(root, glb),
                   "path": glb.relative_to(root).as_posix()},
        "spec": None,
        "items": [],
    }


def _build_loose_run(root: Path, inputs: Path, directory: Path,
                     images: list[Path]) -> dict:
    """A folder of images with no scene.json - crops from an unfinished run."""
    photo = find_photo(inputs, directory.name)
    return {
        "id": directory.relative_to(root).as_posix(),
        "kind": "images",
        "photo": (_image_info(photo, f"/_inputs/{photo.name}") if photo else None),
        "render": None,
        "spec": None,
        "items": [{
            "name": p.stem, "kind": "image", "status": "orphan",
            "crop": _image_info(p, _url(root, p)), "mesh": None,
            "position": None, "size": None, "rotation_z": 0.0,
            "auto_orient": None, "box": None, "box_from": None,
            "score": None, "label": None,
        } for p in images],
    }


def discover(root: Path, inputs: Path) -> list[dict]:
    """Every run under `root`, newest first."""
    root, inputs = Path(root).resolve(), Path(inputs).resolve()
    runs: list[dict] = []
    claimed: set[Path] = set()          # GLBs already spoken for by a run
    seen_dirs: set[Path] = set()

    for spec_path in sorted(root.glob("*/scene.json")):
        spec = _read_spec(spec_path)
        if spec is None:
            continue
        work_dir = spec_path.parent
        run = _build_room_run(root, inputs, work_dir, spec_path, spec)
        runs.append(run)
        claimed.add((root / f"{work_dir.name}.glb").resolve())
        claimed.update(p.resolve() for p in (work_dir / "objects").glob("*")
                       if p.is_file())
        seen_dirs.add(work_dir.resolve())

    for spec_path in sorted(root.glob("*.scene.json")):
        spec = _read_spec(spec_path)
        if spec is None:
            continue
        run = _build_spec_run(root, inputs, spec_path, spec)
        runs.append(run)
        claimed.add((root / f"{run['id']}.glb").resolve())

    for glb in sorted(p for ext in MESH_EXT for p in root.rglob(f"*{ext}")):
        if glb.resolve() in claimed or not glb.is_file():
            continue
        runs.append(_build_object_run(root, inputs, glb))

    # Images in a directory that no run accounts for - a segment pass run on its
    # own, say. Listing them keeps the viewer an honest picture of the folder
    # rather than only of the jobs that finished.
    for directory in sorted(p for p in root.iterdir() if p.is_dir()):
        if directory.resolve() in seen_dirs:
            continue
        images = [p for p in sorted(directory.glob("*"))
                  if p.suffix.lower() in IMAGE_EXT]
        if images:
            runs.append(_build_loose_run(root, inputs, directory, images))

    # Newest first: after a run finishes, its result is what you came to look at.
    def when(run: dict) -> float:
        stamps = [run["render"]["mtime"]] if run.get("render") else []
        stamps += [i["mesh"]["mtime"] for i in run["items"] if i.get("mesh")]
        return max(stamps) if stamps else 0.0

    runs.sort(key=when, reverse=True)
    return runs
