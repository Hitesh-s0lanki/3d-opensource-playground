# dioramic

The app. A signed-in browser client that turns a photo into a 3D object on a
rented GPU, and keeps everything it produces per user, off this machine.

## Two routes

| | |
|---|---|
| **`/`** | the landing page. Public, and one screen long: a headline, a button, and the demo - a drawing beside the mesh the app made of it, turning. It answers *what comes out of this?* by showing it rather than explaining it, which is why there is no section nav and nothing here is longer than a line. |
| **`/app`** | the studio: sidebar, stage, detail column. Signed in only — a visitor is sent to `/sign-in`, and Clerk returns them to `/app` afterwards (`NEXT_PUBLIC_CLERK_SIGN_{IN,UP}_FALLBACK_REDIRECT_URL`). |

The showcase meshes are committed at `public/samples/<id>.glb` beside the
`<id>.png` they were generated from, and which ones appear is `SHOWCASE` in
`components/landing/showcase.tsx`. They are the pipeline's own output, but not
at default settings - see below.

## Flat pictures make flat meshes

Measure a mesh by its thinnest bounding-box side over its longest. A ball is
1.00; a figurine you would call solid is 0.3-0.6; under about 0.15 is a relief,
a picture pressed into a sheet.

The shape model reads depth out of **shading, perspective and occlusion**. A
photograph is full of all three. Flat cel artwork - uniform fills behind a hard
outline - has none, so the model is handed a silhouette and does the only thing
a silhouette supports: it extrudes it. The first pass of showcase meshes came
back at 0.01 (the cat: 20 mm deep against 1.5 m wide), 0.06 and 0.20.

Two things that do **not** fix it, both measured:

- **Background removal.** The obvious suspect, and wrong. rembg isolates every
  one of these drawings correctly - 12-27 % of the frame kept, tight bounding
  boxes. Run `rembg` locally against a sample before blaming it.
- **Marching-cubes resolution.** 512 with 75 steps instead of 384/50 moved a
  test from 0.202 to 0.202. Finer meshing of a flat shape is a flat shape with
  more triangles.

What does help is **guidance** - how literally the shape stage must obey the
picture. Upstream's 5.0 is tuned for photographs, where every shadow is a cue
worth obeying. At 2.0 the model's own 3D prior gets a say:

| | guidance 5.0 | guidance 2.0 |
|---|---|---|
| little-dino | 0.204 | **0.463** |
| tin-robot | 0.061 | **0.247** |

The shipped meshes are `little-dino` at 3.5 (0.379 - solid *and* faithful; 2.0
is deeper but its face comes away) and `tin-robot` at 2.0 (0.247, properly
round). Check the back of a mesh before believing the number.

### Or give it something to read

Guidance only asks the model to lean on its prior instead of the picture. The
larger win is to stop handing it a picture with nothing in it.

**Render as a figurine first** — the switch on the object form, on when
`OPENAI_API_KEY` is set — sends the upload through gpt-image-1 and gets back
the same character as a lit vinyl figure. One call happens to fix three
separate things at once:

- **shading**, the whole point: gradients and ambient occlusion where there
  were flat fills, which is the signal the shape stage was missing
- **pose**: the prompt asks for three-quarter view, and a frontal orthographic
  drawing is the worst case for monocular reconstruction — nothing in it says
  how deep the subject is
- **the cutout**: a transparent background means the Modal side skips rembg,
  whose u2net is a photo segmenter and is at its worst on exactly what cartoon
  art is made of — white-on-white socks, pencil-thin limbs, pale outlines

It does not make this multiview. One image is still one image, so the back of
the figure is still invented. And it is redrawing the character rather than
photographing it: the likeness drifts, differently every call. So the render is
shown in the dialog and becomes the job's input only if you accept it — a bad
one costs a retry, not a credit and two minutes of L40S. Renders are capped per
day (`DAILY_FIGURINES` in [src/lib/credits.ts](src/lib/credits.ts)) rather than
charged against the allowance, since rejecting one is the feature working.

With a figurine in hand, set guidance back to **strict** — it has its own
shading now, so there is something worth obeying.

It is a lever, not a cure, and it costs something. Depth is not the same as
correctness: the dinosaur at 2.0 is 0.463 and *wrong* - its face comes away
from its head as a flat card - while the robot at 2.0 is 0.247 and genuinely
good. It also needs something in the drawing to amplify, and a picture with no
shading at all has nothing: a Shin-chan frame measured 0.204 at guidance 5.0
and 0.204 at 2.0. The cat is beyond help at any setting - 0.007, regenerated.

So: the control is in the New run dialog as **Follow the picture**, defaulting
to strict, because for the photographs this app is actually for, strict is
right. Loosening it is for artwork, and it is a trade rather than a fix.

**The real answer is the input.** Line art is out of distribution for a model
trained on renders of real 3D assets. Photographs of real objects are what it
does well, and are what the showcase should be made of.

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
fallback mode any more — plus one optional fifth:

| variable | from | holds |
|---|---|---|
| `DATABASE_URL` | [Neon](https://console.neon.tech) | runs, jobs, placements |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | [Clerk](https://dashboard.clerk.com) | who each row belongs to |
| `BLOB_READ_WRITE_TOKEN` | Vercel → Storage → Blob | photo and mesh bytes |
| `MODAL_ENDPOINT`, `MODAL_TOKEN` | `modal deploy scripts/modal_app/hunyuan3d.py` | the GPU |
| `OPENAI_API_KEY` *(optional)* | [OpenAI](https://platform.openai.com/api-keys) | the figurine step |

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
| `POST /api/jobs` | charge a credit, store the photo, insert the row, `spawn` the Modal call, save its id |
| `GET /api/jobs` | for each running row, ask Modal if it is done; if so store the mesh, write the run, close the job — and answer with the credit balance |

The viewer already polled `/api/jobs` every two seconds, and that poll is now
the mechanism. Because no state is held in process memory between the two,
a redeploy, a cold start, or the user closing the tab mid-generation loses
nothing — the next poll from any session picks it up.

Jobs no longer queue. The one-at-a-time rule existed because two concurrent
TripoSR runs OOM a 4 GB card; Modal gives each call its own container.

**One collect at a time.** Polling every two seconds is free while the answer
is "not yet", and expensive the instant it is not: every poll still in flight
starts downloading the same 5–22 MB GLB. Measured, before this was fixed — 31
pending polls answered in ~0.4 s each, then five that returned the mesh in
153–228 s of wall clock against ~1 s of execution, because they queued behind
each other on one asgi event loop that was making a *blocking* Modal call. The
job is only marked done when one of those lands, so a three-minute generation
was closing twenty minutes later.

Two changes, both needed:

- `/result` on the Modal side now uses `await handle.get.aio(timeout=0)` rather
  than the sync form. Same finished call: **0.53 s** for 2.9 MB, against 153 s.
- `advanceOne` claims `jobs.polling_since` before it asks Modal, and releases it
  after — the same conditional-UPDATE lock `credit_refunded` uses. Overlapping
  polls find the claim taken and return immediately instead of starting a second
  download. A claim older than a minute is treated as abandoned, since the
  holder is a serverless invocation that can be killed mid-transfer.

### Telling you it landed

A minute and a half is long enough that nobody watches it, so the finish has to
find the user rather than the other way round. Four channels, in increasing
order of how much they interrupt:

- **The tab title.** `(1) generating…` while it runs, `(1) ✅ ready` once
  something finished that has not been looked at. Costs no permission, is
  visible from whatever the user switched to, and does not expire.
- **A toast**, with an *Open* action, held for ten seconds rather than four.
- **A system notification**, carrying the source photo as its icon, raised only
  when the tab is hidden or unfocused — a desktop alert for a page you are
  already looking at is noise. Opt-in, from a button in the waiting room, which
  is the one moment the question is on the user's mind. Clicking it focuses the
  tab and opens the run.
- **A chime**, synthesised in the browser so there is no asset to fetch at the
  moment the tab is in the background. Shares the notification's opt-in, and
  the AudioContext is built on that same click — without a gesture it would be
  born suspended.

The switch is remembered in `localStorage` (`dioramic:alerts-muted`) separately
from the browser permission, so turning alerts off is one click and turning
them back on does not need a second prompt. The sidebar footer carries it once
the waiting room is gone.

**A hidden tab keeps polling.** It used to stop dead, which cost more than
freshness: `GET /api/jobs` is what collects a finished Modal call, so a tab
switched away from was a run that stopped finishing. While something is in
flight the poll continues at 15 s instead of 2 s; with nothing running, and for
the runs catalog either way, a background tab still does nothing.

## Credits

Every account gets **5 free generations**. One job costs one credit.

- **Charged at submit**, before the photo is decoded or uploaded. The GPU
  minute is committed the moment Modal accepts the call, so charging on
  completion would let one credit start any number of runs at once — and a
  user with nothing left is turned away in milliseconds rather than after a
  12-megapixel HEIC has been converted.
- **Refunded when the job produces nothing**: it fails on Modal, the submit
  never reaches Modal, storing the finished mesh fails, or the user cancels.
  Only a mesh you can open is something you paid for.
- **`credits.spent` counts up rather than down**, and every refund is guarded
  by `jobs.credit_refunded`, so an overlapping poll cannot pay twice and a
  refund can never hand back more than was taken.
- **One conditional `UPDATE` is the whole concurrency story.** Neon's HTTP
  driver has no interactive transaction, so "check, then decrement" in two
  statements would let two simultaneous submits both pass the check;
  `where spent < granted` inside the update is the check.
- Running out is a **402** with the reason in `error`. The client already knew
  — the sidebar shows the balance and disables **+ New** — but the balance on
  screen can be stale if another tab spent it.

The allowance is granted lazily on first sight, since Clerk does not tell the
app about new sign-ups. To top someone up, raise `granted` on their row:
`UPDATE credits SET granted = 20 WHERE user_id = '<clerk id>'`.

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
  log, whether its credit has been refunded, and queued / started / finished
  timestamps.
- **`credits`** — one row per user: `granted` (5 by default) and `spent`.
  Remaining is the difference.

Bytes stay out of Postgres deliberately. A GLB is 4–22 MB; Neon's free tier is
0.5 GB and its HTTP driver is a poor pipe for values that size. The rows carry
the key, the size and the hash instead.

`GET /api/catalog` returns this user's rows raw.

## Design

Light theme only, by design — a cool indigo studio palette with Cormorant
Garamond display headings and Inter body text. UI is shadcn/ui (Base UI) +
Tailwind v4; rendering is plain three.js.
