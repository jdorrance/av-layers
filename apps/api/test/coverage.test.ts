import { INDEXED_PRODUCT } from '../../../tests/model-fixtures';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { LIFT_METHOD, MODEL_LEVEL_LIFT_METHOD, canonicalGridJson, createProductDescriptors, createProductMethodId, createRecipeIdentity, gridSchema, sparseCoverageFromDense, type ForecastSurfaceV5, type Grid, type LayerId, type Manifest, type ProductDefinition, type VerticalCoordinateKind } from '@av/contracts';
import type { SamplePayload } from '@av/client';
import { prepareSamplePackLayout } from '@av/forecast';
import { createApp } from '../src/index';
import { resolveCoverage, resolveSparseCoverage } from '../src/coverage';
import { describeSparseCoverage } from '../../batch/src/coverage';
import { fixturePatch } from '../../../tests/forecast-fixture';
import { inFlightAllocationBytes, reserveAllocation } from '../src/resources';

const now = Date.parse('2026-11-01T00:00:00Z');
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const regular: Grid = gridSchema.parse({ kind: 'regular-latlon', width: 3, height: 3, lon0: -1, lat0: 1, dx: 1, dy: -1, wrapLongitude: false, earthRadiusM: 6371229 });
const lambert: Grid = gridSchema.parse({ kind: 'lambert-conformal', width: 3, height: 3, centralMeridianDeg: 0, latitudeOfOriginDeg: 40, standardParallel1Deg: 30, standardParallel2Deg: 60, x0M: -10000, y0M: -10000, dxM: 10000, dyM: 10000, earthRadiusM: 6371229, wrapLongitude: false });

function fixture(grid: Grid = regular, frameCount = 5, options: { model?: string; policy?: string; value?: number; layer?: LayerId; layers?: LayerId[]; verticalCoordinate?: VerticalCoordinateKind } = {}) {
  const model = options.model ?? 'synthetic', buildId = 'fixture-1', prefix = `builds/${model}/${buildId}`;
  const layer = options.layer ?? 'precip-rate';
  const layers = options.layers ?? [layer];
  const bounds: [number, number, number, number] = grid.kind === 'regular-latlon' ? [-2, -2, 2, 2] : [-2, 38, 2, 42];
  const product: ProductDefinition = { execution: { shards: 1, parallelism: 1, workers: 0, schedule: [] }, id: 'synthetic-test', modelId: model, coverageDir: `coverage/${model}`, supportHaloCells: 0, source: { modelFamily: model, configurationId: 'fixture-only', domainId: 'tiny' }, label: 'Synthetic test', attribution: 'Synthetic — not a forecast', bounds, coverageDescription: options.policy ?? 'Tiny synthetic test grid', freshness: { maxCycleAgeHours: 1, minHorizonHours: 1 }, grid, coverageId: 'synthetic-mask', maxNativeZoom: 0, frameHours: Array.from({ length: frameCount }, (_, i) => i + 1), intervalHours: 1, layers, capabilities: { verticalCoordinate: options.verticalCoordinate ?? 'isobaric', maxVerticalLevels: 21, daylightFrames: 'all-hours' } };
  const output = Uint8Array.of(255, 1), halo = Uint8Array.of(0, 0), tiles = Uint8Array.of(0);
  const descriptor = { version: 1, id: product.coverageId, grid, bounds, policy: product.coverageDescription, maxZoom: 0, supportHaloCells: 0, sampleLayout: { format: 'cell-major-blocks-v1', blockSize: 16 }, files: Object.fromEntries(Object.entries({ output, halo, tiles }).map(([name, data]) => [name, { bytes: data.length, sha256: hash(data) }])) };
  const descriptorBytes = json(descriptor), coverageHash = hash(descriptorBytes), coveragePrefix = `coverage/${coverageHash}`;
  const layout = prepareSamplePackLayout(grid, output, halo);
  const cycle = new Date(now).toISOString(), expiresAt = new Date(now + 86400_000).toISOString();
  const frames = product.frameHours.map(hour => ({ id: `h${hour}`, validTime: new Date(now + hour * 3600_000).toISOString(), intervalStart: new Date(now + (hour - 1) * 3600_000).toISOString(), intervalEnd: new Date(now + hour * 3600_000).toISOString() }));
  const samples = new Uint8Array(layout.storedCells * frames.length * layers.length * 5), view = new DataView(samples.buffer);
  for (let offset = 0; offset < samples.length; offset += 5) view.setFloat32(offset, options.value ?? 7, true);
  const provenance = json({ version: 1, model, buildId, cycle, frames: [] });
  const manifest: Manifest = { version: 3, model, buildId, cycle, createdAt: cycle, expiresAt, descriptors: createProductDescriptors(product), recipe: createRecipeIdentity(product, 'a'.repeat(64)), method: { id: createProductMethodId(product), hash: 'a'.repeat(64) }, coverage: { id: product.coverageId, hash: coverageHash, maskKey: `${coveragePrefix}/manifest.json`, maxZoom: 0 }, grid, frames, layers, artifacts: frames.flatMap(frame => layers.map(layer => ({ layer, frame: frame.id, tilesKey: `${prefix}/${layer}/${frame.id}.pmtiles`, tilesSha256: 'b'.repeat(64) }))), samples: { format: 'cell-major-blocks-v1', blockSize: 16, storedCells: layout.storedCells, channelCount: frames.length * layers.length, bytes: samples.length, key: `${prefix}/samples.bin`, sha256: hash(samples) }, source: { provider: 'Synthetic test', provenanceKey: `${prefix}/provenance.json`, provenanceSha256: hash(provenance) }, palettes: [layer === 'precip-rate' ? 'rain' : 'lift'], tool: {}, metrics: {} };
  const objects = new Map<string, Uint8Array>([
    [`${coveragePrefix}/manifest.json`, descriptorBytes], [`${coveragePrefix}/output.bin`, output], [`${coveragePrefix}/halo.bin`, halo], [`${coveragePrefix}/tiles.bin`, tiles],
    [`${prefix}/manifest.json`, json(manifest)], [`${prefix}/samples.bin`, samples], [`${prefix}/provenance.json`, provenance],
    [`catalog/${model}/latest.json`, json({ version: 1, model, latestBuildId: buildId, retained: [{ buildId, manifestKey: `${prefix}/manifest.json`, cycle, expiresAt }] })]
  ]);
  const get = vi.fn(async (key: string, options?: { range?: { offset: number; length: number } }) => {
    const bytes = objects.get(key); if (!bytes) return null;
    const range = options?.range, data = range ? bytes.slice(range.offset, range.offset + range.length) : bytes;
    return { size: bytes.length, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } }) };
  });
  const bucket = { get } as unknown as R2Bucket;
  return { product, manifest, bucket, objects, get, coveragePrefix };
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => undefined } }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(['current', 'historic', 'mismatched'] as const)('checks the %s ICON method against its published pressure-input snapshot', async variant => {
  const { product, manifest, bucket, objects } = fixture(regular, 1, { model: 'icon-eu', layer: 'usable-lift-msl', verticalCoordinate: 'model-levels' });
  if (variant !== 'current') {
    const method = manifest.descriptors.methods[MODEL_LEVEL_LIFT_METHOD.id];
    delete manifest.descriptors.methods[MODEL_LEVEL_LIFT_METHOD.id];
    method.id = LIFT_METHOD.id;
    manifest.descriptors.methods[method.id] = method;
    manifest.descriptors.layers['usable-lift-msl'].methodId = method.id;
    manifest.method.id = variant === 'historic' ? method.id : MODEL_LEVEL_LIFT_METHOD.id;
    objects.set(`builds/icon-eu/${manifest.buildId}/manifest.json`, json(manifest));
  }
  const app = createApp({ products: { 'icon-eu': product } });
  const response = await app.fetch(new Request(`https://api.test/v1/models/icon-eu/runs/${manifest.buildId}`),
    { BUCKET: bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) } }, { waitUntil() {} });
  expect(response.status).toBe(variant === 'mismatched' ? 503 : 200);
  if (variant !== 'mismatched') {
    const body = await response.json() as Manifest;
    expect(body.method.id).toBe(manifest.method.id);
    expect(body.descriptors.methods[body.method.id].requiredInputs).toContain('pressurePa');
    expect(body.descriptors.methods[body.method.id].requiredInputs).not.toContain('pressureLevelsHpa');
  }
});

it.each([regular, lambert])('serves a synthetic %s product with five frames, one layer and explicit descriptors', async grid => {
  const { product, bucket, get } = fixture(grid);
  const app = createApp({ products: { synthetic: product } });
  const fetch = (path: string) => app.fetch(new Request(`https://api.test${path}`, { headers: { 'cf-connecting-ip': '192.0.2.1' } }), { BUCKET: bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) } }, { waitUntil() {} });
  const latest = await fetch('/v1/models/synthetic/latest?expand=manifest');
  expect(latest.status, await latest.clone().text()).toBe(200);
  const metadata = await latest.json() as { manifest: Manifest };
  expect(metadata.manifest.frames).toHaveLength(5); expect(metadata.manifest.layers).toEqual(['precip-rate']);
  expect(metadata.manifest.descriptors.attribution).toBe(product.attribution);
  expect(metadata.manifest.descriptors.bounds).toEqual(product.bounds);
  const sample = await fetch(`/v1/models/synthetic/runs/fixture-1/sample?lat=${grid.kind === 'regular-latlon' ? 0 : 40}&lon=0&frame=all`);
  expect(sample.status, await sample.clone().text()).toBe(200);
  expect((await sample.json() as { frames: { layers: unknown }[] }).frames.map(frame => frame.layers)).toEqual(Array.from({ length: 5 }, () => ({ 'precip-rate': { value: 7, status: 'valid', support: 0, interpolated: false } })));
  expect(get.mock.calls.filter(([key]) => key.endsWith('/samples.bin'))).toHaveLength(1);
  expect(get.mock.calls.filter(([key]) => key.startsWith('coverage/'))).toHaveLength(4);
  expect((await fetch('/v1/models/gfs/latest')).status).toBe(404);
});

it.each(['manifest.json', 'output.bin', 'halo.bin', 'tiles.bin'])('rejects hash-invalid remote coverage %s and permits a repaired retry', async name => {
  const { bucket, manifest, objects, coveragePrefix } = fixture();
  const key = `${coveragePrefix}/${name}`, original = objects.get(key)!;
  objects.set(key, original.map((byte, i) => i === 0 ? byte ^ 1 : byte));
  await expect(resolveCoverage(bucket, manifest)).rejects.toThrow(/hash mismatch/);
  objects.set(key, original);
  expect((await resolveCoverage(bucket, manifest)).layout.storedCells).toBe(9);
});

it('rejects a publication geometry mismatch even after a hash cache hit', async () => {
  const { bucket, manifest } = fixture(); await resolveCoverage(bucket, manifest);
  await expect(resolveCoverage(bucket, { ...manifest, descriptors: { ...manifest.descriptors, bounds: [-3, -2, 2, 2] } })).rejects.toThrow('disagrees');
  await expect(resolveCoverage(bucket, { ...manifest, coverage: { ...manifest.coverage, id: 'wrong' } })).rejects.toThrow('disagrees');
});


it('keeps regular and Lambert coverage identities separate in one API instance and shared bucket', async () => {
  const first = fixture(regular, 5, { model: 'synthetic-regular', value: 7 });
  const second = fixture(lambert, 3, { model: 'synthetic-lambert', value: 11 });
  for (const [key, bytes] of second.objects) first.objects.set(key, bytes);
  const app = createApp({ products: { 'synthetic-regular': first.product, 'synthetic-lambert': second.product } });
  const request = async (path: string) => {
    const response = await app.fetch(new Request(`https://api.test${path}`, { headers: { 'cf-connecting-ip': '192.0.2.1' } }), { BUCKET: first.bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) } }, { waitUntil() {} });
    expect(response.status).toBe(200); return response.json();
  };
  const metadata = await Promise.all(Array.from({ length: 4 }, () => [first, second]).flat().map(item => request(`/v1/models/${item.manifest.model}/latest?expand=manifest`))) as { manifest: Manifest }[];
  for (let i = 0; i < metadata.length; i++) {
    const expected = i % 2 ? second : first;
    expect(metadata[i].manifest.grid).toEqual(expected.manifest.grid);
    expect(metadata[i].manifest.coverage.hash).toBe(expected.manifest.coverage.hash);
  }
  expect(first.manifest.coverage.hash).not.toBe(second.manifest.coverage.hash);
  for (const item of [first, second]) expect(first.get.mock.calls.filter(([key]) => key.startsWith(item.coveragePrefix))).toHaveLength(4);
  for (const [item, lat, value] of [[first, 0, 7], [second, 40, 11]] as const) {
    const sample = await request(`/v1/models/${item.manifest.model}/runs/fixture-1/sample?lat=${lat}&lon=0&frame=all`) as { frames: { layers: Record<string, { value: number; status: string }> }[] };
    expect(sample.frames).toHaveLength(item.manifest.frames.length);
    expect(sample.frames.every(frame => frame.layers['precip-rate'].value === value && frame.layers['precip-rate'].status === 'valid')).toBe(true);
  }
});

it('coalesces concurrent cold coverage descriptor and bitset reads into one materialized result', async () => {
  const { bucket, manifest, get } = fixture();
  const contexts = Array.from({ length: 8 }, () => ({ waitUntil: vi.fn(), metrics: { r2Reads: 0, r2Bytes: 0, cacheHits: 0, coalesced: 0 } }));
  const results = await Promise.all(contexts.map(ctx => resolveCoverage(bucket, manifest, ctx)));
  expect(results.every(result => result === results[0])).toBe(true);
  expect(get).toHaveBeenCalledTimes(4);
  expect(contexts.reduce((sum, ctx) => sum + ctx.metrics.coalesced, 0)).toBe(7);
  expect(contexts.reduce((sum, ctx) => sum + ctx.metrics.r2Reads, 0)).toBe(4);
});

it('evicts and reloads coverage through the production 16-entry cache limit', async () => {
  const variants = Array.from({ length: 17 }, (_, i) => fixture(regular, 5, { policy: `Distinct immutable coverage policy ${i}` }));
  const owner = variants[0];
  for (const item of variants.slice(1)) for (const [key, bytes] of item.objects) owner.objects.set(key, bytes);
  for (const item of variants) await resolveCoverage(owner.bucket, item.manifest);
  expect(owner.get).toHaveBeenCalledTimes(17 * 4);
  const before = owner.get.mock.calls.length;
  expect((await resolveCoverage(owner.bucket, variants[16].manifest)).mask.grid).toEqual(regular);
  expect(owner.get).toHaveBeenCalledTimes(before);
  expect((await resolveCoverage(owner.bucket, variants[0].manifest)).layout.storedCells).toBe(9);
  expect(owner.get).toHaveBeenCalledTimes(before + 4);
  expect(owner.get.mock.calls.filter(([key]) => key.startsWith(variants[0].coveragePrefix))).toHaveLength(8);
});

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
  const results = await Promise.all([resolveSparseCoverage(bucket, surface), resolveSparseCoverage(bucket, surface)]);
  expect(results[0].coverage.mask).toBe(results[1].coverage.mask);
  expect(results[0].coverage.mask.coverage).toEqual(coverage);
  expect(results[0].coverage.layouts.get(1)!.storedCells).toBe(9);
  for (const result of results) result.release();
  expect(get).toHaveBeenCalledTimes(3);
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

function refinedFixture(flag = 0) {
  const data = fixture(regular, 3, { layers: ['precip-rate', 'usable-lift-agl'] });
  const { manifest, product, objects } = data;
  const patch = fixturePatch(manifest), grid = patch.grid, bounds = patch.descriptors.bounds;
  const output = Uint8Array.of(16, 0), halo = Uint8Array.of(239, 1), tiles = Uint8Array.of(0);
  const layout = prepareSamplePackLayout(grid, output, halo);
  const coverage = { version: 1, id: 'refined-mask', grid, bounds, policy: 'Synthetic refinement', maxZoom: 0, supportHaloCells: 1, sampleLayout: { format: 'cell-major-blocks-v1', blockSize: 16 }, files: Object.fromEntries(Object.entries({ output, halo, tiles }).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: hash(bytes) }])) };
  const coverageBytes = json(coverage), coverageHash = hash(coverageBytes), prefix = `coverage/${coverageHash}`;
  for (const [name, bytes] of Object.entries({ 'manifest.json': coverageBytes, 'output.bin': output, 'halo.bin': halo, 'tiles.bin': tiles })) objects.set(`${prefix}/${name}`, bytes);
  const samples = new Uint8Array(layout.storedCells * manifest.frames.length * 5), view = new DataView(samples.buffer);
  for (let i = 0; i < samples.length / 5; i++) { view.setFloat32(i * 5, flag === 1 ? 0 : 900 + i % manifest.frames.length, true); view.setUint8(i * 5 + 4, flag); }
  patch.coverage = { id: coverage.id, hash: coverageHash, maskKey: `${prefix}/manifest.json`, maxZoom: 0 };
  patch.samples = { ...patch.samples, storedCells: layout.storedCells, bytes: samples.length, sha256: hash(samples) };
  manifest.version = 4; manifest.patches = [patch];
  objects.set(patch.samples.key, samples);
  objects.set(`builds/${manifest.model}/${manifest.buildId}/manifest.json`, json(manifest));
  const app = createApp({ products: { synthetic: product } });
  const sample = (lat = 0, lon = 0, layers = manifest.layers.join(',')) => app.fetch(new Request(`https://api.test/v1/models/synthetic/runs/fixture-1/sample?lat=${lat}&lon=${lon}&frame=all&layers=${layers}`, { headers: { 'cf-connecting-ip': '192.0.2.1' } }), { BUCKET: data.bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) } }, { waitUntil() {} });
  return { ...data, patch, sample };
}

it('samples base precipitation and refined AGL using each pack’s inherited frame channels', async () => {
  const { sample, get, patch } = refinedFixture();
  const response = await sample();
  expect(response.status, await response.clone().text()).toBe(200);
  const result = await response.json() as SamplePayload;
  expect(result.frames.map(frame => frame.layers['precip-rate'].value)).toEqual([7, 7, 7]);
  expect(result.frames.map(frame => frame.layers['usable-lift-agl'].value)).toEqual([900, 901, 902]);
  expect(result.frames.every(frame => {
    const agl = frame.layers['usable-lift-agl'], rain = frame.layers['precip-rate'];
    return 'patchId' in agl && agl.patchId === patch.id && !('patchId' in rain);
  })).toBe(true);
  const ranges = get.mock.calls.filter(([, options]) => options?.range);
  expect(ranges).toHaveLength(2);
  expect(ranges.some(([key]) => key === patch.samples.key)).toBe(true);
});

it.each([1, 2])('preserves refined status %i instead of falling back to base lift', async flag => {
  const { sample } = refinedFixture(flag);
  const response = await sample(0, 0, 'usable-lift-agl');
  expect(response.status).toBe(200);
  const value = (await response.json() as SamplePayload).frames[0].layers['usable-lift-agl'];
  expect(value).toMatchObject({ value: flag === 1 ? 0 : null, status: flag === 1 ? 'no-usable-lift' : 'unavailable', patchId: 'zone-001' });
});

it('returns base values outside patch output and skips patch I/O outside its polygon or for base-only layers', async () => {
  for (const [lat, lon, layer, loadsCoverage] of [[0, 0.006, 'usable-lift-agl', true], [0, 0.1, 'usable-lift-agl', false], [0, 0, 'precip-rate', false]] as const) {
    const { sample, get, patch } = refinedFixture();
    const response = await sample(lat, lon, layer);
    expect(response.status).toBe(200);
    expect((await response.json() as SamplePayload).frames[0].layers[layer]).toMatchObject({ value: 7, status: 'valid' });
    expect(get.mock.calls.some(([key]) => key === patch.samples.key)).toBe(false);
    expect(get.mock.calls.some(([key]) => key === patch.coverage.maskKey)).toBe(loadsCoverage);
  }
});

it('keeps base coverage as the outer boundary without reading refinement data', async () => {
  const { sample, get, patch } = refinedFixture();
  const response = await sample(20, 20);
  expect(response.status).toBe(200);
  const result = await response.json() as SamplePayload;
  expect(result.frames.every(frame => Object.values(frame.layers).every(value => value.status === 'outside-domain' && value.patchId === undefined))).toBe(true);
  expect(get.mock.calls.some(([key, options]) => key === patch.coverage.maskKey || options?.range)).toBe(false);
});

it.each(['samples', 'coverage'] as const)('fails missing refined %s without serving coarse replacement', async missing => {
  const { sample, objects, patch, get } = refinedFixture();
  objects.delete(missing === 'samples' ? patch.samples.key : patch.coverage.maskKey);
  const response = await sample(0, 0, 'usable-lift-agl');
  expect(response.status).toBe(503);
  expect(get.mock.calls.some(([key, options]) => options?.range && key !== patch.samples.key)).toBe(false);
});

it('keeps refinement channels aligned when manifest frame order differs from valid-time order', async () => {
  const { manifest, objects, sample } = refinedFixture();
  manifest.frames.reverse();
  objects.set(`builds/${manifest.model}/${manifest.buildId}/manifest.json`, json(manifest));
  const response = await sample(0, 0, 'usable-lift-agl');
  expect(response.status).toBe(200);
  expect((await response.json() as SamplePayload).frames.map(frame => frame.layers['usable-lift-agl'].value)).toEqual([902, 901, 900]);
});

it('rejects a forged refinement pack reference before reading numeric data', async () => {
  const { manifest, patch, objects, sample, get } = refinedFixture();
  patch.samples.key = manifest.samples.key;
  objects.set(`builds/${manifest.model}/${manifest.buildId}/manifest.json`, json(manifest));
  expect((await sample()).status).toBe(503);
  expect(get.mock.calls.some(([, options]) => options?.range)).toBe(false);
});
