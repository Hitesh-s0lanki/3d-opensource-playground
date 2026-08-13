"""Hunyuan3D-2.1 on a rented Modal GPU.

This machine has 4 GB of VRAM. Hunyuan3D-2.1 wants 10 GB for shape, 21 GB for
texture, 29 GB for both, and compiles two CUDA extensions against the full
Toolkit - none of which is going to happen on an RTX 3050 with no nvcc. Modal
rents the GPU by the second and builds those extensions once, inside the image,
so nothing here has to exist on Windows.

    pip install modal
    modal setup
    modal run modal_app/hunyuan3d.py --image inputs/chair.png

The first run builds the image (20-40 min, once) and pulls ~30 GB of weights
into a Volume (once, or ahead of time via `::prefetch`). After that a call is a
cold start of about a minute, and a warm container answers immediately.

Everything below mirrors upstream's own docker/Dockerfile and demo.py. Where it
deviates, the comment says why.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import modal

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
APP_NAME = "dreamspace-hunyuan3d"

REPO_URL = "https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1.git"
REPO_DIR = "/opt/Hunyuan3D-2.1"
MODEL_REPO = "tencent/Hunyuan3D-2.1"
DINO_REPO = "facebook/dinov2-giant"  # the paint pipeline's image encoder

CACHE_DIR = "/cache"

# 12.4 matches the torch cu124 wheels upstream pins. Modal's host driver is
# newer, and a container CUDA no greater than the host's is the requirement, so
# 12.4 is safe. `devel` rather than `runtime` because custom_rasterizer needs
# nvcc at build time.
CUDA_TAG = "12.4.1-devel-ubuntu22.04"
# Upstream builds on 3.10. bpy has since been pruned from PyPI - 4.0 is gone
# entirely and nothing left ships a cp310 wheel - and the oldest survivor, 4.2.0,
# is marked `requires_python == 3.11.*`. Since convert_obj_to_glb imports bpy,
# the texture pass does not work without it, so 3.11 it is. Every other pin
# (pymeshlab, open3d, numpy 1.24.4, onnxruntime, cupy, xatlas) has a cp311 wheel,
# which is what makes this a version bump rather than a rewrite of the pin set.
PYTHON_VERSION = "3.11"

# Upstream lists 6.0 through 9.0. Trimmed to the architectures Modal actually
# rents, because every extra arch is another full nvcc pass over the extension.
# T4=7.5, A100=8.0, A10=8.6, L4/L40S=8.9, H100/H200=9.0.
TORCH_CUDA_ARCH_LIST = "7.5;8.0;8.6;8.9;9.0"

# A list is a fallback chain, not a multi-GPU request: Modal takes the first one
# available. L40S (48 GB) fits the full 29 GB pipeline and is the cheapest thing
# that does; the other two are there so a busy region does not mean a failed run.
GPU = ["L40S", "A100-80GB", "H100"]

MINUTES = 60

# ---------------------------------------------------------------------------
# Image
# ---------------------------------------------------------------------------
# basicsr 1.4.2 imports torchvision.transforms.functional_tensor, which
# torchvision dropped in 0.17. Upstream ships torchvision_fix.py to monkeypatch
# it at runtime; patching the installed file too means the import works even if
# something imports basicsr before the fix is applied.
# The file is located through sysconfig rather than `import basicsr`, because
# importing basicsr runs basicsr/data/__init__.py, which imports degradations.py,
# which raises the very ModuleNotFoundError being patched. The package cannot be
# loaded in order to repair itself.
_PATCH_BASICSR = (
    'python -c "'
    "import sysconfig, pathlib; "
    "p = pathlib.Path(sysconfig.get_paths()['purelib']) / 'basicsr' / 'data' / 'degradations.py'; "
    "p.write_text(p.read_text().replace("
    "'torchvision.transforms.functional_tensor', "
    "'torchvision.transforms.functional'))"
    '"'
)

# compile_mesh_painter.sh verbatim, except that it asks python3-config for the
# extension suffix. That binary belongs to the system python, not to the
# interpreter Modal installs via add_python, so it either is missing or answers
# for the wrong ABI. sysconfig gives the same answer from the right interpreter.
_COMPILE_RENDERER = (
    f"cd {REPO_DIR}/hy3dpaint/DifferentiableRenderer && "
    "c++ -O3 -Wall -shared -std=c++11 -fPIC "
    "$(python -m pybind11 --includes) mesh_inpaint_processor.cpp "
    "-o mesh_inpaint_processor"
    "$(python -c \"import sysconfig; print(sysconfig.get_config_var('EXT_SUFFIX'))\")"
)
# No apt python3.x-dev to back this up, deliberately. Modal's add_python ships
# its own headers (/usr/local/include/python3.11/Python.h) and a pybind11 module
# compiles against them cleanly - verified before this build. Jammy's
# python3.11-dev, the obvious fallback, is 3.11.0~rc1: a release candidate, and a
# worse thing to compile against than no fallback at all.

image = (
    modal.Image.from_registry(f"nvidia/cuda:{CUDA_TAG}", add_python=PYTHON_VERSION)
    # The CUDA image sets its own ENTRYPOINT, which would run instead of Modal's
    # container agent. Clearing it is required for any from_registry CUDA base.
    .entrypoint([])
    .apt_install(
        "git",
        "wget",
        "build-essential",
        "cmake",
        "pkg-config",
        "ninja-build",
        # custom_rasterizer / mesh_inpaint_processor
        "libeigen3-dev",
        "libcgal-dev",
        # EGL offscreen rendering for the differentiable renderer
        "libglvnd0",
        "libglvnd-dev",
        "libgl1",
        "libglx0",
        "libegl1",
        "libgles2",
        "libgl1-mesa-dev",
        "libegl1-mesa-dev",
        "libgles2-mesa-dev",
        # bpy 4.0 links against these even when it never opens a window;
        # convert_obj_to_glb imports bpy, so a headless run still needs them.
        "libglib2.0-0",
        "libsm6",
        "libxext6",
        "libxrender1",
        "libxi6",
        "libxfixes3",
        "libxxf86vm1",
        "libxkbcommon-x11-0",
    )
    .env(
        {
            "CUDA_HOME": "/usr/local/cuda",
            "TORCH_CUDA_ARCH_LIST": TORCH_CUDA_ARCH_LIST,
            # Force headless EGL; there is no X server in a Modal container.
            "PYOPENGL_PLATFORM": "egl",
            "PYTHONUNBUFFERED": "1",
            # Weights land in the Volume mounted at /cache, so a container that
            # dies mid-download does not cost the download again.
            "HF_HOME": f"{CACHE_DIR}/huggingface",
            "U2NET_HOME": f"{CACHE_DIR}/u2net",  # rembg's own cache
            "HF_HUB_ENABLE_HF_TRANSFER": "1",
        }
    )
    # Upstream installs these from download.pytorch.org/whl/cu124. That index
    # resolves the nvidia-* dependencies against pypi.nvidia.com, which has since
    # deleted nvidia-cudnn-cu12 9.1.0.70 - the exact version torch 2.5.1 pins - so
    # the build now dies with "No matching distribution found". PyPI still carries
    # it, and PyPI's torch 2.5.1 declares the same CUDA 12.4 dependency set
    # (nvrtc/runtime/cupti/cublas 12.4.127), so it is the same build without the
    # +cu124 local tag. Pinning the index here rather than leaving it to Modal's
    # default mirror keeps the resolution somewhere we can actually verify.
    .pip_install(
        "torch==2.5.1",
        "torchvision==0.20.1",
        "torchaudio==2.5.1",
        index_url="https://pypi.org/simple",
    )
    .pip_install("hf_transfer==0.1.8")
    .run_commands(
        f"git clone --depth 1 {REPO_URL} {REPO_DIR}",
        # numpy and the build tools go in first. basicsr and pymeshlab compile
        # against whatever numpy is present at build time, and letting pip pick
        # the order has them building against a 2.x that requirements.txt then
        # downgrades - which produces an ABI mismatch that only shows up at
        # import time, on the GPU, ten minutes into a run.
        "pip install numpy==1.24.4 ninja==1.11.1.1 pybind11==2.13.4",
        # requirements.txt carries two Chinese PyPI mirrors as extra indexes.
        # From a US datacenter they are slow and occasionally serve different
        # builds than pypi.org, so they come out.
        f"sed -i '/extra-index-url/d' {REPO_DIR}/requirements.txt",
        # bpy==4.0 no longer exists on PyPI - the release was pulled, and the
        # oldest one still published is 4.2.0. Nothing to weigh here: it is the
        # nearest available version, and the alternative is no texture pass,
        # since convert_obj_to_glb imports bpy at module scope.
        f"sed -i 's/^bpy==.*/bpy==4.2.0/' {REPO_DIR}/requirements.txt",
        f"pip install -r {REPO_DIR}/requirements.txt",
        _PATCH_BASICSR,
    )
    # custom_rasterizer gets a layer to itself. It is the long pole of the build -
    # nvcc over five architectures - and everything after it takes seconds, so
    # sharing a layer would mean a typo in the wget URL re-running the compile.
    .run_commands(
        # --no-build-isolation is the whole point here. setup.py does `import
        # torch` at module scope to reach CUDAExtension, and a PEP 517 build runs
        # in a fresh environment that has only setuptools in it - so the isolated
        # build dies on that import before it compiles a single file. The ambient
        # environment is the one with torch installed.
        "pip install -q setuptools wheel",
        # nvcc lives here; the base image puts it on PATH but an explicit export
        # means this step does not depend on that being preserved.
        f"cd {REPO_DIR}/hy3dpaint/custom_rasterizer && "
        f"export PATH=/usr/local/cuda/bin:$PATH && "
        f'export CUDA_NVCC_FLAGS="-allow-unsupported-compiler" && '
        # python-build-standalone, which is what Modal's add_python installs, is
        # compiled with clang, so sysconfig hands setuptools clang++ as the linker
        # for extension modules. This image has gcc. nvcc compiles every .o fine
        # and then the link dies on a missing clang++. distutils lets the env
        # override each of those vars, which is far cheaper than apt-installing
        # clang - that would invalidate the apt layer and rebuild torch and the
        # whole requirements install sitting behind it. Upstream never sees this:
        # their conda Python is a gcc build.
        'export CC=gcc CXX=g++ LDSHARED="gcc -shared" LDCXXSHARED="g++ -shared" && '
        f"pip install -e . --no-build-isolation",
    )
    .run_commands(
        _COMPILE_RENDERER,
        # The super-resolution checkpoint is a plain GitHub release asset, not an
        # HF repo, so it is baked into the image rather than cached in the Volume.
        f"mkdir -p {REPO_DIR}/hy3dpaint/ckpt",
        f"wget -q -O {REPO_DIR}/hy3dpaint/ckpt/RealESRGAN_x4plus.pth "
        f"https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
    )
    # Upstream resolves config and checkpoint paths relative to the repo root
    # (see Hunyuan3DPaintConfig), so that is where the process has to stand.
    .workdir(REPO_DIR)
    # Deliberately the last layer. The GPU container downloads any weight the
    # cache is missing, and hits the same slow Xet fallback the prefetch did -
    # but putting hf_xet up with the other pip installs would invalidate the
    # clone, the requirements install and both extension compiles behind it.
    # Appended here, it costs one small layer and nothing else rebuilds.
    .pip_install("hf_xet")
)

def clamp_specular(data: bytes) -> bytes:
    """Clamp KHR_materials_specular in a GLB so the mesh is not washed out white.

    Blender's glTF exporter writes specularColorFactor [2, 2, 2] for these meshes.
    The glTF spec treats that as a linear reflectance multiplier normally <= 1, so
    2.0 doubles F0. On a dielectric with roughness ~0.26 the highlight then swamps
    the base colour and the model renders as a white blob in any correct viewer -
    three.js included, which implements the extension faithfully.

    Nothing asked for this. Upstream's own MTL writes no Ks at all on the PBR
    path; the value is invented in the OBJ import -> glTF export round trip, and
    is a plausible casualty of the forced bpy 4.0 -> 4.2 bump.

    The JSON chunk is edited in place rather than round-tripping the mesh through
    trimesh, which would re-encode both 2048x2048 textures to no purpose.
    """
    import json
    import struct

    if data[:4] != b"glTF":
        return data

    header, chunks, offset = data[:12], [], 12
    while offset < len(data):
        (length, kind) = struct.unpack_from("<II", data, offset)
        offset += 8
        chunks.append((kind, data[offset:offset + length]))
        offset += length

    changed = False
    rebuilt = []
    for kind, payload in chunks:
        if kind != 0x4E4F534A:  # not the JSON chunk
            rebuilt.append((kind, payload))
            continue

        doc = json.loads(payload)
        for material in doc.get("materials", []):
            spec = material.get("extensions", {}).get("KHR_materials_specular")
            if not spec:
                continue
            factor = spec.get("specularColorFactor")
            if factor and any(c > 1.0 for c in factor):
                spec["specularColorFactor"] = [min(c, 1.0) for c in factor]
                changed = True
            # All-1.0 is exactly the glTF default, so the extension is then noise.
            if spec.get("specularColorFactor") == [1.0, 1.0, 1.0] and len(spec) == 1:
                del material["extensions"]["KHR_materials_specular"]
                if not material["extensions"]:
                    del material["extensions"]
                changed = True

        if changed and "KHR_materials_specular" not in json.dumps(doc.get("materials", [])):
            used = doc.get("extensionsUsed", [])
            if "KHR_materials_specular" in used:
                used.remove("KHR_materials_specular")
                if not used:
                    doc.pop("extensionsUsed", None)

        blob = json.dumps(doc, separators=(",", ":")).encode()
        blob += b" " * (-len(blob) % 4)          # chunks are 4-byte aligned
        rebuilt.append((kind, blob))

    if not changed:
        return data

    body = b"".join(struct.pack("<II", len(p), k) + p for k, p in rebuilt)
    return header[:8] + struct.pack("<I", 12 + len(body)) + body


# ---------------------------------------------------------------------------
# Weight cache
# ---------------------------------------------------------------------------
# A Volume rather than baking weights into the image: ~30 GB of checkpoints
# would make every image rebuild re-push them, and the weights change on a
# different clock than the build recipe does.
cache_volume = modal.Volume.from_name("hunyuan3d-cache", create_if_missing=True)


def _hf_secret() -> list[modal.Secret]:
    """Forward a HuggingFace token to the container, if there is one locally.

    Optional: tencent/Hunyuan3D-2.1 and facebook/dinov2-giant are both public, so
    an anonymous container downloads them fine. A token only raises the download
    rate limit, which matters when the weight cache is rebuilt repeatedly. It is
    read from the environment, falling back to the project's .env so the token
    lives in exactly one place.

    from_dict creates an ephemeral secret scoped to this run, which is right for
    `modal run`. For `modal deploy`, create a named secret instead:
        modal secret create huggingface-secret HF_TOKEN=hf_...
    and swap this for modal.Secret.from_name("huggingface-secret").
    """
    token = os.environ.get("HF_TOKEN", "").strip()

    if not token:
        env_file = Path(__file__).resolve().parent.parent / ".env"
        if env_file.is_file():
            for line in env_file.read_text(encoding="utf-8").splitlines():
                key, sep, value = line.partition("=")
                if sep and key.strip() == "HF_TOKEN":
                    token = value.strip().strip("\"'")
                    break

    if not token:
        return []
    return [modal.Secret.from_dict({"HF_TOKEN": token})]


app = modal.App(APP_NAME, image=image, secrets=_hf_secret())


# ---------------------------------------------------------------------------
# Weight prefetch
# ---------------------------------------------------------------------------
# Downloading files needs an HTTP client, not a CUDA toolchain. Giving prefetch
# its own two-package image means it runs a minute after you type it, instead of
# waiting out a 20 GB image build to do something the build has no part in.
prefetch_image = modal.Image.debian_slim(python_version=PYTHON_VERSION).pip_install(
    # hf_xet is not optional here. This repo is Xet-backed, and without it
    # huggingface_hub falls back to a plain single-stream HTTP GET - for a single
    # 7.4 GB checkpoint that is both slow and, at a low CPU allocation, enough to
    # starve the container's heartbeat thread until Modal kills the runner.
    "huggingface-hub==0.30.2", "hf_transfer==0.1.8", "hf_xet",
).env({"HF_HOME": f"{CACHE_DIR}/huggingface", "HF_HUB_ENABLE_HF_TRANSFER": "1"})


@app.function(
    image=prefetch_image,
    volumes={CACHE_DIR: cache_volume},
    timeout=60 * MINUTES,
    # Modal's default is 0.125 cores. TLS for ~30 GB is CPU-bound, and the
    # heartbeat Modal uses to decide the container is alive runs on a thread
    # competing for that same eighth of a core - which is how the first attempt
    # died at exactly the 900 s heartbeat limit rather than at the 60 min timeout.
    cpu=4.0,
    memory=8192,
)
def prefetch() -> None:
    """Populate the weight cache without paying for a GPU.

        modal run modal_app/hunyuan3d.py::prefetch

    Optional - the first generate() would download the same files - but doing it
    here means the download happens on a CPU container at a fraction of the
    hourly rate, and a later GPU cold start is only weight loading.
    """
    from huggingface_hub import snapshot_download

    for repo in (MODEL_REPO, DINO_REPO):
        print(f"downloading {repo} ...")
        snapshot_download(repo_id=repo)

    cache_volume.commit()
    print("cache warm")


# ---------------------------------------------------------------------------
# The pipeline
# ---------------------------------------------------------------------------
@app.cls(
    gpu=GPU,
    volumes={CACHE_DIR: cache_volume},
    # Texturing a dense mesh at 6 views is minutes, not seconds, and the first
    # call also loads 30 GB of weights. The 300 s default would kill it.
    timeout=30 * MINUTES,
    # Idle GPU time is billed. Two minutes is the balance point for how this gets
    # used: a batch keeps the container busy back-to-back regardless, so this
    # window only covers the gap between separate jobs. Holding an L40S idle for
    # five minutes costs more than the ~90 s cold start it saves, unless you
    # resubmit almost immediately. Raise it if you iterate in tight bursts.
    scaledown_window=2 * MINUTES,
)
class Hunyuan3D:
    @modal.enter()
    def load(self) -> None:
        import sys

        # Both packages sit inside the repo rather than on the import path, and
        # config paths are relative to the repo root. Same order as demo.py.
        os.chdir(REPO_DIR)
        for path in (f"{REPO_DIR}/hy3dshape", f"{REPO_DIR}/hy3dpaint", REPO_DIR):
            if path not in sys.path:
                sys.path.insert(0, path)

        from torchvision_fix import apply_fix

        apply_fix()

        from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline

        started = time.perf_counter()
        self.shape = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(MODEL_REPO)
        try:
            self.shape.enable_flashvdm()
        except Exception as exc:  # not present in every checkout
            print(f"flashvdm unavailable ({exc}); continuing")
        print(f"shape pipeline ready in {time.perf_counter() - started:.0f}s")

        # 21 GB that is pure waste for a geometry-only run, and its constructor
        # loads the models immediately, so it is built on first use instead.
        self.paint = None

        cache_volume.commit()

    def _paint_pipeline(self, max_num_view: int, resolution: int):
        from textureGenPipeline import Hunyuan3DPaintConfig, Hunyuan3DPaintPipeline

        conf = Hunyuan3DPaintConfig(max_num_view, resolution)
        # The defaults are relative to two different directories - the config
        # path to the repo root, the ESRGAN checkpoint to hy3dpaint/ - which is
        # why demo.py rewrites them. Absolute paths remove the question.
        conf.multiview_cfg_path = f"{REPO_DIR}/hy3dpaint/cfgs/hunyuan-paint-pbr.yaml"
        conf.custom_pipeline = f"{REPO_DIR}/hy3dpaint/hunyuanpaintpbr"
        conf.realesrgan_ckpt_path = f"{REPO_DIR}/hy3dpaint/ckpt/RealESRGAN_x4plus.pth"

        started = time.perf_counter()
        pipeline = Hunyuan3DPaintPipeline(conf)
        print(f"paint pipeline ready in {time.perf_counter() - started:.0f}s")
        return pipeline

    @modal.method()
    def generate(
        self,
        image_bytes: bytes,
        texture: bool = True,
        steps: int = 50,
        guidance_scale: float = 5.0,
        octree_resolution: int = 384,
        num_chunks: int = 8000,
        seed: int = 42,
        max_num_view: int = 6,
        view_resolution: int = 512,
        remove_background: bool = True,
    ) -> bytes:
        """One image in, one GLB out. Defaults match upstream's demo.py."""
        import io
        import tempfile

        import numpy as np
        import torch
        from PIL import Image as PILImage

        work = Path(tempfile.mkdtemp(prefix="hy3d-"))
        source = PILImage.open(io.BytesIO(image_bytes)).convert("RGBA")

        # demo.py tests `image.mode == 'RGB'` one line after convert("RGBA"),
        # so its background removal never actually runs. Test the alpha channel
        # instead: a fully opaque image has not been cut out yet.
        if remove_background and np.asarray(source.getchannel("A")).min() == 255:
            from hy3dshape.rembg import BackgroundRemover

            source = BackgroundRemover()(source)

        # The paint pipeline re-reads the prompt image from disk, and it has to
        # be the same cut-out the shape stage saw or the texture will not line up.
        staged = work / "input.png"
        source.save(staged)

        generator = torch.Generator(device="cuda").manual_seed(seed)

        started = time.perf_counter()
        mesh = self.shape(
            image=source,
            num_inference_steps=steps,
            guidance_scale=guidance_scale,
            octree_resolution=octree_resolution,
            num_chunks=num_chunks,
            generator=generator,
        )[0]
        shape_path = work / "shape.glb"
        mesh.export(str(shape_path))
        print(
            f"shape: {len(mesh.vertices)} verts, {len(mesh.faces)} faces "
            f"in {time.perf_counter() - started:.0f}s"
        )

        if not texture:
            return shape_path.read_bytes()

        if self.paint is None:
            self.paint = self._paint_pipeline(max_num_view, view_resolution)

        # The pipeline writes `output_mesh_path` and then, if save_glb, writes a
        # second file with .obj swapped for .glb - and returns the *first* path.
        # Handing it a .obj name is what makes that swap mean anything; demo.py
        # passes a .glb and ends up converting the file to itself.
        obj_path = work / "textured.obj"
        started = time.perf_counter()
        self.paint(
            mesh_path=str(shape_path),
            image_path=str(staged),
            output_mesh_path=str(obj_path),
        )
        glb_path = obj_path.with_suffix(".glb")
        print(f"texture: {time.perf_counter() - started:.0f}s")

        if not glb_path.is_file():
            raise RuntimeError(f"paint pipeline produced no GLB at {glb_path}")

        cache_volume.commit()
        return clamp_specular(glb_path.read_bytes())


# ---------------------------------------------------------------------------
# Local entrypoint
# ---------------------------------------------------------------------------
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def _collect(target: Path) -> list[Path]:
    if target.is_dir():
        found = sorted(p for p in target.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES)
        if not found:
            raise ValueError(f"No images in {target}")
        return found
    if not target.is_file():
        raise FileNotFoundError(target)
    return [target]


@app.local_entrypoint()
def main(
    image: str,
    out: str = "outputs",
    texture: bool = True,
    steps: int = 50,
    guidance_scale: float = 5.0,
    octree_resolution: int = 384,
    seed: int = 42,
    max_num_view: int = 6,
    view_resolution: int = 512,
    remove_background: bool = True,
) -> None:
    """Send one image, or a folder of them, to the GPU and write the GLBs here.

        modal run modal_app/hunyuan3d.py --image inputs/chair.png
        modal run modal_app/hunyuan3d.py --image inputs/ --no-texture
        modal run modal_app/hunyuan3d.py --image inputs/bedroom.jpg --octree-resolution 256
    """
    images = _collect(Path(image))
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # One instance, reused: the images run one after another on a single warm
    # container instead of each paying the weight-loading cold start. Raise
    # max_containers on the class and use .map() if you would rather trade money
    # for wall clock.
    model = Hunyuan3D()

    failures = 0
    for index, path in enumerate(images, start=1):
        # "1/3  chair.png", matching the shape console.rule() gives the local
        # CLIs. The viewer scrapes progress out of stdout with one regex, and a
        # bracketed [1/3] slips past it - so this is load-bearing formatting.
        print(f"{index}/{len(images)}  {path.name}")
        started = time.perf_counter()
        try:
            glb = model.generate.remote(
                path.read_bytes(),
                texture=texture,
                steps=steps,
                guidance_scale=guidance_scale,
                octree_resolution=octree_resolution,
                seed=seed,
                max_num_view=max_num_view,
                view_resolution=view_resolution,
                remove_background=remove_background,
            )
        except Exception as exc:
            print(f"  failed: {type(exc).__name__}: {exc}")
            failures += 1
            continue

        out_path = out_dir / f"{path.stem}.glb"
        out_path.write_bytes(glb)
        print(
            f"  -> {out_path}  {len(glb) / 1e6:.1f} MB "
            f"in {time.perf_counter() - started:.0f}s"
        )

    print(f"{len(images) - failures}/{len(images)} succeeded -> {out_dir.resolve()}")
