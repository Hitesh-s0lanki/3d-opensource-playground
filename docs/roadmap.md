# Roadmap

Ordered by value per unit of effort, not by dependency.

## Do these next — no GPU needed

### 1. Regression fixture for the sample scene

Store a known-good `scene.json` and the verifier output, so a change that
quietly degrades layout is caught. Right now both check scripts pass on
*self-consistency*, which means a systematic drift in the camera model would go
unnoticed. Cheap and closes the biggest gap in [testing.md](testing.md).

### 2. Yaw estimation

Every piece of furniture currently faces forward, which is the most visible
remaining wrongness after sizing. A bed against the far wall and a bed rotated
90° look completely different.

Approach: the detection box aspect ratio, compared against the prior's own
aspect ratio, constrains yaw — a 2.0 × 1.6 m bed seen 774 px wide and 428 px
tall implies a viewing angle. Ambiguous (two solutions per box) but a prior of
"furniture usually sits parallel to a wall" resolves most cases.

### 3. Test on real photographs

Everything so far is one clean CGI render. Phone photos bring motion blur,
clutter, cropped furniture and a narrower FOV (65–75° rather than 85°). Expect
detection precision to drop and layout scale to need `--fov` tuning. **Do this
before building anything else** — it will change the priorities below.

### 4. Texture resolution as a delivery knob

The output is texture-dominated, not geometry-dominated: `--decimate 0.2` cut
triangles 35% but the file only fell from 17.6 to 13.1 MB. Dropping
`TEXTURE_RESOLUTION` from 2048 to 1024 would do far more for web delivery.
Should be a flag rather than an `.env` edit.

## Needs a rented GPU

### 5. A stronger reconstruction backend

**This is the cure for the remaining size problem.** Both wardrobes hit the
stretch cap because their meshes are near-cubic blobs; no amount of layout work
fixes that.

Two candidates, both Apache-2.0, both slotting into the existing `Backend`
registry:

- **InstantMesh** — single image → Zero123++ multi-view → sparse-view
  reconstruction. ~10 GB VRAM. Clearly better than TripoSR per object.
- **MIDI-3D** — generates all objects *together* with correct spatial
  relationships, so it partly replaces stage 3 as well. ~30 GB for textured
  output.

Worth testing both. MIDI-3D may win for room work despite comparable per-object
quality, because it gives placement for free. See [models.md](models.md).

Cost: roughly $0.30–0.50/hr for a 4090 on RunPod or Vast.

### 6. Hunyuan3D

Already implemented in `backends/hunyuan3d.py` and refuses to load below 6 GB.
Needs two CUDA extensions compiled from source, so it needs the full Toolkit as
well as the VRAM.

## Larger changes

### 7. Depth-model layout

Replace the geometric camera model with monocular depth (Depth Anything V2 is
small enough to run on 4 GB). Would fix side-wall placement, which is currently
centred along the wall because one view gives no depth cue there, and would
remove the FOV assumption that currently sets the scale of the whole room.

`estimate_layout()` returns a `SceneSpec`; anything producing a valid one can
replace it without touching assembly.

### 8. Panorama input

360° panoramas are the sweet spot for room reconstruction — they see the whole
room, so nothing has to be hallucinated. uLayout, Bi-Layout and HoHoNet all
take panoramas and return accurate wall geometry. This would make walls
*measured* rather than *assumed*.

### 9. Furniture retrieval instead of generation

Detect objects, then match against a CAD library (3D-FUTURE, Objaverse) rather
than reconstructing. Clean, low-poly, correctly-scaled, swappable geometry —
which is what an interior design tool actually wants. Reconstruction gets you
*layout*; retrieval gets you *quality*.

This is the biggest architectural fork available and it is how commercial tools
work. Worth considering seriously before investing further in generation.

### 10. Multi-room assembly

Nothing in the spec models more than one room. A whole home needs room
adjacency, shared walls and a floor plan. `360-DFPE` does multi-room floor
plans from panoramas and would be the natural input.

## Explicitly not planned

- **Text-to-3D.** TripoSR has no text encoder; its only tokenizer is a DINO ViT.
  Text would need a different model family entirely.
- **Parallel reconstruction on this hardware.** Memory, not structure, is the
  constraint. See [decisions.md](decisions.md).
