"""What crosses the wire for a single-object generation.

The field names match the Modal container's own arguments exactly, and the
request shape matches what `frontend/src/lib/modal.ts` already sends, so the
viewer needs no change beyond pointing MODAL_ENDPOINT at this backend.

Every knob is optional and defaults to None rather than to a value. A value
here would be a second set of defaults competing with the container's, and the
two would drift; None means "not specified" and is dropped before the call.
"""

from __future__ import annotations

import base64
from typing import Literal

from pydantic import BaseModel, Field


class GenerateRequest(BaseModel):
    image_b64: str = Field(description="The source photo, base64-encoded.")

    texture: bool | None = None
    steps: int | None = Field(default=None, ge=1, le=200)
    guidance_scale: float | None = Field(default=None, ge=0.0)
    octree_resolution: int | None = Field(default=None, ge=64, le=1024)
    seed: int | None = None
    max_num_view: int | None = Field(default=None, ge=1, le=12)
    view_resolution: int | None = Field(default=None, ge=64, le=2048)
    remove_background: bool | None = None

    def image_bytes(self) -> bytes:
        """Decode the image, or say why it could not be decoded.

        Strict: base64 that silently ignores stray characters turns a truncated
        upload into a corrupt image and a confusing GPU-side failure minutes
        later, instead of a 400 now.
        """
        try:
            raw = base64.b64decode(self.image_b64, validate=True)
        except Exception as exc:
            raise ValueError(f"image_b64 is not valid base64: {exc}") from exc
        if not raw:
            raise ValueError("image_b64 decoded to nothing")
        return raw

    def options(self) -> dict:
        """Only the knobs that were actually specified.

        Everything except the image, which travels separately - so adding a knob
        is one field here and one entry in modal_service.GENERATION_OPTIONS,
        and forgetting the second means it is dropped rather than forwarded.
        """
        return self.model_dump(exclude={"image_b64"}, exclude_none=True)


class SubmittedJob(BaseModel):
    """The handle to poll. Named `call_id` because that is what Modal calls it."""

    call_id: str


class PendingJob(BaseModel):
    state: Literal["pending"] = "pending"


class CancelledJob(BaseModel):
    cancelled: bool = True
