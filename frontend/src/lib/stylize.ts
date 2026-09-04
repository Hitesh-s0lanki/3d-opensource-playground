/** Turning flat artwork into something the shape model can read depth from.
 *
 * Hunyuan3D infers volume from shading. A photograph of a vinyl figure hands
 * it gradients, ambient occlusion and specular falloff on every curve, so it
 * reconstructs rather than guesses. A cel-shaded drawing hands it none of
 * that - every surface is one flat fill - so it returns a relief, and the
 * black outlines come back as creases in the mesh.
 *
 * So the drawing is re-rendered as a figurine before the GPU ever sees it. One
 * image-model call happens to fix three separate things at once:
 *
 *   shading   the whole point - the gradients are synthesised rather than
 *             inferred from an image that never had any
 *   pose      the prompt asks for a three-quarter view, and a frontal
 *             orthographic drawing is the worst possible case for monocular
 *             reconstruction: nothing in it says how deep the subject is
 *   cutout    a transparent background means the Modal side skips rembg
 *             entirely, and rembg's u2net is a photo segmenter that chews on
 *             exactly what cartoon art is made of - white-on-white socks,
 *             pencil-thin limbs, pale outlines
 *
 * What it does not fix: one image is still one image, so the back of the
 * figure is still invented downstream. And this is rewriting the character
 * rather than photographing it - the likeness drifts, and it drifts
 * differently every call. Which is why nothing here is automatic. The route
 * hands the render back to the browser and it becomes the job's input only if
 * the user looks at it and accepts it; a bad one costs a retry rather than a
 * credit and two minutes of L40S.
 */

const ENDPOINT = "https://api.openai.com/v1/images/edits";
const MODEL = "gpt-image-1";

/** A 1024 square at medium quality.
 *
 * Neither is a compromise. The shape model works from a 518px crop and the
 * paint pass from a handful of 512px views, so every pixel past 1024 is
 * resampled away before anything looks at it, and `high` buys detail that only
 * costs seconds this route does not have - see `maxDuration` on the route.
 */
const SIZE = "1024x1024";
const QUALITY = "medium";

/** Serverless functions are capped at 60s on Vercel's smaller plans, and a
 * platform timeout gives the user a blank 504 rather than a sentence. Bail out
 * just inside it so the failure is ours to describe. */
const TIMEOUT_MS = 55_000;

/** Every clause here is load-bearing, and most of them are there because the
 * obvious prompt produces something that reconstructs badly:
 *
 * The identity paragraph is the one holding drift down. Image models treat
 * "figurine" as licence to redesign, and a Shinchan that comes back
 * generically chibi has lost the thing the user uploaded him for.
 *
 * The last paragraph is all failure modes rather than style. A display base or
 * a plinth becomes geometry - the mesh arrives standing on a cylinder. A cast
 * shadow on a ground plane either gets segmented in as a flat disc or extruded
 * into a slab. A figure cropped at the frame edge becomes a severed mesh. None
 * of these are hypothetical; they are what "3D figurine of this character"
 * gives you on its own.
 */
export const FIGURINE_PROMPT = `Re-render the supplied character as a physical collectible figurine, shot as a product photograph.

Keep the character's identity exactly: the same face, the same hair shape, the same outfit, the same colours, the same proportions and the same expression. Do not restyle, redesign or "improve" the character. It must be recognisably the same character.

Give it real three-dimensional form as a matte vinyl figure: soft studio key light from the upper left with a gentle falloff across every curved surface, subtle ambient occlusion where the limbs meet the body and inside every fold and crease, and rounded solid volumes throughout. No flat unshaded fills. No black outlines drawn onto the surface.

Three-quarter view, the figure turned roughly thirty degrees away from the camera, standing, full body, entirely inside the frame with a margin on every side and nothing cropped.

Fully transparent background. No ground, no floor, no cast shadow, no contact shadow, no base, no plinth, no stand, no packaging, no text and no watermark.`;

export function stylizeConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/** Why a figurine cannot be rendered, or null when one can be. Mirrors
 * `jobUnavailableReason` - the dialog wants a sentence, not a boolean. */
export function stylizeUnavailableReason(): string | null {
  if (!stylizeConfigured()) {
    return "figurine rendering is not configured - set OPENAI_API_KEY";
  }
  return null;
}

/** OpenAI reports failures as `{ error: { message } }`, and returns HTML for
 * the ones that never reach the API at all. Dig out whichever is there. */
async function failure(response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return new Error(parsed.error.message);
  } catch {
    /* not JSON; fall through to the status line */
  }
  return new Error(`OpenAI answered ${response.status}: ${body.slice(0, 200) || "no body"}`);
}

/**
 * Render `image` as a figurine and hand back PNG bytes with alpha.
 *
 * The edits endpoint rather than generations, because the character has to
 * survive: generations would only ever see the prompt, and no description of
 * Shinchan short of the drawing itself reproduces Shinchan. `input_fidelity`
 * is the knob that keeps a likeness through an edit, and it is the difference
 * between the same character rendered solidly and a different character in
 * the same clothes.
 *
 * `contentType` must be one the endpoint accepts - PNG, JPEG or WebP. Callers
 * get that for free by running the upload through `normalizeImage` first,
 * which is also what makes a HEIC off a phone work here.
 */
export async function renderFigurine(
  image: Buffer,
  filename: string,
  contentType: string,
): Promise<Buffer> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");

  const form = new FormData();
  form.set("model", MODEL);
  form.set("prompt", FIGURINE_PROMPT);
  form.set("size", SIZE);
  form.set("quality", QUALITY);
  // Transparency is the whole reason the Modal side leaves the subject alone,
  // and PNG is the only output format here that carries it.
  form.set("background", "transparent");
  form.set("output_format", "png");
  form.set("input_fidelity", "high");
  form.set("n", "1");
  form.set("image", new Blob([new Uint8Array(image)], { type: contentType }), filename);

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (exc) {
    if (exc instanceof Error && exc.name === "TimeoutError") {
      throw new Error(
        `the figurine render did not come back within ${TIMEOUT_MS / 1000}s - try again`,
      );
    }
    throw exc;
  }

  if (!response.ok) throw await failure(response);

  const payload = (await response.json()) as { data?: { b64_json?: string }[] };
  const b64 = payload.data?.[0]?.b64_json;
  // gpt-image-1 always answers with base64 - there is no hosted-URL mode to
  // fall back to - so an absent field means the response was not what we think.
  if (!b64) throw new Error("OpenAI returned no image");
  return Buffer.from(b64, "base64");
}
