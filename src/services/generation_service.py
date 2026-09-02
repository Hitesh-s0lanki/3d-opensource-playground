"""Running a local backend over a batch of images.

This is the CPU/local-GPU path - TripoSR on whatever card is in the machine -
and it is what the CLI and the room pipeline use. The API does not call it: an
HTTP worker that loads 1.7 GB of weights into the request process would be one
job per box, which is the opposite of what `modal_service` is for.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

from src.config import Config

# Below this there is nothing left to trade away: halving again costs more in
# recomputation than it saves in memory, and the failure is telling you the
# card is simply too small for this resolution.
MIN_CHUNK_SIZE = 512


@dataclass
class GenerationResult:
    """One image's outcome. `mesh` is None exactly when `error` is set."""

    image: Path
    mesh: Path | None = None
    error: str | None = None
    seconds: float = 0.0

    @property
    def ok(self) -> bool:
        return self.mesh is not None


def generate_one(backend, image_path: Path, out_stem: str, config: Config, console):
    """Reconstruct one image, backing off the chunk size on CUDA OOM.

    On a 4 GB card an OOM is the expected case rather than an exceptional one,
    so it is handled as a tuning signal: halve the chunk size and try again,
    without reloading the weights. A backend with no such knob reports that by
    returning False from set_chunk_size, which ends the loop immediately rather
    than retrying an identical computation.
    """
    import torch

    chunk = config.chunk_size
    while True:
        try:
            return backend.generate(image_path, out_stem)
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            if chunk <= MIN_CHUNK_SIZE or not backend.set_chunk_size(chunk // 2):
                raise RuntimeError(
                    f"CUDA out of memory and no further backoff available "
                    f"(chunk_size={chunk}). Try --mc-resolution 192, "
                    f"--no-texture, or --device cpu."
                ) from None
            chunk //= 2
            console.print(f"[yellow]CUDA OOM - retrying at chunk_size={chunk}[/]")


def generate_meshes(
    images: list[Path],
    config: Config,
    console,
) -> list[GenerationResult]:
    """Reconstruct every image with one resident model.

    The weights are loaded once for the whole batch, which is the entire reason
    this takes a list rather than being called in a loop from outside.

    A failure is recorded and the batch continues: one bad crop must not cost a
    whole room, and a wardrobe that OOMs is a missing wardrobe, not a dead job.
    """
    from src.services.backends import get_backend

    config.output_dir.mkdir(parents=True, exist_ok=True)

    backend = get_backend(config.backend, config, console)
    backend.load()

    results: list[GenerationResult] = []
    for index, image_path in enumerate(images, start=1):
        console.rule(f"[bold]{index}/{len(images)}  {image_path.name}")
        started = time.perf_counter()
        try:
            mesh = generate_one(backend, image_path, image_path.stem, config, console)
            results.append(
                GenerationResult(image_path, mesh=mesh, seconds=time.perf_counter() - started)
            )
        except Exception as exc:
            console.print(f"[red]Failed:[/] {type(exc).__name__}: {exc}")
            # The message alone is rarely enough to locate a fault inside
            # vendored upstream code, so always show where it came from.
            console.print_exception(max_frames=6)
            results.append(
                GenerationResult(
                    image_path,
                    error=f"{type(exc).__name__}: {exc}",
                    seconds=time.perf_counter() - started,
                )
            )
        finally:
            backend.unload()

    return results
