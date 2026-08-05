#!/usr/bin/env python
"""Image -> 3D mesh generator.

    dreamspace-generate --doctor
    dreamspace-generate --image inputs/chair.png
    dreamspace-generate --image inputs/ --format glb

Run from inside the project venv (.\\.venv\\Scripts\\Activate.ps1).
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from rich.console import Console
from rich.table import Table

from ..config import Config
from ..preprocess import collect_images

console = Console()


# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="dreamspace-generate",
        description="Reconstruct a 3D mesh from one or more single-object images.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Every flag defaults to the matching value in .env.\n"
            "Run --doctor first to verify your environment."
        ),
    )
    p.add_argument("--image", "-i", type=Path, help="Image file, or a directory of images.")
    p.add_argument("--out", "-o", type=Path, dest="output_dir", help="Output directory.")
    p.add_argument("--model", "-m", dest="backend", help="Backend: triposr | hunyuan3d")

    g = p.add_argument_group("device / memory")
    g.add_argument("--device", choices=["auto", "cuda", "cpu"])
    g.add_argument("--half", dest="half_precision", action="store_true", default=None)
    g.add_argument("--chunk-size", type=int, dest="chunk_size",
                   help="Lower this on CUDA OOM (4096 -> 2048 -> 1024).")
    g.add_argument("--mc-resolution", type=int, dest="mc_resolution",
                   help="Marching-cubes grid, default 256.")

    g = p.add_argument_group("output")
    g.add_argument("--format", dest="output_format", choices=["glb", "obj"])
    g.add_argument("--no-texture", dest="bake_texture", action="store_false", default=None,
                   help="Vertex colours instead of a baked UV texture (much lighter).")
    g.add_argument("--texture-resolution", type=int, dest="texture_resolution")
    g.add_argument("--flip-faces", dest="flip_faces", action="store_true", default=None,
                   help="Reverse triangle winding if the mesh renders inside-out.")

    g = p.add_argument_group("preprocessing")
    g.add_argument("--no-bg-removal", dest="remove_background", action="store_false", default=None,
                   help="Skip rembg. Only use if your input is already cut out.")
    g.add_argument("--foreground-ratio", type=float, dest="foreground_ratio")

    p.add_argument("--doctor", action="store_true", help="Check the environment and exit.")
    return p


# ---------------------------------------------------------------------------
def doctor(config: Config) -> int:
    table = Table(title="Environment check", header_style="bold")
    table.add_column("Check")
    table.add_column("Result")
    table.add_column("Status", justify="center")

    ok = True

    table.add_row("Python", f"{sys.version.split()[0]}", "[green]OK[/]")

    try:
        import torch

        table.add_row("torch", torch.__version__, "[green]OK[/]")
        cuda_build = torch.version.cuda or "CPU-only build"
        if torch.version.cuda:
            table.add_row("torch CUDA build", cuda_build, "[green]OK[/]")
        else:
            ok = False
            table.add_row("torch CUDA build", cuda_build, "[red]FAIL[/]")

        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            vram = props.total_memory / 1024**3
            table.add_row("GPU", props.name, "[green]OK[/]")
            status = "[green]OK[/]" if vram >= 6 else "[yellow]TIGHT[/]"
            table.add_row("VRAM", f"{vram:.1f} GB", status)
            if vram < 6:
                table.add_row(
                    "", f"[dim]use CHUNK_SIZE<={config.chunk_size}, triposr only[/]", ""
                )
        else:
            table.add_row("GPU", "not available - will run on CPU (slow)", "[yellow]WARN[/]")
    except ImportError:
        ok = False
        table.add_row("torch", "not installed", "[red]FAIL[/]")

    from ..compat import install_torchmcubes_shim

    try:
        table.add_row("marching cubes", install_torchmcubes_shim(), "[green]OK[/]")
    except ImportError as exc:
        ok = False
        table.add_row("marching cubes", str(exc), "[red]FAIL[/]")

    for mod, label in [
        ("rembg", "rembg"), ("trimesh", "trimesh"), ("xatlas", "xatlas"),
        ("moderngl", "moderngl"), ("transformers", "transformers"), ("omegaconf", "omegaconf"),
    ]:
        try:
            __import__(mod)
            table.add_row(label, "installed", "[green]OK[/]")
        except ImportError:
            ok = False
            table.add_row(label, "missing", "[red]FAIL[/]")

    try:
        import numpy

        numpy_ok = numpy.__version__.startswith("1.")
        table.add_row("numpy", numpy.__version__,
                      "[green]OK[/]" if numpy_ok else "[red]FAIL (need <2.0)[/]")
        ok = ok and numpy_ok
    except ImportError:
        ok = False
        table.add_row("numpy", "missing", "[red]FAIL[/]")

    # Blender is optional: it is only needed for scene assembly, so a missing
    # one is a WARN rather than a FAIL - single-object generation is unaffected.
    try:
        blender = config.resolve_blender()
        table.add_row("Blender", str(blender), "[green]OK[/]")
    except FileNotFoundError:
        table.add_row("Blender", "not found (scene assembly only)", "[yellow]WARN[/]")

    import os
    hf_home = os.environ.get("HF_HOME", "(default: ~/.cache/huggingface)")
    onedrive = "onedrive" in hf_home.lower()
    table.add_row("HF_HOME", hf_home, "[yellow]IN ONEDRIVE[/]" if onedrive else "[green]OK[/]")

    console.print(table)

    if not ok:
        console.print("\n[red]Environment incomplete.[/] Run [bold].\\setup.ps1[/] to fix.")
    else:
        console.print("\n[green]Ready.[/] Try: [bold]dreamspace-generate --image inputs/[/]")
    return 0 if ok else 1


# ---------------------------------------------------------------------------
def run(config: Config, images: list[Path]) -> int:
    import torch

    from ..backends import get_backend

    config.output_dir.mkdir(parents=True, exist_ok=True)

    backend = get_backend(config.backend, config, console)
    backend.load()

    failures = 0
    for index, image_path in enumerate(images, start=1):
        console.rule(f"[bold]{index}/{len(images)}  {image_path.name}")
        started = time.perf_counter()

        # On a 4 GB card an OOM is expected rather than exceptional, so back off
        # the chunk size and retry instead of dying.
        attempt_chunk = config.chunk_size
        while True:
            try:
                out_path = backend.generate(image_path, image_path.stem)
                break
            except torch.cuda.OutOfMemoryError:
                torch.cuda.empty_cache()
                if attempt_chunk <= 512 or not backend.set_chunk_size(attempt_chunk // 2):
                    console.print(
                        f"[red]CUDA out of memory[/] and no further backoff available "
                        f"(chunk_size={attempt_chunk}). Try --mc-resolution 192, "
                        f"--no-texture, or --device cpu."
                    )
                    failures += 1
                    out_path = None
                    break
                attempt_chunk //= 2
                console.print(f"[yellow]CUDA OOM - retrying at chunk_size={attempt_chunk}[/]")
            except Exception as exc:
                console.print(f"[red]Failed:[/] {type(exc).__name__}: {exc}")
                # The message alone is rarely enough to locate a fault inside
                # vendored upstream code, so always show where it came from.
                console.print_exception(max_frames=6)
                failures += 1
                out_path = None
                break

        if out_path is not None:
            size_mb = out_path.stat().st_size / 1e6
            elapsed = time.perf_counter() - started
            console.print(f"[green]->[/] {out_path}  [dim]{size_mb:.1f} MB in {elapsed:.1f}s[/]")

        backend.unload()

    console.rule()
    succeeded = len(images) - failures
    console.print(f"[bold]{succeeded}/{len(images)} succeeded[/] -> {config.output_dir.resolve()}")
    return 1 if failures else 0


# ---------------------------------------------------------------------------
def main() -> int:
    args = build_parser().parse_args()
    config = Config.load().override(**vars(args))

    if args.doctor:
        return doctor(config)

    if args.image is None:
        console.print("[red]--image is required.[/] Run [bold]--doctor[/] to check setup, "
                      "or [bold]--help[/] for options.")
        return 2

    try:
        images = collect_images(args.image)
    except (FileNotFoundError, ValueError) as exc:
        console.print(f"[red]{exc}[/]")
        return 2

    console.print(f"[bold]{config.backend}[/] | {len(images)} image(s) | "
                  f"chunk={config.chunk_size} mc={config.mc_resolution} "
                  f"texture={'on' if config.bake_texture else 'off'}")
    return run(config, images)


if __name__ == "__main__":
    raise SystemExit(main())
