import sharp from 'sharp';

export interface WebpImage {
  width: number;
  height: number;
  data: Uint8Array;
}

const options = { lossless: true, exact: true, quality: 75, effort: 4 } as const;
export const WEBP_ENCODER = { package: 'sharp', version: sharp.versions.sharp, libwebp: sharp.versions.webp, libvips: sharp.versions.vips, options } as const;

export async function encodeWebp(rgba: Uint8Array, width = 256, height = 256, effort: number = options.effort): Promise<Buffer> {
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 16383) || rgba.byteLength !== width * height * 4) {
    throw new RangeError('Invalid WebP dimensions or RGBA byte length');
  }
  if (!Number.isInteger(effort) || effort < 0 || effort > 6) throw new RangeError('Invalid WebP effort');
  return sharp(rgba, { raw: { width, height, channels: 4 } }).webp({ ...options, effort }).toBuffer();
}

/** Fully decode the lossless format produced by this batch pipeline. */
export async function decodeWebp(bytes: Uint8Array): Promise<WebpImage> {
  const header = Buffer.from(bytes.subarray(0, 21));
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 16) !== 'WEBPVP8L' || header[20] !== 0x2f) {
    throw new Error('Expected lossless VP8L WebP');
  }
  const { data, info } = await sharp(bytes, { failOn: 'warning' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}
