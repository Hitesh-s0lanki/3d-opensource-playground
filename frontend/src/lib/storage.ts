/** Blob storage for everything the pipeline produces.
 *
 * Nothing is written to the server's disk. Photos go up on upload, meshes come
 * back from Modal as bytes and go straight up, and Neon stores only the key
 * plus the numbers describing it.
 *
 * Every key is prefixed with the Clerk user id, so one user's objects are a
 * different subtree from another's and a key can be checked for ownership
 * without a database round trip. Blobs are stored `private`: they are not
 * fetchable by URL, only through `readBlob` from a route that has already
 * established who is asking. See `app/api/files/[...path]/route.ts`.
 */

import { get, put } from "@vercel/blob";

/** Byte ceiling for an uploaded photo. Meshes coming back from Modal are
 * larger (a raw Hunyuan3D shape runs to ~22 MB) and are not checked here. */
export const MAX_UPLOAD = 40 * 1024 * 1024;

const SAFE_CHARS = /[^A-Za-z0-9._-]+/g;

export function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/** A single path segment that cannot contain a separator or walk upwards. */
export function safeSegment(raw: string, fallback = "file"): string {
  const flat = raw.replaceAll("\\", "/").split("/").pop() ?? "";
  const cleaned = flat.replace(SAFE_CHARS, "-").replace(/^[-._]+|[-._]+$/g, "");
  return cleaned || fallback;
}

/** `u/<userId>/<...parts>` - the only shape of key this app ever writes. */
export function userKey(userId: string, ...parts: string[]): string {
  return ["u", safeSegment(userId, "anon"), ...parts.map((p) => safeSegment(p))].join("/");
}

/** True when `key` belongs to `userId`. Cheap guard for anything that takes a
 * key from a request before it has been matched against a row. */
export function ownsKey(userId: string, key: string): boolean {
  return key.startsWith(`u/${safeSegment(userId, "anon")}/`);
}

export interface StoredBlob {
  key: string;
  bytes: number;
  contentType: string;
}

export async function writeBlob(
  key: string,
  data: Buffer | Uint8Array,
  contentType: string,
): Promise<StoredBlob> {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const result = await put(key, body, {
    access: "private",
    contentType,
    // Keys are derived from the user id and the run slug, so they are already
    // unique per user. A suffix would make them unpredictable and force a
    // lookup to rebuild one.
    addRandomSuffix: false,
    // A re-run of the same slug replaces its output rather than erroring.
    allowOverwrite: true,
  });
  return { key: result.pathname, bytes: body.byteLength, contentType };
}

/** Stream one blob back. Null when the key does not exist. */
export async function readBlob(
  key: string,
): Promise<{ stream: ReadableStream; contentType: string } | null> {
  const found = await get(key, { access: "private" });
  if (!found) return null;
  return {
    stream: found.stream as ReadableStream,
    contentType: found.headers.get("content-type") ?? "application/octet-stream",
  };
}

/** The URL the client fetches a stored blob through. Always our own route,
 * never the storage provider's - the route is where ownership is checked. */
export function blobUrl(key: string): string {
  return `/api/files/${key.split("/").map(encodeURIComponent).join("/")}`;
}
