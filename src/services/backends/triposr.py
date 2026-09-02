"""TripoSR backend - the only model in this project that fits a 4 GB card."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch
from PIL import Image

from src.services.backends.compat import install_torchmcubes_shim, patch_bake_texture_device
from src.services.preprocess_service import prepare
from .base import Backend, register


@register
class TripoSRBackend(Backend):
    name = "triposr"
    repo_url = "https://github.com/VAST-AI-Research/TripoSR.git"
    vendor_name = "TripoSR"

    HF_REPO = "stabilityai/TripoSR"

    def load(self) -> None:
        # The shim must be installed before `tsr` is imported, because
        # tsr.system does `from torchmcubes import marching_cubes` at module level.
        impl = install_torchmcubes_shim()
        self.console.print(f"[dim]marching cubes: {impl}[/]")

        self.ensure_vendored()

        from tsr.system import TSR

        self.device = self.config.resolve_device()
        self.console.print(f"[cyan]Loading {self.HF_REPO} onto {self.device}[/] [dim](first run downloads ~1.7 GB)[/]")

        self.model = TSR.from_pretrained(
            self.HF_REPO,
            config_name="config.yaml",
            weight_name="model.ckpt",
        )
        self.model.renderer.set_chunk_size(self.config.chunk_size)
        self.model.to(self.device)

        if self.config.half_precision and self.device == "cuda":
            self.model.half()
            self.console.print("[dim]weights cast to float16[/]")

        if self.device == "cuda":
            used = torch.cuda.memory_allocated() / 1024**3
            total = torch.cuda.get_device_properties(0).total_memory / 1024**3
            self.console.print(f"[dim]VRAM after load: {used:.2f} / {total:.1f} GB[/]")

    def set_chunk_size(self, chunk_size: int) -> bool:
        self.model.renderer.set_chunk_size(chunk_size)
        self.config.chunk_size = chunk_size
        return True

    def generate(self, image_path: Path, out_stem: str) -> Path:
        cfg = self.config
        bake = cfg.bake_texture

        image = prepare(
            image_path,
            remove_bg=cfg.remove_background,
            foreground_ratio=cfg.foreground_ratio,
            rembg_model=cfg.rembg_model,
            # Always flatten onto neutral grey. The image encoder is DINOv2 and
            # takes 3 channels, so the cutout must be composited before it is
            # handed over regardless of how we colour the mesh afterwards.
            # This mirrors upstream run.py, which flattens in the same place.
            flatten_to_grey=True,
        )

        with torch.no_grad():
            scene_codes = self.model([image], device=self.device)

        # has_vertex_color is the inverse of "we are going to bake a texture"
        meshes = self.model.extract_mesh(
            scene_codes,
            not bake,
            resolution=cfg.mc_resolution,
        )
        mesh = meshes[0]

        out_path = cfg.output_dir / f"{out_stem}.{cfg.output_format}"
        if bake:
            self._export_baked(mesh, scene_codes[0], out_path)
        else:
            if cfg.flip_faces:
                mesh.faces = np.ascontiguousarray(np.asarray(mesh.faces)[:, ::-1])
            mesh.export(str(out_path))

        return out_path

    # ------------------------------------------------------------------
    def _export_baked(self, mesh, scene_code, out_path: Path) -> None:
        """Bake a UV texture and export a single self-contained GLB/OBJ.

        Upstream's run.py writes a loose .obj + .png pair. Packing it into one
        GLB instead is what a Three.js viewer actually wants.
        """
        import trimesh
        from trimesh.visual import TextureVisuals
        from trimesh.visual.material import PBRMaterial

        from tsr.bake_texture import bake_texture

        # Upstream's bake path is CPU-only; make it follow the model's device.
        patch_bake_texture_device()

        try:
            baked = bake_texture(mesh, self.model, scene_code, self.config.texture_resolution)
        except Exception as exc:
            # bake_texture rasterises through moderngl, which needs a real GL
            # context. On a hybrid-graphics laptop that can fail depending on
            # which adapter the process lands on. Vertex colours need no GL at
            # all, so say so plainly rather than surfacing a raw GL error.
            if "moderngl" in f"{type(exc).__module__}{exc}".lower() or "context" in str(exc).lower():
                raise RuntimeError(
                    f"Texture baking could not create an OpenGL context ({exc}). "
                    f"Re-run with --no-texture for vertex colours, which needs no GL."
                ) from exc
            raise

        required = {"vmapping", "indices", "uvs", "colors"}
        missing = required - set(baked)
        if missing:
            raise RuntimeError(
                f"bake_texture() returned unexpected keys {sorted(baked)}; "
                f"missing {sorted(missing)}. This checkout of TripoSR may have "
                f"changed - set BAKE_TEXTURE=false to fall back to vertex colours."
            )

        vmapping = np.asarray(baked["vmapping"])
        indices = np.asarray(baked["indices"])
        uvs = np.asarray(baked["uvs"])

        # The bake produces its own index buffer, so the flip has to be applied
        # here rather than to the pre-bake mesh.
        if self.config.flip_faces:
            indices = np.ascontiguousarray(indices[:, ::-1])

        texture = Image.fromarray(
            (np.asarray(baked["colors"]) * 255.0).astype(np.uint8)
        ).transpose(Image.FLIP_TOP_BOTTOM)

        out_mesh = trimesh.Trimesh(
            vertices=np.asarray(mesh.vertices)[vmapping],
            faces=indices,
            vertex_normals=np.asarray(mesh.vertex_normals)[vmapping],
            visual=TextureVisuals(
                uv=uvs,
                material=PBRMaterial(
                    baseColorTexture=texture,
                    metallicFactor=0.0,
                    roughnessFactor=1.0,
                ),
            ),
            process=False,
        )
        out_mesh.export(str(out_path))
