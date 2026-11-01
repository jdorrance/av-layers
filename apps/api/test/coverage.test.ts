import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createProductDescriptors, createRecipeIdentity, gridSchema, type Grid, type Manifest, type ProductDefinition } from '@av/contracts';
import { prepareSamplePackLayout } from '@av/forecast';
import { createApp } from '../src/index';
import { resolveCoverage } from '../src/coverage';

const now = Date.parse('2026-11-01T00:00:00Z');
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const regular: Grid = gridSchema.parse({ kind: 'regular-latlon', width: 3, height: 3, lon0: -1, lat0: 1, dx: 1, dy: -1, wrapLongitude: false, earthRadiusM: 6371229 });
const lambert: Grid = gridSchema.parse({ kind: 'lambert-conformal', width: 3, height: 3, centralMeridianDeg: 0, latitudeOfOriginDeg: 40, standardParallel1Deg: 30, standardParallel2Deg: 60, x0M: -10000, y0M: -10000, dxM: 10000, dyM: 10000, earthRadiusM: 6371229, wrapLongitude: false });

function fixture(grid: Grid = regular, frameCount = 5, options: { model?: string; policy?: string; value?: number } = {}) {
  const model = options.model ?? 'synthetic', buildId = 'fixture-1', prefix = `builds/${model}/${buildId}`;
  const bounds: [number, number, number, number] = grid.kind === 'regular-latlon' ? [-2, -2, 2, 2] : [-2, 38, 2, 42];
  const product: ProductDefinition = { id: 'synthetic-test', source: { modelFamily: model, configurationId: 'fixture-only', domainId: 'tiny' }, label: 'Synthetic test', attribution: 'Synthetic — not a forecast', bounds, coverageDescription: options.policy ?? 'Tiny synthetic test grid', freshness: { maxCycleAgeHours: 1, minHorizonHours: 1 }, grid, coverageId: 'synthetic-mask', maxNativeZoom: 0, frameHours: Array.from({ length: frameCount }, (_, i) => i + 1), intervalHours: 1, layers: ['precip-rate'] };
  const output = Uint8Array.of(255, 1), halo = Uint8Array.of(0, 0), tiles = Uint8Array.of(0);
  const descriptor = { version: 1, id: product.coverageId, grid, bounds, policy: product.coverageDescription, maxZoom: 0, supportHaloCells: 0, sampleLayout: { format: 'cell-major-blocks-v1', blockSize: 16 }, files: Object.fromEntries(Object.entries({ output, halo, tiles }).map(([name, data]) => [name, { bytes: data.length, sha256: hash(data) }])) };
  const descriptorBytes = json(descriptor), coverageHash = hash(descriptorBytes), coveragePrefix = `coverage/${coverageHash}`;
  const layout = prepareSamplePackLayout(grid, output, halo);
  const cycle = new Date(now).toISOString(), expiresAt = new Date(now + 86400_000).toISOString();
  const frames = product.frameHours.map(hour => ({ id: `h${hour}`, validTime: new Date(now + hour * 3600_000).toISOString(), intervalStart: new Date(now + (hour - 1) * 3600_000).toISOString(), intervalEnd: new Date(now + hour * 3600_000).toISOString() }));
  const samples = new Uint8Array(layout.storedCells * frames.length * 5), view = new DataView(samples.buffer);
  for (let offset = 0; offset < samples.length; offset += 5) view.setFloat32(offset, options.value ?? 7, true);
  const provenance = json({ version: 1, model, buildId, cycle, frames: [] });
  const manifest: Manifest = { version: 3, model, buildId, cycle, createdAt: cycle, expiresAt, descriptors: createProductDescriptors(product), recipe: createRecipeIdentity(product, 'a'.repeat(64)), method: { id: 'synthetic-method', hash: 'a'.repeat(64) }, coverage: { id: product.coverageId, hash: coverageHash, maskKey: `${coveragePrefix}/manifest.json`, maxZoom: 0 }, grid, frames, layers: ['precip-rate'], artifacts: frames.map(frame => ({ layer: 'precip-rate', frame: frame.id, tilesKey: `${prefix}/precip-rate/${frame.id}.pmtiles`, tilesSha256: 'b'.repeat(64) })), samples: { format: 'cell-major-blocks-v1', blockSize: 16, storedCells: layout.storedCells, channelCount: frames.length, bytes: samples.length, key: `${prefix}/samples.bin`, sha256: hash(samples) }, source: { provider: 'Synthetic test', provenanceKey: `${prefix}/provenance.json`, provenanceSha256: hash(provenance) }, palettes: ['rain'], tool: {}, metrics: {} };
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

it.each([regular, lambert])('serves a synthetic %s product with five frames, one layer and explicit descriptors', async grid => {
  const { product, bucket, get } = fixture(grid);
  const app = createApp({ products: { synthetic: product } });
  const fetch = (path: string) => app.fetch(new Request(`https://api.test${path}`, { headers: { 'cf-connecting-ip': '192.0.2.1' } }), { BUCKET: bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) } }, { waitUntil() {} });
  const latest = await fetch('/v1/models/synthetic/latest?expand=manifest');
  expect(latest.status, await latest.clone().text()).toBe(200);
  const metadata = await latest.json() as { manifest: Manifest; bounds: number[] };
  expect(metadata.manifest.frames).toHaveLength(5); expect(metadata.manifest.layers).toEqual(['precip-rate']);
  expect(metadata.manifest.descriptors.attribution).toBe(product.attribution);
  expect(metadata.bounds).toEqual(product.bounds);
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
