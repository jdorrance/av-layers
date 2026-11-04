import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { link, mkdtemp, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { putImmutable } from '../immutable-upload';
import { ASSET_MAX_BYTES } from './contract';
import { localTerrainStorage } from './local-store';

const hooks = vi.hoisted(() => ({ stat: undefined as undefined | ((path: string, stats: Stats) => Promise<Stats>) }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (path: Parameters<typeof actual.open>[0], flags: string) => {
    const file = await actual.open(path, flags);
    return new Proxy(file, { get(target, property) {
      if (property === 'stat') return async (...args: unknown[]) => {
        const stats = await Reflect.apply(target.stat, target, args) as Stats;
        return hooks.stat ? hooks.stat(String(path), stats) : stats;
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
});

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'terrain-storage-')); });
afterEach(async () => { hooks.stat = undefined; await rm(directory, { recursive: true, force: true }); });

function changedCtime(stats: Stats, ctime: number): Stats {
  return Object.assign(Object.create(Object.getPrototypeOf(stats)) as Stats, stats, { ctimeMs: ctime + 1 });
}

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

it.each(['hashing', 'before reading', 'during reading'] as const)('retries a hard-link cleanup %s', async window => {
  const store = localTerrainStorage(directory), key = 'terrain/test.bin', bytes = Buffer.from('native terrain');
  const path = join(directory, key), etag = `"${createHash('md5').update(bytes).digest('hex')}"`;
  await store.put(key, bytes, { ifNoneMatch: '*' });
  await link(path, `${path}.tmp`);
  if (window !== 'hashing') await store.head(key);
  const changeAt = window === 'during reading' ? 2 : 1;
  let calls = 0, ctime = 0;
  hooks.stat = async (opened, stats) => {
    if (opened !== path) return stats;
    calls++;
    if (calls === changeAt) {
      ctime = stats.ctimeMs;
      await rm(`${path}.tmp`);
    }
    return calls === changeAt + 1 ? changedCtime(stats, ctime) : stats;
  };
  if (window === 'hashing') await expect(store.head(key)).resolves.toEqual({ size: bytes.length, etag });
  else await expect(store.get(key, { offset: 7, length: 7 }, 7)).resolves.toEqual({ bytes: Buffer.from('terrain'), etag });
  expect(calls).toBeGreaterThan(changeAt + 1);
  expect(await readdir(join(directory, 'terrain'))).toEqual(['test.bin']);
});

it('rejects changed existing content after retrying a metadata race', async () => {
  const store = localTerrainStorage(directory), key = 'terrain/test.bin', bytes = Buffer.from('original');
  const path = join(directory, key);
  await store.put(key, bytes, { ifNoneMatch: '*' });
  let calls = 0, ctime = 0;
  hooks.stat = async (opened, stats) => {
    if (opened !== path) return stats;
    calls++;
    if (calls === 1) { ctime = stats.ctimeMs; await writeFile(path, 'modified'); }
    return calls === 2 ? changedCtime(stats, ctime) : stats;
  };
  await expect(putImmutable(store, key, bytes, 'application/octet-stream')).rejects.toThrow('Immutable object hash mismatch');
  hooks.stat = undefined;
  expect((await store.get(key))?.bytes).toEqual(Buffer.from('modified'));
});

it('fails closed after bounded metadata changes', async () => {
  const store = localTerrainStorage(directory), key = 'terrain/test.bin', path = join(directory, key);
  await store.put(key, Buffer.from('original'), { ifNoneMatch: '*' });
  let calls = 0, ctime = 0;
  hooks.stat = async (opened, stats) => {
    if (opened !== path) return stats;
    calls++;
    if (calls % 2 === 1) { ctime = stats.ctimeMs; return stats; }
    return changedCtime(stats, ctime);
  };
  await expect(store.head(key)).rejects.toThrow('Local terrain object changed during hashing');
  expect(calls).toBe(6);
});

it('honors cancellation before retrying a metadata change', async () => {
  const store = localTerrainStorage(directory), key = 'terrain/test.bin', path = join(directory, key), controller = new AbortController();
  await store.put(key, Buffer.from('original'), { ifNoneMatch: '*' });
  let calls = 0, ctime = 0;
  hooks.stat = async (opened, stats) => {
    if (opened !== path) return stats;
    calls++;
    if (calls === 1) { ctime = stats.ctimeMs; return stats; }
    controller.abort(new Error('cancelled retry'));
    return changedCtime(stats, ctime);
  };
  await expect(store.head(key, controller.signal)).rejects.toThrow('cancelled retry');
  expect(calls).toBe(2);
});
