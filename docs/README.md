# dreamspace docs

Notes on how this project is built, what has been verified, and what is left.

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | The four pipeline stages, the two-interpreter split, and where each decision lives |
| [status.md](status.md) | What is built and measured today, with real numbers from the sample bedroom |
| [testing.md](testing.md) | How correctness is checked, how to run the checks, and what is **not** covered |
| [decisions.md](decisions.md) | Why things are built the way they are, and the bugs that shaped them |
| [roadmap.md](roadmap.md) | What is left, in priority order, with honest cost estimates |
| [models.md](models.md) | The image-to-3D landscape: what exists, what runs on 4 GB, what needs a rented GPU |

## The short version

One command turns a room photo into one GLB:

```powershell
dreamspace-room --image inputs\bedroom.jpg --decimate 0.2
```

It detects the objects, reconstructs a mesh for each, estimates where they sit
in a real-sized room, builds the walls procedurally, and assembles everything
into a single file.

**It works and is verified.** The limiting factor is not the pipeline but the
quality of the meshes TripoSR produces on a 4 GB card — see
[roadmap.md](roadmap.md).

## Read this first if you are picking the project up

Three facts explain most of the design:

1. **Blender ships its own Python** (3.13) which cannot see the project venv
   (3.10). Everything crosses that boundary as a JSON file.
2. **Image-to-3D models emit unit-cube meshes in arbitrary orientations.** A
   bed and a lamp come out the same size, and the chair comes out lying on its
   side. Real dimensions and an upright orientation have to be imposed
   afterwards, and that is most of what `scene/` does.
3. **A single photo has no depth.** Known furniture sizes and an assumed camera
   supply it. The output is a plausible editable layout, not a measurement.
