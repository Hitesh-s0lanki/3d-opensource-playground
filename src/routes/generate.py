"""Single-object image-to-3D.

Three paths, and the shape is fixed by the constraint rather than by taste: a
textured generation runs 60-105 seconds, which is longer than any sensible HTTP
timeout, so the work is queued and then polled.

    POST /generate          -> 200 {"call_id": ...}
    GET  /result?call_id=   -> 202 {"state": "pending"} until 200 <GLB bytes>
    POST /cancel?call_id=   -> 200 {"cancelled": true}

These paths and the token header match what the Next.js viewer already sends,
so pointing MODAL_ENDPOINT at this service is the whole migration.
"""

from fastapi import APIRouter, Query
from fastapi.responses import Response

from src.controllers import generate_controller
from src.routes.dependencies import Authenticated, ConfigDep
from src.schemas.generation import CancelledJob, GenerateRequest, SubmittedJob

router = APIRouter(tags=["generate"], dependencies=[Authenticated])

CallId = Query(description="The id returned by POST /generate.", min_length=1)


@router.post("/generate", summary="Queue a generation")
def submit(request: GenerateRequest, config: ConfigDep) -> SubmittedJob:
    return generate_controller.submit(request, config)


@router.get(
    "/result",
    summary="Collect a finished generation",
    response_class=Response,
    responses={
        200: {"content": {"model/gltf-binary": {}}, "description": "The finished mesh."},
        202: {"description": "Still running - poll again."},
    },
)
def result(config: ConfigDep, call_id: str = CallId) -> Response:
    return generate_controller.collect(call_id, config)


@router.post("/cancel", summary="Stop a queued or running generation")
def cancel(config: ConfigDep, call_id: str = CallId) -> CancelledJob:
    return generate_controller.cancel(call_id, config)
