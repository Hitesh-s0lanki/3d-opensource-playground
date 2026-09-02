"""Things every route needs: the config, and the token check.

Both are FastAPI dependencies rather than imports so a test can override them
with `app.dependency_overrides` instead of monkey-patching the environment.
"""

from __future__ import annotations

import hmac
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, Header, HTTPException

from src.config import Config

TOKEN_HEADER = "X-Dioramic-Token"


@lru_cache(maxsize=1)
def get_config() -> Config:
    """One Config for the process.

    Config.load() re-reads .env and normalises HF_HOME, which must happen once
    and before huggingface_hub is imported anywhere - so this is cached rather
    than called per request.
    """
    return Config.load()


ConfigDep = Annotated[Config, Depends(get_config)]


def require_token(
    config: ConfigDep,
    token: Annotated[str | None, Header(alias=TOKEN_HEADER)] = None,
) -> None:
    """Reject anyone without the shared secret.

    These endpoints spend GPU money, so they are not open to the internet. A
    blank DIORAMIC_TOKEN disables the check entirely, which is a reasonable
    thing to want on localhost and never right anywhere else.
    """
    if not config.api_token:
        return
    # Constant-time: a check that returns early leaks the token's prefix.
    if not token or not hmac.compare_digest(token, config.api_token):
        raise HTTPException(401, f"bad or missing {TOKEN_HEADER}")


Authenticated = Depends(require_token)
