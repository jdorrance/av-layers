import { afterEach, expect, it, vi } from 'vitest';
import { createArchiveContentValidator } from './validate.js';
import * as codec from './webp.js';

afterEach(() => vi.restoreAllMocks());

it('coalesces pending repeated content and bounds verified digests with LRU eviction', async () => {
  const a = await codec.encodeWebp(new Uint8Array(256 * 256 * 4));
  const rgba = new Uint8Array(256 * 256 * 4).fill(255), b = await codec.encodeWebp(rgba);
  rgba[0] = 1; const c = await codec.encodeWebp(rgba);
  const decode = vi.spyOn(codec, 'decodeWebp');
  const verify = createArchiveContentValidator(2);
  await Promise.all([verify(a), verify(a), verify(a)]);
  expect(decode).toHaveBeenCalledTimes(1);
  await verify(b); await verify(a); await verify(c);
  expect(decode).toHaveBeenCalledTimes(3);
  await verify(a); expect(decode).toHaveBeenCalledTimes(3);
  await verify(b); expect(decode).toHaveBeenCalledTimes(4);
});

it('does not cache corrupt content as success or conflate payloads of equal length', async () => {
  const good = await codec.encodeWebp(new Uint8Array(256 * 256 * 4)), bad = Buffer.from(good);
  bad.fill(255, 25);
  const verify = createArchiveContentValidator(1);
  await verify(good);
  for (let i = 0; i < 2; i++) await expect(verify(bad)).rejects.toThrow();
  await verify(good);
  await expect(verify(new Uint8Array(1024 * 1024 + 1))).rejects.toThrow('byte length');
});
