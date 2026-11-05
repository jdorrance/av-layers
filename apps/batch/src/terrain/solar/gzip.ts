import { gzipSync } from 'node:zlib';

/** Gzip OS255 keeps generation bytes identical across Node hosts. */
export function gzipSolar(bytes: Uint8Array): Uint8Array {
  const encoded = gzipSync(bytes, { level: 9 });
  encoded[9] = 255;
  return encoded;
}
