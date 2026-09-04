/** Generation jobs, owned by a user and held in Neon.
 *
 * The old runner spawned the venv's Python and scraped its stdout. Nothing
 * runs locally now, so a job is a row plus a Modal call id, and the shape of
 * the thing changed accordingly:
 *
 *   POST /api/jobs   upload the photo -> blob, insert the row, hand the bytes
 *                    to Modal, store the call id
 *   GET  /api/jobs   for every still-running row, ask Modal whether it is
 *                    done; if it is, store the mesh and write the run
 *
 * Nothing is held in process memory between those two, which is what makes it
 * survive a serverless cold start, a redeploy, or the user closing the tab
 * mid-generation. There is also no queue any more: the 4 GB card that forced
 * one-at-a-time is not in the picture, and Modal scales containers itself.
 *
 * A job costs one credit, taken at submit and given back if the job never
 * produces a mesh - see `credits.ts` for why it is charged that way round.
 */

import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { getDb } from "@/db";
import { jobs } from "@/db/schema";
import { refundCredit, spendCredit } from "./credits";
import { type NormalizedImage, normalizeImage } from "./images";
import * as modal from "./modal";
import { uniqueSlug, upsertRun } from "./runs";
import { MAX_UPLOAD, blobConfigured, blobUrl, userKey, writeBlob } from "./storage";
import type { JobKind, JobSnapshot, JobState } from "./types";

type JobRow = typeof jobs.$inferSelect;

const KINDS: Record<JobKind, { label: string }> = {
  object: { label: "image → mesh" },
  room: { label: "photo → scene" },
};

/** The room pipeline is four stages - detect, reconstruct, layout, assemble -
 * and the last of them is Blender. None of that exists on Modal yet, so the
 * kind is still modelled everywhere but cannot be submitted. */
export const ROOM_AVAILABLE = false;

export function isJobKind(kind: string): kind is JobKind {
  return kind in KINDS;
}

export function jobUnavailableReason(kind: JobKind): string | null {
  if (kind === "room" && !ROOM_AVAILABLE) {
    return "the room pipeline needs Blender and has not been ported to the cloud yet - single objects only for now";
  }
  if (!modal.modalConfigured()) {
    return "generation is not configured - set MODAL_ENDPOINT and MODAL_TOKEN";
  }
  if (!blobConfigured()) {
    return "storage is not configured - set BLOB_READ_WRITE_TOKEN";
  }
  return null;
}

function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function snapshot(row: JobRow): JobSnapshot {
  const end = row.finishedAt ?? new Date();
  const started = row.startedAt ?? row.queuedAt;
  return {
    id: row.id,
    kind: row.kind as JobKind,
    label: KINDS[row.kind as JobKind]?.label ?? row.kind,
    image: row.imageName,
    image_url: blobUrl(row.imageKey),
    state: row.state as JobState,
    stage: row.stage ?? "",
    options: row.options,
    run_id: row.runSlug ?? "",
    elapsed: row.startedAt
      ? Math.round((end.getTime() - row.startedAt.getTime()) / 100) / 10
      : 0,
    waited: Math.round((started.getTime() - row.queuedAt.getTime()) / 100) / 10,
    returncode: null,
    error: row.error ?? "",
    log: row.log ?? [],
  };
}

function modalOptions(options: Record<string, string>): modal.ModalOptions {
  const number = (key: string, fallback?: number) => {
    const raw = options[key];
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    texture: !(options.no_texture === "true" || options.no_texture === "1"),
    steps: number("steps"),
    guidance_scale: number("guidance_scale"),
    octree_resolution: number("octree_resolution") ?? number("mc_resolution"),
    seed: number("seed"),
    max_num_view: number("max_num_view"),
    view_resolution: number("view_resolution"),
  };
}

/** How long one poll may hold a job's collect before another may take over.
 *
 * The holder is a serverless invocation, so it can be killed mid-download and
 * never release the claim. This is the ceiling on how long that wedges a job:
 * long enough that a legitimately slow transfer is never stolen from,
 * short enough that a dead instance costs one extra minute rather than a run.
 */
const POLL_CLAIM_STALE_MS = 60_000;

/** Take the right to ask Modal about this job, or return null if someone else
 * already has it.
 *
 * The conditional UPDATE is the lock, the same way `creditRefunded` is: two
 * polls two seconds apart both run this, and only the one that moves
 * `polling_since` from null-or-stale to now proceeds. Without it, every poll
 * during a generation started its own collect, and the ones that overlapped
 * the moment the mesh appeared all downloaded the same GLB at once.
 *
 * Returns the timestamp it wrote, which is the receipt `releasePoll` needs so
 * it cannot release a claim that has since been taken over.
 */
async function claimPoll(jobId: string): Promise<Date | null> {
  const db = getDb();
  const now = new Date();
  const [claimed] = await db
    .update(jobs)
    .set({ pollingSince: now })
    .where(
      and(
        eq(jobs.id, jobId),
        or(isNull(jobs.pollingSince), lt(jobs.pollingSince, new Date(now.getTime() - POLL_CLAIM_STALE_MS))),
      ),
    )
    .returning({ id: jobs.id });
  return claimed ? now : null;
}

/** Hand the claim back, but only if it is still ours. */
async function releasePoll(jobId: string, held: Date): Promise<void> {
  const db = getDb();
  await db
    .update(jobs)
    .set({ pollingSince: null })
    .where(and(eq(jobs.id, jobId), eq(jobs.pollingSince, held)));
}

/** Give this job's credit back, at most once.
 *
 * The conditional update is the lock. Two overlapping polls can both watch the
 * same Modal call fail, and both will try to pay; only the one that flips
 * `credit_refunded` from false to true gets to. */
async function refundJobCredit(userId: string, jobId: string): Promise<boolean> {
  const db = getDb();
  const [flipped] = await db
    .update(jobs)
    .set({ creditRefunded: true })
    .where(and(eq(jobs.id, jobId), eq(jobs.creditRefunded, false)))
    .returning({ id: jobs.id });
  if (!flipped) return false;
  await refundCredit(userId);
  return true;
}

/** Upload the photo, insert the row, hand it to Modal. */
export async function submitJob(
  userId: string,
  kind: JobKind,
  filename: string,
  data: Buffer,
  options: Record<string, string>,
): Promise<JobSnapshot> {
  if (!data.length) throw new Error("empty upload");
  if (data.length > MAX_UPLOAD) {
    throw new Error(
      `image is ${Math.round(data.length / 1e6)} MB; the limit is ${MAX_UPLOAD / 1e6} MB`,
    );
  }
  const blocked = jobUnavailableReason(kind);
  if (blocked) throw new Error(blocked);

  // Charged before the photo is decoded or stored, so a user with nothing left
  // is turned away in milliseconds rather than after a 12-megapixel HEIC has
  // been converted and uploaded. Everything from here to the insert is
  // wrapped, because a credit taken for a job that never existed is a credit
  // the user can never spend or see.
  const balance = await spendCredit(userId);

  // Decoded and re-encoded here, before anything is stored, so the browser
  // showing the photo back and Pillow opening it on Modal are looking at the
  // same bytes in a format they both read. `image` from here on is the
  // normalised upload, never what arrived.
  const db = getDb();
  let row: JobRow;
  let image: NormalizedImage;
  try {
    image = await normalizeImage(filename, data);
    const slug = await uniqueSlug(userId, stem(image.name));

    const stored = await writeBlob(
      userKey(userId, slug, image.name),
      image.data,
      image.contentType,
    );

    const uploaded = `uploaded ${image.name} (${Math.round(image.data.length / 1e3)} kB)`;
    const charged = `1 credit spent · ${balance.remaining} of ${balance.granted} left`;

    [row] = await db
      .insert(jobs)
      .values({
        userId,
        kind,
        state: "queued",
        stage: "uploading",
        options,
        imageKey: stored.key,
        imageName: image.name,
        imageBytes: stored.bytes,
        imageWidth: image.width,
        imageHeight: image.height,
        runSlug: slug,
        log: image.note ? [uploaded, image.note, charged] : [uploaded, charged],
      })
      .returning();
  } catch (exc) {
    // No job row means nothing will ever refund this one later.
    await refundCredit(userId);
    throw exc;
  }

  try {
    const callId = await modal.submit(image.data, modalOptions(options));
    const [running] = await db
      .update(jobs)
      .set({
        state: "running",
        stage: "generating on modal",
        modalCallId: callId,
        startedAt: new Date(),
        log: [...(row.log ?? []), `modal call ${callId}`],
      })
      .where(eq(jobs.id, row.id))
      .returning();
    return snapshot(running);
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    const refunded = await refundJobCredit(userId, row.id);
    const [failed] = await db
      .update(jobs)
      .set({
        state: "failed",
        stage: "",
        error: message,
        finishedAt: new Date(),
        log: [...(row.log ?? []), message, ...(refunded ? ["credit refunded"] : [])],
      })
      .where(eq(jobs.id, row.id))
      .returning();
    return snapshot(failed);
  }
}

/** Poll Modal for every running job of this user and finish the ones that are
 * ready. Called from GET /api/jobs, which the viewer already polls. */
export async function advanceJobs(userId: string): Promise<void> {
  const db = getDb();
  const running = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.userId, userId), inArray(jobs.state, ["queued", "running"])));

  const live = running.filter((row) => row.modalCallId);
  if (!live.length) return;

  await Promise.all(live.map((row) => advanceOne(userId, row)));
}

async function advanceOne(userId: string, row: JobRow): Promise<void> {
  // Somebody else is already asking about this job; a second answer would be
  // the same answer, bought with a second multi-megabyte download.
  const held = await claimPoll(row.id);
  if (!held) return;
  try {
    await collectOne(userId, row);
  } finally {
    await releasePoll(row.id, held);
  }
}

async function collectOne(userId: string, row: JobRow): Promise<void> {
  const db = getDb();
  let result: modal.ModalResult;
  try {
    result = await modal.collect(row.modalCallId!);
  } catch (exc) {
    console.error("[jobs] poll failed:", exc instanceof Error ? exc.message : exc);
    return;
  }
  if (result.state === "pending") return;

  if (result.state === "failed") {
    // The GPU ran and gave nothing back, so the credit goes back too.
    const refunded = await refundJobCredit(userId, row.id);
    await db
      .update(jobs)
      .set({
        state: "failed",
        stage: "",
        error: result.error,
        finishedAt: new Date(),
        modalCallId: null,
        log: [...(row.log ?? []), result.error, ...(refunded ? ["credit refunded"] : [])],
      })
      .where(eq(jobs.id, row.id));
    return;
  }

  // The mesh is here. Store it, write the run, then close the job - in that
  // order, so a failure halfway leaves the job visibly unfinished rather than
  // pointing at a run that has no bytes behind it.
  try {
    const slug = row.runSlug ?? stem(row.imageName);
    const mesh = await writeBlob(
      userKey(userId, slug, `${slug}.glb`),
      result.glb,
      "model/gltf-binary",
    );

    await upsertRun(userId, {
      slug,
      kind: "object",
      photoKey: row.imageKey,
      photoName: row.imageName,
      photoBytes: row.imageBytes,
      photoWidth: row.imageWidth,
      photoHeight: row.imageHeight,
      renderKey: mesh.key,
      renderBytes: mesh.bytes,
      renderSha256: createHash("sha256").update(result.glb).digest("hex"),
    });

    await db
      .update(jobs)
      .set({
        state: "done",
        stage: "finished",
        finishedAt: new Date(),
        modalCallId: null,
        runSlug: slug,
        log: [
          ...(row.log ?? []),
          `stored ${slug}.glb (${(mesh.bytes / 1e6).toFixed(1)} MB)`,
        ],
      })
      .where(eq(jobs.id, row.id));
  } catch (exc) {
    // The mesh existed for a moment but the user will never see it; on our
    // side of the line, so they are not charged for it.
    const message = exc instanceof Error ? exc.message : String(exc);
    const refunded = await refundJobCredit(userId, row.id);
    await db
      .update(jobs)
      .set({
        state: "failed",
        stage: "",
        error: `generated, but storing it failed: ${message}`,
        finishedAt: new Date(),
        modalCallId: null,
        log: [...(row.log ?? []), message, ...(refunded ? ["credit refunded"] : [])],
      })
      .where(eq(jobs.id, row.id));
  }
}

export async function listJobs(userId: string, limit = 50): Promise<JobSnapshot[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(jobs)
    .where(eq(jobs.userId, userId))
    .orderBy(desc(jobs.queuedAt))
    .limit(limit);
  // The viewer renders oldest-first in the sidebar.
  return rows.reverse().map(snapshot);
}

export async function cancelJob(userId: string, jobId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.userId, userId), eq(jobs.id, jobId)))
    .limit(1);
  if (!row || ["done", "failed", "cancelled"].includes(row.state)) return false;

  if (row.modalCallId) await modal.cancel(row.modalCallId);
  const refunded = await refundJobCredit(userId, row.id);
  await db
    .update(jobs)
    .set({
      state: "cancelled",
      stage: "",
      finishedAt: new Date(),
      modalCallId: null,
      log: [...(row.log ?? []), "cancelled", ...(refunded ? ["credit refunded"] : [])],
    })
    .where(eq(jobs.id, row.id));
  return true;
}
