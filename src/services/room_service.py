"""One room photo in, one assembled GLB out.

    segment -> generate a mesh per object -> estimate layout -> assemble

A note on parallelism, since it is the obvious thing to want here. Running
several 3D generations at once needs a separate model resident per worker, and
TripoSR alone is ~1.7 GB of weights before activations - so on a 4 GB card the
sequential path is not merely easier, it is the only one that fits, and it wins
anyway by loading the weights once instead of once per object.

`jobs` therefore defaults to 1 and runs in-process. Above 1 it spawns worker
subprocesses, which is the right shape for a rented GPU and useless below about
10 GB of VRAM. The work is embarrassingly parallel either way; the constraint
is memory, not structure.
"""

from __future__ import annotations

import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from src.config import Config
from src.schemas.scene import SceneSpec, SourceSpec
from src.services.assembly_service import assemble
from src.services.layout_service import Camera, estimate_layout
from src.services.segmentation_service import segment


MIN_FACES = 200


def parse_walls(choice: str):
    """Turn the `--walls` / `walls` string into what build_room expects.

    Shared by the CLI and the API because "auto" is a sentinel the layout code
    reads, not a list of walls - so the two callers have to agree on passing the
    string through untouched rather than each inventing a default.
    """
    choice = (choice or "auto").strip().lower()
    if choice == "auto":
        return "auto"
    if choice == "all":
        return ("-x", "+x", "-y", "+y")
    if choice == "none":
        return ()
    return tuple(part.strip() for part in choice.split(",") if part.strip())


def is_usable(mesh_path: Path, console) -> bool:
    """Reject meshes the reconstructor effectively failed to produce.

    Wide, shallow crops - a band of cupboards above a window, say - give
    TripoSR too little to work with, and it returns a near-empty shell rather
    than an error: the sample bedroom's "cabinet" came back as 4 triangles.
    Such a mesh is worse than nothing, because it still claims a place in the
    room and its degenerate bounding box makes the placement arbitrary.
    """
    try:
        import trimesh

        scene = trimesh.load(str(mesh_path), force="scene")
        faces = sum(len(g.faces) for g in scene.geometry.values()
                    if hasattr(g, "faces"))
    except Exception as exc:
        console.print(f"[yellow]{mesh_path.name}: could not be read ({exc})[/]")
        return False

    if faces < MIN_FACES:
        console.print(
            f"[yellow]{mesh_path.stem}: only {faces} faces - reconstruction "
            f"failed, dropping it[/]"
        )
        return False
    return True


@dataclass
class RoomResult:
    glb: Path
    spec: SceneSpec
    spec_path: Path
    generated: list[str]
    failed: list[str]


def _generate_in_process(crops, config, console) -> dict[str, Path]:
    """Generate every mesh with one resident model.

    One bad crop must not cost the whole room, which is exactly what
    generate_meshes already guarantees - a wardrobe that OOMs is a missing
    wardrobe, not a failed job - so failures are simply absent from the result.
    """
    from src.services.generation_service import generate_meshes

    results = generate_meshes([crop_path for _, crop_path in crops], config, console)
    by_image = {result.image: result for result in results}
    return {
        name: by_image[crop_path].mesh
        for name, crop_path in crops
        if by_image[crop_path].ok
    }


def _generate_in_subprocesses(crops, config, jobs, console) -> dict[str, Path]:
    """Generate meshes in parallel worker processes.

    Each worker re-reads .env, so it inherits the same configuration without
    having to be handed every flag.
    """
    def run_one(item):
        name, crop_path = item
        cmd = [
            sys.executable, "-m", "src.cli.generate",
            "--image", str(crop_path),
            "--out", str(config.output_dir),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        produced = config.output_dir / f"{name}.{config.output_format}"
        if result.returncode != 0 or not produced.is_file():
            console.print(f"[red]{name} failed[/] (exit {result.returncode})")
            return name, None
        return name, produced

    console.print(f"[cyan]Generating {len(crops)} meshes across {jobs} workers[/]")
    meshes: dict[str, Path] = {}
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        for name, path in pool.map(run_one, crops):
            if path is not None:
                meshes[name] = path
                console.print(f"[green]->[/] {name}")
    return meshes


def build_room(
    image_path: Path,
    config: Config,
    console,
    *,
    labels: list[str] | None = None,
    out_path: Path | None = None,
    work_dir: Path | None = None,
    camera: Camera | None = None,
    jobs: int = 1,
    decimate: float | None = None,
    max_stretch: float = 1.0,
    threshold: float = 0.30,
    skip_existing: bool = True,
    blender: Path | None = None,
    walls="auto",
) -> RoomResult:
    """Run the whole pipeline for one room image."""
    image_path = Path(image_path)
    stem = image_path.stem
    work_dir = Path(work_dir) if work_dir else config.output_dir / stem
    crops_dir = work_dir / "crops"
    objects_dir = work_dir / "objects"
    out_path = Path(out_path) if out_path else config.output_dir / f"{stem}.glb"

    # -- 1. what is in the picture ----------------------------------------
    console.rule("[bold]1/4  detect")
    device = config.resolve_device()
    results = segment(image_path, crops_dir, labels,
                      device=device, threshold=threshold)
    if not results:
        raise RuntimeError(
            f"No objects detected in {image_path.name}. Try --threshold 0.2, "
            f"or pass --labels with words describing what is in the frame."
        )
    console.print(f"[green]{len(results)}[/] object(s): "
                  + ", ".join(name for _, name, _ in results))

    # -- 2. a mesh for each --------------------------------------------------
    console.rule("[bold]2/4  reconstruct")
    from src.services.layout_service import lookup_prior

    pending = []
    meshes: dict[str, Path] = {}
    billboards: set[str] = set()
    for _, name, crop_path in results:
        # Flat things skip reconstruction entirely: their crop IS the asset.
        # Cheaper, faster and more faithful than a mesh of a painting.
        if lookup_prior(name).flat:
            meshes[name] = crop_path
            billboards.add(name)
            console.print(f"[dim]{name}: flat, using crop as a panel[/]")
            continue

        existing = objects_dir / f"{name}.{config.output_format}"
        # Regenerating is minutes per object, so a re-run after tweaking the
        # layout should not pay for it again.
        if skip_existing and existing.is_file():
            meshes[name] = existing
            console.print(f"[dim]reusing {existing.name}[/]")
        else:
            pending.append((name, crop_path))

    if pending:
        objects_dir.mkdir(parents=True, exist_ok=True)
        original_out = config.output_dir
        config.output_dir = objects_dir
        try:
            if jobs > 1:
                meshes.update(_generate_in_subprocesses(pending, config, jobs, console))
            else:
                meshes.update(_generate_in_process(pending, config, console))
        finally:
            config.output_dir = original_out

    meshes = {name: path for name, path in meshes.items()
              if name in billboards or is_usable(path, console)}

    if not meshes:
        raise RuntimeError("Every object failed to reconstruct; nothing to assemble.")

    # -- 3. where does each one go ------------------------------------------
    console.rule("[bold]3/4  layout")
    size = Image.open(image_path).size
    # The fourth element is provenance: which photo, which crop, what the
    # detector called it and how sure it was. Recorded here because this is the
    # only point where all four are still in hand.
    items = [
        (name, det.box, str(meshes[name]),
         SourceSpec(image=str(image_path), crop=str(crop_path),
                    label=det.label, score=det.score, box=det.box))
        for det, name, crop_path in results
        if name in meshes
    ]
    spec = estimate_layout(items, size, camera=camera, name=stem, walls=walls)
    console.print(f"room {spec.room.width:g} x {spec.room.depth:g} x "
                  f"{spec.room.height:g} m, {len(spec.objects)} placed")

    spec_path = spec.save(work_dir / "scene.json")
    console.print(f"[dim]spec: {spec_path}[/]")

    # -- 4. one file ---------------------------------------------------------
    console.rule("[bold]4/4  assemble")
    glb = assemble(spec, out_path, config=config, blender=blender,
                   console=console, decimate=decimate, max_stretch=max_stretch)

    placed = {obj.name for obj in spec.objects}
    failed = [name for _, name, _ in results if name not in placed]
    return RoomResult(glb=glb, spec=spec, spec_path=spec_path,
                      generated=sorted(placed), failed=failed)
