# The image-to-3D landscape

Notes from surveying what is available, and why this project uses what it does.
Accurate as of August 2026; this field moves fast.

## What this project uses

| Role | Model | Why |
|---|---|---|
| Object reconstruction | **TripoSR** | The only one that fits 4 GB |
| Object detection | **GroundingDINO tiny** | Open-vocabulary, already in `transformers` |
| Background removal | **rembg / u2net** | Already a dependency, good enough |

GroundingDINO deserves a note: it needed **no new dependency**, because
`transformers` 4.57 ships it. Open-vocabulary matters here — interior furniture
does not map onto COCO's 80 classes, and a fixed class list would miss half a
bedroom.

## Object reconstruction

All single-object. Feed them a whole room and you get garbage.

| Model | VRAM | Licence | Notes |
|---|---|---|---|
| **TripoSR** | ~2 GB | MIT | Single-view. Weakest, but runs here |
| **InstantMesh** | ~10 GB | Apache-2.0 | Zero123++ multi-view → sparse reconstruction. Clearly better |
| **TRELLIS 2** | ~10 GB+ | MIT | Best open visual quality |
| **Hunyuan3D-2** | 6 GB shape / 16 GB textured | custom | Implemented here; needs CUDA Toolkit |

**On generating your own multi-views:** the intuition that you should produce
several views of an object and reconstruct from those is exactly right — it is
what InstantMesh does internally. But the multi-view generator must be
*3D-aware*. Zero123++ has cross-view attention; a generic image model (SDXL,
FLUX) has none and produces views that disagree with each other. Consistency is
the documented failure mode of this whole family — Carve3D, MVDiff and
MV-Diffus3R exist solely to attack it. Do not hand-roll this step; use a model
that already does it.

Two further traps:

- **Object-centric ≠ scene-level.** These models are trained on orbits around a
  centred object on a blank background. A room photo needs the camera *inside*
  the scene. Feeding a bedroom to Zero123 makes it orbit the room like a teacup.
- **No canonical up-axis.** Nothing in the output says which way is up. See
  [decisions.md](decisions.md).

## Whole-scene reconstruction

Single image → walls *and* separated furniture. The category this project
reimplements with simpler parts.

| Project | Licence | Notes |
|---|---|---|
| **3D-RE-GEN** | MIT (code) | Most complete. Objects + background, materials, lighting. Bundles VGGT, SAM, Hunyuan3D-2, Grounded-SAM — **check each licence before commercial use** |
| **MIDI-3D** | Apache-2.0 | Multi-instance diffusion; all objects generated together with correct spatial relationships. ~30 GB textured. Safest licence |

MIDI-3D is interesting for this project beyond mesh quality: generating objects
jointly means it produces *placement* as a side effect, partly replacing the
layout stage.

## Room structure

Walls, doors, windows — the part this project generates procedurally.

| Project | Input | Output |
|---|---|---|
| **SpatialLM 1.1** | point cloud (from RGB video) | walls, doors, windows + oriented boxes for 59 furniture types |
| **uLayout** | perspective **or** panorama | unified layout |
| **Bi-Layout** | 360° panorama | resolves layout ambiguity |
| **360-DFPE** | multiple 360° views | multi-room floor plan |
| HorizonNet / HoHoNet / DuLa-Net | 360° panorama | classic, battle-tested |

Two licence notes: SpatialLM's v1.1 point encoder is **CC-BY-NC**
(non-commercial), though its Qwen variant's LLM is Apache-2.0. Check before
shipping.

Panorama methods are the accuracy sweet spot — a 360° view sees the whole room,
so nothing has to be hallucinated. This project's camera-model approach exists
because the input is a single perspective image.

## Scene generation

Not reconstruction — these invent rooms rather than copying one.

- **SpatialGen** (3DV 2026) — layout + reference image or text → view-consistent
  3D room. Trained on 12,328 scenes / 57,440 rooms. The closest thing to skipping
  this pipeline outright: it invents a coherent room instead of recovering the
  one in the photo.

## Capturing a real space

If the home physically exists, capture beats reconstruction:

- **Scaniverse** — free, iOS and Android, unlimited Gaussian splats, on-device
- **KIRI Engine** — cross-platform photogrammetry, unlimited free exports
- **Polycam** — best LiDAR UX, limited free tier
- **Nerfstudio / Meshroom / COLMAP** — fully open source, self-hosted

Caveat: these produce a photo-realistic *shell*, not editable furniture. The bed
is fused into the floor. Excellent for viewing, useless for "swap this sofa".

## The honest summary

**No free model turns a handful of images into a complete multi-room home.**
Per-room reconstruction is very achievable — that is what this project does.
Assembling rooms into a home is still manual.

For a design tool specifically, the biggest available quality jump may not be a
better generator at all, but **retrieval**: detect the furniture, then match it
against a CAD library rather than reconstructing it. Generated furniture is
lumpy and hard to edit; a retrieved model is clean, low-poly, correctly scaled
and swappable. Reconstruction gets you *layout*; retrieval gets you *quality*.

## Judging them yourself

[notebooks/image_to_3d_eval.ipynb](../notebooks/image_to_3d_eval.ipynb) runs your
own images through **TripoSR**, **Hunyuan3D 2.0** and **TRELLIS** on a free Colab
T4, so the comparison above can be checked against your actual furniture rather
than taken on trust. It needs a GPU this machine does not have — hence Colab.

## Sources

- [InstantMesh](https://github.com/TencentARC/InstantMesh) ·
  [MIDI-3D](https://github.com/VAST-AI-Research/MIDI-3D) ·
  [3D-RE-GEN](https://github.com/cgtuebingen/3D-RE-GEN)
- [SpatialLM](https://github.com/manycore-research/SpatialLM) ·
  [SpatialGen](https://github.com/manycore-research/SpatialGen) ·
  [Bi-Layout](https://github.com/LIAGM/Bi_Layout) ·
  [360-DFPE](https://github.com/EnriqueSolarte/direct_360_FPE)
- [Room layout survey](https://github.com/zhanght021/awesome-3D-Room-Layout-Estimation) ·
  [Awesome-3D-Scene-Generation](https://github.com/hzxie/Awesome-3D-Scene-Generation)
- [Carve3D](https://desaixie.github.io/carve-3d/) ·
  [CAT3D](https://arxiv.org/pdf/2405.10314) — on multi-view consistency
