"""Whole-room reconstruction from one photo.

One request, one finished room, minutes later. That is a bad shape for an HTTP
endpoint and it is chosen knowingly: unlike /generate there is no queue behind
this - the pipeline runs in this process, on this machine's GPU, driving this
machine's Blender - so there is no call id to hand back and poll. A client must
raise its own timeout, and a deployment serving this route is single-tenant in
practice.

The honest fix is to give the room pipeline a Modal worker of its own, at which
point this becomes submit-then-poll like /generate. Until then, /rooms is for a
local or dedicated instance, and the browser drives /generate instead.
"""

from typing import Annotated

from fastapi import APIRouter, File, Form, UploadFile

from src.controllers import room_controller
from src.routes.dependencies import Authenticated, ConfigDep
from src.schemas.room import RoomBuilt, RoomOptions

router = APIRouter(prefix="/rooms", tags=["rooms"], dependencies=[Authenticated])


@router.post("", summary="Detect, reconstruct, place and assemble a whole room")
def build(
    config: ConfigDep,
    image: Annotated[UploadFile, File(description="One photo or render of one room.")],
    options: Annotated[RoomOptions | None, Form()] = None,
) -> RoomBuilt:
    return room_controller.build(image, options or RoomOptions(), config)
