"""Assembling a described scene into one GLB.

The counterpart to /rooms: the same Blender step, without the detection and
reconstruction in front of it. Fast enough to answer in a request, and the loop
anyone editing a scene.json actually wants - tweak a position, re-assemble,
look at it.
"""

from fastapi import APIRouter
from fastapi.responses import Response

from src.controllers import scene_controller
from src.routes.dependencies import Authenticated, ConfigDep
from src.schemas.room import AssembleRequest

router = APIRouter(prefix="/scenes", tags=["scenes"], dependencies=[Authenticated])


@router.post(
    "/assemble",
    summary="Build a scene spec into a single GLB",
    response_class=Response,
    responses={200: {"content": {"model/gltf-binary": {}}, "description": "The assembled scene."}},
)
def assemble(request: AssembleRequest, config: ConfigDep) -> Response:
    return scene_controller.build(request, config)
