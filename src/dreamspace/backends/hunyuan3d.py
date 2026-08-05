"""Hunyuan3D 2.0 backend - cloud GPU only.

This will not run on a 4 GB card. Shape generation alone needs ~6 GB and
shape+texture needs ~16 GB. It also compiles two CUDA extensions
(custom_rasterizer, differentiable_renderer) which require the full CUDA
Toolkit, so `uv pip install -r requirements.txt` on a Toolkit-less machine is
not enough to make it work.

It is implemented here so the CLI is ready the moment you point it at a rented
GPU box. See README > "Moving to a bigger GPU".
"""

from __future__ import annotations

from pathlib import Path

import torch

from ..preprocess import prepare
from .base import Backend, register


@register
class Hunyuan3DBackend(Backend):
    name = "hunyuan3d"
    repo_url = "https://github.com/Tencent-Hunyuan/Hunyuan3D-2.git"
    vendor_name = "Hunyuan3D-2"

    SHAPE_REPO = "tencent/Hunyuan3D-2"        # 'tencent/Hunyuan3D-2mini' needs ~5 GB
    PAINT_REPO = "tencent/Hunyuan3D-2"

    def load(self) -> None:
        self.device = self.config.resolve_device()
        if self.device != "cuda":
            raise RuntimeError("Hunyuan3D requires a CUDA GPU; it has no usable CPU path.")

        vram = torch.cuda.get_device_properties(0).total_memory / 1024**3
        if vram < 6:
            raise RuntimeError(
                f"Hunyuan3D needs ~6 GB VRAM for shape generation and ~16 GB with "
                f"texture; this GPU has {vram:.1f} GB. Use MODEL_BACKEND=triposr "
                f"locally, or run this backend on a rented GPU."
            )
        if vram < 16 and self.config.bake_texture:
            self.console.print(
                f"[yellow]{vram:.1f} GB VRAM: texture stage will likely OOM. "
                f"Set BAKE_TEXTURE=false for geometry only.[/]"
            )

        self.ensure_vendored()

        from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline

        self.console.print(f"[cyan]Loading {self.SHAPE_REPO} onto cuda[/]")
        self.shape = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(self.SHAPE_REPO)
        try:
            self.shape.enable_flashvdm()
        except Exception as exc:  # present only in recent checkouts
            self.console.print(f"[dim]flashvdm unavailable ({exc}); continuing[/]")

        self.paint = None

    def generate(self, image_path: Path, out_stem: str) -> Path:
        cfg = self.config

        image = prepare(
            image_path,
            remove_bg=cfg.remove_background,
            foreground_ratio=cfg.foreground_ratio,
            rembg_model=cfg.rembg_model,
            flatten_to_grey=False,
        )
        staged = cfg.output_dir / f"{out_stem}_input.png"
        image.save(staged)

        mesh = self.shape(image=str(staged))[0]

        if cfg.bake_texture:
            # Load the paint pipeline lazily so the shape model's memory is the
            # only thing resident until it is actually needed.
            if self.paint is None:
                from hy3dgen.texgen import Hunyuan3DPaintPipeline

                self.console.print(f"[cyan]Loading {self.PAINT_REPO} paint pipeline[/]")
                self.paint = Hunyuan3DPaintPipeline.from_pretrained(self.PAINT_REPO)
            mesh = self.paint(mesh, image=str(staged))

        out_path = cfg.output_dir / f"{out_stem}.{cfg.output_format}"
        mesh.export(str(out_path))
        staged.unlink(missing_ok=True)
        return out_path
