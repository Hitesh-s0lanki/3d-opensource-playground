"""Configuration resolved from .env, then overridden by CLI flags.

One dataclass covers both entry points on purpose. The API and the CLI run
the same services against the same weights and the same output directory, so
a second settings object would only be a second place for them to disagree.
The `api_*` fields are simply the ones the CLI never overrides.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, fields
from pathlib import Path

from dotenv import load_dotenv

def _find_project_root() -> Path:
    """Locate the repo root by walking up for a marker file.

    The backend lives under ``src/`` but writes to ``outputs/`` and ``vendor/``
    at the repo root, so a fixed number of ``.parent`` hops is fragile - it
    breaks the moment a module moves one level deeper. Anchor on
    pyproject.toml instead.
    """
    here = Path(__file__).resolve()
    for candidate in here.parents:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    # Installed non-editable, or the marker is gone: src/config.py -> repo.
    return here.parent.parent


PROJECT_ROOT = _find_project_root()
VENDOR_DIR = PROJECT_ROOT / "vendor"


def _bool(key: str, default: bool) -> bool:
    raw = os.getenv(key)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int(key: str, default: int) -> int:
    raw = os.getenv(key)
    return int(raw) if raw not in (None, "") else default


def _float(key: str, default: float) -> float:
    raw = os.getenv(key)
    return float(raw) if raw not in (None, "") else default


def _str(key: str, default: str) -> str:
    raw = os.getenv(key)
    return raw if raw not in (None, "") else default


def _csv(key: str) -> tuple[str, ...]:
    raw = os.getenv(key) or ""
    return tuple(part.strip() for part in raw.split(",") if part.strip())


def _path(key: str, default: str) -> Path:
    """Read a path, resolving relative values against the repo root."""
    value = Path(_str(key, default)).expanduser()
    return value if value.is_absolute() else PROJECT_ROOT / value


@dataclass
class Config:
    backend: str = "triposr"

    device: str = "auto"
    half_precision: bool = False
    chunk_size: int = 4096
    mc_resolution: int = 256

    remove_background: bool = True
    foreground_ratio: float = 0.85
    rembg_model: str = "u2net"

    output_dir: Path = PROJECT_ROOT / "outputs"
    output_format: str = "glb"
    bake_texture: bool = True
    texture_resolution: int = 2048
    flip_faces: bool = False

    # Path to blender.exe. Blender ships its own Python, so it is driven as an
    # external process rather than imported - see services/assembly_service.py.
    blender_exe: str = ""

    # -- API ---------------------------------------------------------------
    # The generation endpoints spend GPU money, so they are not open to the
    # internet: every request carries X-Dioramic-Token. Blank disables the
    # check, which is only ever right on localhost.
    #     DIORAMIC_TOKEN=$(openssl rand -hex 32)
    api_token: str = ""
    api_host: str = "127.0.0.1"
    api_port: int = 8000
    # Browsers only reach this through the Next.js server, which is not a
    # browser, so CORS stays closed unless someone opts in.
    api_cors_origins: tuple[str, ...] = ()

    # The deployed Modal app that owns the GPU. Addressed by name rather than
    # URL - a deployed app has no hostname unless it declares a web endpoint,
    # and this one deliberately declares none now that the HTTP surface is here.
    #     modal deploy scripts/modal_app/hunyuan3d.py
    modal_app: str = "dioramic-hunyuan3d"
    modal_class: str = "Hunyuan3D"

    @classmethod
    def load(cls) -> "Config":
        """Read .env (if present) and build a config from the environment."""
        load_dotenv(PROJECT_ROOT / ".env")

        # HF_HOME must be set before huggingface_hub is imported anywhere, so we
        # normalise it here at config time rather than inside the backend.
        hf_home = os.getenv("HF_HOME")
        if hf_home:
            resolved = Path(hf_home).expanduser()
            resolved.mkdir(parents=True, exist_ok=True)
            os.environ["HF_HOME"] = str(resolved)

        return cls(
            backend=_str("MODEL_BACKEND", "triposr").lower(),
            device=_str("DEVICE", "auto").lower(),
            half_precision=_bool("HALF_PRECISION", False),
            chunk_size=_int("CHUNK_SIZE", 4096),
            mc_resolution=_int("MC_RESOLUTION", 256),
            remove_background=_bool("REMOVE_BACKGROUND", True),
            foreground_ratio=_float("FOREGROUND_RATIO", 0.85),
            rembg_model=_str("REMBG_MODEL", "u2net"),
            # Relative paths are resolved against the repo, not the shell's cwd:
            # the CLI is an installed console script now and can be invoked from
            # anywhere, so "outputs" must not mean "wherever you happen to be".
            output_dir=_path("OUTPUT_DIR", "outputs"),
            output_format=_str("OUTPUT_FORMAT", "glb").lower(),
            bake_texture=_bool("BAKE_TEXTURE", True),
            texture_resolution=_int("TEXTURE_RESOLUTION", 2048),
            flip_faces=_bool("FLIP_FACES", False),
            blender_exe=_str("BLENDER_EXE", ""),
            api_token=_str("DIORAMIC_TOKEN", ""),
            api_host=_str("API_HOST", "127.0.0.1"),
            api_port=_int("API_PORT", 8000),
            api_cors_origins=_csv("API_CORS_ORIGINS"),
            modal_app=_str("MODAL_APP", "dioramic-hunyuan3d"),
            modal_class=_str("MODAL_CLASS", "Hunyuan3D"),
        )

    def override(self, **kwargs) -> "Config":
        """Apply non-None CLI values on top of the env-derived config."""
        known = {f.name for f in fields(self)}
        for key, value in kwargs.items():
            if value is None or key not in known:
                continue
            setattr(self, key, value)
        return self

    def resolve_device(self) -> str:
        import torch

        if self.device == "cpu":
            return "cpu"
        if self.device == "cuda":
            if not torch.cuda.is_available():
                raise RuntimeError("DEVICE=cuda but torch reports no CUDA device available.")
            return "cuda"
        return "cuda" if torch.cuda.is_available() else "cpu"

    def resolve_blender(self) -> Path:
        """Locate blender.exe, preferring BLENDER_EXE then PATH."""
        import shutil

        if self.blender_exe:
            candidate = Path(self.blender_exe).expanduser()
            if not candidate.is_file():
                raise FileNotFoundError(f"BLENDER_EXE points at a missing file: {candidate}")
            return candidate

        found = shutil.which("blender")
        if found:
            return Path(found)

        raise FileNotFoundError(
            "Blender not found. Set BLENDER_EXE in .env to the full path of "
            "blender.exe, or put it on PATH."
        )
