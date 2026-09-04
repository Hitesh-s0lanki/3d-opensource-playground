/** `heic-decode` ships no types. Only the single-image entry point is used -
 * see `lib/images.ts` - so only that is declared. */
declare module "heic-decode" {
  interface DecodedHeic {
    width: number;
    height: number;
    /** RGBA, four bytes per pixel, row-major. */
    data: Uint8ClampedArray;
  }
  function decode(input: { buffer: Uint8Array }): Promise<DecodedHeic>;
  export default decode;
}
