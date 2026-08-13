"""Compatibility shims applied before third-party model code is imported."""

from __future__ import annotations

import sys
import types


def install_torchmcubes_shim() -> str:
    """Satisfy TripoSR's ``torchmcubes`` import using PyMCubes instead.

    TripoSR calls ``torchmcubes.marching_cubes(volume, threshold)``. The real
    torchmcubes is a CUDA extension compiled from source, which requires the
    full CUDA Toolkit (nvcc) - not just the runtime bundled with the driver.
    On a machine without the Toolkit it cannot be installed at all.

    torchmcubes is a GPU port of PyMCubes and keeps its call signature, but it
    does *not* keep its vertex or face conventions. Two differences have to be
    corrected here, or the shim silently produces a mirrored mesh:

    * Axis order. PyMCubes returns vertices in array-index order ``(i, j, k)``;
      torchmcubes returns them reversed, ``(k, j, i)``. TripoSR compensates for
      torchmcubes in ``tsr/models/isosurface.py`` with ``v_pos[..., [2, 1, 0]]``.
      Feeding it index-order vertices makes that line *introduce* the swap
      instead of undoing it, reflecting the model across the x=z plane - which
      reads as a 90-degree rotation plus a mirror.
    Faces need no adjustment. Reversing the axes here and TripoSR's swizzle are
    both reflections, so they cancel: the net transform is the identity and
    PyMCubes' own winding survives intact. (This is why FLIP_FACES is not needed
    once the axis order is right - the inside-out mesh was a *symptom* of the
    reflection, not an independent quirk of TripoSR.)

    The only remaining cost is that extraction runs on CPU, which is a rounding
    error next to the transformer forward pass - and on a 4 GB card it is
    arguably a win, since it keeps the density grid off the GPU.

    Returns a short string describing which implementation is active.
    """
    try:
        import torchmcubes  # noqa: F401

        return "torchmcubes (native CUDA extension)"
    except ImportError:
        pass

    try:
        import mcubes
    except ImportError as exc:  # pragma: no cover - dependency is in requirements.txt
        raise ImportError(
            "Neither torchmcubes nor PyMCubes is installed. "
            "Run: uv pip install PyMCubes"
        ) from exc

    import numpy as np
    import torch

    def marching_cubes(volume, threshold: float):
        if torch.is_tensor(volume):
            grid = volume.detach().cpu().numpy()
        else:
            grid = np.asarray(volume)
        grid = np.ascontiguousarray(grid, dtype=np.float64)

        verts, faces = mcubes.marching_cubes(grid, float(threshold))

        # Match torchmcubes' vertex convention - see the docstring above.
        verts = verts[:, ::-1]

        return (
            torch.from_numpy(np.ascontiguousarray(verts)).float(),
            torch.from_numpy(np.ascontiguousarray(faces)).long(),
        )

    module = types.ModuleType("torchmcubes")
    module.marching_cubes = marching_cubes
    module.__doc__ = "PyMCubes-backed stand-in installed by dreamspace.compat"
    sys.modules["torchmcubes"] = module

    return "PyMCubes (CPU shim - no CUDA Toolkit required)"


def patch_bake_texture_device() -> None:
    """Let TripoSR's texture baking run with the model on a GPU.

    Upstream ``tsr.bake_texture.positions_to_colors`` does:

        positions = torch.tensor(positions_texture.reshape(-1, 4)[:, :-1])
        queried_grid = model.renderer.query_triplane(..., positions, scene_code)
        rgb_f = queried_grid["color"].numpy()

    ``positions`` is built from a numpy buffer and never moved onto the model's
    device, and ``.numpy()`` then assumes the result is on CPU. Both only hold
    when the model itself is on CPU - so ``--bake-texture`` has never worked in
    CUDA mode, failing inside grid_sampler_2d with a device mismatch.

    This swaps in a device-agnostic version. Positions follow ``scene_code``
    onto whatever device it is on, and the result comes back via ``.cpu()``.
    Chunking is unaffected: query_triplane still batches at ``chunk_size``.
    """
    import numpy as np
    import torch
    from tsr import bake_texture as _bt

    if getattr(_bt, "_dreamspace_device_patched", False):
        return

    def positions_to_colors(model, scene_code, positions_texture, texture_resolution):
        flat = positions_texture.reshape(-1, 4)
        positions = torch.tensor(flat[:, :-1]).to(scene_code.device)
        with torch.no_grad():
            queried_grid = model.renderer.query_triplane(
                model.decoder, positions, scene_code
            )
        rgb_f = queried_grid["color"].detach().cpu().numpy().reshape(-1, 3)
        rgba_f = np.insert(rgb_f, 3, flat[:, -1], axis=1)
        rgba_f[rgba_f[:, -1] == 0.0] = [0, 0, 0, 0]
        return rgba_f.reshape(texture_resolution, texture_resolution, 4)

    _bt.positions_to_colors = positions_to_colors
    _bt._dreamspace_device_patched = True
