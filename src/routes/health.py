"""Liveness, and a full environment report.

Deliberately unauthenticated: a probe that needs a secret is a probe that stops
working the day the secret rotates, and neither response says anything a caller
could not learn by trying an endpoint.
"""

from fastapi import APIRouter

from src.controllers import health_controller
from src.routes.dependencies import ConfigDep

router = APIRouter(tags=["health"])


@router.get("/health", summary="Is the service up?")
def health(config: ConfigDep) -> dict:
    return health_controller.status(config)


@router.get("/health/doctor", summary="Can this machine actually run the pipeline?")
def doctor(config: ConfigDep) -> dict:
    """Slow - imports torch, resolves Blender, checks a dozen versions.

    The same checks `dioramic-generate --doctor` prints as a table.
    """
    return health_controller.doctor(config)
