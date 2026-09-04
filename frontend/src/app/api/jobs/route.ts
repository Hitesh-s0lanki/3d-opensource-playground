/** The signed-in user's generation jobs.
 *
 * GET also advances them: there is no background worker, so each poll is what
 * moves a finished Modal call into blob storage and the catalog. The viewer
 * already polls this route every few seconds, which is the whole mechanism.
 *
 * The credit balance is answered here too, after the advance: a job that just
 * failed refunds its credit, and reading the balance in the same breath is how
 * the number on screen goes back up without another round trip.
 */

import { errorResponse, requireUserId } from "@/lib/auth";
import { getCredits } from "@/lib/credits";
import { advanceJobs, isJobKind, jobUnavailableReason, listJobs, submitJob } from "@/lib/jobs";
import type { JobsPayload } from "@/lib/types";

/** POST decodes the upload before it stores anything, and a full-size HEIC off
 * a phone goes through a WASM build of libheif - seconds, not milliseconds,
 * for a 12-megapixel photo. The default 10s is close enough to that to be
 * worth raising. */
export const maxDuration = 60;

export async function GET(): Promise<Response> {
  try {
    const userId = await requireUserId();
    await advanceJobs(userId);
    const payload: JobsPayload = {
      jobs: await listJobs(userId),
      credits: await getCredits(userId),
    };
    return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (exc) {
    return errorResponse(exc);
  }
}

/** Take an uploaded image and start a generation against it.
 *
 * multipart/form-data with a `file` field, a `kind` field ("object" | "room")
 * and any generation options as further string fields.
 *
 * Costs one credit. With none left the answer is 402 and nothing is uploaded.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const userId = await requireUserId();

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return Response.json({ error: "expected multipart form data" }, { status: 400 });
    }

    const file = form.get("file");
    if (!(file instanceof File) || !file.size) {
      return Response.json({ error: "no image in the request body" }, { status: 400 });
    }
    const kind = String(form.get("kind") ?? "object");
    if (!isJobKind(kind)) {
      return Response.json({ error: `unknown job kind: ${kind}` }, { status: 400 });
    }
    const blocked = jobUnavailableReason(kind);
    if (blocked) return Response.json({ error: blocked }, { status: 501 });

    const options: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (key === "file" || key === "kind" || typeof value !== "string" || !value) continue;
      options[key] = value;
    }

    const job = await submitJob(
      userId,
      kind,
      file.name,
      Buffer.from(await file.arrayBuffer()),
      options,
    );
    return Response.json({ job, credits: await getCredits(userId) });
  } catch (exc) {
    return errorResponse(exc);
  }
}
