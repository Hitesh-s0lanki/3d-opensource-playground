/** The catalog, read back raw: this user's run rows and their whole job
 * history, straight out of Neon with no shaping.
 */

import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { jobs, runs } from "@/db/schema";
import { errorResponse, requireUserId } from "@/lib/auth";

export async function GET(): Promise<Response> {
  try {
    const userId = await requireUserId();
    const db = getDb();
    const [allRuns, allJobs] = await Promise.all([
      db.select().from(runs).where(eq(runs.userId, userId)).orderBy(desc(runs.updatedAt)),
      db
        .select()
        .from(jobs)
        .where(eq(jobs.userId, userId))
        .orderBy(desc(jobs.queuedAt))
        .limit(200),
    ]);
    return Response.json(
      { runs: allRuns, jobs: allJobs },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (exc) {
    return errorResponse(exc);
  }
}
