"""Input image preparation.

Every model here is a *single-object* reconstructor. Feeding it an uncropped
photo is the most common reason people conclude the model is bad when the input
was the problem. Background removal is effectively mandatory on real photos.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

_session_cache: dict[str, object] = {}


def _rembg_session(model_name: str):
    if model_name not in _session_cache:
        import rembg

        _session_cache[model_name] = rembg.new_session(model_name)
    return _session_cache[model_name]


def collect_images(target: Path) -> list[Path]:
    """Expand a file or directory argument into a sorted list of image paths."""
    if target.is_dir():
        found = sorted(p for p in target.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES)
        if not found:
            raise FileNotFoundError(f"No images found in {target}")
        return found
    if not target.exists():
        raise FileNotFoundError(f"No such file: {target}")
    if target.suffix.lower() not in IMAGE_SUFFIXES:
        raise ValueError(f"Unsupported image type: {target.suffix}")
    return [target]


def resize_foreground(image: Image.Image, ratio: float) -> Image.Image:
    """Tight-crop to the alpha bounding box, then pad to a square.

    Mirrors TripoSR's own preprocessing so results stay comparable with upstream.
    """
    arr = np.array(image)
    alpha = np.where(arr[..., 3] > 0)
    if alpha[0].size == 0:
        return image

    y1, y2 = int(alpha[0].min()), int(alpha[0].max())
    x1, x2 = int(alpha[1].min()), int(alpha[1].max())
    cropped = arr[y1:y2, x1:x2]

    side = int(max(cropped.shape[0], cropped.shape[1]) / ratio)
    pad_h = (side - cropped.shape[0]) // 2
    pad_w = (side - cropped.shape[1]) // 2
    padded = np.pad(
        cropped,
        ((pad_h, side - cropped.shape[0] - pad_h), (pad_w, side - cropped.shape[1] - pad_w), (0, 0)),
        mode="constant",
        constant_values=0,
    )
    return Image.fromarray(padded)


def prepare(
    path: Path,
    *,
    remove_bg: bool,
    foreground_ratio: float,
    rembg_model: str,
    flatten_to_grey: bool,
) -> Image.Image:
    """Load and prepare a single image for the model.

    ``flatten_to_grey`` composites the cutout onto neutral grey and drops alpha.
    TripoSR expects that when producing vertex colours, but wants the alpha kept
    when it is going to bake a UV texture.
    """
    image = Image.open(path)

    if not remove_bg:
        return image.convert("RGB")

    import rembg

    image = rembg.remove(image, session=_rembg_session(rembg_model))
    image = resize_foreground(image.convert("RGBA"), foreground_ratio)

    if not flatten_to_grey:
        return image

    arr = np.array(image).astype(np.float32) / 255.0
    rgb = arr[:, :, :3] * arr[:, :, 3:4] + (1 - arr[:, :, 3:4]) * 0.5
    return Image.fromarray((rgb * 255.0).astype(np.uint8))
