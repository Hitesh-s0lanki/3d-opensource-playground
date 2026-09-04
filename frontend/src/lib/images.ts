/** Turning whatever the user dropped in into something the rest of the app can
 * read.
 *
 * Three consumers downstream have different ideas about what an image is, and
 * the intersection is narrow:
 *
 *   the browser   shows the photo back in the detail panel - no Chrome or
 *                 Firefox build decodes HEIC
 *   Pillow        opens the bytes on the Modal side; no AVIF before 11.3, no
 *                 HEIC at all
 *   blob storage  wants a content type it will not have to guess
 *
 * A phone hands out HEIC, a screenshot tool hands out AVIF or WebP, a scanner
 * hands out TIFF, and none of them ask first. So the upload boundary is the
 * one place that decides: decode it here, re-encode into PNG or JPEG, and
 * everything past this point only ever sees a format all three understand.
 *
 * Formats that survive untouched are exactly the three that are already safe
 * everywhere - JPEG, PNG, WebP - and only when they need neither rotating nor
 * shrinking. Anything else is converted, which is also what applies EXIF
 * orientation: a portrait iPhone photo is landscape bytes plus a tag, and the
 * tag is lost the moment Pillow hands the array to the model.
 *
 * One thing to know before touching the alpha handling here: on the Modal side
 * a fully opaque image means "not cut out yet" and gets the background
 * remover, while any transparency means "already cut out" and is passed
 * straight to the model. So the alpha channel is not decoration, and a decoder
 * that invents one - `bmp-js` fills it with zeroes - would hand the model a
 * subject it reads as entirely background. Alpha is kept only where it carries
 * real information; see `hasRealAlpha`.
 */

import sharp from "sharp";

// sharp's typings are an `export =`, so its namespace is not reliably in
// scope under this tsconfig. Derived from the callable instead.
type Image = ReturnType<typeof sharp>;
type ImageMeta = Awaited<ReturnType<Image["metadata"]>>;

/** The longest edge we keep. Hunyuan3D works from a 518px crop, so pixels past
 * this buy nothing and cost a lot: the image reaches Modal as base64 inside a
 * JSON body, where every byte is a byte and a third. */
const MAX_EDGE = 4096;

/** Rasterisation density for vector input, chosen so a typical 512pt SVG lands
 * near 2000px rather than the 96dpi default's 512. */
const SVG_DENSITY = 384;

/** Formats that need no conversion, mapped to the extension and content type
 * we store them under. Everything absent from this table is re-encoded. */
const PASS_THROUGH: Record<string, { ext: string; contentType: string }> = {
  jpeg: { ext: ".jpg", contentType: "image/jpeg" },
  png: { ext: ".png", contentType: "image/png" },
  webp: { ext: ".webp", contentType: "image/webp" },
};

export interface NormalizedImage {
  /** The bytes to store and to send to Modal. */
  data: Buffer;
  /** Filename with the extension the bytes actually are, not the one claimed. */
  name: string;
  contentType: string;
  width: number;
  height: number;
  /** A line for the job log when the bytes changed, null when they did not. */
  note: string | null;
}

/** True for the ISO-BMFF brands libheif recognises. Read off the `ftyp` box
 * rather than the filename, because the filename is whatever the user's
 * download folder made of it. */
function isHeifContainer(data: Buffer): boolean {
  if (data.length < 12 || data.toString("latin1", 4, 8) !== "ftyp") return false;
  const brand = data.toString("latin1", 8, 12).replace(/\0/g, " ").trim();
  return ["mif1", "msf1", "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"].includes(
    brand,
  );
}

/** The one format sharp cannot do.
 *
 * sharp is built against libheif and reads the HEIF container happily, but the
 * prebuilt binary ships only the AV1 decoder - the HEVC one is left out over
 * its patent licensing. AVIF is HEIF with AV1 inside, so it works; a photo off
 * an iPhone is HEIF with HEVC inside, so it does not. libheif-js is the same
 * library compiled to WASM with HEVC included: slower, and only reached when
 * sharp has already refused the bytes.
 */
async function decodeHeic(data: Buffer): Promise<Image> {
  const decode = (await import("heic-decode")).default;
  const { width, height, data: rgba } = await decode({ buffer: new Uint8Array(data) });
  return sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), {
    raw: { width, height, channels: 4 },
  });
}

/** `BM`, then enough bytes for a header to live in. Only ever asked after
 * sharp has already failed, so it does not have to be more than a hint. */
function isBmp(data: Buffer): boolean {
  return data.length > 26 && data[0] === 0x42 && data[1] === 0x4d;
}

/** The other format sharp cannot do.
 *
 * libvips has no BMP loader at all, and the app accepted `.bmp` before any of
 * this existed, so it needs one. `bmp-js` covers 1, 4, 8, 16, 24 and 32 bit.
 *
 * It emits ABGR, not RGBA, and - the part that matters - sets every alpha byte
 * to zero for the bit depths that have no alpha at all. Handing that to sharp
 * as four channels would produce an image that is uniformly transparent, which
 * the Modal side reads as a subject already cut down to nothing. So the alpha
 * byte is discarded and the three colour bytes are reversed into RGB. BMP
 * transparency is rare enough that losing it costs a white background, which
 * is where an opaque image ends up anyway.
 */
async function decodeBmp(data: Buffer): Promise<Image> {
  // bmp-js sizes its output from the header before it has looked at how many
  // bytes actually follow, so a 30-byte file claiming 30000x30000 asks for a
  // multi-gigabyte allocation. sharp has `limitInputPixels` for this; bmp-js
  // has nothing, so the header is checked here first. The bound is the same
  // 268 megapixels sharp defaults to.
  const declared = Math.abs(data.readInt32LE(18)) * Math.abs(data.readInt32LE(22));
  if (!declared || declared > 0x3fff * 0x3fff) {
    throw new Error(`implausible bitmap dimensions (${declared} pixels)`);
  }

  const bmp = (await import("bmp-js")).default;
  const { width, height, data: abgr } = bmp.decode(data);
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let src = 0, dst = 0; dst < rgb.length; src += 4, dst += 3) {
    rgb[dst] = abgr[src + 3];
    rgb[dst + 1] = abgr[src + 2];
    rgb[dst + 2] = abgr[src + 1];
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } });
}

function friendlyError(kind: string | null, cause: unknown): Error {
  if (kind) {
    const detail = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    return new Error(`this ${kind} file could not be decoded: ${detail}`);
  }
  return new Error(
    "that file is not an image we can read - JPEG, PNG, WebP, AVIF, HEIC, GIF, " +
      "TIFF, BMP and SVG all work",
  );
}

/** Decode `data` however it can be decoded, and say what it turned out to be. */
async function open(data: Buffer): Promise<{ image: Image; format: string }> {
  try {
    const probe = sharp(data, { density: SVG_DENSITY });
    const meta = await probe.metadata();
    if (!meta.width || !meta.height) throw new Error("no dimensions");
    // sharp reports AVIF and HEIC alike as `heif`; the codec inside is what
    // separates them, and only `av1` is one it can actually decode. Force the
    // read now so an HEVC file fails here, where the fallback is, rather than
    // later inside toBuffer().
    if (meta.format === "heif") {
      if (meta.compression !== "av1") {
        throw new Error(`unsupported HEIF codec: ${meta.compression}`);
      }
      await probe.clone().stats();
    }
    return { image: probe, format: meta.format === "heif" ? "avif" : (meta.format ?? "unknown") };
  } catch (exc) {
    const fallback = isHeifContainer(data)
      ? { kind: "HEIC", decode: decodeHeic }
      : isBmp(data)
        ? { kind: "BMP", decode: decodeBmp }
        : null;
    if (!fallback) throw friendlyError(null, exc);
    try {
      return { image: await fallback.decode(data), format: fallback.kind.toLowerCase() };
    } catch (fallbackExc) {
      throw friendlyError(fallback.kind, fallbackExc);
    }
  }
}

/** Whether the alpha channel says anything.
 *
 * `hasAlpha` only reports that a channel exists, and the ones synthesised by a
 * fallback decoder always do - `heic-decode` returns RGBA for a photo that
 * cannot be transparent. Re-encoding those as PNG to preserve an alpha channel
 * that is uniformly 255 costs several times the file size for nothing, so the
 * channel is inspected rather than counted. `stats()` decodes the image, which
 * is why this is only asked on the path that was going to decode anyway. */
async function hasRealAlpha(image: Image, meta: ImageMeta): Promise<boolean> {
  if (!meta.hasAlpha) return false;
  try {
    return !(await image.clone().stats()).isOpaque;
  } catch {
    // Unreadable statistics are not a reason to drop transparency.
    return true;
  }
}

/**
 * Decode an upload and hand back bytes every consumer downstream can read.
 *
 * `filename` is only used for its stem - the extension on the result comes
 * from what the bytes turned out to be, since a `.jpg` off a phone is
 * routinely a HEIC and a `.png` off a chat app is routinely a WebP.
 */
export async function normalizeImage(filename: string, data: Buffer): Promise<NormalizedImage> {
  const { image, format } = await open(data);
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const oversized = Math.max(width, height) > MAX_EDGE;
  // 1 is "as stored"; anything higher is a rotation or a flip that lives only
  // in the EXIF tag, and would be dropped the moment the pixels are read raw.
  const rotated = (meta.orientation ?? 1) > 1;
  const passable = PASS_THROUGH[format];
  const stem = safeStem(filename);

  if (passable && !oversized && !rotated) {
    return {
      data,
      name: stem + passable.ext,
      contentType: passable.contentType,
      width,
      height,
      note: null,
    };
  }

  // Transparency has to survive, and only PNG among the two carries it. For
  // everything opaque JPEG is the better trade: a photo re-encoded to PNG can
  // come back several times larger than it went in.
  const alpha = await hasRealAlpha(image, meta);
  const resized = image
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true });
  const encoded = alpha
    ? resized.png({ compressionLevel: 9 })
    : resized.flatten({ background: "#ffffff" }).jpeg({ quality: 92, mozjpeg: true });

  const { data: out, info } = await encoded.toBuffer({ resolveWithObject: true });

  const reasons = [
    passable ? null : `${format} to ${info.format}`,
    oversized ? `resized to ${info.width}x${info.height}` : null,
    rotated ? "orientation applied" : null,
  ].filter(Boolean);

  return {
    data: out,
    name: stem + (alpha ? ".png" : ".jpg"),
    contentType: alpha ? "image/png" : "image/jpeg",
    width: info.width,
    height: info.height,
    note: `converted: ${reasons.join(", ")}`,
  };
}

/** The filename without its extension, safe as a blob key segment. Mirrors
 * `safeSegment` in storage.ts, which is applied again on the way into a key -
 * this one runs first so the stem is already clean when the run slug is
 * derived from it. */
function safeStem(raw: string): string {
  const flat = raw.replaceAll("\\", "/").split("/").pop() ?? "";
  const dot = flat.lastIndexOf(".");
  const stem = dot > 0 ? flat.slice(0, dot) : flat;
  const cleaned = stem.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return cleaned || "upload";
}
