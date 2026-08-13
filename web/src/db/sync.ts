/** Keep the Neon catalog in step with what discovery finds on disk.
 *
 * Discovery stays the source of truth for the UI (the files are right there);
 * the database is the durable record. Every new generation gets upserted the
 * next time /api/runs walks the folder, so "newly generated" lands in Neon on
 * its own. Rows are never deleted here - a run whose files were cleaned out
 * of outputs/ remains in the catalog as history.
 *
 * Every write is best-effort: a down database must never take the file
 * listing down with it.
 */

import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from ".";
import { jobs as jobsTable, runItems, runs as runsTable } from "./schema";
import { OUTPUTS_DIR } from "@/lib/paths";
import type { JobSnapshot, Run } from "@/lib/types";

export interface DbState {
  enabled: boolean;
  synced: boolean;
}

/** "/api/files/outputs/bedroom/crops/bed.png" -> "bedroom/crops/bed.png" */
function relFromUrl(url: string | null | undefined): string | null {
  const prefix = "/api/files/outputs/";
  if (!url?.startsWith(prefix)) return null;
  return url
    .slice(prefix.length)
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");
}

async function sha256(relPath: string): Promise<string | null> {
  try {
    const data = await fsp.readFile(path.join(OUTPUTS_DIR, relPath));
    return createHash("sha256").update(data).digest("hex");
  } catch {
    return null;
  }
}

const secondsToDate = (seconds: number) => new Date(Math.round(seconds * 1000));

/** What of a run the catalog cares about; when unchanged, no write happens. */
function fingerprint(run: Run): string {
  const items = run.items
    .map((item) => `${item.name}:${item.status}:${item.mesh?.mtime ?? 0}`)
    .join(",");
  return `${run.kind}:${run.render?.mtime ?? 0}:${run.render?.bytes ?? 0}:${items}`;
}

// Written runs, by fingerprint, so the every-few-seconds poll costs nothing
// while the folder is quiet. Cleared on server restart, which just means one
// full re-upsert - idempotent by design.
const written = new Map<string, string>();
let lastOutcome: DbState = { enabled: false, synced: false };

export async function syncRuns(all: Run[]): Promise<DbState> {
  const db = getDb();
  if (!db) return { enabled: false, synced: false };

  const dirty = all.filter((run) => written.get(run.id) !== fingerprint(run));
  if (!dirty.length) return lastOutcome.enabled ? lastOutcome : { enabled: true, synced: true };

  try {
    // Hashing only when the GLB actually changed: compare against the stored
    // mtime rather than re-reading megabytes on every sync.
    const known = new Map(
      (
        await db
          .select({ id: runsTable.id, mtime: runsTable.renderMtime })
          .from(runsTable)
      ).map((row) => [row.id, row.mtime?.getTime() ?? 0]),
    );

    for (const run of dirty) {
      const renderPath = relFromUrl(run.render?.url) ?? run.render?.path ?? null;
      const renderMtimeMs = run.render ? Math.round(run.render.mtime * 1000) : 0;
      const needsHash =
        run.render && renderPath && known.get(run.id) !== renderMtimeMs;

      const row = {
        kind: run.kind,
        photoName: run.photo?.name ?? null,
        photoWidth: run.photo?.width ?? null,
        photoHeight: run.photo?.height ?? null,
        renderPath,
        renderBytes: run.render?.bytes ?? null,
        renderMtime: run.render ? secondsToDate(run.render.mtime) : null,
        ...(needsHash ? { renderSha256: await sha256(renderPath!) } : {}),
        specPath: run.spec?.path ?? null,
        room: run.spec?.room ?? null,
        updatedAt: new Date(),
      };
      await db
        .insert(runsTable)
        .values({ id: run.id, ...row })
        .onConflictDoUpdate({ target: runsTable.id, set: row });

      // Items are few and cheap: replace wholesale rather than diffing.
      await db.delete(runItems).where(eq(runItems.runId, run.id));
      if (run.items.length) {
        await db.insert(runItems).values(
          run.items.map((item) => ({
            runId: run.id,
            name: item.name,
            kind: item.kind,
            status: item.status,
            cropPath: relFromUrl(item.crop?.url),
            cropBytes: item.crop?.bytes ?? null,
            meshPath: relFromUrl(item.mesh?.url),
            meshBytes: item.mesh?.bytes ?? null,
            position: item.position,
            size: item.size,
            rotationZ: item.rotation_z,
            autoOrient: item.auto_orient,
            box: item.box,
            boxFrom: item.box_from,
            score: item.score,
            label: item.label,
          })),
        );
      }
      written.set(run.id, fingerprint(run));
    }
    lastOutcome = { enabled: true, synced: true };
  } catch (exc) {
    console.error("[db] run sync failed:", exc instanceof Error ? exc.message : exc);
    lastOutcome = { enabled: true, synced: false };
  }
  return lastOutcome;
}

/** One history row per finished job (done, failed or cancelled). */
export async function recordJob(
  job: JobSnapshot,
  times: { queuedAt: number; startedAt: number | null; finishedAt: number | null },
): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db.insert(jobsTable).values({
      localId: job.id,
      kind: job.kind,
      image: job.image,
      options: job.options,
      state: job.state,
      stage: job.stage || null,
      error: job.error || null,
      returncode: job.returncode,
      runId: job.run_id,
      log: job.log,
      queuedAt: new Date(times.queuedAt),
      startedAt: times.startedAt ? new Date(times.startedAt) : null,
      finishedAt: times.finishedAt ? new Date(times.finishedAt) : null,
    });
  } catch (exc) {
    console.error("[db] job record failed:", exc instanceof Error ? exc.message : exc);
  }
}
