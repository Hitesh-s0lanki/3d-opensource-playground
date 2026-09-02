"""Call the *deployed* Hunyuan3D app, instead of spinning up an ephemeral one.

`modal run hunyuan3d.py` creates a throwaway app per invocation: it hydrates the
image graph, registers the functions, runs, and tears the app down again. That is
right for one-off CLI use and wrong for a UI that fires a job every time someone
clicks a button.

This is the other half of `modal deploy hunyuan3d.py`. The app already exists in
the workspace, so there is nothing to create - look the class up by name and call
it. Deploy once:

    modal deploy scripts/modal_app/hunyuan3d.py

then this script is a plain Python program, not a `modal run` target:

    python scripts/modal_app/call.py --image photos/chair.png

To be clear about what this does and does not save: the GPU time, the cold start
and the weight loading are identical either way. What goes away is the per-call
app setup, a couple of seconds. It is worth it because the viewer shells out once
per job, not because it makes generation cheaper.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import modal

# Must match modal.App(APP_NAME) and the class name in hunyuan3d.py. A deployed
# app is addressed by name - there is no URL unless a web endpoint is declared,
# and this one declares none.
APP_NAME = "dioramic-hunyuan3d"
CLASS_NAME = "Hunyuan3D"

# The defaults and the image-collection rule live in hunyuan3d.py so the two
# entry points cannot drift apart. Importing it only builds Image/Volume objects
# in memory; nothing is sent anywhere until something is actually called.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from hunyuan3d import _collect  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="scripts/modal_app/call.py",
        description="Generate a 3D mesh on the deployed Modal app.",
        epilog="Requires `modal deploy scripts/modal_app/hunyuan3d.py` to have been run once.",
    )
    p.add_argument("--image", required=True, help="Image file, or a directory of images.")
    p.add_argument("--out", default="outputs", help="Local output directory.")
    p.add_argument("--no-texture", dest="texture", action="store_false", default=True,
                   help="Geometry only. Skips the 21 GB paint pipeline.")
    p.add_argument("--steps", type=int, default=50)
    p.add_argument("--guidance-scale", type=float, default=5.0)
    p.add_argument("--octree-resolution", type=int, default=384)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--max-num-view", type=int, default=6)
    p.add_argument("--view-resolution", type=int, default=512)
    p.add_argument("--no-remove-background", dest="remove_background",
                   action="store_false", default=True)
    return p


def main() -> int:
    args = build_parser().parse_args()

    try:
        images = _collect(Path(args.image))
    except (FileNotFoundError, ValueError) as exc:
        print(f"{exc}")
        return 2

    try:
        model = modal.Cls.from_name(APP_NAME, CLASS_NAME)()
    except modal.exception.NotFoundError:
        # The single most likely failure here, and the message Modal gives for it
        # is about a missing object rather than about the thing you forgot to do.
        print(f"'{APP_NAME}' is not deployed in this workspace.\n"
              f"Run:  modal deploy scripts/modal_app/hunyuan3d.py")
        return 1

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    failures = 0
    for index, path in enumerate(images, start=1):
        # "1/3  chair.png" - the shape the viewer scrapes progress out of.
        print(f"{index}/{len(images)}  {path.name}", flush=True)
        started = time.perf_counter()
        try:
            glb = model.generate.remote(
                path.read_bytes(),
                texture=args.texture,
                steps=args.steps,
                guidance_scale=args.guidance_scale,
                octree_resolution=args.octree_resolution,
                seed=args.seed,
                max_num_view=args.max_num_view,
                view_resolution=args.view_resolution,
                remove_background=args.remove_background,
            )
        except Exception as exc:
            print(f"  failed: {type(exc).__name__}: {exc}", flush=True)
            failures += 1
            continue

        out_path = out_dir / f"{path.stem}.glb"
        out_path.write_bytes(glb)
        print(f"  -> {out_path}  {len(glb) / 1e6:.1f} MB "
              f"in {time.perf_counter() - started:.0f}s", flush=True)

    print(f"{len(images) - failures}/{len(images)} succeeded -> {out_dir.resolve()}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
