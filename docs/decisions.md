# Decisions

Why things are built the way they are. Most entries exist because something
broke first.

## Walls are generated, never reconstructed

A room is a handful of boxes. Generating them gives exact right angles, flat
faces, correct normals and a couple of kilobytes. Reconstructing them gives
wavy, holed geometry weighing megabytes.

Corollary: **don't reconstruct what you can generate.** The same reasoning
later produced the flat-panel decision below.

## Only two walls by default

A closed box is geometrically correct and visually useless — a viewer orbiting
outside sees six blank faces and nothing of the room.

`--walls auto` keeps the far wall plus whichever side wall actually holds
artwork. Which two matters: keeping a bare wall while dropping the one with the
painting on it leaves the painting nowhere to hang, and it ends up on the wrong
surface.

## Flat things are textured quads, not meshes

**Found by verification.** The painting came out **0.06 × 0.05 × 0.06 m** with
23,919 triangles, against a 0.90 × 0.05 × 0.70 target.

TripoSR returns a *volumetric blob* for a painting. Uniform-fitting that blob
into a 5 cm-deep target made 5 cm the binding constraint, collapsing everything.

The fix is not better scaling — it is not reconstructing flat objects at all. A
quad carrying the original crop is more faithful, weighs 2 triangles instead of
23,919, and skips the reconstruction step entirely. Marked by `Prior.flat`.

## Uniform fit, but with a bounded stretch

**Found by verification.** A wardrobe came out 0.89 × 0.60 × 0.75 m against a
1.20 × 0.60 × 2.30 target.

Strictly uniform scaling is bound by whichever axis reaches its target first,
which is punishing when the mesh has the wrong proportions — and reconstructed
furniture usually does. But fully per-axis scaling distorts, and a stretched
sofa looks worse than a slightly small one.

Compromise: the tightest axis sets the floor, the others may scale up to
`--max-stretch` (default 1.5) times that, never past their own target.
Distortion is capped at 1.5:1 instead of everything being shrunk to the worst
axis. The bed went from 1.63 × 1.60 × 0.77 to 2.00 × 1.60 × 1.08.

Ordering subtlety: the scale must be applied **after** the orientation fix,
because `size` is expressed per *target* axis, not per mesh axis. That still
decomposes exactly into Blender's rotation-then-scale transform because the
orientation matrix is a signed permutation.

## Orientation is inferred from the stated size

**Found by verification.** A chair came out 0.29 m tall against a 0.9 m target.

Nothing in a GLB says which way is up, and reconstruction produces no canonical
orientation — `chair.glb` measures 1.07 × 0.60 × 0.57 m, lying on its side.

Guessing from geometry alone is unreliable, but the spec already states real
dimensions, and those *imply* an orientation: a 0.55 × 0.55 × 0.9 target is
unambiguously upright. So all six axis permutations are tried and the one that
fills the target box best is kept.

Reflections are excluded — half the permutations have a negative determinant,
and applying one would mirror the model, which is glaring on asymmetric
furniture.

## Depth comes from apparent height, not the box bottom

**Found by verification.** The wardrobe was placed 13 m away.

Back-projecting the bottom edge of a detection box onto the floor plane is the
textbook approach and it fails here: the wardrobe stands *behind* the bed, so
the bottom of its box is where the duvet begins, not where it meets the floor.

Apparent height is better twice over. It is unaffected by yaw — an upright
wardrobe covers the same vertical span whichever way it faces, whereas
projected width shrinks as an object turns and would read as extra distance.
And it survives occlusion of the base entirely.

## The field of view default is wide

**Found by verification.** The first layout produced a 9.07 × 9.93 m "bedroom".

The assumed FOV sets the scale of everything. Interior renders and estate
photography use wide lenses; 62° is a normal photographic default and was
badly wrong here.

Measured on the sample bedroom, for a 2.30 m wardrobe spanning 390 px:

| FOV | Focal (px) | Wardrobe distance |
|---|---|---|
| 62° | 1165 | 6.87 m |
| 75° | 912 | 5.38 m |
| **85°** | **764** | **4.51 m** |
| 95° | 641 | 3.78 m |

85° is the default. If a room comes out too large, raise `--fov`.

## The room is sized from footprints, not centres

**Found by verification.** Scene bounds measured 3.89 m deep against a 3.64 m
room — furniture was poking through the wall.

Sizing from object centres plus a fixed margin ignores that objects have
extent. A bed centred 1.27 m from the middle of a 3.44 m room pushes 0.35 m
through the back wall, because half its 1.6 m depth exceeds the 0.45 m margin.

## De-duplication tests nesting, not just overlap

**Found by verification.** Detection returned 14 objects, 4 of them duplicates.

GroundingDINO scores every phrase independently, so one wardrobe returns as
both "wardrobe" and "cabinet". Standard IoU-based NMS catches that.

What it misses is *nesting*, and both of this detector's duplicate modes are
nested: a seat cushion inside the seat containing it, and one huge box spanning
an entire wall of wardrobes alongside the individual units. A small box inside
a much larger one has a small intersection over a large union — low IoU, so it
survives.

Fix: also test intersection over the *smaller* area. 14 → 10.

## Degenerate meshes are dropped, not placed

Reconstruction fails *silently* on wide, shallow crops — the upper cabinets
came back as 24 faces with no error raised.

Such a mesh is worse than nothing: it still claims a place in the room, and its
degenerate bounding box makes placement arbitrary (it was the one object the
verifier flagged as misplaced). Anything under 200 faces is dropped and
reported in `skipped:`.

## Reconstruction is sequential, not parallel

Running several 3D generations at once needs a separate model resident per
worker, and TripoSR alone is ~1.7 GB of weights before activations. On a 4 GB
card the sequential path is not merely easier — it is the only one that fits,
and it wins anyway by loading the weights once instead of once per object.

`--jobs` above 1 spawns worker subprocesses, which is the right shape for a
rented GPU and useless below about 10 GB. The work is embarrassingly parallel;
the constraint is memory, not structure.

## Blender's exit code is not trusted

Blender exits 0 even when an embedded Python script raises. The driver requires
a sentinel line on stdout *and* the output file to exist before treating a
build as successful.

## Background removal happens once

`segment.py` produces plain crops, not cutouts. The backends already run rembg
inside `preprocess.prepare()` on the way into the model, so cutting out during
segmentation would only do it twice.

Crops are padded ~6% beyond the detection box, because rembg keys against the
background and a box cut exactly at the silhouette tends to eat the object's
own edges.

## requirements.txt stays the source of truth

`pyproject.toml` declares dependencies dynamically from `requirements.txt`
rather than duplicating them. That file carries the reasoning behind every
ceiling — `transformers <5` because TripoSR's checkpoint predates the v5
renaming, `numpy <2` because it breaks rembg and xatlas — and two lists would
inevitably drift.

`setup.ps1` installs the package with `--no-deps` after resolving
requirements.txt, so a pyproject resolution cannot pull torch from PyPI and
clobber the CUDA build.
