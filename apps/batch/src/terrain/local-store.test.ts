import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { putImmutable } from '../immutable-upload';
import { ASSET_MAX_BYTES } from './contract';
import { localTerrainStorage } from './local-store';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'terrain-storage-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('supports concurrent immutable retries and exact byte ranges without leftover files', async () => {
  const store = localTerrainStorage(directory), key = 'terrain/test.bin', bytes = Buffer.from('native terrain');
  await expect(store.head(key)).resolves.toBeNull();
  await Promise.all(Array.from({ length: 3 }, () => putImmutable(store, key, bytes, 'application/octet-stream')));
  const etag = `"${createHash('md5').update(bytes).digest('hex')}"`;
  await expect(store.head(key)).resolves.toEqual({ size: bytes.length, etag });
  await expect(store.get(key, { offset: 7, length: 7 }, 7)).resolves.toEqual({ bytes: Buffer.from('terrain'), etag });
  await expect(putImmutable(store, key, Buffer.from('changed values'), 'application/octet-stream')).rejects.toThrow(/hash mismatch/);
  expect(await readdir(join(directory, 'terrain'))).toEqual(['test.bin']);
});

it('rejects traversal, unbounded reads, oversized files and cancelled reads', async () => {
  const store = localTerrainStorage(directory), key = 'terrain/test.bin';
  await store.put(key, Buffer.from('12345678'), { ifNoneMatch: '*' });
  for (const bad of ['terrain/../secret', '/terrain/test', 'other/test']) await expect(store.head(bad)).rejects.toThrow(/object key/);
  await expect(store.get(key, { offset: 0, length: 8 }, 7)).rejects.toThrow(/oversized/);
  await expect(store.get(key, { offset: 7, length: 2 }, 8)).rejects.toThrow(/oversized/);
  await expect(store.get(key, undefined, ASSET_MAX_BYTES + 1)).rejects.toThrow(/read budget/);
  await expect(store.get(key, undefined, 8, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
  await truncate(join(directory, key), ASSET_MAX_BYTES + 1);
  await expect(store.head(key)).rejects.toThrow(/byte budget/);
});

it('invalidates cached ETags when an existing local file changes', async () => {
  const store = localTerrainStorage(directory), key = 'terrain/test.bin';
  await store.put(key, Buffer.from('old'), { ifNoneMatch: '*' });
  const before = await store.head(key);
  await writeFile(join(directory, key), 'new');
  const after = await store.get(key);
  expect(after?.bytes).toEqual(Buffer.from('new'));
  expect(after?.etag).not.toBe(before?.etag);
});
