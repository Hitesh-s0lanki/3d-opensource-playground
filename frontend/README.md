# dioramic

The app. A signed-in browser client that turns a photo into a 3D object on a
rented GPU, and keeps everything it produces per user, off this machine.

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
cd frontend
npm install
Copy-Item .env.example .env          # then fill it in
npm run db:migrate                   # create the tables
npm run dev                          # http://localhost:3000
```

Four services, all with free tiers, all required — there is no local
fallback mode any more:

| variable | from | holds |
|---|---|---|
| `DATABASE_URL` | [Neon](https://console.neon.tech) | runs, jobs, placements |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | [Clerk](https://dashboard.clerk.com) | who each row belongs to |
| `BLOB_READ_WRITE_TOKEN` | Vercel → Storage → Blob | photo and mesh bytes |
| `MODAL_ENDPOINT`, `MODAL_TOKEN` | `modal deploy scripts/modal_app/hunyuan3d.py` | the GPU |

Every one is documented in [.env.example](.env.example).

## Nothing is stored locally

There is no `outputs/` directory, no `inputs/`, no venv, and no subprocess.
The three modules that used to walk the filesystem — `discover.ts`,
`paths.ts`, `db/sync.ts` — are gone.

```
upload ──> blob storage   u/<userId>/<slug>/photo.jpg
             │
             └─ bytes ──> Modal (Hunyuan3D-2.1) ──> .glb bytes
                                                      │
                            blob storage <────────────┘
                              u/<userId>/<slug>/<slug>.glb
                                     ▲
                            Neon row points at both keys
```

**Every row belongs to one Clerk user.** `userId` is a column on `runs` and
`jobs`; `run_items` inherits it through its run. There is no query in the app
that reads a run without naming its owner, and no shared or global scope.

**Every blob key starts `u/<userId>/`.** Blobs are written `private`, so they
have no publicly fetchable URL; the only way to read one is
`GET /api/files/<key>`, which checks the prefix against the caller and answers
404 — not 403 — for someone else's key, since there is no reason to confirm
that another user's file exists.

## Jobs, without a worker

A textured generation takes 60–105 seconds, longer than a serverless request
should stay open, and there is no background worker to wait on it. So a job is
a row plus a Modal call id:

| | |
|---|---|
| `POST /api/jobs` | store the photo, insert the row, `spawn` the Modal call, save its id |
| `GET /api/jobs` | for each running row, ask Modal if it is done; if so store the mesh, write the run, close the job |

The viewer already polled `/api/jobs` every two seconds, and that poll is now
the mechanism. Because no state is held in process memory between the two,
a redeploy, a cold start, or the user closing the tab mid-generation loses
nothing — the next poll from any session picks it up.

Jobs no longer queue. The one-at-a-time rule existed because two concurrent
TripoSR runs OOM a 4 GB card; Modal gives each call its own container.

## What it does

- **Runs, not files.** `/api/runs` reads this user's rows. New runs appear on
  their own; no refresh.
- **three.js stage.** Orbit controls (drag to orbit, right-drag to pan, scroll
  to zoom — zooming aims at the cursor, and **double-click re-pivots the orbit**
  onto the clicked spot, or re-frames the model from empty space), environment
  lighting, and the keyboard shortcuts: `F` fit, `W` wireframe, `G` ground grid
  (1 m / 0.25 m / 0.1 m by object size), `B` bounding box, `E` dark backdrop,
  `R` spin, `↑`/`↓` previous / next object in the run. Drop a `.glb` from
  anywhere onto the viewport to inspect it.
- **Provenance.** Click a box on the photo, or a tile in the pipeline strip,
  and the detail column becomes that object's story: the patch of photograph,
  the crop, the mesh that came back, and where it was placed. Detector boxes
  come from the run's `spec` column.
- **Generation.** **+ New**, or dropping an image onto the viewport. *Whole
  room* is shown but disabled: that pipeline's last stage is Blender and it
  has not been ported to Modal.

## Database — Neon Postgres + Drizzle ORM

`npm run db:migrate` applies [drizzle/](drizzle/); `npm run db:studio` opens
Drizzle Studio on the live tables.

- **`runs`** — one per generation: `userId`, a `slug` unique per user, kind,
  the photo's blob key and dimensions, the mesh's blob key, size and
  **SHA-256**, and `spec` — what used to be `scene.json` on disk, now jsonb.
- **`run_items`** — every object inside a run: status (placed / dropped /
  orphan), crop and mesh keys + sizes, position, target size, rotation,
  detection box, label and confidence.
- **`jobs`** — one per generation, live and historical: state, stage, error,
  options, the uploaded photo's key, the Modal call id while in flight, the
  log, and queued / started / finished timestamps.

Bytes stay out of Postgres deliberately. A GLB is 4–22 MB; Neon's free tier is
0.5 GB and its HTTP driver is a poor pipe for values that size. The rows carry
the key, the size and the hash instead.

`GET /api/catalog` returns this user's rows raw.

## Design

Light theme only, by design — a cool indigo studio palette with Cormorant
Garamond display headings and Inter body text. UI is shadcn/ui (Base UI) +
Tailwind v4; rendering is plain three.js.
