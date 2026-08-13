/** Serve one file from the outputs/ or inputs/ tree.
 *
 * The 3D meshes and photos live outside the Next.js project, so they get a
 * file route rather than /public. A URL is not allowed to walk out of the
 * directory it addresses.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { INPUTS_DIR, OUTPUTS_DIR, insideDir } from "@/lib/paths";

const MOUNTS: Record<string, string> = {
  outputs: OUTPUTS_DIR,
  inputs: INPUTS_DIR,
};

// Node has no glTF entries in any built-in table; without these the meshes
// would go out as application/octet-stream.
const MIME: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path: segments } = await ctx.params;
  const [mount, ...rest] = segments;
  const base = MOUNTS[mount];
  if (!base || rest.length === 0) {
    return Response.json({ error: "no such mount" }, { status: 404 });
  }

  const target = path.resolve(base, rest.join("/"));
  if (!insideDir(base, target)) {
    return Response.json({ error: "no such file" }, { status: 404 });
  }

  try {
    const body = await fsp.readFile(target);
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": String(body.length),
        // The page polls for new results; stale bytes would hide them.
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json({ error: "no such file" }, { status: 404 });
  }
}
