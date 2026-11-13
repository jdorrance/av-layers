import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Compression, TileType } from 'pmtiles';
import { admit, manifest, pointer, pointerCacheState } from '../src/publication';
import { readTile } from '../src/pmtiles';
import { matchStorageBytes, storeStorageBytes } from '../src/storage-cache';
import { inFlightAllocationBytes, reserveAllocation, type WaitContext } from '../src/resources';
import { NOW, createV5Fixture } from './v5-fixture';

class StorageCache {
  entries = new Map<string, { bytes: Uint8Array; headers: Headers }>();
  match = vi.fn(async (request: Request) => {
    const value = this.entries.get(request.url);
    return value ? new Response(value.bytes.slice(), { headers: value.headers }) : undefined;
  });
  put = vi.fn(async (request: Request, response: Response) => {
    this.entries.set(request.url, { bytes: new Uint8Array(await response.arrayBuffer()), headers: new Headers(response.headers) });
  });
}
let cache: StorageCache;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); cache = new StorageCache(); vi.stubGlobal('caches', { default: cache }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function context(origin = 'https://api.test') {
  const pending: Promise<unknown>[] = [];
  const ctx: WaitContext = { cacheOrigin: origin, metrics: { r2Reads: 0, r2Bytes: 0, cacheHits: 0, coalesced: 0 }, waitUntil(promise) { pending.push(promise); } };
  return { ctx, async settle() { while (pending.length) await Promise.all(pending.splice(0)); } };
}
const retained = (fixture: ReturnType<typeof createV5Fixture>) => ({ buildId: fixture.buildId, manifestKey: `builds/${fixture.manifest.model}/${fixture.buildId}/manifest.json`, cycle: fixture.manifest.cycle, expiresAt: fixture.manifest.expiresAt });
const nextBuild = '20261101T000000Z-00000000-0000-0000-0000-000000000002';

it('shares validated publication bytes across cold bucket handles without extending pointer freshness', async () => {
  const first = createV5Fixture(), owner = context();
  const load = async (fixture: typeof first, ctx: WaitContext) => {
    const entry = await admit(fixture.bucket, fixture.manifest.model, fixture.buildId, ctx);
    return manifest(fixture.bucket, fixture.manifest.model, fixture.buildId, entry, ctx, fixture.product);
  };
  await load(first, owner.ctx); await owner.settle();
  expect(first.get).toHaveBeenCalledTimes(2);
  vi.setSystemTime(NOW + 10_000);
  const second = createV5Fixture(), visitor = context();
  expect(await load(second, visitor.ctx)).toEqual(first.manifest); await visitor.settle();
  expect(second.get).not.toHaveBeenCalled();
  expect(visitor.ctx.metrics).toMatchObject({ r2Reads: 0, cacheHits: 2 });
  expect(pointerCacheState(await pointer(second.bucket, second.manifest.model))).toMatchObject({ until: NOW + 15_000 });
  vi.setSystemTime(NOW + 15_000);
  await pointer(second.bucket, second.manifest.model, false, visitor.ctx); await visitor.settle();
  expect(second.get).toHaveBeenCalledTimes(1);
  expect(pointerCacheState(await pointer(second.bucket, second.manifest.model))).toMatchObject({ until: NOW + 30_000 });
});

it('bypasses shared pointer bytes for membership refresh and keeps API origins separate', async () => {
  const old = createV5Fixture(), first = context();
  await pointer(old.bucket, old.manifest.model, false, first.ctx); await first.settle();
  vi.setSystemTime(NOW + 2000);
  const next = createV5Fixture({ buildId: nextBuild }), second = context();
  const entry = await admit(next.bucket, next.manifest.model, next.buildId, second.ctx); await second.settle();
  expect(entry.buildId).toBe(nextBuild);
  expect(next.get).toHaveBeenCalledTimes(1);
  const separate = createV5Fixture(), staging = context('https://staging.test');
  expect((await pointer(separate.bucket, separate.manifest.model, false, staging.ctx)).latestBuildId).toBe(separate.buildId);
  await staging.settle(); expect(separate.get).toHaveBeenCalledTimes(1);
});

it('rechecks retained membership and deployed product compatibility before using a shared manifest', async () => {
  const fixture = createV5Fixture(), first = context();
  await pointer(fixture.bucket, fixture.manifest.model, false, first.ctx);
  await manifest(fixture.bucket, fixture.manifest.model, fixture.buildId, retained(fixture), first.ctx, fixture.product);
  await first.settle();
  const second = createV5Fixture(), next = context();
  await expect(manifest(second.bucket, second.manifest.model, second.buildId, retained(second), next.ctx,
    { ...second.product, attribution: 'Changed product' })).rejects.toThrow('admitted product');
  expect(second.get).not.toHaveBeenCalled();
  vi.setSystemTime(NOW + 15_000);
  const removed = createV5Fixture({ buildId: nextBuild }), third = context();
  await expect(admit(removed.bucket, removed.manifest.model, fixture.buildId, third.ctx)).rejects.toMatchObject({ code: 'not-retained' });
  await third.settle();
  expect(removed.get.mock.calls.every(([key]) => key.startsWith('catalog/'))).toBe(true);
});

it('recovers corrupt or schema-invalid shared bytes from R2 and never caches rejected manifests', async () => {
  const fixture = createV5Fixture(), first = context();
  await manifest(fixture.bucket, fixture.manifest.model, fixture.buildId, retained(fixture), first.ctx, fixture.product); await first.settle();
  const [key, stored] = [...cache.entries][0]; stored.bytes[0] ^= 1;
  const second = createV5Fixture(), next = context();
  await manifest(second.bucket, second.manifest.model, second.buildId, retained(second), next.ctx, second.product); await next.settle();
  expect(second.get).toHaveBeenCalledTimes(1);
  await storeStorageBytes(`manifest:${retained(fixture).manifestKey}:${fixture.manifest.cycle}:${fixture.manifest.expiresAt}`,
    { bytes: new TextEncoder().encode('{}'), until: Date.parse(fixture.manifest.expiresAt) }, next.ctx);
  const third = createV5Fixture();
  await manifest(third.bucket, third.manifest.model, third.buildId, retained(third), next.ctx, third.product); await next.settle();
  expect(third.get).toHaveBeenCalledTimes(1);
  expect(cache.entries.get(key)!.bytes).toEqual(fixture.objects.get(retained(fixture).manifestKey));
  cache.entries.clear();
  const invalid = createV5Fixture();
  await expect(manifest(invalid.bucket, invalid.manifest.model, invalid.buildId, retained(invalid), next.ctx,
    { ...invalid.product, attribution: 'Changed product' })).rejects.toThrow('admitted product');
  await next.settle(); expect(cache.entries.size).toBe(0);
});

it('treats cache outages as optional and releases failed cache-write reservations', async () => {
  cache.match.mockRejectedValue(new Error('cache unavailable'));
  cache.put.mockRejectedValue(new Error('cache unavailable'));
  const fixture = createV5Fixture(), owner = context();
  await pointer(fixture.bucket, fixture.manifest.model, false, owner.ctx);
  await manifest(fixture.bucket, fixture.manifest.model, fixture.buildId, retained(fixture), owner.ctx, fixture.product);
  await owner.settle();
  expect(fixture.get).toHaveBeenCalledTimes(2);
  expect(inFlightAllocationBytes()).toBe(0);
});

it('holds the cache-write permit until settlement and preserves allocations on oversized cache reads', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  cache.put.mockImplementationOnce(async () => { await gate; });
  const owner = context(), bytes = new Uint8Array(1024);
  const put = storeStorageBytes('held', { bytes, until: NOW + 1000 }, owner.ctx);
  await vi.waitFor(() => expect(cache.put).toHaveBeenCalledTimes(1));
  expect(inFlightAllocationBytes()).toBe(2048);
  release(); await put; expect(inFlightAllocationBytes()).toBe(0);
  await storeStorageBytes('oversized', { bytes, until: NOW + 1000 }, owner.ctx);
  expect(await matchStorageBytes('oversized', 512, owner.ctx, new AbortController().signal)).toBeUndefined();
  const free = reserveAllocation(32 * 1024 * 1024);
  try { expect(await matchStorageBytes('oversized', 1024, owner.ctx, new AbortController().signal)).toBeUndefined(); }
  finally { free(); }
  expect(inFlightAllocationBytes()).toBe(0);
});

it('honors cancellation and absolute expiry while consuming shared cache bytes', async () => {
  const owner = context(), bytes = Uint8Array.of(1, 2, 3), controller = new AbortController();
  await storeStorageBytes('data', { bytes, until: NOW + 1000 }, owner.ctx);
  const original = cache.match.getMockImplementation()!;
  cache.match.mockImplementationOnce(async request => { const response = await original(request); controller.abort(new Error('cancelled')); return response; });
  await expect(matchStorageBytes('data', 3, owner.ctx, controller.signal)).rejects.toThrow('cancelled');
  vi.setSystemTime(NOW + 1000);
  expect(await matchStorageBytes('data', 3, owner.ctx, new AbortController().signal)).toBeUndefined();
  expect(inFlightAllocationBytes()).toBe(0);
});

it('stops a late cache miss at the pointer deadline before reading or caching an unavailable publication', async () => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  let release!: () => void;
  cache.match.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(undefined); }));
  const fixture = createV5Fixture(), owner = context();
  const get = fixture.get.getMockImplementation()!;
  fixture.get.mockResolvedValue(null);
  const pending = expect(pointer(fixture.bucket, fixture.manifest.model, false, owner.ctx)).rejects.toThrow('Object read deadline exceeded');
  await vi.advanceTimersByTimeAsync(15_000);
  await pending;
  release(); await owner.settle();
  expect(fixture.get).not.toHaveBeenCalled();
  fixture.get.mockImplementation(get);
  expect((await pointer(fixture.bucket, fixture.manifest.model, false, owner.ctx)).latestBuildId).toBe(fixture.buildId);
  await owner.settle(); expect(fixture.get).toHaveBeenCalledTimes(1);
  expect(inFlightAllocationBytes()).toBe(0);
});

function archiveFixture(etag = 'archive-etag') {
  const bytes = new Uint8Array(16387), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('PMTiles')); bytes[7] = 3;
  for (const [offset, value] of [[8, 127], [16, 5], [40, 132], [48, 5], [56, 16384], [64, 3], [72, 1], [80, 1], [88, 1]]) view.setBigUint64(offset, BigInt(value), true);
  bytes[97] = Compression.None; bytes[98] = Compression.None; bytes[99] = TileType.Webp;
  bytes.set([1, 0, 0, 5, 1], 127); bytes.set([1, 0, 1, 3, 1], 132); bytes.set([7, 8, 9], 16384);
  const identity = { sha256: createHash('sha256').update(bytes).digest('hex'), expiresAt: new Date(NOW + 60_000).toISOString() };
  const get = vi.fn(async (_key: string, options: { range: { offset: number; length: number }; onlyIf?: { etagMatches: string } }) => {
    if (options.onlyIf && options.onlyIf.etagMatches !== etag) return { etag };
    const { offset, length } = options.range;
    return { size: bytes.length, etag, body: new Response(bytes.slice(offset, offset + length)).body! };
  });
  return { identity, get, bucket: { get } as unknown as R2Bucket };
}

it('shares PMTiles header/root and leaf ranges across isolates while reading addressed tile payloads', async () => {
  const first = archiveFixture(), owner = context();
  expect(new Uint8Array(await readTile(first.bucket, 'archive', 0, 0, 0, owner.ctx, undefined, first.identity))).toEqual(Uint8Array.of(7, 8, 9));
  await owner.settle(); expect(first.get).toHaveBeenCalledTimes(3);
  expect(cache.entries.size).toBe(2);
  const second = archiveFixture(), next = context();
  expect(new Uint8Array(await readTile(second.bucket, 'archive', 0, 0, 0, next.ctx, undefined, second.identity))).toEqual(Uint8Array.of(7, 8, 9));
  await next.settle(); expect(second.get).toHaveBeenCalledTimes(1);
  expect(second.get).toHaveBeenCalledWith('archive', { range: { offset: 16384, length: 3 }, onlyIf: { etagMatches: 'archive-etag' } });
  expect(next.ctx.metrics).toMatchObject({ r2Reads: 1, cacheHits: 2 });
  expect(inFlightAllocationBytes()).toBe(0);
});

it('refreshes shared archive metadata after an ETag mismatch and shares the recovered ranges', async () => {
  const first = archiveFixture(), owner = context();
  await readTile(first.bucket, 'archive', 0, 0, 0, owner.ctx, undefined, first.identity); await owner.settle();
  const second = archiveFixture('new-etag'), next = context();
  expect(new Uint8Array(await readTile(second.bucket, 'archive', 0, 0, 0, next.ctx, undefined, second.identity))).toEqual(Uint8Array.of(7, 8, 9));
  await next.settle();
  expect(second.get).toHaveBeenCalledTimes(4);
  expect(second.get).toHaveBeenNthCalledWith(1, 'archive', { range: { offset: 16384, length: 3 }, onlyIf: { etagMatches: 'archive-etag' } });
  expect(second.get).toHaveBeenNthCalledWith(2, 'archive', { range: { offset: 0, length: 16384 } });
  const third = archiveFixture('new-etag'), visitor = context();
  expect(new Uint8Array(await readTile(third.bucket, 'archive', 0, 0, 0, visitor.ctx, undefined, third.identity))).toEqual(Uint8Array.of(7, 8, 9));
  await visitor.settle(); expect(third.get).toHaveBeenCalledTimes(1);
  expect(third.get).toHaveBeenCalledWith('archive', { range: { offset: 16384, length: 3 }, onlyIf: { etagMatches: 'new-etag' } });
  expect(inFlightAllocationBytes()).toBe(0);
});

it('separates archive identities and recovers corrupt metadata ranges', async () => {
  const first = archiveFixture(), owner = context();
  await readTile(first.bucket, 'archive', 0, 0, 0, owner.ctx, undefined, first.identity); await owner.settle();
  const header = [...cache.entries.values()].find(value => value.bytes.length === 16384)!;
  header.bytes[0] ^= 1;
  const second = archiveFixture();
  await readTile(second.bucket, 'archive', 0, 0, 0, owner.ctx, undefined, second.identity); await owner.settle();
  expect(second.get).toHaveBeenCalledTimes(2);
  const third = archiveFixture();
  await readTile(third.bucket, 'archive', 0, 0, 0, owner.ctx, undefined, { ...third.identity, sha256: 'f'.repeat(64) }); await owner.settle();
  expect(third.get).toHaveBeenCalledTimes(3);
});

it('validates coalesced manifest callers independently and publishes bytes once after successful validation', async () => {
  const fixture = createV5Fixture(), owner = context();
  const load = (product: typeof fixture.product) => manifest(fixture.bucket, fixture.manifest.model, fixture.buildId,
    retained(fixture), owner.ctx, product);
  const results = await Promise.allSettled([load({ ...fixture.product, attribution: 'Changed product' }), load(fixture.product), load(fixture.product)]);
  expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'publication-invalid' } });
  expect(results[1]).toMatchObject({ status: 'fulfilled', value: fixture.manifest });
  expect(results[2]).toMatchObject({ status: 'fulfilled', value: fixture.manifest });
  await owner.settle();
  expect(fixture.get).toHaveBeenCalledTimes(1);
  expect(cache.put).toHaveBeenCalledTimes(1);
  const second = createV5Fixture(), visitor = context();
  await manifest(second.bucket, second.manifest.model, second.buildId, retained(second), visitor.ctx, second.product);
  await visitor.settle(); expect(second.get).not.toHaveBeenCalled();
});
