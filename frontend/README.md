# diorama

The browser inspector for the dreamspace pipeline, rebuilt as a Next.js app —
the successor to `dreamspace-view`. It serves the same `outputs/` directory,
draws the same run graph, and starts the same CLIs.

```
sidebar          stage                       detail
────────┬───────────────────────────┬──────────────────────
runs    │  the mesh, in 3D          │  the photo it came
jobs    │  (three.js)               │  from, boxes drawn on
        │                           │  it; the pipeline
        │                           │  strip; one object's
        │                           │  end-to-end story
```

## Run it

```powershell
cd web
npm install
npm run dev          # http://localhost:3000
```

The app finds the repo root (the folder with `outputs/`, `inputs/` and
`.venv/`) as its parent directory. Override with env vars if the layout
differs:

| variable | default | meaning |
|---|---|---|
| `DREAMSPACE_ROOT` | `..` | repo root |
| `DREAMSPACE_OUTPUTS` | `<root>/outputs` | where runs live |
| `DREAMSPACE_INPUTS` | `<root>/inputs` | where source photos live |
| `DREAMSPACE_PYTHON` | `<root>/.venv/Scripts/python.exe` | interpreter that runs the pipeline |

Without a venv the app still works read-only; the **+ New** button explains
what is missing.

## What it does

- **Runs, not files.** `/api/runs` walks `outputs/` back into runs — `room`,
  `scene`, `object`, `images` — with the same naming-convention logic as the
  Python viewer's `runs.py`. New runs appear on their own; no refresh.
- **three.js stage.** Orbit controls (drag to orbit, right-drag to pan, scroll
  to zoom — zooming aims at the cursor, and **double-click re-pivots the orbit**
  onto the clicked spot, or re-frames the model from empty space), environment
  lighting, and the original keyboard shortcuts: `F` fit, `W` wireframe, `G`
  ground grid (1 m / 0.25 m / 0.1 m by object size), `B` bounding box, `E` dark
  backdrop, `R` spin, `↑`/`↓` previous / next object in the run. Drop a `.glb`
  from anywhere onto the viewport to inspect it.
- **Provenance.** Click a box on the photo, or a tile in the pipeline strip,
  and the detail column becomes that object's story: the patch of photograph,
  the crop, the mesh that came back, and where it was placed. Detector boxes
  come from `scene.json`; for older runs the `.provenance.json` cache written
  by the Python viewer is read as-is (recovering boxes by template match stays
  a Python-side job).
- **Generation.** **+ New** (or dropping an image onto the viewport) uploads
  into `inputs/` and spawns `dreamspace-generate` or `dreamspace-room` from the
  repo venv, streaming output into a job card with the current stage and a
  Stop button. Jobs run one at a time — two concurrent TripoSR runs OOM a 4 GB
  card. A wide image preselects *Whole room*.
- **File serving.** `/api/files/outputs/...` and `/api/files/inputs/...` serve
  meshes and photos with correct glTF MIME types; paths cannot escape either
  directory, uploads are capped at 40 MB and stripped to a tame basename.

## Database — Neon Postgres + Drizzle ORM

Optional but recommended: a durable catalog of everything the pipeline has
produced, in [Neon](https://neon.tech). Setup:

```powershell
cd web
copy .env.example .env     # paste your Neon connection string into it
npm run db:push            # create the tables
npm run dev
```

The sidebar footer shows a green **neon** dot once syncing works.

What gets stored, and when:

- **`runs`** — one row per run, upserted automatically whenever `/api/runs`
  discovers something new or changed (so every newly generated result lands in
  the catalog by itself): kind, source photo + dimensions, the assembled GLB's
  path / size / mtime and a **SHA-256 of its bytes**, the scene.json path and
  room parameters.
- **`run_items`** — every object inside a run: status (placed / dropped /
  orphan), crop and mesh paths + sizes, position, target size, rotation,
  detection box, label and confidence.
- **`jobs`** — a history row for every generation the viewer ran: kind, image,
  CLI options, final state, exit code, error, the log tail, and queued /
  started / finished timestamps.

Rows are never deleted by the sync: a run whose files get cleaned out of
`outputs/` stays in the catalog as history. `GET /api/catalog` returns the
whole record (all runs ever seen + the last 200 jobs); `npm run db:studio`
opens Drizzle Studio on the live tables.

The GLB **bytes** deliberately stay on disk — Postgres rows are the wrong home
for 20 MB meshes (the serverless driver caps payloads well below that, and the
free tier is 0.5 GB); the catalog stores their path, size and hash instead. If
the meshes ever need to live off-machine, that is an object-storage job (S3 /
Vercel Blob), and the schema already has the columns to point at it.

Without `DATABASE_URL` everything still works file-only — the database layer
is a strict add-on and every write is best-effort, so a down database never
breaks the viewer.

## Design

Light theme only, by design — a cool indigo studio palette with Cormorant
Garamond display headings and Inter body text. UI is shadcn/ui (Base UI) +
Tailwind v4; rendering is plain three.js.
