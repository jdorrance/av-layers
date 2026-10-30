import { describe, expect, it } from 'vitest';
import { decodeWebp, encodeWebp, WEBP_ENCODER } from './webp.js';

describe('packaged libwebp lossless codec', () => {
  it('preserves every RGBA byte, including RGB under alpha zero and partial alpha', async () => {
    const width = 16, height = 16;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = (i * 37) & 0xff;
      rgba[i * 4 + 1] = (i * 73) & 0xff;
      rgba[i * 4 + 2] = (i * 151) & 0xff;
      rgba[i * 4 + 3] = i % 5 === 0 ? 0 : (i * 19) & 0xff;
    }
    const padded = new Uint8Array(rgba.byteLength + 8).fill(255);
    padded.set(rgba, 4);
    const encoded = await encodeWebp(padded.subarray(4, 4 + rgba.byteLength), width, height);
    const decoded = await decodeWebp(encoded);
    expect(decoded).toEqual({ width, height, data: rgba });
    expect(WEBP_ENCODER.options).toMatchObject({ lossless: true, exact: true });
  });

  it.each([0, 2, 4, 6])('preserves exact RGBA at benchmark effort %i', async effort => {
    const rgba = Uint8Array.from([1, 2, 3, 0, 185, 59, 136, 128, 0, 255, 0, 255, 0, 0, 255, 255]);
    expect((await decodeWebp(await encodeWebp(rgba, 2, 2, effort))).data).toEqual(rgba);
  });

  it('decodes an independently encoded libwebp image and respects byte-view bounds', async () => {
    // cwebp 1.5.0 -lossless -exact, from a 2x2 RGBA PNG containing these pixels.
    const fixture = Buffer.from('UklGRjgAAABXRUJQVlA4TCsAAAAvAUAAEB9AIEBRrPJ/mBsCgaT9hcYjEKAotttNIEBw7lzgn7S6F9Yhov8RAA==', 'base64');
    const padded = Buffer.concat([Buffer.from('unrelated prefix'), fixture, Buffer.from('unrelated suffix')]);
    const decoded = await decodeWebp(padded.subarray(16, 16 + fixture.length));
    expect(decoded).toEqual({ width: 2, height: 2, data: new Uint8Array([1, 2, 3, 0, 185, 59, 136, 128, 0, 255, 0, 255, 0, 0, 255, 255]) });
  });

  it('keeps constant opaque tiles compact', async () => {
    const rgba = new Uint8Array(256 * 256 * 4);
    for (let i = 0; i < 256 * 256; i++) rgba[i * 4 + 3] = 255;
    const encoded = await encodeWebp(rgba);
    expect(encoded.byteLength).toBeLessThan(300);
    expect((await decodeWebp(encoded)).data).toEqual(rgba);
  });

  it('rejects invalid dimensions and incomplete RGBA input', async () => {
    await expect(encodeWebp(new Uint8Array(4), 1, 1, 7)).rejects.toThrow(RangeError);
    await expect(encodeWebp(new Uint8Array(4), 1, 1, 1.5)).rejects.toThrow(RangeError);
    await expect(encodeWebp(new Uint8Array(4), 0, 1)).rejects.toThrow(RangeError);
    await expect(encodeWebp(new Uint8Array(4), 1.5, 1)).rejects.toThrow(RangeError);
    await expect(encodeWebp(new Uint8Array(4), 16384, 1)).rejects.toThrow(RangeError);
    await expect(encodeWebp(new Uint8Array(3), 1, 1)).rejects.toThrow(RangeError);
  });

  it('rejects invalid headers and truncated pixel data', async () => {
    await expect(decodeWebp(new Uint8Array(10))).rejects.toThrow('Expected lossless VP8L WebP');
    const encoded = await encodeWebp(new Uint8Array(4 * 4 * 4), 4, 4);
    await expect(decodeWebp(encoded.subarray(0, 25))).rejects.toThrow();
    const lossyHeader = Buffer.from(encoded); lossyHeader[15] = 0x20;
    await expect(decodeWebp(lossyHeader)).rejects.toThrow('Expected lossless VP8L WebP');
  });
});
