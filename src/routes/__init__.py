"""The HTTP surface, and nothing else.

Every module here does three things: declare a path, name its dependencies, and
call one controller. Anything longer than that belongs a layer down - the test
is whether the function would still make sense with FastAPI removed.

Paths are mounted at the root rather than under /api/v1. The viewer reaches
this service directly, one base URL in one environment variable, and a prefix
would be a second thing to keep in sync for no benefit while there is one
client and one version.
"""

from fastapi import APIRouter

from src.routes import generate, health, rooms, scenes

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(generate.router)
api_router.include_router(rooms.router)
api_router.include_router(scenes.router)

__all__ = ["api_router"]
