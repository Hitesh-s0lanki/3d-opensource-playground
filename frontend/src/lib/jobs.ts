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
 */

import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import imageSize from "image-size";
import { getDb } from "@/db";
import { jobs } from "@/db/schema";
import * as modal from "./modal";
import { uniqueSlug, upsertRun } from "./runs";
import { MAX_UPLOAD, blobConfigured, blobUrl, safeSegment, userKey, writeBlob } from "./storage";
import type { JobKind, JobSnapshot, JobState } from "./types";

type JobRow = typeof jobs.$inferSelect;

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

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

/** An image name that is safe as a blob key segment. */
export function safeImageName(raw: string): string {
  const name = safeSegment(raw, "upload");
  const dot = name.lastIndexOf(".");
  const suffix = dot > 0 ? name.slice(dot).toLowerCase() : "";
  if (!IMAGE_EXT.has(suffix)) throw new Error(`not an image: ${raw}`);
  return name;
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

  const db = getDb();
  const imageName = safeImageName(filename);
  const slug = await uniqueSlug(userId, stem(imageName));

  const stored = await writeBlob(
    userKey(userId, slug, imageName),
    data,
    contentTypeFor(imageName),
  );

  // Measured here, on bytes already in memory, rather than by fetching the
  // photo back when the job finishes.
  let width: number | null = null;
  let height: number | null = null;
  try {
    const probed = imageSize(new Uint8Array(data));
    width = probed.width ?? null;
    height = probed.height ?? null;
  } catch {
    // Dimensions decorate the detail panel; not worth failing an upload for.
  }

  const [row] = await db
    .insert(jobs)
    .values({
      userId,
      kind,
      state: "queued",
      stage: "uploading",
      options,
      imageKey: stored.key,
      imageName,
      imageBytes: stored.bytes,
      imageWidth: width,
      imageHeight: height,
      runSlug: slug,
      log: [`uploaded ${imageName} (${Math.round(data.length / 1e3)} kB)`],
    })
    .returning();

  try {
    const callId = await modal.submit(data, modalOptions(options));
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
    const [failed] = await db
      .update(jobs)
      .set({
        state: "failed",
        stage: "",
        error: message,
        finishedAt: new Date(),
        log: [...(row.log ?? []), message],
      })
      .where(eq(jobs.id, row.id))
      .returning();
    return snapshot(failed);
  }
}

function contentTypeFor(name: string): string {
  const suffix = name.slice(name.lastIndexOf(".")).toLowerCase();
  return (
    { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".bmp": "image/bmp" }[
      suffix
    ] ?? "application/octet-stream"
  );
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
    await db
      .update(jobs)
      .set({
        state: "failed",
        stage: "",
        error: result.error,
        finishedAt: new Date(),
        modalCallId: null,
        log: [...(row.log ?? []), result.error],
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
    const message = exc instanceof Error ? exc.message : String(exc);
    await db
      .update(jobs)
      .set({
        state: "failed",
        stage: "",
        error: `generated, but storing it failed: ${message}`,
        finishedAt: new Date(),
        modalCallId: null,
        log: [...(row.log ?? []), message],
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
  await db
    .update(jobs)
    .set({
      state: "cancelled",
      stage: "",
      finishedAt: new Date(),
      modalCallId: null,
      log: [...(row.log ?? []), "cancelled"],
    })
    .where(eq(jobs.id, row.id));
  return true;
}
