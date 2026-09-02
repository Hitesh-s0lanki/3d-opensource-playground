/** The Neon catalog, read back: every run ever recorded (even ones whose
 * files have since been cleaned out of outputs/) and the full job history.
 */

import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { jobs, runs } from "@/db/schema";

export async function GET(): Promise<Response> {
  const db = getDb();
  if (!db) {
    return Response.json(
      { error: "no DATABASE_URL configured - the catalog is disabled" },
      { status: 503 },
    );
  }
  try {
    const [allRuns, allJobs] = await Promise.all([
      db.query.runs.findMany({ orderBy: [desc(runs.updatedAt)] }),
      db.select().from(jobs).orderBy(desc(jobs.finishedAt)).limit(200),
    ]);
    return Response.json(
      { runs: allRuns, jobs: allJobs },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (exc) {
    return Response.json(
      { error: exc instanceof Error ? exc.message : String(exc) },
      { status: 502 },
    );
  }
}
