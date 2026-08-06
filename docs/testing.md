# Testing

Two entry points, split along the interpreter boundary described in
[architecture.md](architecture.md): one needs no Blender, the other needs no GPU.

## 1. Pure logic — no GPU, no Blender, no weights

```powershell
python scripts\selftest.py
```

28 checks, runs in about a second. Covers spec round-tripping, detection
de-duplication, the camera model, prior lookup, wall choice, and room sizing.

Plain asserts rather than pytest, so it runs in the project venv with nothing
extra installed. Exits non-zero on failure.

Every check exists because that code broke at least once. Notable ones:

| Check | The bug it guards |
|---|---|
| `round-trips exactly` | JSON has no tuples, so `load(save(x)) != x` — positions came back as lists |
| `drops a nested box` | The detector duplicates by *nesting*, which IoU-only NMS misses entirely |
| `a narrow lens pushes it too far` | A 62° FOV assumption produced a 9 × 10 m "bedroom" |
| `never picks an unbuilt wall` | Hanging a painting on an omitted wall leaves it floating |
| `furniture fits inside the room` | Sizing the room from object centres pushed a bed 0.35 m through the back wall |

## 2. Assembled output — needs Blender, no GPU

```powershell
blender --background --factory-startup --python scripts\verify_scene.py -- `
    --glb outputs\bedroom.glb --spec outputs\bedroom\scene.json
```

Re-imports the exported GLB and asserts it matches the spec it was built from:

- scene bounds match the room the spec describes (catches furniture through walls)
- the floor sits at the right depth and `room_shell` exists
- every object in the spec is present in the export
- each object's centre and base are within 5 cm of its spec position
- no object exceeds its target box, **allowing for yaw** — a rotated object has
  a larger world-aligned box by `w·|cos θ| + d·|sin θ|`
- warns on meshes under 200 triangles (a failed reconstruction that got through)

Exits non-zero on failure, so it can gate a build.

**This is the check that has actually caught things.** A build completing
without error is not evidence the geometry is right — the first working
assembly placed a 0.9 m chair at 0.29 m tall and reported success.

Current output on the sample: `all checks passed (9 objects)`.

## What is not covered

Being explicit, because the gaps matter more than the coverage:

**No test of reconstruction quality.** Nothing asserts that `bed.glb` looks
like a bed. Mesh quality is judged by eye, and it is the weakest part of the
pipeline.

**No test of detection accuracy.** `segment.py`'s de-duplication is tested with
synthetic boxes; the detector itself is not. There is no labelled fixture, so
"10/10 correct on the sample" is an eyeball judgement, not an assertion.

**No test of layout correctness against ground truth.** The sample room's real
dimensions are unknown — it is a render. Checks confirm the layout is
*self-consistent* and *plausible*, not that it is *right*.

**One image.** Everything has been exercised on a single clean CGI bedroom.
Real photographs, cluttered rooms and other room types are untested.

**No CI.** Both scripts are run by hand.

**No regression fixtures.** There is no stored "known good" GLB to diff
against, so a change that quietly degrades output would pass both scripts.

## Reproducing the sample end to end

```powershell
# ~18 minutes cold, ~30 s with cached meshes
dreamspace-room --image inputs\bedroom.jpg --decimate 0.2

# then verify
blender --background --factory-startup --python scripts\verify_scene.py -- `
    --glb outputs\bedroom.glb --spec outputs\bedroom\scene.json
```

For a fast assembly-only loop that needs no models at all, use the hand-written
example — it runs in seconds against meshes already in `outputs/`:

```powershell
dreamspace-assemble --spec examples\room-demo.json
```

## Checking the environment

```powershell
dreamspace-generate --doctor
```

Reports Python, torch, the CUDA build, VRAM, the marching-cubes shim, every
required import, and whether Blender was found. A missing Blender is a warning
rather than a failure — it only disables assembly.
