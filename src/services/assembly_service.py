"""Drive Blender to turn a SceneSpec into one GLB.

Blender runs as a subprocess because it bundles its own Python, so this module
does the parts that are easier on our side - resolving and checking mesh paths,
writing the JSON, translating Blender's output into an exception - and leaves
the geometry to scene/blender/build_scene.py.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from src.config import PROJECT_ROOT, Config
from src.schemas.scene import SceneSpec

SENTINEL = "DIORAMIC_ASSEMBLE_OK"

BUILD_SCRIPT = Path(__file__).resolve().parent / "blender" / "build_scene.py"


def resolve_meshes(spec: SceneSpec) -> SceneSpec:
    """Make every mesh path absolute, failing early if one is missing.

    Blender's own error for a missing file is buried in several hundred lines
    of startup noise, so it is worth catching here where the message can name
    the object and the spec entry.
    """
    for obj in spec.objects:
        path = Path(obj.mesh).expanduser()
        if not path.is_absolute():
            path = PROJECT_ROOT / path
        if not path.is_file():
            raise FileNotFoundError(
                f"object {obj.name!r}: mesh not found at {path}"
            )
        obj.mesh = str(path)
    return spec


def assemble(
    spec: SceneSpec,
    out_path: Path,
    *,
    config: Config | None = None,
    blender: Path | None = None,
    console=None,
    keep_spec: Path | None = None,
    decimate: float | None = None,
    max_stretch: float = 1.0,
) -> Path:
    """Build `spec` into a single GLB at `out_path` and return that path.

    `decimate` is a triangle-ratio in (0, 1] applied to furniture only, and
    `max_stretch` caps how far a mesh may be scaled non-uniformly to reach its
    target size (1.0 keeps the fit strictly uniform). Both are delivery and
    fitting concerns rather than part of the scene, so they are build arguments
    and never written into the spec.
    """
    if decimate is not None and not 0.0 < decimate <= 1.0:
        raise ValueError(f"decimate must be in (0, 1], got {decimate}")
    if max_stretch < 1.0:
        raise ValueError(f"max_stretch must be >= 1.0, got {max_stretch}")
    config = config or Config.load()
    blender = Path(blender) if blender else config.resolve_blender()
    out_path = Path(out_path)

    spec = resolve_meshes(spec)
    spec.validate()

    if keep_spec is not None:
        spec_path = spec.save(Path(keep_spec))
        cleanup = False
    else:
        handle = tempfile.NamedTemporaryFile(
            "w", suffix=".scene.json", delete=False, encoding="utf-8"
        )
        handle.close()
        spec_path = spec.save(Path(handle.name))
        cleanup = True

    cmd = [
        str(blender),
        "--background",
        # Ignore whatever add-ons and preferences this user's Blender has
        # accumulated; a broken third-party add-on must not be able to fail
        # a headless build. Bundled add-ons such as the glTF IO stay enabled.
        "--factory-startup",
        "--python", str(BUILD_SCRIPT),
        "--", "--spec", str(spec_path), "--out", str(out_path),
    ]
    if decimate is not None:
        cmd += ["--decimate", str(decimate)]
    if max_stretch > 1.0:
        cmd += ["--max-stretch", str(max_stretch)]

    if console:
        console.print(f"[cyan]Assembling {len(spec.objects)} object(s) via Blender[/]")

    try:
        result = subprocess.run(cmd, capture_output=True, text=True)
    finally:
        if cleanup:
            Path(spec_path).unlink(missing_ok=True)

    stdout = result.stdout or ""

    # Blender exits 0 even when an embedded script raises, so the exit code
    # alone is not evidence of success. Require the sentinel and the file.
    if SENTINEL not in stdout or not out_path.is_file():
        raise RuntimeError(_failure_message(result))

    if console:
        for line in stdout.splitlines():
            if line.startswith(("room:", "walls:", "  placed", "  panel",
                                "wrote", "decimating", "allowing")):
                console.print(f"[dim]{line}[/]")

    return out_path


def _failure_message(result: subprocess.CompletedProcess) -> str:
    """Pull the useful part out of Blender's very chatty output."""
    tail = (result.stdout or "").strip().splitlines()[-25:]
    err = (result.stderr or "").strip().splitlines()[-15:]
    parts = [f"Blender failed (exit {result.returncode})."]
    if tail:
        parts.append("stdout tail:\n  " + "\n  ".join(tail))
    if err:
        parts.append("stderr tail:\n  " + "\n  ".join(err))
    return "\n".join(parts)
