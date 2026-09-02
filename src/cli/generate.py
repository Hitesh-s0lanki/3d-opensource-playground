#!/usr/bin/env python
"""Image -> 3D mesh generator.

    dioramic-generate --doctor
    dioramic-generate --image photos/chair.png
    dioramic-generate --image photos/ --format glb

Runs the local backend, not the Modal worker: this is the path for a card in
this machine. Run from inside the project venv (.\.venv\Scripts\Activate.ps1).
"""

from __future__ import annotations

import argparse
from pathlib import Path

from rich.console import Console
from rich.table import Table

from src.config import Config
from src.services.diagnostics_service import FAIL, OK, WARN, environment_report, is_healthy
from src.services.generation_service import generate_meshes
from src.services.preprocess_service import collect_images

console = Console()

STATUS_STYLES = {OK: "[green]OK[/]", WARN: "[yellow]WARN[/]", FAIL: "[red]FAIL[/]"}


# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="dioramic-generate",
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
    """Render the environment report. The checks themselves live in services."""
    checks = environment_report(config)

    table = Table(title="Environment check", header_style="bold")
    table.add_column("Check")
    table.add_column("Result")
    table.add_column("Status", justify="center")

    for check in checks:
        table.add_row(check.name, check.detail, STATUS_STYLES[check.status])
        if check.note:
            table.add_row("", f"[dim]{check.note}[/]", "")

    console.print(table)

    if is_healthy(checks):
        console.print("\n[green]Ready.[/] Try: [bold]dioramic-generate --image photos/[/]")
        return 0
    console.print("\n[red]Environment incomplete.[/] Run [bold].\setup.ps1[/] to fix.")
    return 1


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

    results = generate_meshes(images, config, console)

    for result in results:
        if result.ok:
            size_mb = result.mesh.stat().st_size / 1e6
            console.print(f"[green]->[/] {result.mesh}  "
                          f"[dim]{size_mb:.1f} MB in {result.seconds:.1f}s[/]")

    console.rule()
    succeeded = sum(1 for r in results if r.ok)
    console.print(f"[bold]{succeeded}/{len(results)} succeeded[/] -> {config.output_dir.resolve()}")
    return 0 if succeeded == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
