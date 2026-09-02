"""Backend interface and registry."""

from __future__ import annotations

import subprocess
import sys
from abc import ABC, abstractmethod
from pathlib import Path

from src.config import VENDOR_DIR, Config


class Backend(ABC):
    """A single image-to-3D model."""

    name: str = "base"
    repo_url: str = ""
    vendor_name: str = ""

    def __init__(self, config: Config, console) -> None:
        self.config = config
        self.console = console

    # -- lifecycle ----------------------------------------------------------
    @abstractmethod
    def load(self) -> None:
        """Download weights and move the model onto the target device."""

    @abstractmethod
    def generate(self, image_path: Path, out_stem: str) -> Path:
        """Reconstruct one image and return the path to the written mesh."""

    def unload(self) -> None:
        import gc

        import torch

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def set_chunk_size(self, chunk_size: int) -> bool:
        """Re-tune memory usage after an OOM, without reloading weights.

        Returns True if the backend could apply it. Backends with no such knob
        return False, which tells the runner that retrying is pointless.
        """
        return False

    # -- helpers ------------------------------------------------------------
    def ensure_vendored(self) -> Path:
        """Clone the upstream repo into vendor/ and put it on sys.path.

        These projects ship as repositories, not installable packages - there is
        no setup.py to pip-install - so vendoring is the supported way to use
        them as a library.
        """
        target = VENDOR_DIR / self.vendor_name
        if not target.exists():
            VENDOR_DIR.mkdir(parents=True, exist_ok=True)
            self.console.print(f"[cyan]Cloning {self.repo_url} -> vendor/{self.vendor_name}[/]")
            result = subprocess.run(
                ["git", "clone", "--depth", "1", self.repo_url, str(target)],
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                raise RuntimeError(f"git clone failed:\n{result.stderr.strip()}")

        path = str(target)
        if path not in sys.path:
            sys.path.insert(0, path)
        return target


_REGISTRY: dict[str, type[Backend]] = {}


def register(cls: type[Backend]) -> type[Backend]:
    _REGISTRY[cls.name] = cls
    return cls


def get_backend(name: str, config: Config, console) -> Backend:
    from . import hunyuan3d, triposr  # noqa: F401  (populates the registry)

    if name not in _REGISTRY:
        available = ", ".join(sorted(_REGISTRY)) or "none"
        raise KeyError(f"Unknown backend '{name}'. Available: {available}")
    return _REGISTRY[name](config, console)


def available_backends() -> list[str]:
    from . import hunyuan3d, triposr  # noqa: F401

    return sorted(_REGISTRY)
