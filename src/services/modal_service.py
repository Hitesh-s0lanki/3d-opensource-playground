"""Handing generation to the GPU, which is somewhere else.

Nothing in this process touches CUDA. Hunyuan3D needs ~16 GB with texture and
compiles two CUDA extensions on the way up, so the model lives in a container on
Modal and this backend is the thing that queues work into it and reads the
result out. That keeps the API deployable anywhere - a small box, a container,
a laptop - and keeps GPU cost proportional to jobs rather than to uptime.

The deployed app is addressed by name, not by URL: `modal.Cls.from_name` looks
the class up in the workspace and calls it directly, so nothing here depends on
the container's own web endpoint. That endpoint still exists in
scripts/modal_app/hunyuan3d.py, and it is now a second, older copy of the
surface in `routes/generate.py` - kept working so a deployment pointed straight
at Modal keeps running, but this is the path to build on.

Submit-then-poll rather than one blocking call, because a textured generation
runs 60-105 seconds and holding an HTTP request open that long is exactly what
serverless request timeouts kill. `spawn` queues and returns an id immediately;
`collect` is polled until the bytes exist. The id is the only state, so nothing
depends on this process staying alive between the two.
"""

from __future__ import annotations

from src.config import Config

# The knobs the API is willing to forward. Anything else in a request body is
# ignored rather than passed through, so a typo cannot silently reconfigure a
# GPU job - and the container's own defaults stay the single source of truth.
GENERATION_OPTIONS = (
    "texture",
    "steps",
    "guidance_scale",
    "octree_resolution",
    "seed",
    "max_num_view",
    "view_resolution",
    "remove_background",
)


class ModalUnavailable(RuntimeError):
    """The worker cannot be reached: client missing, or app not deployed."""


class CallNotFound(LookupError):
    """No such call id - expired, or never issued by this workspace."""


class GenerationFailed(RuntimeError):
    """The call ran on the GPU and raised there."""


def _modal():
    """Import the Modal client, lazily.

    It is an optional dependency (`uv pip install -e ".[modal]"`) and a fairly
    heavy import, so the API can boot and serve /health without it. Every path
    that actually needs a GPU goes through here and gets a usable message.
    """
    try:
        import modal
    except ImportError as exc:
        raise ModalUnavailable(
            'the modal client is not installed - uv pip install -e ".[modal]"'
        ) from exc
    return modal


def configured(config: Config) -> bool:
    """Whether a GPU worker could be reached at all.

    Cheap and import-only: it does not phone the workspace. Used to answer
    /health without paying for a lookup on every poll.
    """
    try:
        _modal()
    except ModalUnavailable:
        return False
    return bool(config.modal_app and config.modal_class)


def _worker(config: Config):
    modal = _modal()
    try:
        return modal.Cls.from_name(config.modal_app, config.modal_class)()
    except modal.exception.NotFoundError as exc:
        # By far the most likely failure, and Modal's own message for it talks
        # about a missing object rather than about the step you skipped.
        raise ModalUnavailable(
            f"'{config.modal_app}' is not deployed in this workspace. "
            f"Run: modal deploy scripts/modal_app/hunyuan3d.py"
        ) from exc


def submit(image: bytes, options: dict, *, config: Config) -> str:
    """Queue one generation and return the call id to poll for it."""
    if not image:
        raise ValueError("empty image")
    allowed = {k: options[k] for k in GENERATION_OPTIONS if options.get(k) is not None}
    return _worker(config).generate.spawn(image, **allowed).object_id


def collect(call_id: str, *, config: Config) -> bytes | None:
    """Return the finished GLB, or None while the call is still running.

    Raises GenerationFailed if the call itself blew up on the GPU - which is
    worth distinguishing from "not yet", because one is worth reporting to the
    user and the other is the normal answer to nearly every poll.
    """
    modal = _modal()
    try:
        handle = modal.FunctionCall.from_id(call_id)
        # timeout=0 asks "is it done?" without blocking the request.
        return handle.get(timeout=0)
    except TimeoutError:
        return None
    except modal.exception.NotFoundError as exc:
        # Modal keeps a finished call's result for a limited window, so an
        # unknown id means "expired or wrong", not "still working" - and a
        # caller polling forever deserves to be told.
        raise CallNotFound(f"unknown call id: {call_id}") from exc
    except Exception as exc:
        raise GenerationFailed(f"{type(exc).__name__}: {exc}") from exc


def cancel(call_id: str, *, config: Config) -> None:
    """Best effort - the container may already be past the point of saving."""
    modal = _modal()
    try:
        modal.FunctionCall.from_id(call_id).cancel()
    except modal.exception.NotFoundError as exc:
        raise CallNotFound(f"unknown call id: {call_id}") from exc
