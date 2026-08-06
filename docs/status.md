# Status

Everything below was measured on this machine: **RTX 3050 Laptop, 4 GB VRAM,
no CUDA Toolkit**, Windows 11.

Environment: Python 3.10.11, torch 2.6.0+cu124, transformers 4.57.6,
numpy 1.26.4, Blender 5.3.0 Alpha (its own Python 3.13.13).

## Built and working

| Component | State |
|---|---|
| `src/` package layout, editable install, 4 console scripts | done |
| Single image → mesh (`dreamspace-generate`) | done, pre-existing |
| Object detection (`scene/segment.py`) | done, 10/10 correct on the sample |
| Layout estimation (`scene/layout.py`) | done, approximate by design |
| Blender assembly (`scene/blender/build_scene.py`) | done, verified |
| Orchestrator (`dreamspace-room`) | done, verified end to end |
| Two-wall cutaway, auto wall selection | done |
| Flat objects as textured panels | done |
| Degenerate-mesh rejection | done |
| Bounded non-uniform fit | done |
| Verification scripts | done, both passing |

## The sample run

`dreamspace-room --image inputs/bedroom.jpg --decimate 0.2` on a 1400×777
interior render.

**Detection — 10 objects, all real:**

| | | | |
|---|---|---|---|
| painting 0.87 | bed 0.86 | potted_plant 0.78 | nightstand 0.71 |
| curtain 0.66 | pendant light 0.46 | wardrobe 0.46 | window seat 0.41 |
| wardrobe_2 0.36 | upper cabinet 0.31 | | |

**Estimated room:** 6.35 × 4.54 × 2.70 m.

**Final output:** 9 objects, 69,221 triangles, 13.10 MB.

**Verified sizes** (`scripts/verify_scene.py`, all checks passing):

| Object | Built | Target |
|---|---|---|
| bed | 2.00 × 1.60 × 1.08 | 2.00 × 1.60 × 1.10 |
| nightstand | 0.49 × 0.45 × 0.55 | 0.50 × 0.45 × 0.55 |
| potted plant | 0.35 × 0.35 × 0.50 | 0.35 × 0.35 × 0.50 |
| wardrobe_2 | 1.20 × 0.32 × 2.21 | 1.20 × 0.60 × 2.30 |
| sofa (window seat) | 1.39 × 0.90 × 0.74 | 2.00 × 0.90 × 0.85 |
| wardrobe | 1.20 × 0.60 × 1.13 | 1.20 × 0.60 × 2.30 |
| painting (panel) | 0.90 × 0.70 | exact |
| curtain (panel) | 1.60 × 1.80 | exact |

## Timings

| Stage | Cost |
|---|---|
| Detection, CUDA | ~13 s |
| Detection, CPU | ~6 min (first run also downloads ~700 MB) |
| Reconstruction | ~90 s per object |
| Layout | instant |
| Blender assembly, 9 objects | ~8 s |
| **Full 10-object run** | **1052 s (17.5 min)** |
| Re-run with cached meshes | ~30 s |

Reconstruction dominates completely. Meshes are cached under
`outputs/<name>/objects/`, so layout and assembly changes cost seconds, not
minutes. `--regenerate` forces a rebuild.

## Measured improvements

Three fixes, each traceable to a specific verification failure:

| | Before | After |
|---|---|---|
| painting | 0.06 × 0.05 × 0.06 m, 23,919 tris | 0.90 × 0.70 m, 2 tris |
| curtain | 0.16 × 0.10 × 0.23 m, 12,676 tris | 1.60 × 1.80 m, 2 tris |
| bed | 1.63 × 1.60 × 0.77 m | 2.00 × 1.60 × 1.08 m |
| scene total | 105,836 tris, 17.6 MB | 69,221 tris, 13.10 MB |

## Known limitations

**Furniture can still fall short.** Both wardrobes hit the 1.5× stretch cap at
1.13 m and 2.21 m against a 2.30 m target. Their meshes are near-cubic blobs;
reaching full height would need ~3× stretch and would look smeared. This is a
mesh-quality problem, not a layout one.

**No yaw estimation.** Every piece of furniture faces forward.

**Side-wall items are centred along their wall.** One view gives no depth cue
along a wall running away from the camera, so inventing a position would be
false precision.

**Reconstruction fails silently on wide, shallow crops.** The upper cabinets
came back as 24 faces. Detected and dropped, but not recovered.

**Scale rests on an assumed field of view.** 85° suits interior renders; a real
photo from a phone is nearer 65–75°. Wrong FOV scales the whole room. See
[decisions.md](decisions.md).

**Detection is not perfect on a real photo.** All results here are from a clean
CGI render. Clutter, poor lighting and unusual furniture will do worse.

## Not started

- A stronger 3D backend (InstantMesh, MIDI-3D) — needs ~10 GB VRAM
- Yaw estimation
- Depth-model-based layout
- Multi-room / whole-home assembly
