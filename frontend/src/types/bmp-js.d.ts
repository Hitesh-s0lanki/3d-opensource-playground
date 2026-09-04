/** `bmp-js` ships no types. Only the decoder is used - see `lib/images.ts` -
 * and its `data` is ABGR, one byte per channel, not RGBA. */
declare module "bmp-js" {
  interface DecodedBmp {
    width: number;
    height: number;
    /** ABGR, four bytes per pixel, row-major. */
    data: Buffer;
  }
  const bmp: { decode(buffer: Buffer): DecodedBmp };
  export default bmp;
}
