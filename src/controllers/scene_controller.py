"""Assembling an already-described scene into one GLB.

The cheap half of the room pipeline: no detection, no reconstruction, no GPU -
just Blender placing meshes that already exist. Seconds rather than minutes,
which is what makes it reasonable to answer inside a request.

This is the route to use after hand-editing a scene.json: change a position,
re-assemble, look at it, repeat.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import Response

from src.config import Config
from src.controllers import GLB_MEDIA_TYPE, console
from src.schemas.room import AssembleRequest
from src.schemas.scene import SceneSpec
from src.services.assembly_service import assemble


def build(request: AssembleRequest, config: Config) -> Response:
    try:
        spec = SceneSpec.from_dict(request.spec)
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, f"invalid scene spec: {exc}") from exc

    # The GLB goes back in the response body, so it needs a path only for as
    # long as Blender takes to write it.
    handle = tempfile.NamedTemporaryFile(suffix=".glb", delete=False)
    handle.close()
    out_path = Path(handle.name)

    try:
        assemble(
            spec,
            out_path,
            config=config,
            console=console,
            decimate=request.decimate,
            max_stretch=request.max_stretch,
        )
        return Response(content=out_path.read_bytes(), media_type=GLB_MEDIA_TYPE)
    except FileNotFoundError as exc:
        raise HTTPException(424, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except RuntimeError as exc:
        # Blender's own failure, already trimmed to the useful lines by
        # assembly_service._failure_message.
        raise HTTPException(500, str(exc)) from exc
    finally:
        out_path.unlink(missing_ok=True)
