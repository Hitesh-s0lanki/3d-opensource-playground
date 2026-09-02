#!/usr/bin/env python
"""Turn one room photo into one assembled 3D scene.

    dioramic-room --image photos/bedroom.jpg
    dioramic-room --image photos/bedroom.jpg --labels "bed,wardrobe,lamp"
    dioramic-room --image photos/bedroom.jpg --fov 95 --decimate 0.2

Runs detect -> reconstruct -> layout -> assemble. Intermediate crops, meshes
and the scene JSON are kept under outputs/<name>/ so a re-run reuses them.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from rich.console import Console

from src.config import Config
from src.services.layout_service import Camera
from src.services.room_service import build_room, parse_walls

console = Console()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="dioramic-room",
        description="Reconstruct a whole room from a single photo.",
    )
    p.add_argument("--image", "-i", type=Path, required=True,
                   help="A photo or render of one room.")
    p.add_argument("--out", "-o", type=Path, help="Output GLB.")
    p.add_argument("--labels", "-l",
                   help="Comma-separated things to look for. Defaults to a "
                        "generic furniture list.")
    p.add_argument("--threshold", type=float, default=0.30,
                   help="Detection confidence, 0-1. Lower finds more (0.30).")

    g = p.add_argument_group("camera")
    g.add_argument("--fov", type=float, default=85.0,
                   help="Horizontal field of view in degrees. Interior renders "
                        "are typically 85-95; this sets the scale of the room.")
    g.add_argument("--camera-height", type=float, default=1.35,
                   help="Camera height above the floor, metres.")
    g.add_argument("--pitch", type=float, default=0.0,
                   help="Downward camera tilt, degrees.")

    g = p.add_argument_group("output")
    g.add_argument("--decimate", type=float, metavar="RATIO",
                   help="Reduce furniture triangles for web delivery, e.g. 0.2.")
    g.add_argument("--max-stretch", type=float, default=1.5, metavar="K",
                   help="How far a mesh may be scaled non-uniformly to reach "
                        "its target size. 1.0 is a strictly uniform fit, which "
                        "leaves mis-proportioned meshes undersized (1.5).")
    g.add_argument("--jobs", "-j", type=int, default=1,
                   help="Parallel reconstruction workers. Each needs its own "
                        "copy of the model in VRAM, so leave at 1 below ~10 GB.")
    g.add_argument("--walls", default="auto",
                   help="Which walls to build, from -x,+x,-y,+y. Default "
                        "'auto' keeps two - the far wall plus whichever side "
                        "wall holds artwork. 'all' for a closed box, 'none' "
                        "for furniture only.")
    g.add_argument("--regenerate", action="store_true",
                   help="Rebuild meshes even if they already exist.")
    g.add_argument("--blender", type=Path, help="Override BLENDER_EXE.")
    return p


def main() -> int:
    args = build_parser().parse_args()
    config = Config.load()

    if not args.image.is_file():
        console.print(f"[red]No such image:[/] {args.image}")
        return 2

    labels = None
    if args.labels:
        labels = [part.strip() for part in args.labels.split(",") if part.strip()]

    if args.jobs > 1:
        console.print(
            f"[yellow]--jobs {args.jobs}: each worker loads its own model. "
            f"Expect CUDA OOM below ~10 GB of VRAM.[/]"
        )

    camera = Camera(fov_x_deg=args.fov, height=args.camera_height,
                    pitch_deg=args.pitch)

    started = time.perf_counter()
    try:
        result = build_room(
            args.image, config, console,
            labels=labels,
            out_path=args.out,
            camera=camera,
            jobs=args.jobs,
            decimate=args.decimate,
            max_stretch=args.max_stretch,
            threshold=args.threshold,
            skip_existing=not args.regenerate,
            blender=args.blender,
            walls=parse_walls(args.walls),
        )
    except FileNotFoundError as exc:
        console.print(f"[red]{exc}[/]")
        return 2
    except RuntimeError as exc:
        console.print(f"[red]{exc}[/]")
        return 1

    elapsed = time.perf_counter() - started
    size_mb = result.glb.stat().st_size / 1e6
    console.rule()
    console.print(f"[bold green]{len(result.generated)} object(s)[/] -> "
                  f"{result.glb}  [dim]{size_mb:.1f} MB in {elapsed:.0f}s[/]")
    if result.failed:
        console.print(f"[yellow]skipped:[/] {', '.join(result.failed)}")
    console.print(f"[dim]edit {result.spec_path} and re-run "
                  f"dioramic-assemble to adjust placement[/]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
