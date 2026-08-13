# Architecture

## The pipeline

```
bedroom.jpg
    │
    │  1. detect      scene/segment.py      GroundingDINO
    ▼                 open-vocabulary boxes -> padded crops
crops/*.png
    │
    │  2. reconstruct backends/triposr.py   one mesh per crop
    ▼                 flat items skip this entirely
objects/*.glb
    │
    │  3. layout      scene/layout.py       camera model + size priors
    ▼                 -> positions in metres
scene.json
    │
    │  4. assemble    scene/blender/build_scene.py
    ▼                 walls, fit, place, export
bedroom.glb
```

Each stage is independently runnable. `dreamspace-generate` is stage 2 alone;
`dreamspace-assemble` is stage 4 alone. `dreamspace-room` chains all four.

## The two-interpreter split

This is the constraint that shapes everything else.

Blender bundles its own Python — **3.13** in the build used here — and it
cannot import from the project venv, which is on **3.10**. There is no version
of this project where `import bpy` works in the venv, or where `import torch`
works inside Blender.

So the pipeline splits, joined by a file:

```
dreamspace (venv 3.10) ──writes──> scene.json ──read by──> Blender (bpy 3.13)
       torch, transformers                            geometry, glTF export
```

Consequences worth knowing:

- **`scene/spec.py` is the contract**, not an implementation detail. The
  *format* is what both sides agree on; the Blender side re-reads the same
  JSON with its own parser and must never import `dreamspace`.
- **Nothing under `scene/blender/` may import a third-party package.** Standard
  library and `bpy` only.
- **Everything upstream of the JSON is testable without Blender**, and
  everything downstream is testable without a GPU. That is why
  [testing.md](testing.md) has two separate entry points.
- Blender is launched with `--factory-startup` so a broken user add-on cannot
  fail a headless build.
- **Blender exits 0 even when an embedded script raises.** The driver therefore
  requires a sentinel line *and* the output file before believing a build
  succeeded — exit status alone proves nothing.

## Conventions

Fixed once in `scene/spec.py` so nothing downstream has to guess:

| | |
|---|---|
| Units | metres |
| Up axis | +Z (Blender's). glTF is Y-up; its exporter converts on the way out |
| Floor | the interior floor surface is z = 0 |
| `position` | centre in x/y, **base** in z — so a bed at `(0, 1.2, 0)` rests on the floor |
| `rotation_z` | degrees, counter-clockwise from above. Yaw only |
| `size` | the object's **own** bounding box, before yaw |

That last row matters when reading verification output: a yawed object has a
larger world-axis-aligned box than its `size`, by `w·|cos θ| + d·|sin θ|`.

## Where each decision lives

| Question | Answered in |
|---|---|
| What objects are in the picture? | `scene/segment.py` |
| How big is a wardrobe, really? | `SIZE_PRIORS` in `scene/layout.py` |
| How far away is it? | `depth_from_height()` + `Camera` in `scene/layout.py` |
| Which wall does a painting hang on? | `_choose_wall()` in `scene/layout.py` |
| Which way is up for this mesh? | `best_orientation()` in `scene/blender/build_scene.py` |
| How big should it end up? | the fit block in `place_object()` |
| Should it be a mesh or a flat panel? | `Prior.flat` -> `ObjectSpec.kind` |
| Was the reconstruction any good? | `is_usable()` in `scene/room.py` |

## Extension points

**Adding a 3D backend** — subclass `Backend` in `backends/base.py`, decorate
with `@register`, implement `load()` and `generate()`. The registry, the vendor
cloning, and the OOM retry loop are already there. `--model <name>` picks it.

**Replacing layout estimation** — `estimate_layout()` returns a `SceneSpec`.
Anything that produces a valid `SceneSpec` can replace it (a depth model, a
panorama layout network, a hand-written JSON file) without touching assembly.

**Replacing assembly** — `scene/blender/build_scene.py` reads `scene.json` and
writes a GLB. Any tool that does the same is a drop-in swap.
