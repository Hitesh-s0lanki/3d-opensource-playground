/** Recognising an image in the browser, before it has been uploaded.
 *
 * The server decides what it can actually decode - see `lib/images.ts`, which
 * reads the bytes. This is only the gate in front of the file picker and the
 * drop target, and it has to be looser than an honest MIME check would be:
 * Windows and Chrome between them have no registered type for HEIC, so an
 * iPhone photo arrives as a File with an empty `type` and nothing but its
 * name to go on.
 *
 * Erring loose is the right way round. A file that turns out not to be an
 * image gets a clear message from the upload route; a real photo rejected here
 * gets nothing but a picker that refuses to show it.
 */

/** Extensions worth naming explicitly in the picker. `image/*` covers the
 * common ones on every platform, but the formats an OS has no MIME entry for
 * are exactly the ones this change is about, so they are listed by name. */
const EXOTIC = [".heic", ".heif", ".avif", ".jfif", ".tif", ".tiff", ".bmp", ".gif"];

/** The `accept` attribute for any file input that takes a photo. */
export const IMAGE_ACCEPT = ["image/*", ...EXOTIC].join(",");

/** Kept in step with what `lib/images.ts` can actually decode. Offering more
 * than that only moves the rejection from the picker to the upload. */
const IMAGE_EXT = new Set([...EXOTIC, ".png", ".jpg", ".jpeg", ".webp", ".svg", ".apng"]);

/** Whether to treat a dropped or picked file as a photo to generate from. */
export function looksLikeImage(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  const dot = file.name.lastIndexOf(".");
  return dot > 0 && IMAGE_EXT.has(file.name.slice(dot).toLowerCase());
}

/** Whether this browser is likely to render the file in an `<img>`.
 *
 * Only used to decide between showing a preview and showing a placeholder, so
 * a wrong answer costs a thumbnail. HEIC is the case that matters: Safari
 * decodes it, no other engine does, and there is no way to ask up front
 * without trying - so the caller also listens for the load error and falls
 * back on that. */
const UNDRAWABLE = new Set([".heic", ".heif", ".tif", ".tiff"]);

export function isDisplayable(file: File): boolean {
  const dot = file.name.lastIndexOf(".");
  return !UNDRAWABLE.has(dot > 0 ? file.name.slice(dot).toLowerCase() : "");
}
