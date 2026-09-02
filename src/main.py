"""The application entry point.

    uvicorn src.main:app --reload
    python -m src.main

Everything below this file is layered: routes call controllers, controllers call
services, and nothing calls back up. This file is the only place that knows
FastAPI exists as a whole application rather than as a decorator.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src import __version__
from src.routes import api_router
from src.routes.dependencies import get_config

DESCRIPTION = """\
Image to 3D. Single objects run on a GPU worker deployed to Modal; room-scale
assembly runs wherever this service does, because it needs Blender.

Generation endpoints require an `X-Dioramic-Token` header when DIORAMIC_TOKEN
is set. `/health` never does.
"""


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Resolving the config on the way up rather than on the first request means
    # a bad .env is a failed startup, not a 500 for whoever arrives first. It
    # also normalises HF_HOME before anything can import huggingface_hub.
    get_config()
    yield


def create_app() -> FastAPI:
    config = get_config()

    app = FastAPI(
        title="dioramic",
        description=DESCRIPTION,
        version=__version__,
        lifespan=lifespan,
    )

    # Off unless asked for. The viewer talks to this from its Next.js server,
    # which is not a browser and sends no Origin, so the default deployment
    # needs no CORS at all - and an open one here would expose a GPU budget.
    if config.api_cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(config.api_cors_origins),
            allow_methods=["GET", "POST"],
            allow_headers=["*"],
        )

    app.include_router(api_router)
    return app


app = create_app()


def main() -> int:
    """Run a development server. Production should invoke uvicorn directly."""
    import uvicorn

    config = get_config()
    uvicorn.run(
        "src.main:app",
        host=config.api_host,
        port=config.api_port,
        reload=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
