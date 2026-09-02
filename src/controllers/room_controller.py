"""Whole-room builds.

Unlike single-object generation, this runs *here*: detection, reconstruction,
layout and Blender all execute in this process against local hardware. There is
no Modal path for it yet - the room pipeline drives a backend object directly
rather than a container - so the deployment that serves this route is the one
that needs the GPU and the Blender install.

That makes it a minutes-long, single-tenant operation. See routes/rooms.py.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import HTTPException, UploadFile

from src.config import Config
from src.controllers import console
from src.schemas.room import RoomBuilt, RoomDimensions, RoomOptions
from src.services.layout_service import Camera
from src.services.preprocess_service import IMAGE_SUFFIXES
from src.services.room_service import build_room, parse_walls


def _store_upload(upload: UploadFile, config: Config) -> Path:
    """Put the photo on disk, because the pipeline works in files.

    Everything downstream - the crops, the per-object meshes, scene.json - is
    written next to it under outputs/<name>/, and a re-run reuses that tree.
    Keeping the source image there too means the whole build is one directory.
    """
    name = Path(upload.filename or "room.jpg").name
    if Path(name).suffix.lower() not in IMAGE_SUFFIXES:
        raise HTTPException(
            400,
            f"unsupported image type {Path(name).suffix!r}; "
            f"expected one of {', '.join(sorted(IMAGE_SUFFIXES))}",
        )

    target = config.output_dir / "uploads" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("wb") as handle:
        shutil.copyfileobj(upload.file, handle)
    if not target.stat().st_size:
        target.unlink(missing_ok=True)
        raise HTTPException(400, "the uploaded image is empty")
    return target


def build(upload: UploadFile, options: RoomOptions, config: Config) -> RoomBuilt:
    image_path = _store_upload(upload, config)

    camera = Camera(
        fov_x_deg=options.fov,
        height=options.camera_height,
        pitch_deg=options.pitch,
    )

    try:
        result = build_room(
            image_path,
            config,
            console,
            labels=options.labels,
            camera=camera,
            decimate=options.decimate,
            max_stretch=options.max_stretch,
            threshold=options.threshold,
            skip_existing=not options.regenerate,
            walls=parse_walls(options.walls),
        )
    except FileNotFoundError as exc:
        # A missing Blender or a missing mesh: the request was fine, the
        # machine is not set up. 424 rather than 500 says which.
        raise HTTPException(424, str(exc)) from exc
    except RuntimeError as exc:
        # "nothing detected" and "everything failed to reconstruct" both land
        # here, and both are usually answered by a lower --threshold or better
        # labels, so the message is the useful part of the response.
        raise HTTPException(422, str(exc)) from exc

    return RoomBuilt(
        name=result.spec.name,
        glb=str(result.glb),
        spec=str(result.spec_path),
        room=RoomDimensions(
            width=result.spec.room.width,
            depth=result.spec.room.depth,
            height=result.spec.room.height,
        ),
        generated=result.generated,
        failed=result.failed,
    )
