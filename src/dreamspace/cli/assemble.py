#!/usr/bin/env python
"""Assemble a room description into a single GLB.

    dreamspace-assemble --spec examples/room-demo.json
    dreamspace-assemble --spec scene.json --out outputs/bedroom.glb

The spec format is documented in dreamspace/scene/spec.py. Needs Blender:
set BLENDER_EXE in .env, or put blender on PATH.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from rich.console import Console

from ..config import Config
from ..scene.assemble import assemble
from ..scene.spec import SceneSpec

console = Console()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="dreamspace-assemble",
        description="Build a room shell, place meshes inside it, export one GLB.",
    )
    p.add_argument("--spec", "-s", type=Path, required=True,
                   help="Scene JSON describing the room and its objects.")
    p.add_argument("--out", "-o", type=Path,
                   help="Output GLB. Defaults to <output_dir>/<spec name>.glb")
    p.add_argument("--blender", type=Path,
                   help="Path to blender.exe, overriding BLENDER_EXE.")
    p.add_argument("--decimate", type=float, metavar="RATIO",
                   help="Reduce furniture triangles to this fraction (e.g. 0.25) "
                        "for web delivery. The room shell is never decimated.")
    p.add_argument("--max-stretch", type=float, default=1.5, metavar="K",
                   help="How far a mesh may be scaled non-uniformly to reach "
                        "its target size. 1.0 keeps the fit strictly uniform "
                        "but leaves mis-proportioned meshes undersized (1.5).")
    return p


def main() -> int:
    args = build_parser().parse_args()
    config = Config.load()

    try:
        spec = SceneSpec.load(args.spec)
    except FileNotFoundError:
        console.print(f"[red]No such spec file:[/] {args.spec}")
        return 2
    except (ValueError, TypeError) as exc:
        console.print(f"[red]Invalid spec:[/] {exc}")
        return 2

    out_path = args.out or (config.output_dir / f"{spec.name}.glb")

    console.print(
        f"[bold]{spec.name}[/] | room "
        f"{spec.room.width:g}x{spec.room.depth:g}x{spec.room.height:g} m | "
        f"{len(spec.objects)} object(s)"
    )

    started = time.perf_counter()
    try:
        written = assemble(spec, out_path, config=config,
                           blender=args.blender, console=console,
                           decimate=args.decimate, max_stretch=args.max_stretch)
    except FileNotFoundError as exc:
        console.print(f"[red]{exc}[/]")
        return 2
    except ValueError as exc:
        console.print(f"[red]{exc}[/]")
        return 2
    except RuntimeError as exc:
        console.print(f"[red]Assembly failed.[/]\n{exc}")
        return 1

    elapsed = time.perf_counter() - started
    size_mb = written.stat().st_size / 1e6
    console.print(f"[green]->[/] {written}  [dim]{size_mb:.2f} MB in {elapsed:.1f}s[/]")
    console.print("[dim]View it with:[/] [bold]dreamspace-view[/]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
