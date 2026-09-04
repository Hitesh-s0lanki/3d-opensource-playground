/** Render an upload as a figurine, without committing to generating from it.
 *
 * This is deliberately not a step inside POST /api/jobs. The image model is
 * rewriting the character rather than photographing it, so it drifts, and it
 * drifts differently every call - folding it into submission would mean
 * discovering that the face came back wrong only after a credit and two
 * minutes of L40S had already gone. So the render happens here, the browser
 * shows it next to the original, and the user decides which one is uploaded.
 *
 * Nothing is stored. The PNG goes back as a data URL, and if the user accepts
 * it the browser posts it to /api/jobs as the file - where it takes exactly
 * the same path any upload takes.
 */

import { errorResponse, requireUserId } from "@/lib/auth";
import { OutOfCredits, getCredits, refundFigurine, takeFigurine } from "@/lib/credits";
import { normalizeImage } from "@/lib/images";
import { MAX_UPLOAD } from "@/lib/storage";
import { renderFigurine, stylizeUnavailableReason } from "@/lib/stylize";
import type { StylizePayload } from "@/lib/types";

/** gpt-image-1 takes 15-40s for a medium 1024 square, which does not fit in
 * the default 10s. 60 is the ceiling on Vercel's smaller plans, and
 * `TIMEOUT_MS` in lib/stylize.ts sits just inside it so the user gets a
 * sentence rather than a platform 504. */
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  try {
    const userId = await requireUserId();

    const blocked = stylizeUnavailableReason();
    if (blocked) return Response.json({ error: blocked }, { status: 501 });

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
    if (file.size > MAX_UPLOAD) {
      return Response.json(
        { error: `image is ${Math.round(file.size / 1e6)} MB; the limit is ${MAX_UPLOAD / 1e6} MB` },
        { status: 400 },
      );
    }

    // A figurine is only worth rendering for a run that can actually happen,
    // and this call costs money on our side, so someone with nothing left to
    // spend is turned away before OpenAI is touched. The daily counter is the
    // bound on everyone else - see `takeFigurine`.
    const balance = await getCredits(userId);
    if (balance.remaining <= 0) throw new OutOfCredits(balance.granted);
    const remainingToday = await takeFigurine(userId);

    // Normalised first, for the same reason the job route does it: the edits
    // endpoint reads PNG, JPEG and WebP, and a phone hands out HEIC. This is
    // also what applies the EXIF rotation, so the figurine is not rendered
    // from a photo lying on its side.
    const source = await normalizeImage(file.name, Buffer.from(await file.arrayBuffer()));

    let png: Buffer;
    try {
      png = await renderFigurine(source.data, source.name, source.contentType);
    } catch (exc) {
      // A render that failed billed nothing, so it should not have counted.
      await refundFigurine(userId);
      throw exc;
    }

    const payload: StylizePayload = {
      image: `data:image/png;base64,${png.toString("base64")}`,
      name: `${source.name.replace(/\.[^.]+$/, "")}-figurine.png`,
      remaining_today: remainingToday,
    };
    return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (exc) {
    return errorResponse(exc);
  }
}
