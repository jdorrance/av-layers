import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dataIdentity, sha256 } from './contract.js';
import { openTerrainSourceCache, type TerrainSourceCache } from './source-cache.js';
import { TerrainTestStorage, terrainCatalogFixture } from './test-fixtures.js';

let directory: string;
const caches: TerrainSourceCache[] = [];
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'terrain-source-cache-')); });
afterEach(async () => { await Promise.all(caches.splice(0).map(cache => cache.close())); await rm(directory, { recursive: true, force: true }); });

function fixture(count = 6) {
  const storage = new TerrainTestStorage(), catalog = terrainCatalogFixture();
  const bytes = Array.from({ length: count }, (_, index) => Buffer.alloc(16, index + 1));
  catalog.tiles = bytes.map((data, index) => ({ ...catalog.tiles[0],
    id: `Copernicus_DSM_COG_30_N00_00_E${String(index).padStart(3, '0')}_00_DEM`, west: index,
    geometry: { ...catalog.tiles[0].geometry, lon0: index },
    asset: { key: `terrain/assets/${sha256(data)}.tif`, sha256: sha256(data), bytes: data.length }
  }));
  catalog.dataId = dataIdentity(catalog);
  for (let index = 0; index < bytes.length; index++) storage.objects.set(catalog.tiles[index].asset.key, bytes[index]);
  const keys = catalog.tiles.map(tile => tile.asset.key);
  return { storage, catalog, bytes, keys };
}
async function open(input: ReturnType<typeof fixture>, maxBytes = 96) {
  const cache = await openTerrainSourceCache({ ...input, directory, maxBytes }); caches.push(cache); return cache;
}
function blocked(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal!.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    releases.push(() => { signal?.removeEventListener('abort', abort); resolve(); });
  });
}
const releases: (() => void)[] = [];
afterEach(() => { releases.splice(0).forEach(release => release()); });

it('coalesces immutable downloads and serves exact ranges with locally verified identity', async () => {
  const input = fixture(), original = input.storage.get.bind(input.storage);
  const get = vi.spyOn(input.storage, 'get').mockImplementation(async (...args) => {
    await blocked(args[3]); const result = await original(...args); return result && { ...result, etag: 'remote-multipart-etag' };
  });
  const head = vi.spyOn(input.storage, 'head'), put = vi.spyOn(input.storage, 'put');
  const cache = await open(input), key = input.keys[0];
  const first = cache.storage.head(key), ranges = Array.from({ length: 8 }, () => cache.storage.get(key, { offset: 3, length: 7 }, 7));
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  releases.splice(0).forEach(release => release());
  const proof = await first, values = await Promise.all(ranges);
  const etag = `"${createHash('md5').update(input.bytes[0]).digest('hex')}"`;
  expect(proof).toEqual({ size: 16, etag, computedSha256: sha256(input.bytes[0]) });
  expect(values).toEqual(Array.from({ length: 8 }, () => ({ bytes: input.bytes[0].subarray(3, 10), etag })));
  expect(get.mock.calls[0].slice(0, 3)).toEqual([key, undefined, 16]);
  expect(head).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  expect(cache.stats()).toMatchObject({ downloads: 1, remoteRequests: 1, downloadBytes: 16, cachedBytes: 16, reservedBytes: 0 });
});

it('delegates catalog, inventory and prepared objects to their original storage', async () => {
  const input = fixture(), cache = await open(input), key = 'terrain/prepared/fixture/manifest.json', bytes = Buffer.from('prepared');
  await cache.storage.put(key, bytes, { ifNoneMatch: '*' });
  expect(await cache.storage.get(key)).toEqual(await input.storage.get(key));
  expect(await cache.storage.head(key)).toEqual(await input.storage.head(key));
  expect(cache.stats()).toMatchObject({ downloads: 0, cachedBytes: 0 });
  expect(await readdir(join(directory, 'terrain/assets'))).toEqual([]);
});

it('bounds downloads at four and reserves disk bytes before starting each transfer', async () => {
  const input = fixture(), original = input.storage.get.bind(input.storage);
  const get = vi.spyOn(input.storage, 'get').mockImplementation(async (...args) => { await blocked(args[3]); return original(...args); });
  const cache = await open(input), pending = cache.prefetch(input.keys);
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(4));
  expect(cache.stats()).toMatchObject({ activeDownloads: 4, reservedBytes: 64, peakDownloads: 4 });
  releases.splice(0).forEach(release => release());
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(6));
  releases.splice(0).forEach(release => release());
  const release = await pending; release(); release();
  expect(cache.stats()).toMatchObject({ downloads: 6, cachedBytes: 96, reservedBytes: 0, peakDownloads: 4 });
  expect(cache.stats().peakBytes).toBeLessThanOrEqual(96);
  await cache.close();
  const smaller = await open(input, 32);
  get.mockClear();
  await expect(smaller.prefetch(input.keys.slice(0, 3))).rejects.toThrow('window exceeds');
  expect(get).not.toHaveBeenCalled();
  expect(smaller.stats().cachedBytes).toBeLessThanOrEqual(32);
});

it('pins complete source windows until release and evicts the least recently used unpinned file', async () => {
  const input = fixture(), cache = await open(input, 48), get = vi.spyOn(input.storage, 'get');
  const release = await cache.prefetch(input.keys.slice(0, 3));
  await cache.storage.head(input.keys[1]);
  await cache.storage.head(input.keys[2]);
  await cache.storage.head(input.keys[0]);
  const waiting = cache.storage.head(input.keys[3]);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(get).toHaveBeenCalledTimes(3);
  expect(cache.stats().cachedBytes).toBe(48);
  release(); await waiting;
  const names = await readdir(join(directory, 'terrain/assets'));
  expect(names.sort()).toEqual([input.keys[0], input.keys[2], input.keys[3]].map(key => key.split('/').at(-1)!).sort());
  expect(cache.stats()).toMatchObject({ cachedBytes: 48, reservedBytes: 0 });
  expect(cache.stats().peakBytes).toBe(48);
});

it('reuses verified files after restart and replaces a corrupt cached COG before sampling', async () => {
  const input = fixture(), get = vi.spyOn(input.storage, 'get'), cache = await open(input, 16);
  await cache.storage.head(input.keys[0]); await cache.close();
  const resumed = await open(input, 16);
  expect((await resumed.storage.get(input.keys[0]))!.bytes).toEqual(input.bytes[0]);
  expect(get).toHaveBeenCalledTimes(1); await resumed.close();
  await writeFile(join(directory, input.keys[0]), Buffer.alloc(16, 99));
  const repaired = await open(input, 16);
  expect((await repaired.storage.get(input.keys[0]))!.bytes).toEqual(input.bytes[0]);
  expect(get).toHaveBeenCalledTimes(2);
  expect(repaired.stats()).toMatchObject({ downloads: 1, cachedBytes: 16 });
});

it.each(['hash', 'size'] as const)('rejects a remote %s mismatch before installing a cache file and permits retry', async defect => {
  const input = fixture(), original = input.storage.get.bind(input.storage);
  const get = vi.spyOn(input.storage, 'get').mockImplementationOnce(async (...args) => {
    const result = (await original(...args))!;
    return { ...result, bytes: defect === 'hash' ? Buffer.alloc(16, 99) : result.bytes.subarray(1) };
  });
  const cache = await open(input, 16);
  await expect(cache.storage.head(input.keys[0])).rejects.toThrow('integrity mismatch');
  expect(cache.stats()).toMatchObject({ cachedBytes: 0, reservedBytes: 0, activeDownloads: 0 });
  expect(await readdir(join(directory, 'terrain/assets'))).toEqual([]);
  await cache.storage.head(input.keys[0]);
  expect(get).toHaveBeenCalledTimes(2);
});

it('cancels one coalesced waiter while retaining the shared download for its survivor', async () => {
  const input = fixture(), original = input.storage.get.bind(input.storage);
  let ownerSignal: AbortSignal | undefined;
  const get = vi.spyOn(input.storage, 'get').mockImplementation(async (...args) => { ownerSignal = args[3]; await blocked(ownerSignal); return original(...args); });
  const cache = await open(input, 16), controller = new AbortController(), reason = new Error('cancel waiter');
  const first = cache.storage.head(input.keys[0], controller.signal), survivor = cache.storage.head(input.keys[0]);
  await vi.waitFor(() => expect(get).toHaveBeenCalledOnce()); controller.abort(reason);
  await expect(first).rejects.toBe(reason); expect(ownerSignal?.aborted).toBe(false);
  releases.splice(0).forEach(release => release());
  expect((await survivor)?.computedSha256).toBe(sha256(input.bytes[0]));
  expect(get).toHaveBeenCalledOnce();
});

it('starts a fresh download for a live waiter after the abandoned owner drains', async () => {
  const input = fixture(), original = input.storage.get.bind(input.storage), key = input.keys[0];
  let started!: (owner: AbortSignal) => void, finish!: () => void;
  const ownerSignal = new Promise<AbortSignal>(resolve => { started = resolve; });
  const drain = new Promise<void>(resolve => { finish = resolve; });
  const get = vi.spyOn(input.storage, 'get').mockImplementationOnce(async (...args) => {
    started(args[3]!);
    await drain;
    return original(...args);
  });
  const cache = await open(input, 16), controller = new AbortController(), reason = new Error('cancel first waiter');
  const first = cache.storage.head(key, controller.signal);
  try {
    const owner = await ownerSignal;
    controller.abort(reason);
    await expect(first).rejects.toBe(reason);
    expect(owner.aborted).toBe(true);
    const next = cache.storage.head(key);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(get).toHaveBeenCalledOnce();
    expect(cache.stats()).toMatchObject({ activeDownloads: 1, reservedBytes: 16 });
    finish();
    expect((await next)?.computedSha256).toBe(sha256(input.bytes[0]));
    expect(get).toHaveBeenCalledTimes(2);
    expect(cache.stats()).toMatchObject({ downloads: 1, peakBytes: 16, reservedBytes: 0 });
  } finally { finish(); }
});

it('observes cancelled source work when its waiter aborts before pin admission completes', async () => {
  const input = fixture(), cache = await open(input), reason = new Error('cancel during admission');
  for (const kind of ['head', 'prefetch']) {
    const controller = new AbortController();
    const pending = kind === 'head' ? cache.storage.head(input.keys[0], controller.signal) : cache.prefetch(input.keys, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  }
  await cache.close();
  expect(cache.stats()).toMatchObject({ activeDownloads: 0, reservedBytes: 0 });
});

it('drains active and queued downloads on window cancellation without publishing partial COGs', async () => {
  const input = fixture(), get = vi.spyOn(input.storage, 'get').mockImplementation(async (_key, _range, _maximum, signal) => { await blocked(signal); return null; });
  const cache = await open(input), controller = new AbortController(), reason = new Error('cancel source window');
  const pending = cache.prefetch(input.keys, controller.signal);
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(4)); controller.abort(reason);
  await expect(pending).rejects.toBe(reason); await cache.close();
  expect(get).toHaveBeenCalledTimes(4);
  expect(cache.stats()).toMatchObject({ downloads: 0, cachedBytes: 0, reservedBytes: 0, activeDownloads: 0 });
  expect(await readdir(join(directory, 'terrain/assets'))).toEqual([]);
  await expect(cache.storage.head(input.keys[0])).rejects.toThrow('cache closed');
});

it('keeps an active local range read pinned while another source waits for the same disk space', async () => {
  const input = fixture(), cache = await open(input, 16);
  await cache.storage.head(input.keys[0]);
  const [range, next] = await Promise.all([cache.storage.get(input.keys[0], { offset: 2, length: 7 }, 7), cache.storage.head(input.keys[1])]);
  expect(range?.bytes).toEqual(input.bytes[0].subarray(2, 9));
  expect(next?.computedSha256).toBe(sha256(input.bytes[1]));
  expect(cache.stats()).toMatchObject({ cachedBytes: 16, reservedBytes: 0 });
});
