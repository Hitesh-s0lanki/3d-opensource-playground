import { syncRuns } from "@/db/sync";
import { discover } from "@/lib/discover";
import { pythonExe, INPUTS_DIR, OUTPUTS_DIR } from "@/lib/paths";
import type { RunsPayload } from "@/lib/types";

export async function GET(): Promise<Response> {
  const runs = await discover();
  // Every newly generated run lands in the Neon catalog as soon as discovery
  // sees it; a missing or down database never blocks the listing.
  const db = await syncRuns(runs);
  const payload: RunsPayload = {
    root: OUTPUTS_DIR,
    inputs: INPUTS_DIR,
    can_generate: pythonExe() !== null,
    db,
    runs,
  };
  // The page polls for new results, so a cached listing would hide them.
  return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
}
