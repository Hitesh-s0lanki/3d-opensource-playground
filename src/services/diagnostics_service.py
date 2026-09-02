"""Is this machine actually able to run anything?

Every check here has been a real support question at some point: a CPU-only
torch wheel, numpy 2 quietly breaking rembg, a marching-cubes extension that
will not build without the CUDA Toolkit. Answering them costs a second and
saves reading a stack trace from inside vendored upstream code.

Returns data, not a table. The CLI renders it with rich and /health/doctor
serialises the same rows to JSON, so the two can never drift apart.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass

from src.config import Config

OK, WARN, FAIL = "ok", "warn", "fail"

# Imported for their presence, not their contents: each one is a hard runtime
# dependency of some path through the pipeline, and a missing one fails late
# and confusingly if it is not caught here.
REQUIRED_MODULES = (
    "rembg",
    "trimesh",
    "xatlas",
    "moderngl",
    "transformers",
    "omegaconf",
)


@dataclass(frozen=True)
class Check:
    name: str
    detail: str
    status: str = OK
    note: str = ""


def _torch_checks() -> list[Check]:
    try:
        import torch
    except ImportError:
        return [Check("torch", "not installed", FAIL)]

    checks = [Check("torch", torch.__version__)]

    # A CPU-only wheel is the single most common broken install, because
    # `pip install torch` gives you one without saying so.
    if torch.version.cuda:
        checks.append(Check("torch CUDA build", torch.version.cuda))
    else:
        checks.append(Check("torch CUDA build", "CPU-only build", FAIL))

    if not torch.cuda.is_available():
        checks.append(Check("GPU", "not available - will run on CPU (slow)", WARN))
        return checks

    props = torch.cuda.get_device_properties(0)
    vram = props.total_memory / 1024**3
    checks.append(Check("GPU", props.name))
    checks.append(
        Check(
            "VRAM",
            f"{vram:.1f} GB",
            OK if vram >= 6 else WARN,
            "" if vram >= 6 else "triposr only; keep CHUNK_SIZE low",
        )
    )
    return checks


def environment_report(config: Config) -> list[Check]:
    """Every check, in the order a person would want to read them."""
    from src.services.backends.compat import install_torchmcubes_shim

    checks = [Check("Python", sys.version.split()[0])]
    checks += _torch_checks()

    try:
        checks.append(Check("marching cubes", install_torchmcubes_shim()))
    except ImportError as exc:
        checks.append(Check("marching cubes", str(exc), FAIL))

    for module in REQUIRED_MODULES:
        try:
            __import__(module)
            checks.append(Check(module, "installed"))
        except ImportError:
            checks.append(Check(module, "missing", FAIL))

    try:
        import numpy

        good = numpy.__version__.startswith("1.")
        checks.append(
            Check("numpy", numpy.__version__, OK if good else FAIL,
                  "" if good else "need <2.0")
        )
    except ImportError:
        checks.append(Check("numpy", "missing", FAIL))

    # Blender is optional: it is only needed for scene assembly, so a missing
    # one is a warning rather than a failure - single-object generation and the
    # whole API surface are unaffected by it.
    try:
        checks.append(Check("Blender", str(config.resolve_blender())))
    except FileNotFoundError:
        checks.append(Check("Blender", "not found (scene assembly only)", WARN))

    # Weights are gigabytes and OneDrive will happily sync every one of them.
    hf_home = os.environ.get("HF_HOME", "(default: ~/.cache/huggingface)")
    in_onedrive = "onedrive" in hf_home.lower()
    checks.append(
        Check("HF_HOME", hf_home, WARN if in_onedrive else OK,
              "inside OneDrive - move it off the synced tree" if in_onedrive else "")
    )

    return checks


def is_healthy(checks: list[Check]) -> bool:
    """Warnings are survivable by design; failures are not."""
    return not any(check.status == FAIL for check in checks)
