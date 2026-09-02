"""Single-object generation: queue it, poll it, cancel it.

Three calls rather than one, because the work takes 60-105 seconds on a GPU in
another datacentre. Nothing is stored here - the call id Modal returns is the
whole of the state, and whoever is polling holds it.
"""

from __future__ import annotations

from fastapi import HTTPException
from fastapi.responses import JSONResponse, Response

from src.config import Config
from src.controllers import GLB_MEDIA_TYPE
from src.schemas.generation import CancelledJob, GenerateRequest, PendingJob, SubmittedJob
from src.services import modal_service


def submit(request: GenerateRequest, config: Config) -> SubmittedJob:
    try:
        image = request.image_bytes()
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    try:
        call_id = modal_service.submit(image, request.options(), config=config)
    except modal_service.ModalUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc

    return SubmittedJob(call_id=call_id)


def collect(call_id: str, config: Config) -> Response:
    """202 while it runs, 200 with the GLB when it is done.

    The status code carries the answer so a polling client does not have to
    parse a body to find out whether to poll again - and the finished case is
    binary, which has no sensible JSON representation anyway.
    """
    try:
        glb = modal_service.collect(call_id, config=config)
    except modal_service.ModalUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    except modal_service.CallNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except modal_service.GenerationFailed as exc:
        raise HTTPException(500, str(exc)) from exc

    if glb is None:
        return JSONResponse(PendingJob().model_dump(), status_code=202)
    if not glb:
        raise HTTPException(500, "the worker returned an empty mesh")
    return Response(content=glb, media_type=GLB_MEDIA_TYPE)


def cancel(call_id: str, config: Config) -> CancelledJob:
    try:
        modal_service.cancel(call_id, config=config)
    except modal_service.ModalUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    except modal_service.CallNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    return CancelledJob()
