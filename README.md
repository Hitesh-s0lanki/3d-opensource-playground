# dreamspace

Turn a photo into 3D — a single object, or a whole room — running locally on Windows.

Built around the constraints of this machine: **RTX 3050 Laptop, 4 GB VRAM, no CUDA Toolkit installed.**

Deeper notes live in [docs/](docs/): [architecture](docs/architecture.md) ·
[status](docs/status.md) · [testing](docs/testing.md) ·
[decisions](docs/decisions.md) · [roadmap](docs/roadmap.md) ·
[model landscape](docs/models.md)

## Setup

```powershell
.\setup.ps1
.\.venv\Scripts\Activate.ps1
dreamspace-generate --doctor
```

`setup.ps1` installs `uv` if missing, creates `.venv` on Python 3.10, installs CUDA-enabled torch from the PyTorch index, installs `requirements.txt`, installs this package in editable mode, copies `.env.example` → `.env`, and runs a self-check.

Room assembly also needs **Blender**. Point `BLENDER_EXE` in `.env` at `blender.exe`, or put it on PATH. `--doctor` reports whether it was found; a missing Blender only disables room assembly, not single-object generation.

## The two pipelines

### A whole room, from one photo

```powershell
dreamspace-room --image inputs\bedroom.jpg
dreamspace-room --image inputs\bedroom.jpg --labels "bed,wardrobe,lamp" --decimate 0.2
```

```
detect  ->  reconstruct  ->  layout  ->  assemble
GroundingDINO   TripoSR      camera model    Blender
                per object   + size priors   -> one .glb
```

Intermediates live in `outputs/<name>/` — `crops/`, `objects/`, and `scene.json`. A re-run reuses existing meshes, so tuning the layout does not pay for reconstruction again. `--regenerate` forces a rebuild.

### One object, from one image

```powershell
dreamspace-generate --image inputs\chair.png
dreamspace-generate --image inputs\                    # a whole folder
dreamspace-generate --image inputs\ --no-texture       # much lighter
dreamspace-generate --image inputs\chair.png --chunk-size 2048 --mc-resolution 192
```

Output lands in `outputs/` as `<name>.glb`. Every flag defaults to the matching key in `.env`; `--help` lists them all.

### Assembling by hand

`scene.json` is plain, millimetre-rounded JSON meant to be edited. Adjust it and rebuild without re-running any model:

```powershell
dreamspace-assemble --spec outputs\bedroom\scene.json --decimate 0.2
```

See [examples/room-demo.json](examples/room-demo.json) for a hand-written one.

### Viewing

```powershell
dreamspace-view          # serves outputs/ at http://localhost:8000
```

A three.js inspector organised around **runs**, not files. One room job scatters itself across four places — the photo in `inputs/`, crops and per-object meshes under `outputs/<name>/`, the placement in `scene.json`, the finished GLB at `outputs/<name>.glb` — and the viewer walks that naming convention back into one thing:

```
sidebar          stage                       detail
────────┬───────────────────────────┬──────────────────────
runs    │  the mesh, in 3D          │  the photo it came
        │                           │  from, boxes drawn on
        ├───────────────────────────┤  it
        │  pipeline strip:          │
        │  photo → crops → scene    │  the crop, the mesh
        │                           │  stats, the placement
```

Click any object in the strip — or any box drawn on the photo — and the whole right-hand column becomes that one object's story: **which patch of the photograph** produced it, **the crop** that was fed to the reconstructor, **the mesh** that came back (triangles, materials, bounding box in metres), and **where it was placed** (position, target size, rotation). That is the end-to-end trace for a single result.

Runs come in four shapes, and the viewer labels which one it is looking at:

| kind | what it is |
|---|---|
| `room` | `dreamspace-room`: photo → crops → meshes → assembled scene |
| `scene` | a `scene.json` beside its GLB — usually hand-written or re-assembled |
| `object` | `dreamspace-generate`: one image → one mesh |
| `images` | crops with no scene.json, from a run that did not finish |

Things it deliberately surfaces rather than hides: objects that were **detected and reconstructed but never placed** (a mesh under 200 faces is dropped — see `is_usable`), and objects that **skipped reconstruction entirely** because they are flat and became textured panels.

| key | |
|---|---|
| `F` | fit the camera to the model |
| `W` | wireframe |
| `G` | 1 m ground grid (0.25 m / 0.1 m for smaller objects) |
| `B` | bounding box |
| `E` | pale backdrop, for meshes too dark to read against black |
| `R` | spin |
| `↑` `↓` | previous / next object in the run |

Drop a `.glb` from anywhere onto the viewport to inspect it without restarting. New runs appear on their own — no refresh needed.

#### Generating from the viewer

The page can start runs, not just look at them. **+ New** (or dropping an image onto the viewport) opens a small form: the image, **Single object** or **Whole room**, and the flags that matter for each — marching-cubes resolution and texture mode for objects; field of view, detection threshold, walls, decimation and a label list for rooms. A wide image preselects *Whole room*, since that is what wide usually means.

The upload is saved into `inputs/` under a sanitised name and the viewer then runs the command you would have typed — `dreamspace-generate` or `dreamspace-room` — as a subprocess, streaming its output into a job card with the current stage (`2/4 reconstruct`) and a **Stop** button. When it finishes, the new run appears at the top of the list and opens itself.

Jobs run **one at a time**. Two concurrent TripoSR runs do not fail politely on a 4 GB card, they OOM in the middle of whichever was further along, and queueing costs nothing when the bottleneck is one GPU either way.

The server binds to `127.0.0.1` only, which matters more once a POST to it starts a subprocess. Uploads are capped at 40 MB, must carry an image extension, and are stripped to a bare filename so nothing can be written outside `inputs/`. Use `--no-generate` for a browse-only server.

**Where the boxes on the photo come from.** Runs made from now on record each detection — its pixel box, its label and the detector's confidence — into `scene.json` under `source`. Runs made before that have none, so for those the viewer recovers the rectangle by matching each crop back into the photo: `segment.crop` writes an exact, unresampled sub-rectangle, which makes it a template match with one right answer rather than a similarity search. The result is cached in `outputs/<name>/.provenance.json`, and the caption says which of the two you are looking at.

It runs a server rather than opening an HTML file because browsers block a `file://` page from fetching a local `.glb` cross-origin — double-clicking an HTML file gives you an empty viewport. The three.js modules come from a CDN, so the first load needs a network connection.

Other options: drag a `.glb` onto [gltf-viewer.donmccurdy.com](https://gltf-viewer.donmccurdy.com), the **glTF Tools** VS Code extension, Windows **3D Viewer**, or Blender via `File → Import → glTF 2.0`.

## How the room pipeline decides where things go

A single photo has no depth, so two assumptions supply it.

**Furniture has known real-world sizes.** [`SIZE_PRIORS`](src/dreamspace/scene/layout.py) says a double bed is about 2.0 × 1.6 m. Without that, every mesh would stay in the unit cube it was generated in — an image-to-3D model has no idea whether it made a lamp or a wardrobe.

**Depth comes from apparent height.** An object of known height spanning *h* pixels sits at `focal × real_height / h`. Height is used rather than the bottom edge of the detection box for two reasons: projected height does not change as an object turns, and it survives occlusion of the base. In the sample bedroom the wardrobe stands behind the bed, so its box bottom is where the duvet begins — treating that as a floor contact put it 13 m away.

**The assumed field of view sets the scale of everything.** Interior renders use wide lenses. Measured on the sample bedroom, 62° (a normal photographic default) put the wardrobe at 6.9 m and produced a 9 × 10 m "bedroom"; 85° puts it at 4.5 m. If a room comes out too large, raise `--fov`.

Walls are generated, never reconstructed: a room is a handful of boxes, and generating them gives exact right angles, flat faces, correct normals and a couple of kilobytes, where reconstruction gives wavy holed geometry and megabytes.

**Only two walls are built by default.** A closed box is correct and also useless — a viewer orbiting outside it sees six blank faces and nothing of the room. `--walls auto` keeps the far wall plus whichever side wall actually holds artwork, so pictures have somewhere to hang. `--walls all` closes the box, `--walls none` gives furniture only, or name them explicitly: `--walls "-x,+y"`.

**Flat things are built as textured quads, not reconstructed.** Ask an image-to-3D model for a painting and it returns a volumetric blob; uniform-fitting that blob into a 5 cm-deep target collapses the whole thing, which is how a 0.9 m painting once came out 6 cm across. A quad cut from the source crop is more faithful, weighs two triangles instead of twenty thousand, and skips reconstruction entirely. Applies to paintings, curtains, windows and mirrors — see `flat` in `SIZE_PRIORS`.

Reconstruction sometimes fails silently rather than erroring: a wide, shallow crop can come back as a near-empty shell. Meshes under 200 faces are dropped and reported, because such an object still claims a place in the room while its degenerate bounding box makes placement arbitrary.

**Fitting allows a bounded amount of stretch.** A strictly uniform fit is bound by whichever axis reaches its target first, which is punishing when the mesh has the wrong proportions — and reconstructed furniture usually does. A nearly-cubic wardrobe blob came out 0.89 × 0.60 × 0.75 m against a 1.20 × 0.60 × 2.30 m target, because its depth pinned every other axis. `--max-stretch` (default 1.5) lets the other axes scale up to 1.5× the tightest one, never past their own target, capping distortion at 1.5:1 instead of leaving everything shrunk. `--max-stretch 1.0` restores the strictly uniform fit.

Known limits: object yaw is not estimated, side-wall items are centred along their wall since one view gives no depth cue there, and a badly mis-proportioned mesh still falls short of its target once it hits the stretch cap. The output is a plausible editable starting layout, not a measurement.

## Input images matter more than settings

`dreamspace-generate` is a **single-object** reconstructor — a whole-room photo produces garbage. Crop to one object, roughly centred, filling most of the frame. Background removal runs automatically (`rembg`).

`dreamspace-room` does that cropping for you, which is the entire point of the detect step.

## Four things this project works around

**No CUDA Toolkit.** TripoSR depends on `torchmcubes`, a CUDA extension compiled from source that needs `nvcc` — the driver's CUDA runtime is not enough. [compat.py](src/dreamspace/compat.py) satisfies the import with **PyMCubes**, which ships prebuilt wheels. torchmcubes is a GPU port of PyMCubes with the same signature and conventions, so it is a drop-in replacement. Marching cubes runs on CPU, which costs almost nothing next to the transformer forward pass and keeps the density grid off a 4 GB card.

**4 GB VRAM.** `CHUNK_SIZE` defaults to 4096 rather than upstream's 8192 (~6 GB). On a CUDA OOM the runner halves the chunk size and retries automatically, down to 512, rather than crashing.

**Inverted meshes.** TripoSR emits **inside-out** meshes. [isosurface.py:50](vendor/TripoSR/tsr/models/isosurface.py#L50) does `v_pos[..., [2, 1, 0]]`, swapping X and Z; swapping two axes is a reflection, which reverses triangle orientation. Verified here — signed volume was `-0.064` before the fix and `+0.064` after. `FLIP_FACES=true` is therefore the default.

**Meshes arrive in arbitrary orientations.** Nothing in a GLB says which way is up, and reconstruction does not produce a canonical one — `chair.glb` here comes out 1.07 × 0.60 × 0.57 m, lying on its side. Since the spec states real dimensions, those imply an orientation, so the assembler tries all six axis permutations and keeps whichever fills the target box best. Reflections are excluded, or asymmetric furniture would come out mirrored.

## Two Pythons

Blender bundles its own interpreter (3.13 here) which cannot see this venv (3.10), and never will. The pipeline therefore splits, joined by a file:

```
dreamspace (venv) --writes--> scene.json --read by--> Blender (bpy)
```

Everything upstream of that JSON is testable without Blender; everything downstream is testable without a GPU. [scene/spec.py](src/dreamspace/scene/spec.py) defines the format — metres, Z up, floor at z=0 — and is the contract between them. Nothing under `scene/blender/` may import `dreamspace` or any third-party package.

## Moving to a bigger GPU

`MODEL_BACKEND=hunyuan3d` is implemented in [backends/hunyuan3d.py](src/dreamspace/backends/hunyuan3d.py) and produces substantially better output, but **cannot run here**: ~6 GB for geometry, ~16 GB with texture, plus two CUDA extensions that need the Toolkit. The backend refuses to load below 6 GB.

### Modal: rent the GPU per second, keep working here

[modal_app/](modal_app/) is a ready-to-run [Modal](https://modal.com) app for **Hunyuan3D-2.1** — the newer model, with PBR texture output. It builds the CUDA image, compiles both extensions, and caches ~30 GB of weights in a Volume, all on Modal's side. This machine sends an image and receives a `.glb`:

```powershell
uv pip install -e ".[modal]"
modal setup                                        # one-time browser login
modal run modal_app/hunyuan3d.py::prefetch         # warm the weight cache (optional)
modal run modal_app/hunyuan3d.py --image inputs\chair.png
```

Output lands in `outputs/` like any other run, so `dreamspace-view` picks it up unchanged. The first `modal run` builds the image (20–40 min, cached afterwards); a warm container turns an image into a textured mesh in 3–6 minutes for roughly 10–20 cents. A new Modal account gets $30 of free credit a month. Setup, flags, costs and troubleshooting: **[modal_app/README.md](modal_app/README.md)**.

No HuggingFace account is needed: `tencent/Hunyuan3D-2.1` is public and the container downloads it anonymously. `HF_TOKEN` in `.env` is forwarded if present, but only raises the download rate limit.

### Or a plain rented box

On a rented GPU (RunPod/Vast, ~$0.30–0.50/hr for a 4090), with the 2.0 backend in `src/`:

```bash
git clone <this project> && cd 3d
uv venv --python 3.10 && source .venv/bin/activate
uv pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
uv pip install -r requirements.txt && uv pip install -e . --no-deps
cd vendor/Hunyuan3D-2/hy3dgen/texgen/custom_rasterizer      && python setup.py install
cd ../differentiable_renderer                               && python setup.py install
MODEL_BACKEND=hunyuan3d dreamspace-room --image inputs/bedroom.jpg --jobs 4
```

`--jobs` is only useful there. Each worker loads its own copy of the model, so parallel reconstruction needs roughly 10 GB before it beats the sequential path — which loads the weights once and reuses them.

## Layout

```
pyproject.toml          package metadata, console scripts
requirements.txt        deps (torch comes from the PyTorch index, see setup.ps1)
setup.ps1               uv bootstrap
.env.example            all tunables, documented
examples/               hand-written scene specs
src/dreamspace/
  config.py             .env -> Config, CLI override, device and Blender resolution
  compat.py             torchmcubes -> PyMCubes shim
  preprocess.py         rembg cutout, square padding
  cli/
    generate.py         dreamspace-generate  (one image -> one mesh)
    room.py             dreamspace-room      (one photo -> one scene)
    assemble.py         dreamspace-assemble  (scene.json -> one GLB)
    view.py             dreamspace-view      (browser inspector)
    runs.py             walks outputs/ back into runs, recovers crop boxes
    jobs.py             uploads -> inputs/, runs the CLIs, streams their output
    viewer/index.html   the inspector page itself
  backends/
    base.py             Backend ABC + registry + vendor cloning
    triposr.py          runs on 4 GB
    hunyuan3d.py        cloud GPU only
  scene/
    spec.py             the SceneSpec JSON contract
    segment.py          GroundingDINO detection + cropping
    layout.py           camera model, size priors, placement
    room.py             the four-stage orchestrator
    assemble.py         drives Blender as a subprocess
    blender/
      build_scene.py    runs INSIDE Blender: walls, import, fit, export
modal_app/
  hunyuan3d.py          Hunyuan3D-2.1 on a rented Modal GPU: image, weight volume, entrypoint
  README.md             setup, flags, costs, troubleshooting
vendor/                 upstream repos, cloned on first run (gitignored)
```

`vendor/` exists because these projects ship as repositories, not installable packages — there is no `setup.py` to pip-install. The first run clones TripoSR there automatically.
