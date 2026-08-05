"""Find the individual objects in a room photo and crop them out.

Open-vocabulary detection via GroundingDINO, which takes a plain list of words
("bed", "wardrobe") rather than a fixed class list - necessary because interior
furniture does not map onto COCO's 80 categories.

Background removal is deliberately NOT done here. The backends already run
rembg inside `preprocess.prepare()` on their way into the model, so cutting out
here would only mean doing it twice. This module's job ends at a tight crop.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image

# Deliberately generic and slightly redundant ("wardrobe" and "cabinet" both
# appear): GroundingDINO scores each phrase independently, so an extra synonym
# costs one forward pass and catches objects a single word would miss.
DEFAULT_LABELS = [
    "bed", "wardrobe", "cabinet", "chest of drawers", "nightstand",
    "chair", "sofa", "table", "desk", "bench",
    "lamp", "pendant light", "rug", "potted plant", "painting", "curtain",
]

MODEL_ID = "IDEA-Research/grounding-dino-tiny"

_cache: dict[str, tuple] = {}


@dataclass
class Detection:
    """One detected object, in pixel coordinates."""

    label: str
    score: float
    box: tuple[float, float, float, float]   # x0, y0, x1, y1

    @property
    def width(self) -> float:
        return self.box[2] - self.box[0]

    @property
    def height(self) -> float:
        return self.box[3] - self.box[1]

    @property
    def area(self) -> float:
        return max(0.0, self.width) * max(0.0, self.height)


def _iou(a: Detection, b: Detection) -> float:
    ax0, ay0, ax1, ay1 = a.box
    bx0, by0, bx1, by1 = b.box
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    union = a.area + b.area - inter
    return inter / union if union > 0 else 0.0


def _containment(a: Detection, b: Detection) -> float:
    """Fraction of the smaller box that lies inside the larger one."""
    ax0, ay0, ax1, ay1 = a.box
    bx0, by0, bx1, by1 = b.box
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    smaller = min(a.area, b.area)
    return inter / smaller if smaller > 0 else 0.0


def deduplicate(
    detections: list[Detection],
    iou_threshold: float = 0.6,
    containment_threshold: float = 0.8,
) -> list[Detection]:
    """Greedy non-maximum suppression across all labels.

    GroundingDINO scores every phrase independently, so one wardrobe reliably
    comes back as "wardrobe" and "cabinet" at nearly the same box. Suppressing
    across labels rather than within them removes those - and duplicates matter
    here beyond tidiness, since each one becomes its own 3D generation job.

    IoU alone is not enough, because the two ways this detector duplicates a
    room are both *nested* rather than overlapping:

    * a seat cushion detected inside the seat that contains it, and
    * one huge box over an entire wall of wardrobes, alongside the individual
      units it spans.

    Neither scores a high IoU - a small box inside a much larger one has a
    small intersection over a large union - so nesting is tested separately as
    intersection over the *smaller* area.
    """
    kept: list[Detection] = []
    for det in sorted(detections, key=lambda d: d.score, reverse=True):
        redundant = any(
            _iou(det, other) >= iou_threshold
            or _containment(det, other) >= containment_threshold
            for other in kept
        )
        if not redundant:
            kept.append(det)
    return kept


def load_model(device: str, model_id: str = MODEL_ID):
    """Load and cache the detector. ~700 MB on first call."""
    key = f"{model_id}@{device}"
    if key not in _cache:
        import torch
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

        processor = AutoProcessor.from_pretrained(model_id)
        model = AutoModelForZeroShotObjectDetection.from_pretrained(model_id).to(device)
        model.eval()
        _cache[key] = (processor, model, torch)
    return _cache[key]


def detect(
    image: Image.Image,
    labels: list[str] | None = None,
    *,
    device: str = "cpu",
    threshold: float = 0.30,
    text_threshold: float = 0.25,
    min_area_ratio: float = 0.004,
    model_id: str = MODEL_ID,
) -> list[Detection]:
    """Detect `labels` in `image` and return deduplicated boxes."""
    labels = labels or DEFAULT_LABELS
    processor, model, torch = load_model(device, model_id)

    # GroundingDINO expects lowercase phrases separated by full stops.
    prompt = ". ".join(label.lower().strip(" .") for label in labels) + "."

    image = image.convert("RGB")
    inputs = processor(images=image, text=prompt, return_tensors="pt").to(device)
    with torch.no_grad():
        outputs = model(**inputs)

    results = processor.post_process_grounded_object_detection(
        outputs,
        inputs["input_ids"],
        threshold=threshold,
        text_threshold=text_threshold,
        target_sizes=[image.size[::-1]],   # (height, width)
    )[0]

    # transformers >=4.51 moved the matched phrases to `text_labels` and makes
    # `labels` emit a deprecation warning on access, so this must test for the
    # key rather than passing results["labels"] as a default to .get().
    names = results["text_labels"] if "text_labels" in results else results["labels"]

    frame_area = float(image.width * image.height)
    detections = []
    for score, name, box in zip(results["scores"], names, results["boxes"]):
        det = Detection(
            label=str(name).strip() or "object",
            score=float(score),
            box=tuple(float(v) for v in box.tolist()),
        )
        # Speckle rejection. A box under ~0.4% of the frame is a cushion or a
        # doorknob; reconstructing it costs as much as reconstructing the bed
        # and contributes nothing a viewer would notice.
        if det.area / frame_area >= min_area_ratio:
            detections.append(det)

    return deduplicate(detections)


def unique_names(detections: list[Detection]) -> list[str]:
    """Assign a unique, spec-safe name to each detection.

    SceneSpec rejects duplicate names outright, and three chairs in one room is
    the normal case rather than the exception.
    """
    counts: dict[str, int] = {}
    names = []
    for det in detections:
        base = det.label.lower().replace(" ", "_") or "object"
        counts[base] = counts.get(base, 0) + 1
        names.append(base if counts[base] == 1 else f"{base}_{counts[base]}")
    return names


def crop(
    image: Image.Image,
    detection: Detection,
    out_path: Path,
    *,
    padding: float = 0.06,
) -> Path:
    """Write a padded crop of one detection.

    The padding matters: rembg runs on this crop later, and a box cut exactly
    at the silhouette gives it no background to key against, which tends to
    eat the object's own edges.
    """
    x0, y0, x1, y1 = detection.box
    pad_x = (x1 - x0) * padding
    pad_y = (y1 - y0) * padding
    box = (
        max(0, int(x0 - pad_x)),
        max(0, int(y0 - pad_y)),
        min(image.width, int(x1 + pad_x)),
        min(image.height, int(y1 + pad_y)),
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").crop(box).save(out_path)
    return out_path


def segment(
    image_path: Path,
    out_dir: Path,
    labels: list[str] | None = None,
    *,
    device: str = "cpu",
    threshold: float = 0.30,
    padding: float = 0.06,
) -> list[tuple[Detection, str, Path]]:
    """Detect and crop every object. Returns (detection, name, crop path)."""
    image = Image.open(image_path)
    detections = detect(image, labels, device=device, threshold=threshold)
    names = unique_names(detections)

    results = []
    for det, name in zip(detections, names):
        path = crop(image, det, Path(out_dir) / f"{name}.png", padding=padding)
        results.append((det, name, path))
    return results
