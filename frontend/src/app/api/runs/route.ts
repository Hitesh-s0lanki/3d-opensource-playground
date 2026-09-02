/** Every run belonging to the signed-in user. */

import { dbConfigured } from "@/db";
import { errorResponse, requireUserId } from "@/lib/auth";
import { ROOM_AVAILABLE, jobUnavailableReason } from "@/lib/jobs";
import { listRuns } from "@/lib/runs";
import type { Run, RunsPayload } from "@/lib/types";

export async function GET(): Promise<Response> {
  try {
    const userId = await requireUserId();

    // The catalog and the ability to start a run are separate concerns: the
    // submit path needs Modal and blob storage, not this listing. So a Neon
    // outage costs the user their history, not the + New button - this route
    // used to 500 as a whole, which left the client with no payload at all and
    // a button disabled for a reason it could not name.
    let runs: Run[] = [];
    let synced = true;
    try {
      runs = await listRuns(userId);
    } catch (exc) {
      synced = false;
      console.error("[api/runs] catalog read failed:", exc instanceof Error ? exc.message : exc);
    }

    const blocked = jobUnavailableReason("object");
    const payload: RunsPayload = {
      generate_blocked: blocked,
      room_available: ROOM_AVAILABLE,
      db: { enabled: dbConfigured(), synced },
      runs,
    };
    // The page polls for new results, so a cached listing would hide them.
    return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (exc) {
    return errorResponse(exc);
  }
}
