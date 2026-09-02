"""Is the service up, and is the machine under it actually capable?

Two questions with two different answers, so two endpoints. `status` is the
liveness probe: cheap, no imports, no network, safe to hit every second.
`doctor` is the one a person runs when something is wrong - it imports torch,
resolves Blender and checks a dozen versions, which is far too slow for a probe.
"""

from __future__ import annotations

from dataclasses import asdict

from src import __version__
from src.config import Config
from src.services import modal_service
from src.services.diagnostics_service import environment_report, is_healthy


def status(config: Config) -> dict:
    return {
        "status": "ok",
        "version": __version__,
        # Whether generation *could* work, which is the difference between "the
        # API is down" and "you never deployed the GPU app".
        "gpu_worker": {
            "configured": modal_service.configured(config),
            "app": config.modal_app,
        },
        "auth_required": bool(config.api_token),
    }


def doctor(config: Config) -> dict:
    checks = environment_report(config)
    return {
        "healthy": is_healthy(checks),
        "checks": [asdict(check) for check in checks],
    }
