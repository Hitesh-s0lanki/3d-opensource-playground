# Hunyuan3D-2.1 on Modal

The good model, on a rented GPU, driven from this laptop.

[hunyuan3d.py](hunyuan3d.py) is a complete [Modal](https://modal.com) app: it builds a
CUDA image containing Hunyuan3D-2.1 and its two compiled extensions, caches the weights in
a Volume, and exposes one method that takes image bytes and returns a `.glb`. Your machine
only ever holds the input and the output.

```
photos/chair.png                     scripts/modal_app/hunyuan3d.py
       |                                     |
       |  modal run --image photos/chair.png |
       +-------------------------------------+
                                             v
                            +--------------------------------+
                            |  Modal container, L40S (48 GB) |
                            |                                |
                            |  rembg  ->  Hunyuan3D-Shape    |
                            |               |                |
                            |             shape.glb          |
                            |               |                |
                            |             Hunyuan3D-Paint    |
                            |               |                |
                            |            textured.glb        |
                            +--------------------------------+
                                             |
                                    outputs/chair.glb
```

Why the directory is `modal_app` and not `modal`: a folder named `modal` shadows the `modal`
package on `sys.path` — `modal run` puts the script's own directory first, so every
`import modal` inside these files would resolve to the folder instead of the package.

## Setup

```powershell
.\.venv\Scripts\Activate.ps1
uv pip install -e ".[modal]"     # or: uv pip install modal
modal setup                      # opens a browser, writes ~/.modal.toml
```

`modal setup` is a one-time browser login. A new account gets **$30 of free credit a month**,
which is roughly 15 hours of L40S time — enough to build the image and generate a few dozen
objects without paying anything.

**HuggingFace: nothing to do.** `tencent/Hunyuan3D-2.1` and `facebook/dinov2-giant` are both
public and ungated — no account, no licence click, no token. The container downloads them
anonymously.

A token is still forwarded if you have one. `_hf_secret()` reads `HF_TOKEN` from your
environment, falling back to the project's `.env`, and passes it to the container as an
ephemeral secret; with no token it passes nothing and the run works the same. The only thing
a token buys here is a higher anonymous-download rate limit, which matters if you rebuild the
weight cache repeatedly.

## Use

```powershell
# Warm the weight cache on a cheap CPU container first (optional, recommended)
modal run scripts/modal_app/hunyuan3d.py::prefetch

# One image -> outputs/chair.glb
modal run scripts/modal_app/hunyuan3d.py --image photos/chair.png

# A whole folder, sequentially, on one warm container
modal run scripts/modal_app/hunyuan3d.py --image photos/

# Geometry only: skips the 21 GB paint pipeline, ~4x faster
modal run scripts/modal_app/hunyuan3d.py --image photos/chair.png --no-texture

# Coarser, cheaper geometry
modal run scripts/modal_app/hunyuan3d.py --image photos/bedroom.jpg --octree-resolution 256 --steps 30
```

Output lands in `outputs/<name>.glb`, the same place `dioramic-generate` writes, so
the viewer in `frontend/` picks it up with no extra step.

| Flag | Default | What it does |
| --- | --- | --- |
| `--image` | required | File, or a directory of images |
| `--out` | `outputs` | Local output directory |
| `--texture` / `--no-texture` | on | PBR texture pass. Off is much faster and needs 10 GB instead of 29 |
| `--steps` | 50 | Shape diffusion steps |
| `--guidance-scale` | 5.0 | Higher tracks the image more literally |
| `--octree-resolution` | 384 | Geometry detail. 256 is noticeably cheaper |
| `--seed` | 42 | Same seed + same image = same mesh |
| `--max-num-view` | 6 | Views the texture pass bakes from, 6-9 |
| `--view-resolution` | 512 | Multiview render size, 512 or 768 |
| `--no-remove-background` | off | Skip rembg. Only for images that are already cut out |

## Calling the deployed app

[call.py](call.py) looks the deployed class up by name and calls it, instead of the
throwaway app `modal run` creates per invocation. Deploy once, then call it as often as
you like:

```powershell
modal deploy scripts/modal_app/hunyuan3d.py
python scripts/modal_app/call.py --image photos/chair.png
```

It writes to `outputs/<stem>.glb` like every other generator, so the viewer treats what
comes back as an ordinary run. The removed Python viewer had a **Cloud GPU** button that
ran exactly this command; `frontend/` has no equivalent yet, so cloud runs are a
command-line step for now.

`modal run` builds a throwaway app per invocation; a deployed app is looked up by name and
already exists. It saves seconds, not money — the GPU time is identical.

**Each job is a fresh interpreter.** The viewer spawns the venv's Python per job rather
than importing the pipeline, so an edit under `src/` or to `call.py` takes effect on the
next run you start — but never mid-job: a job already running keeps the code it started
with for its full duration.

## What it actually costs

Measured on this project, L40S, `tencent/Hunyuan3D-2.1`:

| | Time | Notes |
| --- | --- | --- |
| Image build | ~5 min of compute | One-off, content-cached. Budget an afternoon of *wall clock* the first time - see "index rot" below |
| Weight download | ~8 min | ~30 GB into the Volume. Needs `hf_xet` and real CPU, see troubleshooting |
| Cold start | ~60 s | Shape pipeline from Volume onto GPU |
| Shape only, cold | **87 s** | 336 k verts, 1.24 M faces, octree 384 |
| Shape only, warm | **53 s** | octree 256, 30 steps |
| Shape + PBR texture | **104 s** | 2048² base colour + metallic-roughness |

The texture pass remeshes before UV unwrapping, so a textured mesh comes back with *fewer*
faces than a raw one (40 k vs 1.24 M) and a smaller file despite carrying two 2048² maps.
That is upstream's `remesh_mesh`, not a downgrade.

Only the container is billed, and only while it is up. At L40S rates (**$0.000542/s, about
$1.95/hour**) a textured object is roughly 6 cents. `A100-80GB` is $2.50/hour and `H100`
$3.95/hour; the app asks for them in that order and takes whichever is free.

The container stays alive for `scaledown_window` (2 minutes) after the last call. That idle
time is billed: two minutes of idle L40S costs about as much as the cold start it saves, so
it is set at roughly the break-even point for click-wait-look use. Raise it if you batch.

## Operating it

```powershell
modal app list                              # what is running
modal app logs dioramic-hunyuan3d         # live logs
modal volume ls hunyuan3d-cache             # what is cached
modal volume rm -r hunyuan3d-cache /huggingface   # force a re-download
```

The Modal dashboard shows the build log line by line, which is where to look when a
container fails during image build rather than at runtime.

## Troubleshooting

Every one of these was hit while getting this working. They are written down because the
error each produces points somewhere other than the cause.

**`Runner heartbeat timeout: 900 seconds` during the weight download.** Not a slow download -
a wedged container. The repo is Xet-backed, and without `hf_xet` huggingface_hub falls back
to one single-stream HTTP GET for a 7.4 GB checkpoint. On Modal's default 0.125 CPU cores,
TLS for that starves the heartbeat thread until Modal reaps the container as dead. Fixed by
installing `hf_xet` and giving `prefetch` `cpu=4.0`. If you write a new download function,
give it CPU.

**`No matching distribution found for nvidia-cudnn-cu12==9.1.0.70`.** `pypi.nvidia.com`
deleted the version torch 2.5.1 pins. PyPI still has it, which is why the torch install
pins `index_url="https://pypi.org/simple"` instead of the pytorch cu124 index.

**`No matching distribution found for bpy==4.0`.** That release was pulled from PyPI and no
surviving version ships a cp310 wheel. This is why the image is Python **3.11** and rewrites
the pin to `bpy==4.2.0` - `convert_obj_to_glb` imports bpy, so there is no texture pass
without it.

**`command 'clang++' failed: No such file or directory`** while building `custom_rasterizer`,
*after* nvcc has already compiled everything. Modal's `add_python` is python-build-standalone,
compiled with clang, so sysconfig hands setuptools `clang++` as the extension linker. The
image has gcc. Hence the `CC`/`CXX`/`LDSHARED`/`LDCXXSHARED` overrides on that step. Upstream
never sees this - their conda Python is a gcc build.

**`ModuleNotFoundError: No module named 'torch'`** while building `custom_rasterizer`. Its
`setup.py` imports torch at module scope, and PEP 517 builds in an isolated environment that
has none. Hence `--no-build-isolation`.

**CUDA OOM in the texture pass.** Drop `--view-resolution` to 512 and `--max-num-view` to 6
(the defaults), or pin `GPU = "A100-80GB"` in [hunyuan3d.py](hunyuan3d.py).

**A one-line fix re-runs the ten-minute requirements install.** Modal caches per
`run_commands()` call, not per command inside it. Keep expensive steps in their own call -
that is why `custom_rasterizer` has a layer to itself.

## Turning it into a service

`modal run` is ephemeral — the app exists for the length of the command. To keep it
addressable:

```powershell
modal deploy scripts/modal_app/hunyuan3d.py
```

Then call it from any Python process, including the `dioramic` CLI:

```python
import modal

Hunyuan3D = modal.Cls.from_name("dioramic-hunyuan3d", "Hunyuan3D")
glb = Hunyuan3D().generate.remote(image_bytes, texture=True)
```

For a deployed app, replace the ephemeral `modal.Secret.from_dict(...)` in `_hf_secret()`
with a named secret so the token is not baked into the deployment:

```powershell
modal secret create huggingface-secret HF_TOKEN=hf_...
```

## Where the recipe comes from

The image mirrors upstream's own
[docker/Dockerfile](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/main/docker/Dockerfile)
and the pipeline call mirrors
[demo.py](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/main/demo.py). It deviates in
the places below, each commented at the point of departure in [hunyuan3d.py](hunyuan3d.py).

Forced by the environment having moved since upstream was written:

- **Python 3.11, not 3.10**, and `bpy==4.2.0`, not `4.0` - that release no longer exists.
- **torch from PyPI**, not the pytorch cu124 index, which can no longer resolve the cudnn
  version torch 2.5.1 pins. Same wheel, same CUDA 12.4 dependency set, minus the `+cu124` tag.
- **gcc forced for the extension link**, because Modal's Python is a clang build.
- **`--no-build-isolation`** for `custom_rasterizer`, whose `setup.py` imports torch.
- **basicsr patched** for the `functional_tensor` import torchvision dropped in 0.17. Located
  via `sysconfig`, not `import basicsr` - importing it raises the error being patched.

Chosen:

- **No conda.** Upstream installs Miniconda to get its Python; `add_python` already provides
  one, and skipping conda takes tens of GB off the image.
- **`compile_mesh_painter.sh` is inlined.** It asks `python3-config` for the extension suffix,
  which answers for the system Python rather than the one Modal installed. The inlined
  version asks `sysconfig` instead.
- **Absolute config paths.** `Hunyuan3DPaintConfig` resolves its paths against two different
  directories; absolutes remove the ambiguity.
- **The texture output is named `.obj`.** The pipeline writes that path, then writes a second
  file with `.obj` replaced by `.glb`. `demo.py` passes a `.glb` and so converts the file to
  itself; passing `.obj` is what makes the GLB come out.
- **Background removal tests the alpha channel.** `demo.py` checks `mode == 'RGB'` one line
  after `convert("RGBA")`, so its rembg call is unreachable.

Upstream's licence is the **Tencent Hunyuan Non-Commercial License**. Renting the GPU does
not change what you are allowed to do with the output.
