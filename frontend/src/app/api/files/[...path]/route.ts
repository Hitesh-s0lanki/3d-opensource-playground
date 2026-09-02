/** Stream one stored blob back to its owner.
 *
 * Blobs are written `private`, so they have no publicly fetchable URL. This is
 * the only way to read one, and the check is the key prefix: every key this
 * app writes is `u/<userId>/...`, so a key that does not start with the
 * caller's own prefix is not theirs and is answered as a 404 rather than a
 * 403 - there is no reason to confirm that someone else's file exists.
 */

import { errorResponse, requireUserId } from "@/lib/auth";
import { ownsKey, readBlob } from "@/lib/storage";

const MIME: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".json": "application/json; charset=utf-8",
};

const notFound = () => Response.json({ error: "no such file" }, { status: 404 });

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  try {
    const userId = await requireUserId();
    const { path: segments } = await ctx.params;
    if (!segments?.length) return notFound();

    const key = segments.map((segment) => decodeURIComponent(segment)).join("/");
    if (!ownsKey(userId, key)) return notFound();

    const found = await readBlob(key);
    if (!found) return notFound();

    const dot = key.lastIndexOf(".");
    const suffix = dot > 0 ? key.slice(dot).toLowerCase() : "";
    return new Response(found.stream, {
      headers: {
        "Content-Type": MIME[suffix] ?? found.contentType,
        // Private to this user, but the bytes never change under a key that
        // is rewritten wholesale, so the browser may keep them for a session.
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (exc) {
    return errorResponse(exc);
  }
}
