import { gzipSync, gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { gzipSolar } from './gzip.ts';

it('canonicalizes the host header while preserving the complete DEFLATE payload and CRC', () => {
  const input = Uint8Array.from({ length: 4096 }, (_, index) => index % 251), native = gzipSync(input, { level: 9 });
  const encoded = gzipSolar(input);
  expect([...encoded.subarray(0, 10)]).toEqual([31, 139, 8, 0, 0, 0, 0, 0, 2, 255]);
  expect(encoded.byteLength).toBe(native.byteLength);
  expect(encoded.subarray(10)).toEqual(native.subarray(10));
  expect(gunzipSync(encoded)).toEqual(Buffer.from(input));
});
