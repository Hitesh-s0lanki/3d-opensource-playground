"""What crosses the wire for room-scale work.

Rooms are the long half of the pipeline: detection, one reconstruction per
object, layout, then Blender. Minutes, not seconds. The response is therefore
a report on a finished build rather than a job handle - see routes/rooms.py for
why that is deliberate and what it costs.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class RoomOptions(BaseModel):
    """Everything `dioramic-room` exposes as a flag, as a request body.

    Defaults are duplicated from the CLI parser rather than shared with it,
    which is a real cost - but the alternative is an argparse parser imported
    into an HTTP layer, and these five numbers have not changed in the life of
    the project.
    """

    labels: list[str] | None = Field(
        default=None,
        description="Words to look for. None uses the generic furniture list.",
    )
    threshold: float = Field(default=0.30, ge=0.0, le=1.0)

    fov: float = Field(default=85.0, gt=0.0, lt=180.0,
                       description="Horizontal field of view, degrees. Sets the room's scale.")
    camera_height: float = Field(default=1.35, gt=0.0)
    pitch: float = Field(default=0.0, description="Downward camera tilt, degrees.")

    decimate: float | None = Field(default=None, gt=0.0, le=1.0)
    max_stretch: float = Field(default=1.5, ge=1.0)
    walls: str = Field(default="auto", description="'auto', 'all', 'none', or e.g. '-x,+y'.")
    regenerate: bool = Field(default=False, description="Rebuild meshes that already exist.")


class RoomDimensions(BaseModel):
    width: float
    depth: float
    height: float


class RoomBuilt(BaseModel):
    name: str
    glb: str
    spec: str = Field(description="Path to the scene.json this was built from.")
    room: RoomDimensions
    generated: list[str]
    failed: list[str] = Field(
        default_factory=list,
        description="Detected but not placed - reconstruction failed for these.",
    )


class AssembleRequest(BaseModel):
    """A hand-written or edited scene, ready for Blender.

    `spec` stays a plain dict on purpose. schemas/scene.py already validates the
    format - it has to, because Blender re-reads the same JSON with its own
    interpreter - so restating it as a pydantic model would be a second copy of
    the rules with its own error messages.
    """

    spec: dict
    decimate: float | None = Field(default=None, gt=0.0, le=1.0)
    max_stretch: float = Field(default=1.0, ge=1.0)
