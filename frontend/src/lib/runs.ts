/** Reading and writing runs, scoped to one user.
 *
 * A run exists because a row says so - nothing is inferred from a directory
 * listing or a filename convention. The shapes below are the same ones the
 * viewer already consumed, so the client did not have to change.
 *
 * Every function here takes a userId and every query filters on it. That is
 * the entire access-control story - there is no path that reads a run without
 * naming its owner.
 */

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { runItems, runs } from "@/db/schema";
import { blobUrl } from "./storage";
import type { FileRef, ImageRef, Run, RunItem, RunKind } from "./types";

type RunRow = typeof runs.$inferSelect;
type ItemRow = typeof runItems.$inferSelect;

const seconds = (date: Date | null) => (date ? date.getTime() / 1000 : 0);

function fileRef(
  key: string | null,
  bytes: number | null,
  name: string,
  mtime: Date | null,
): FileRef | null {
  if (!key) return null;
  return { name, url: blobUrl(key), bytes: bytes ?? 0, mtime: seconds(mtime) };
}

function toItem(row: ItemRow, mtime: Date | null): RunItem {
  const crop = fileRef(row.cropKey, row.cropBytes, `${row.name}.png`, mtime);
  return {
    name: row.name,
    kind: row.kind,
    status: row.status as RunItem["status"],
    crop: crop as ImageRef | null,
    mesh: fileRef(row.meshKey, row.meshBytes, `${row.name}.glb`, mtime),
    position: row.position,
    size: row.size,
    rotation_z: row.rotationZ,
    auto_orient: row.autoOrient,
    box: row.box,
    box_from: row.boxFrom as RunItem["box_from"],
    score: row.score,
    label: row.label,
  };
}

function toRun(row: RunRow, items: ItemRow[]): Run {
  const photo: ImageRef | null = row.photoKey
    ? {
        name: row.photoName ?? "photo",
        url: blobUrl(row.photoKey),
        bytes: row.photoBytes ?? 0,
        mtime: seconds(row.updatedAt),
        width: row.photoWidth ?? undefined,
        height: row.photoHeight ?? undefined,
      }
    : null;

  return {
    id: row.slug,
    kind: row.kind as RunKind,
    photo,
    render: fileRef(row.renderKey, row.renderBytes, `${row.slug}.glb`, row.updatedAt),
    spec: row.spec
      ? { url: null, path: `${row.slug}/scene.json`, room: row.room ?? {} }
      : null,
    items: items.map((item) => toItem(item, row.updatedAt)),
  };
}

/** Every run this user has, newest first. */
export async function listRuns(userId: string): Promise<Run[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(runs)
    .where(eq(runs.userId, userId))
    .orderBy(desc(runs.updatedAt));
  if (!rows.length) return [];

  const ids = new Set(rows.map((row) => row.id));
  // One query for every item of every run, then grouped in memory: a user has
  // tens of runs, not thousands, and this keeps it to two round trips.
  const allItems = await db
    .select()
    .from(runItems)
    .innerJoin(runs, eq(runItems.runId, runs.id))
    .where(eq(runs.userId, userId));

  const grouped = new Map<string, ItemRow[]>();
  for (const joined of allItems) {
    const item = joined.run_items;
    if (!ids.has(item.runId)) continue;
    const bucket = grouped.get(item.runId);
    if (bucket) bucket.push(item);
    else grouped.set(item.runId, [item]);
  }

  return rows.map((row) => toRun(row, grouped.get(row.id) ?? []));
}

/** One run by its user-facing slug, or null. */
export async function getRun(userId: string, slug: string): Promise<Run | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.userId, userId), eq(runs.slug, slug)))
    .limit(1);
  if (!row) return null;
  const items = await db.select().from(runItems).where(eq(runItems.runId, row.id));
  return toRun(row, items);
}

export interface NewRun {
  slug: string;
  kind: RunKind;
  photoKey: string | null;
  photoName: string | null;
  photoBytes: number | null;
  photoWidth?: number | null;
  photoHeight?: number | null;
  renderKey: string | null;
  renderBytes: number | null;
  renderSha256: string | null;
  spec?: Record<string, unknown> | null;
  room?: Record<string, unknown> | null;
}

/** Record a finished generation. Re-running the same slug replaces it, which
 * matches the blob write - `allowOverwrite` means the old mesh is gone too. */
export async function upsertRun(userId: string, run: NewRun): Promise<string> {
  const db = getDb();
  const row = {
    kind: run.kind,
    photoKey: run.photoKey,
    photoName: run.photoName,
    photoBytes: run.photoBytes,
    photoWidth: run.photoWidth ?? null,
    photoHeight: run.photoHeight ?? null,
    renderKey: run.renderKey,
    renderBytes: run.renderBytes,
    renderSha256: run.renderSha256,
    spec: run.spec ?? null,
    room: run.room ?? null,
    updatedAt: new Date(),
  };
  const [inserted] = await db
    .insert(runs)
    .values({ userId, slug: run.slug, ...row })
    .onConflictDoUpdate({ target: [runs.userId, runs.slug], set: row })
    .returning({ id: runs.id });
  return inserted.id;
}

/** A slug that is free for this user: "chair", then "chair-2", "chair-3". */
export async function uniqueSlug(userId: string, wanted: string): Promise<string> {
  const db = getDb();
  const taken = new Set(
    (
      await db.select({ slug: runs.slug }).from(runs).where(eq(runs.userId, userId))
    ).map((row) => row.slug),
  );
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) {
    const candidate = `${wanted}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
