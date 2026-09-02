/** Talking to the Hunyuan3D container on Modal.
 *
 * Generation used to be a subprocess: the venv's Python, the same command you
 * would have typed, its stdout scraped for progress. Nothing runs on this
 * machine any more, so the pipeline is reached over HTTP instead - two
 * endpoints on `scripts/modal_app/hunyuan3d.py`, one to start a call and one to
 * collect it.
 *
 * The split matters because a textured generation takes 60-105 seconds, which
 * is longer than a serverless function should hold a request open. `submit`
 * returns as soon as Modal has queued the work; `collect` is polled from
 * `/api/jobs` until the bytes are ready. State lives in Neon between polls,
 * so nothing depends on this process staying alive.
 */

export interface ModalOptions {
  texture: boolean;
  steps?: number;
  guidance_scale?: number;
  octree_resolution?: number;
  seed?: number;
  max_num_view?: number;
  view_resolution?: number;
  remove_background?: boolean;
}

export type ModalResult =
  | { state: "pending" }
  | { state: "done"; glb: Buffer }
  | { state: "failed"; error: string };

function endpoint(): string {
  const base = process.env.MODAL_ENDPOINT;
  if (!base) {
    throw new Error(
      "MODAL_ENDPOINT is not set - deploy scripts/modal_app/hunyuan3d.py and put its " +
        "web URL in .env.local",
    );
  }
  return base.replace(/\/+$/, "");
}

export function modalConfigured(): boolean {
  return Boolean(process.env.MODAL_ENDPOINT && process.env.MODAL_TOKEN);
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const token = process.env.MODAL_TOKEN;
  if (!token) {
    throw new Error("MODAL_TOKEN is not set - it must match TOKEN_SECRET on the Modal side");
  }
  return { "X-Dioramic-Token": token, ...extra };
}

/** Hand Modal an image and get back the id of the queued call. */
export async function submit(image: Buffer, options: ModalOptions): Promise<string> {
  const response = await fetch(`${endpoint()}/generate`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ image_b64: image.toString("base64"), ...options }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`modal refused the job (${response.status}): ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text) as { call_id?: string };
  if (!parsed.call_id) throw new Error("modal returned no call id");
  return parsed.call_id;
}

/** Ask whether a queued call has finished. Never throws for "not yet". */
export async function collect(callId: string): Promise<ModalResult> {
  let response: Response;
  try {
    response = await fetch(`${endpoint()}/result?call_id=${encodeURIComponent(callId)}`, {
      headers: headers(),
      cache: "no-store",
    });
  } catch {
    // A network blip should leave the job running, not fail it.
    return { state: "pending" };
  }

  if (response.status === 202) return { state: "pending" };
  if (response.ok) {
    const body = Buffer.from(await response.arrayBuffer());
    if (!body.length) return { state: "failed", error: "modal returned an empty mesh" };
    return { state: "done", glb: body };
  }
  const detail = await response.text().catch(() => "");
  return {
    state: "failed",
    error: `modal call failed (${response.status}): ${detail.slice(0, 300)}`,
  };
}

/** Ask Modal to stop a call. Best effort - the container may already be past
 * the point where stopping saves anything. */
export async function cancel(callId: string): Promise<void> {
  try {
    await fetch(`${endpoint()}/cancel?call_id=${encodeURIComponent(callId)}`, {
      method: "POST",
      headers: headers(),
    });
  } catch (exc) {
    console.error("[modal] cancel failed:", exc instanceof Error ? exc.message : exc);
  }
}
