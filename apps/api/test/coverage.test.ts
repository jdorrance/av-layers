import { INDEXED_PRODUCT } from '../../../tests/model-fixtures';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as contracts from '@av/contracts';
import { canonicalGridJson, gridSchema, sparseCoverageFromDense, type ForecastSurfaceV5, type Grid } from '@av/contracts';
import { resolveSparseCoverage } from '../src/coverage';
import { describeSparseCoverage } from '../../batch/src/coverage';
import { inFlightAllocationBytes, reserveAllocation } from '../src/resources';

const now = Date.parse('2026-11-01T00:00:00Z');
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const regular: Grid = gridSchema.parse({ kind: 'regular-latlon', width: 3, height: 3, lon0: -1, lat0: 1, dx: 1, dy: -1, wrapLongitude: false, earthRadiusM: 6371229 });
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => undefined } }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('lazily verifies sparse coverage and binds its canonical sample layout', async () => {
  const gridHash = hash(new TextEncoder().encode(canonicalGridJson(regular)));
  const coverage = sparseCoverageFromDense({ width: 3, height: 3, wrapLongitude: false, gridHash, output: Uint8Array.of(16, 0), halo: Uint8Array.of(239, 1) });
  const mask = { grid: regular, coverage, maxZoom: 0, tiles: Uint8Array.of(1) }, description = describeSparseCoverage(mask, INDEXED_PRODUCT);
  const prefix = `coverage/${description.hash}`;
  const objects = new Map<string, Uint8Array>([[`${prefix}/manifest.json`, description.bytes], [`${prefix}/sparse.bin`, description.sparseBytes], [`${prefix}/tiles.bin`, mask.tiles]]);
  const get = vi.fn(async (key: string) => {
    const bytes = objects.get(key);
    return bytes ? { size: bytes.length, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } : null;
  });
  const bucket = { get } as unknown as R2Bucket;
  const surface: ForecastSurfaceV5 = {
    id: 'fine', kind: 'fine', grid: regular, gridHash, coverage: { id: description.descriptor.id, hash: description.hash, maskKey: `${prefix}/manifest.json`, maxZoom: 0, gridHash }, layers: ['usable-lift-msl'],
    samples: { format: 'cell-major-block-shards-v1', blockSize: 16, channelOrder: 'frame-then-layer', channelCount: 1, blockCount: 1, storedCells: 9, coverageHash: description.hash, shards: [{ firstBlock: 0, blockCount: 1, storedCells: 9, bytes: 45, key: 'unused', sha256: 'a'.repeat(64) }] }
  };
  const binding = vi.spyOn(contracts, 'assertSampleLayoutBindingV5');
  const results = await Promise.all([resolveSparseCoverage(bucket, surface), resolveSparseCoverage(bucket, surface)]);
  expect(binding).toHaveBeenCalledTimes(1);
  expect(results[0].coverage.mask).toBe(results[1].coverage.mask);
  expect(results[0].coverage.mask.coverage).toEqual(coverage);
  expect(results[0].coverage.layouts.get(1)!.storedCells).toBe(9);
  for (const result of results) result.release();
  expect(get).toHaveBeenCalledTimes(3);
  (await resolveSparseCoverage(bucket, surface)).release();
  expect(binding).toHaveBeenCalledTimes(1);
  await expect(resolveSparseCoverage(bucket, surface, undefined, [-1, -1, 1, 1])).rejects.toThrow('disagrees');
  await expect(resolveSparseCoverage(bucket, { ...surface, gridHash: '0'.repeat(64) })).rejects.toThrow('disagrees');
  if (surface.samples.format !== 'cell-major-block-shards-v1') throw new Error('Expected legacy samples');
  await expect(resolveSparseCoverage(bucket, { ...surface, samples: { ...surface.samples, shards: [{ ...surface.samples.shards[0], bytes: 44 }] } })).rejects.toThrow('disagrees');
  const corrupted = new Map(objects); corrupted.set(`${prefix}/sparse.bin`, Uint8Array.from(description.sparseBytes, (value, i) => i ? value : value ^ 1));
  const badBucket = { get: async (key: string) => { const bytes = corrupted.get(key); return bytes ? { size: bytes.length, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } : null; } } as unknown as R2Bucket;
  await expect(resolveSparseCoverage(badBucket, surface)).rejects.toThrow('hash mismatch');
  const oversized = json({ ...description.descriptor, files: { ...description.descriptor.files, sparse: { ...description.descriptor.files.sparse, bytes: 60 + 72 * 400000 } } });
  const oversizedHash = hash(oversized), oversizedKey = `coverage/${oversizedHash}/manifest.json`;
  const oversizedGet = vi.fn(async (key: string) => { const data = key === oversizedKey ? oversized : mask.tiles; return { size: data.length, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } }) }; });
  const oversizedSurface = { ...surface, coverage: { ...surface.coverage, hash: oversizedHash, maskKey: oversizedKey }, samples: { ...surface.samples, coverageHash: oversizedHash } };
  await expect(resolveSparseCoverage({ get: oversizedGet } as unknown as R2Bucket, oversizedSurface)).rejects.toThrow('serving byte budget');
  expect(oversizedGet).toHaveBeenCalledTimes(2);
});

function sparseBlobFixture() {
  const gridHash = hash(new TextEncoder().encode(canonicalGridJson(regular)));
  const coverage = sparseCoverageFromDense({ width: 3, height: 3, wrapLongitude: false, gridHash, output: Uint8Array.of(16, 0), halo: Uint8Array.of(239, 1) });
  const mask = { grid: regular, coverage, maxZoom: 0, tiles: Uint8Array.of(1) }, description = describeSparseCoverage(mask, INDEXED_PRODUCT);
  const prefix = `coverage/${description.hash}`;
  const objects = new Map<string, Uint8Array>([[`${prefix}/manifest.json`, description.bytes], [`${prefix}/sparse.bin`, description.sparseBytes], [`${prefix}/tiles.bin`, mask.tiles]]);
  const stream = (bytes: Uint8Array) => ({ size: bytes.length, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) });
  const surface: ForecastSurfaceV5 = {
    id: 'fine', kind: 'fine', grid: regular, gridHash, coverage: { id: description.descriptor.id, hash: description.hash, maskKey: `${prefix}/manifest.json`, maxZoom: 0, gridHash }, layers: ['usable-lift-msl'],
    samples: { format: 'cell-major-block-shards-v1', blockSize: 16, channelOrder: 'frame-then-layer', channelCount: 1, blockCount: 1, storedCells: 9, coverageHash: description.hash, shards: [{ firstBlock: 0, blockCount: 1, storedCells: 9, bytes: 45, key: 'unused', sha256: 'a'.repeat(64) }] }
  };
  const get = vi.fn(async (key: string) => { const bytes = objects.get(key); return bytes ? stream(bytes) : null; });
  return { coverage, surface, get, bucket: { get } as unknown as R2Bucket };
}

it('reuses verified sparse coverage blobs from the Cache API on a cold isolate', async () => {
  const stored = new Map<string, Uint8Array>();
  vi.stubGlobal('caches', { default: {
    async match(request: Request) {
      const bytes = stored.get(request.url);
      return bytes ? new Response(bytes.slice()) : undefined;
    },
    async put(request: Request, response: Response) { stored.set(request.url, new Uint8Array(await response.arrayBuffer())); }
  } });
  const { coverage, surface, get, bucket } = sparseBlobFixture();
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { waited.push(promise); }, metrics: { r2Reads: 0, r2Bytes: 0, cacheHits: 0, coalesced: 0 } };
  (await resolveSparseCoverage(bucket, surface, ctx)).release();
  await Promise.all(waited);
  expect(get).toHaveBeenCalledTimes(3);
  expect(ctx.metrics).toMatchObject({ r2Reads: 3, cacheHits: 0 });
  expect(stored.size).toBe(3);
  const secondGet = vi.fn(get.getMockImplementation()!);
  const second = { waitUntil() {}, metrics: { r2Reads: 0, r2Bytes: 0, cacheHits: 0, coalesced: 0 } };
  const hit = await resolveSparseCoverage({ get: secondGet } as unknown as R2Bucket, surface, second);
  hit.release();
  expect(secondGet).not.toHaveBeenCalled();
  expect(second.metrics).toMatchObject({ r2Reads: 0, cacheHits: 3 });
  expect(hit.coverage.mask.coverage).toEqual(coverage);
  for (const key of stored.keys()) stored.set(key, Uint8Array.of(1));
  const thirdGet = vi.fn(get.getMockImplementation()!);
  const third = { waitUntil() {}, metrics: { r2Reads: 0, r2Bytes: 0, cacheHits: 0, coalesced: 0 } };
  const recovered = await resolveSparseCoverage({ get: thirdGet } as unknown as R2Bucket, surface, third);
  recovered.release();
  expect(third.metrics.r2Reads).toBeGreaterThan(0);
  expect(recovered.coverage.mask.coverage).toEqual(coverage);
});

it.each([true, false])('bounds oversized cached descriptors before falling back to R2 (length header=%s)', async lengthHeader => {
  const { surface, get, bucket } = sparseBlobFixture();
  let sent = 0;
  const cancel = vi.fn();
  vi.stubGlobal('caches', { default: {
    async match(request: Request) {
      if (!request.url.endsWith(surface.coverage.hash)) return undefined;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(16 * 1024)); if (++sent === 64) controller.close(); }, cancel
      }, { highWaterMark: 0 }), { headers: lengthHeader ? { 'content-length': String(1024 * 1024) } : {} });
    },
    async put() {}
  } });
  (await resolveSparseCoverage(bucket, surface)).release();
  expect(sent * 16 * 1024).toBeLessThanOrEqual(144 * 1024);
  expect(cancel).toHaveBeenCalledOnce();
  expect(get).toHaveBeenCalledTimes(3);
  expect(inFlightAllocationBytes()).toBe(0);
});

it('cancels a stalled cached body at its owner deadline and releases its allocation', async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const { surface, get, bucket } = sparseBlobFixture(), cancel = vi.fn(), owners: Promise<unknown>[] = [];
  vi.stubGlobal('caches', { default: {
    async match() { return new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'content-length': '1' } }); },
    async put() {}
  } });
  const pending = resolveSparseCoverage(bucket, surface, { waitUntil: promise => { owners.push(promise); } });
  void pending.catch(() => {});
  await vi.waitFor(() => expect(inFlightAllocationBytes()).toBe(256 * 1024));
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(pending).rejects.toThrow('deadline');
  await Promise.allSettled(owners);
  expect(cancel).toHaveBeenCalledOnce();
  expect(get).not.toHaveBeenCalled();
  expect(inFlightAllocationBytes()).toBe(0);
});

it('holds a stalled cache match until settlement and cancels its late body', async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const { surface, get, bucket } = sparseBlobFixture(), owners: Promise<unknown>[] = [], cancel = vi.fn();
  let finish!: (response: Response) => void;
  const match = vi.fn<() => Promise<Response | undefined>>(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('caches', { default: { match, async put() {} } });
  const context = { waitUntil: (promise: Promise<unknown>) => { owners.push(promise); } };
  const pending = resolveSparseCoverage(bucket, surface, context);
  void pending.catch(() => {});
  await vi.waitFor(() => expect(match).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(pending).rejects.toThrow('deadline');
  await expect(resolveSparseCoverage(bucket, surface, context)).rejects.toThrow('deadline');
  expect(match).toHaveBeenCalledOnce();
  expect(get).not.toHaveBeenCalled();
  finish(new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'content-length': '1' } }));
  await Promise.allSettled(owners);
  expect(cancel).toHaveBeenCalledOnce();
  match.mockResolvedValue(undefined);
  (await resolveSparseCoverage(bucket, surface, context)).release();
  await Promise.allSettled(owners);
  expect(get).toHaveBeenCalledTimes(3);
  expect(inFlightAllocationBytes()).toBe(0);
});

it('holds copied Cache API bodies in the allocation pool until every write settles', async () => {
  const { surface, bucket } = sparseBlobFixture(), owners: Promise<unknown>[] = [];
  const puts: { response: Response; finish(): void }[] = [];
  vi.stubGlobal('caches', { default: {
    async match() {},
    put(_request: Request, response: Response) { return new Promise<void>(finish => { puts.push({ response, finish }); }); }
  } });
  (await resolveSparseCoverage(bucket, surface, { waitUntil: promise => { owners.push(promise); } })).release();
  expect(puts).toHaveLength(3);
  expect(inFlightAllocationBytes()).toBe(puts.reduce((sum, { response }) => sum + Number(response.headers.get('content-length')) * 2, 0));
  await Promise.all(puts.map(async ({ response, finish }) => { await response.arrayBuffer(); finish(); }));
  await Promise.all(owners);
  expect(inFlightAllocationBytes()).toBe(0);
});

it.each([true, false])('preserves coverage and releases write allocations when Cache API put fails (sync=%s)', async sync => {
  const { coverage, surface, bucket } = sparseBlobFixture();
  vi.stubGlobal('caches', { default: {
    async match() {},
    put() { if (sync) throw new Error('cache unavailable'); return Promise.reject(new Error('cache unavailable')); }
  } });
  const lease = await resolveSparseCoverage(bucket, surface);
  expect(lease.coverage.mask.coverage).toEqual(coverage);
  lease.release();
  expect(inFlightAllocationBytes()).toBe(0);
});

it('skips cache population when its body copy cannot be admitted', async () => {
  const { coverage, surface, get, bucket } = sparseBlobFixture(), original = get.getMockImplementation()!, put = vi.fn(async () => {});
  let release: (() => void) | undefined;
  vi.stubGlobal('caches', { default: { async match() {}, put } });
  get.mockImplementation(async key => {
    if (key.endsWith('/sparse.bin')) release = reserveAllocation(32 * 1024 * 1024 - inFlightAllocationBytes());
    return original(key);
  });
  try {
    const lease = await resolveSparseCoverage(bucket, surface);
    expect(lease.coverage.mask.coverage).toEqual(coverage);
    lease.release();
    expect(put).toHaveBeenCalledTimes(2);
  } finally { release?.(); }
  expect(inFlightAllocationBytes()).toBe(0);
});
