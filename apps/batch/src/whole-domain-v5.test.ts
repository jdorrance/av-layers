import { INDEXED_PRODUCT } from '../../../tests/model-fixtures.js';
import { NORTHERN_LAMBERT } from '../../../tests/lambert-fixtures.js';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import z from 'zod';
import { LAYER_IDS, LIFT_METHOD, MAX_METADATA_JSON_TOKENS, PRECIPITATION_ALL_HOURS_METHOD, RETENTION_DAYS, TERRAIN_CLEARANCE_METHOD, TERRAIN_COLUMN_METHOD, canonicalGridJson, coverageIndices, createProductDescriptors, createProductMethodId, getBit, manifestV5Schema, modelPointerSchema, parseBoundedJson, planWholeDomainGrid, sampleResponseV5Schema, setBit, sparseCoverageFromDense, sparseCoverageLookup, STATUS_MASK, STATUS_OUTSIDE, STATUS_UNAVAILABLE, SUPPORT_MASK, surfaceFrameCount, wholeDomainDonorSupport, type CoverageMask, type ProductDefinition, type RegularLatLonGrid, type SparseCoverageMask } from '@av/contracts';
import { deriveTerrainM } from '@av/client';
import { deriveFrame, profileRecordBytes, readProfileRecord, prepareShardedSamplePackLayout } from '@av/forecast';
import { preparePackedTerrainColumns, prepareTerrainColumns } from '@av/forecast/refinement';
import { buildForecast } from './build.js';
import { describeSparseCoverage } from './coverage.js';
import { createBuildPlan, buildShard, finalizeBuild, readBuildPlan, verifyBuildReceipts, type BuildPlan } from './parallel.js';
import { seedTerrainCatalog, TerrainTestStorage } from './terrain/test-fixtures.js';
import { acquisitionSupport, loadBundledFineCoverage, nativeSparseMask, sparseActiveIndices, stageFineCoverage, wholeDomainPlan } from './whole-domain/coverage.js';
import { admitWholeDomain, wholeDomainSampleGroupLayouts } from './whole-domain/capacity.js';
import { samplePackWriterBufferBytes } from './sample-pack-v5.js';
import { rasterWorkerCount } from './raster-pool.js';
import { BUILD_BUDGETS, MAX_V5_SHARD_BYTES, checkPerformance } from './capacity.js';
import { fixtureProvider, PublicationStore } from '../parallel-fixtures.js';
import { normalizedFixtureFrame } from '../../../scripts/fixtures/normalized-provider.js';
import { denseFixtureMask, syntheticWholeDomain } from '../../../scripts/fixtures/whole-domain.js';
import type { ForecastProvider } from './provider.js';
import { frozenWholeDomain, loadFrozenWholeDomain, loadWholeDomainTerrain, prepareWholeDomain } from './whole-domain/prepare.js';
import { prepareWholeDomainTerrain } from './whole-domain/terrain.js';
import { buildWholeDomainFrames } from './whole-domain/frames.js';
import { assertValidatedBuild, sha256, validateBuild, validateSampleGroup, type ValidatedBuild } from './validate.js';
import { workflowAuthority } from './authority.js';
import { assertUsefulHorizon, cleanup, publish, rollback, type CleanupSummary } from './publication.js';
import { forecastObjects } from './publication-objects.js';
import { createLocalFileReader, readLocalFile } from './local-file.js';
import type { ArchiveTarget } from './render.js';

const publicationPolicy = vi.hoisted(() => ({ minHorizonHours: 6 }));
vi.mock('@av/contracts/models', async importOriginal => {
  const actual = await importOriginal<typeof import('@av/contracts/models')>();
  return { ...actual, getProduct: (id: string) => {
    const product = actual.getProduct(id);
    return product ? { ...product, freshness: { ...product.freshness, minHorizonHours: publicationPolicy.minHorizonHours } } : undefined;
  } };
});
const shardTarget = vi.hoisted(() => ({ bytes: 0 }));
const resources = vi.hoisted(() => ({ writers: [] as Array<{ surface: string; close: () => Promise<void> }>, renderers: [] as Array<{ renderArchives: (targets: readonly ArchiveTarget[]) => Promise<void> }> }));
vi.mock('@av/forecast', async importOriginal => {
  const actual = await importOriginal<typeof import('@av/forecast')>();
  return { ...actual, prepareShardedSamplePackLayout: (...args: Parameters<typeof actual.prepareShardedSamplePackLayout>) =>
    actual.prepareShardedSamplePackLayout(args[0], args[1], args[2], shardTarget.bytes || args[3], args[4]) };
});
vi.mock('./local-file.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./local-file.js')>();
  return { ...actual, readLocalFile: vi.fn(actual.readLocalFile), createLocalFileReader: vi.fn(actual.createLocalFileReader) };
});
vi.mock('./validate.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./validate.js')>();
  return { ...actual, validateSampleGroup: vi.fn(actual.validateSampleGroup) };
});
vi.mock('./sample-pack-v5.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./sample-pack-v5.js')>();
  return { ...actual, createShardedSamplePackWriter: (...args: Parameters<typeof actual.createShardedSamplePackWriter>) => {
    const writer = actual.createShardedSamplePackWriter(...args), close = vi.fn(writer.close);
    resources.writers.push({ surface: args[2].surfaceId, close });
    return { ...writer, close };
  } };
});
vi.mock('./render.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./render.js')>();
  return { ...actual, createRenderer: (...args: Parameters<typeof actual.createRenderer>) => {
    const renderer = actual.createRenderer(...args), renderArchives = vi.fn(renderer.renderArchives);
    resources.renderers.push({ renderArchives });
    return { ...renderer, renderArchives };
  } };
});
vi.mock('./raster-pool.js', async importOriginal => ({ ...await importOriginal<typeof import('./raster-pool.js')>(), rasterWorkerCount: vi.fn(() => 0) }));
vi.mock('./terrain/source.js', async importOriginal => ({ ...await importOriginal<typeof import('./terrain/source.js')>(), verifyTerrainCatalogInventory: async () => undefined }));
vi.mock('./terrain/reader.js', async importOriginal => ({
  ...await importOriginal<typeof import('./terrain/reader.js')>(),
  verifyTerrainInventory: async () => 0,
  createTerrainReader: async () => ({
    close() {},
    async sample(lat: number, lon: number) { return { elevationM: lon < 0 ? -1200 : 200 + lat + 50 * lon, source: 'dem' as const }; },
    sourceBlocks: () => 'Copernicus_DSM_COG_30_N00_00_E000_00_DEM/0',
    async sampleBatch(points: Array<{ latitude: number; longitude: number }>) { return points.map(({ latitude, longitude }) => ({ elevationM: longitude < 0 ? -1200 : 200 + latitude + 50 * longitude, source: 'dem' as const })); },
    stats: () => ({ requests: 1, bytesRead: 100, decodedPixels: 4, outputPixels: 100, cacheHits: 0 })
  })
}));

const CYCLE = '2026-06-21T00:00:00.000Z';
const temporary: string[] = [];
const sharedRoots: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
afterAll(async () => { await Promise.all(sharedRoots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function root(name: string): Promise<string> { const path = await mkdtemp(join(tmpdir(), `av-${name}-`)); temporary.push(path); return path; }
async function sharedRoot(name: string): Promise<string> { const path = await mkdtemp(join(tmpdir(), `av-${name}-`)); sharedRoots.push(path); return path; }

async function sampleReader(store: PublicationStore, manifest: Awaited<ReturnType<typeof readV5>>, configured: ProductDefinition) {
  const bucket = { async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const object = store.objects.get(key);
    if (!object) return null;
    const range = options?.range, bytes = range ? object.bytes.slice(range.offset, range.offset + range.length) : object.bytes;
    return { key, size: object.bytes.length, httpEtag: object.etag, customMetadata: object.metadata, range,
      body: new Response(Uint8Array.from(bytes).buffer).body, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
  } };
  const { model, buildId, cycle, expiresAt } = manifest;
  const entry = { buildId, manifestKey: `builds/${model}/${buildId}/manifest.json`, cycle, expiresAt };
  const pointerKey = `catalog/${model}/latest.json`;
  if (!store.objects.has(pointerKey)) store.objects.set(pointerKey, { bytes: Buffer.from(JSON.stringify({ version: 1, model, latestBuildId: buildId, retained: [entry] })), etag: 'pointer' });
  const apiPath = '../../api/src/index.js';
  const { createApp } = await import(apiPath) as { createApp(options: { products: Record<string, ProductDefinition> }): { fetch(request: Request, env: unknown, context: unknown): Promise<Response> } };
  const app = createApp({ products: { [model]: configured } });
  return async (params: URLSearchParams) => {
    const url = new URL(`https://example.com/v1/models/${model}/runs/${buildId}/sample?${params}`);
    const response = await app.fetch(new Request(url, { headers: { 'cf-connecting-ip': '192.0.2.1' } }), { BUCKET: bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) }, AV_RESPONSE_CACHE: 'off' }, { waitUntil() {}, passThroughOnException() {} });
    expect(response.status, await response.clone().text()).toBe(200);
    return sampleResponseV5Schema.parse(await response.json());
  };
}

async function verifySampleServing(store: PublicationStore, manifest: Awaited<ReturnType<typeof readV5>>, configured: ProductDefinition) {
  const sample = await sampleReader(store, manifest, configured);
  for (const frame of [manifest.frames[0].id, 'all']) {
    const body = await sample(new URLSearchParams({ lat: '71', lon: '10', frame, layers: 'usable-lift-msl' }));
    expect(body.frames.length).toBe(frame === 'all' ? manifest.frames.length : 1);
  }
}

const product: ProductDefinition = {
  ...INDEXED_PRODUCT,
  modelId: 'whole-domain-fixture', id: 'whole-domain-fixture-recipe',
  source: { modelFamily: 'fixture-model', configurationId: 'whole-domain-fixture-provider', domainId: 'synthetic' },
  label: 'Whole-domain fixture', attribution: 'Synthetic test data',
  coverageDescription: 'Synthetic wrapping grid at a fine subdivision', coverageId: 'whole-domain-fixture-coverage',
  bounds: [-180, 70, 180, 72], grid: { kind: 'regular-latlon', width: 18, height: 3, earthRadiusM: 6371229, lon0: -180, lat0: 72, dx: 20, dy: -1, wrapLongitude: true },
  maxNativeZoom: 0, frameHours: [2, 4], intervalHours: 2, terrainSubdivisionFactor: 2,
  layers: ['usable-lift-msl', 'usable-lift-agl', 'precip-rate']
};
const cells = product.grid.width * product.grid.height;
const nativeMask: CoverageMask = {
  grid: product.grid, bounds: product.bounds, maxZoom: 0,
  output: new Uint8Array(Math.ceil(cells / 8)), halo: new Uint8Array(Math.ceil(cells / 8)), tiles: Uint8Array.of(1)
};
for (let index = 0; index < cells - 1; index++) setBit(nativeMask.output, index);
setBit(nativeMask.halo, cells - 1);

function fineCoverage(configured = product): SparseCoverageMask {
  if (configured.grid.kind !== 'regular-latlon' || !configured.terrainSubdivisionFactor) throw new Error('Missing fine grid');
  const plan = planWholeDomainGrid(configured.grid, configured.terrainSubdivisionFactor), count = plan.fine.width * plan.fine.height;
  const output = new Uint8Array(Math.ceil(count / 8));
  for (let index = 0; index < count; index++) setBit(output, index);
  return { grid: plan.fine, bounds: configured.bounds, maxZoom: 0, tiles: Uint8Array.of(1),
    coverage: sparseCoverageFromDense({ width: plan.fine.width, height: plan.fine.height, wrapLongitude: plan.fine.wrapLongitude,
      gridHash: createHash('sha256').update(canonicalGridJson(plan.fine)).digest('hex'), output, halo: new Uint8Array(output.length) }) };
}

async function fixture(configured = product) {
  const storage = new TerrainTestStorage(), catalogRef = seedTerrainCatalog(storage), mask = fineCoverage(configured);
  const description = describeSparseCoverage(mask, configured);
  return { storage, catalogRef, fine: { mask, descriptor: description.descriptor, bytes: description.bytes, hash: description.hash } };
}

async function readV5(path: string) { return manifestV5Schema.parse(JSON.parse(await readFile(path, 'utf8'))); }
function surface(manifest: ReturnType<typeof manifestV5Schema.parse>, id: 'native' | 'fine') { const found = manifest.surfaces.find(item => item.id === id); if (!found) throw new Error(`Missing ${id}`); return found; }
async function surfaceBytes(root: string, manifest: ReturnType<typeof manifestV5Schema.parse>, id: 'native' | 'fine'): Promise<Buffer[]> {
  return Promise.all(surface(manifest, id).samples.shards.map(shard => readFile(join(root, shard.key))));
}


function sizedManifest(manifest: ReturnType<typeof manifestV5Schema.parse>, sizes: { bytes: number; storedCells: number }[]) {
  const copy = structuredClone(manifest), surface = copy.surfaces[0]!;
  surface.samples.channelCount = 1;
  surface.samples.blockCount = sizes.length;
  surface.samples.storedCells = sizes.reduce((sum, shard) => sum + shard.storedCells, 0);
  surface.samples.shards = sizes.map((size, index) => ({ firstBlock: index, blockCount: 1, storedCells: size.storedCells,
    bytes: size.bytes, key: `${surface.samples.shards[0]!.key.replace(/\/0\.bin$/, '')}/${index}.bin`, sha256: 'a'.repeat(64) }));
  return copy;
}
async function buildSerialFixture() {
  const setup = await fixture(), out = await sharedRoot('wd-serial-fixture');
  const path = await buildForecast({ out, cycle: CYCLE, product, mask: nativeMask, provider: fixtureProvider().provider, wholeDomain: setup });
  return { out, manifest: await readV5(path) };
}

let serialFixture: ReturnType<typeof buildSerialFixture> | undefined;
const sealedSerial = () => serialFixture ??= buildSerialFixture();
async function builtManifest() {
  return structuredClone((await sealedSerial()).manifest);
}

it('serves separate 1 km Lambert lift and native surfaces with serial and shard parity', async () => {
  const grid = { ...NORTHERN_LAMBERT, width: 18, height: 18, x0M: 0, y0M: 0, dxM: 1000, dyM: 1000 };
  const configured: ProductDefinition = { ...product, grid, bounds: [44, 40, 45, 41],
    terrainSubdivisionFactor: 1, frameHours: [1, 2], intervalHours: 1 };
  const geometry = planWholeDomainGrid(grid, 1);
  expect(geometry.fine).toEqual(geometry.native);
  const corners = [0, grid.width - 1, (grid.height - 1) * grid.width, grid.width * grid.height - 1];
  const donors = wholeDomainDonorSupport(geometry, corners);
  expect(Array.from({ length: grid.width * grid.height }, (_, index) => index).filter(index => getBit(donors, index))).toEqual(corners);

  const cycle = '2026-06-21T12:00:00.000Z';
  const provider: ForecastProvider = { id: 'fixture', provider: 'Synthetic', maxLevels: 3, async open({ activeIndices }) {
    return { cycle, stats: { fixture: true }, async close() {}, async acquire(hour) { return normalizedFixtureFrame(grid, activeIndices, cycle, hour, 1); } };
  } };
  const options = { cycle, product: configured, provider, mask: denseFixtureMask(configured, grid) };
  const serialRoot = await root('wd-lambert-k1-serial'), out = await root('wd-lambert-k1-shards'), store = new PublicationStore();
  const elevationM = 175;
  const serial = await readV5(await buildForecast({ ...options, out: serialRoot, wholeDomain: await syntheticWholeDomain(serialRoot, configured, elevationM) }));
  const plan = await createBuildPlan({ ...options, out, store, shards: 2, wholeDomain: await syntheticWholeDomain(out, configured, elevationM) });
  for (const [shard] of plan.groups.entries()) await buildShard({ ...options, out, plan, shard, store });
  const path = await finalizeBuild({ ...options, out, plan, store }), manifest = await readV5(path);
  expect(manifest.frames).toEqual(serial.frames);
  for (const id of ['native', 'fine'] as const) {
    const shards = surface(manifest, id).samples.shards;
    const actual = shards.map(shard => Buffer.from(store.objects.get(shard.key)!.bytes));
    expect(actual).toEqual(await surfaceBytes(serialRoot, serial, id));
  }
  expect(surface(manifest, 'fine')).toMatchObject({ grid, kind: 'fine', terrain: { layoutVersion: 1 } });
  const manifestKey = `builds/${manifest.model}/${manifest.buildId}/manifest.json`;
  await store.put(manifestKey, await readFile(path), { ifNoneMatch: '*' });
  const sample = await sampleReader(store, manifest, configured);
  const result = await sample(new URLSearchParams({ lat: String(grid.latitudeOfOriginDeg), lon: String(grid.centralMeridianDeg),
    frame: 'all', layers: 'usable-lift-msl,usable-lift-agl' }));
  expect(result.frames).toHaveLength(2);
  for (const frame of result.frames) {
    expect(frame.layers['usable-lift-msl']).toMatchObject({ status: 'valid', surfaceId: 'fine' });
    expect(frame.layers['usable-lift-agl']).toMatchObject({ status: 'valid', surfaceId: 'fine' });
    expect(deriveTerrainM(frame, { manifest, templates: {}, expiresAtMs: Date.parse(manifest.expiresAt) })).toBeCloseTo(elevationM, 3);
  }
}, 60_000);

describe('whole-domain v5 production', () => {
  it('rejects independently valid duplicate cells while allowing a nonduplicate change', async () => {
    const sealed = await sealedSerial(), out = await root('wd-duplicate');
    await cp(sealed.out, out, { recursive: true });
    const manifest = structuredClone(sealed.manifest), native = surface(manifest, 'native');
    const layout = prepareShardedSamplePackLayout(native.grid, nativeSparseMask(nativeMask).coverage.blockIds, native.samples.channelCount);
    const first = layout.block(0), last = layout.block(1), stride = native.samples.channelCount * 5;
    const shard = native.samples.shards[0], shardPath = join(out, shard.key), original = await readFile(shardPath);
    try {
      for (const [offset, duplicate] of [[first.byteOffset + 16 * stride, true], [last.byteOffset + (last.width - 1) * stride, true], [first.byteOffset + stride, false]] as const) {
        const bytes = Buffer.from(original);
        bytes.writeFloatLE(bytes.readFloatLE(offset) + 1, offset);
        await writeFile(shardPath, bytes);
        const changed = structuredClone(manifest);
        surface(changed, 'native').samples.shards[0].sha256 = sha256(bytes);
        const result = validateBuild(out, changed, nativeMask, product);
        if (duplicate) await expect(result).rejects.toThrow('Duplicate sample cell differs');
        else await expect(result).resolves.toBeDefined();
      }
      const bytes = Buffer.from(original), a = first.byteOffset + 16 * stride, b = last.byteOffset;
      for (const offset of [a, b]) { bytes.writeUInt32LE(0x7fc00000, offset); bytes[offset + 4] = STATUS_UNAVAILABLE; }
      const changed = structuredClone(manifest);
      await writeFile(shardPath, bytes);
      surface(changed, 'native').samples.shards[0].sha256 = sha256(bytes);
      await expect(validateBuild(out, changed, nativeMask, product)).resolves.toBeDefined();
      bytes.writeUInt32LE(0x7fc00001, a);
      await writeFile(shardPath, bytes);
      surface(changed, 'native').samples.shards[0].sha256 = sha256(bytes);
      await expect(validateBuild(out, changed, nativeMask, product)).rejects.toThrow('Duplicate sample cell differs');
      bytes.writeUInt32LE(0x7fc00000, a);
      bytes[a + 4] = 0;
      bytes.writeFloatLE(1, a); bytes.writeFloatLE(1, b);
      await writeFile(shardPath, bytes);
      surface(changed, 'native').samples.shards[0].sha256 = sha256(bytes);
      await expect(validateBuild(out, changed, nativeMask, product)).rejects.toThrow('Duplicate sample cell differs');
    } finally { await writeFile(shardPath, original); }
  }, 60_000);

  it('compares duplicate cells across ordered shard files', async () => {
    shardTarget.bytes = 2000;
    try {
      const setup = await fixture(), out = await root('wd-duplicate-shards');
      const path = await buildForecast({ out, cycle: CYCLE, product, mask: nativeMask, provider: fixtureProvider().provider, wholeDomain: setup });
      const manifest = await readV5(path), fine = surface(manifest, 'fine');
      const layout = prepareShardedSamplePackLayout(fine.grid, setup.fine.mask.coverage.blockIds, fine.samples.channelCount);
      const first = layout.block(0), second = layout.block(1);
      expect(first.shard).not.toBe(second.shard);
      const shard = fine.samples.shards[first.shard], shardPath = join(out, shard.key), bytes = await readFile(shardPath);
      const offset = first.byteOffset + (first.width - 1) * fine.samples.channelCount * 5;
      expect(Number.isFinite(bytes.readFloatLE(offset))).toBe(true);
      bytes.writeFloatLE(bytes.readFloatLE(offset) + 1, offset);
      await writeFile(shardPath, bytes);
      const changed = structuredClone(manifest);
      surface(changed, 'fine').samples.shards[first.shard].sha256 = sha256(bytes);
      await expect(validateBuild(out, changed, nativeMask, product)).rejects.toThrow('Duplicate sample cell differs');
    } finally { shardTarget.bytes = 0; }
  }, 60_000);

  it.each(['bottom', 'lower-right', 'lower-left'] as const)('compares %s overlaps without intervening blocks', async direction => {
    const grid: RegularLatLonGrid = { kind: 'regular-latlon', width: 18, height: 18, earthRadiusM: 6371229, lon0: -180, lat0: 72, dx: 20, dy: -1, wrapLongitude: true };
    const configured: ProductDefinition = { ...product, grid, bounds: [-180, 55, 180, 72] };
    const count = grid.width * grid.height, mask: CoverageMask = { grid, bounds: configured.bounds, maxZoom: 0, output: new Uint8Array(Math.ceil(count / 8)), halo: new Uint8Array(Math.ceil(count / 8)), tiles: Uint8Array.of(1) };
    for (let index = 0; index < count; index++) setBit(mask.output, index);
    const fineGrid = planWholeDomainGrid(grid, 2).fine, fineCells = fineGrid.width * fineGrid.height;
    const output = new Uint8Array(Math.ceil(fineCells / 8)), halo = new Uint8Array(output.length);
    const points = direction === 'lower-right' ? [[1, 1], [30, 30]] : direction === 'lower-left' ? [[18, 1], [1, 18]] : [[1, 1], [1, 18]];
    for (const [x, y] of points) {
      setBit(output, y * fineGrid.width + x);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) setBit(halo, (y + dy) * fineGrid.width + x + dx);
    }
    const fineMask: SparseCoverageMask = { grid: fineGrid, bounds: configured.bounds, maxZoom: 0, tiles: Uint8Array.of(1),
      coverage: sparseCoverageFromDense({ width: fineGrid.width, height: fineGrid.height, wrapLongitude: true, gridHash: sha256(Buffer.from(canonicalGridJson(fineGrid))), output, halo }) };
    const storage = new TerrainTestStorage(), catalogRef = seedTerrainCatalog(storage), description = describeSparseCoverage(fineMask, configured);
    const provider: ForecastProvider = { id: configured.source.configurationId, provider: 'Synthetic fixture', maxLevels: 3,
      async open({ cycle, activeIndices }) { const selected = cycle ?? CYCLE; return { cycle: selected, stats: { fixture: true },
        async acquire(hour) { return normalizedFixtureFrame(grid, activeIndices, selected, hour, configured.intervalHours); }, async close() {} }; } };
    const out = await root('wd-diagonal'), path = await buildForecast({ out, cycle: CYCLE, product: configured, mask, provider,
      wholeDomain: { storage, catalogRef, fine: { mask: fineMask, descriptor: description.descriptor, bytes: description.bytes, hash: description.hash } } });
    const manifest = await readV5(path), fine = surface(manifest, 'fine'), layout = prepareShardedSamplePackLayout(fine.grid, fineMask.coverage.blockIds, fine.samples.channelCount);
    expect(layout.blockCount).toBe(2);
    const first = layout.block(0), shard = fine.samples.shards[first.shard], shardPath = join(out, shard.key), bytes = await readFile(shardPath);
    const x = direction === 'lower-right' ? first.width - 1 : direction === 'bottom' ? 1 : 0;
    const offset = first.byteOffset + (16 * first.width + x) * fine.samples.channelCount * 5;
    expect(bytes[offset + 4] & STATUS_MASK).toBe(STATUS_OUTSIDE);
    bytes.writeFloatLE(42, offset);
    await writeFile(shardPath, bytes);
    surface(manifest, 'fine').samples.shards[first.shard].sha256 = sha256(bytes);
    await expect(validateBuild(out, manifest, mask, configured)).rejects.toThrow('Duplicate sample cell differs');
  }, 60_000);

  it('binds bundled fine coverage to product policy before loading sparse assets', async () => {
    const plan = wholeDomainPlan(INDEXED_PRODUCT);
    if (!plan) throw new Error('Missing GFS whole-domain plan');
    const fine = await loadBundledFineCoverage(INDEXED_PRODUCT, plan);
    expect(fine.descriptor.id).toBe(INDEXED_PRODUCT.coverageId);
    expect(fine.descriptor.bounds).toEqual(INDEXED_PRODUCT.bounds);
    expect(fine.descriptor.maxZoom).toBeGreaterThanOrEqual(INDEXED_PRODUCT.maxNativeZoom);
    const lowered = await loadBundledFineCoverage({ ...INDEXED_PRODUCT, maxNativeZoom: 0 }, plan);
    expect(lowered.hash).toBe(fine.hash);
    expect(lowered.mask.maxZoom).toBe(fine.mask.maxZoom);
    vi.mocked(readLocalFile).mockClear();
    for (const changed of [
      { ...INDEXED_PRODUCT, coverageId: 'wrong-policy' },
      { ...INDEXED_PRODUCT, bounds: [-179, -50, 180, 65] as const },
      { ...INDEXED_PRODUCT, maxNativeZoom: fine.descriptor.maxZoom + 1 }
    ]) await expect(loadBundledFineCoverage(changed, plan)).rejects.toThrow('Fine coverage does not match');
    expect(vi.mocked(readLocalFile).mock.calls).toHaveLength(3);
    expect(vi.mocked(readLocalFile).mock.calls.every(([path]) => path.endsWith('/manifest.json'))).toBe(true);
  }, 60_000);

  it('publishes a sealed build and refuses rollback to corrupted dependencies', async () => {
    const setup = await fixture(), out = await root('wd-publication'), store = new PublicationStore();
    const publishedProduct = { ...product, modelId: 'gfs', frameHours: [12, 24] };
    const masterMask = { ...nativeMask, maxZoom: 1, tiles: Uint8Array.of(31) };
    const masterFine = { ...setup.fine.mask, maxZoom: 1, tiles: Uint8Array.of(31) };
    setup.fine = { mask: masterFine, ...describeSparseCoverage(masterFine, publishedProduct) };
    const cycle = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
    const authority = workflowAuthority({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: 'a'.repeat(40), GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/forecast.yml@refs/heads/main', GITHUB_RUN_ID: '123', TARGET_ENV: 'staging', MODEL: 'gfs' });
    let published = false, sealed: ValidatedBuild | undefined;
    const path = await buildForecast({ out, cycle, product: publishedProduct, mask: masterMask, provider: fixtureProvider().provider, wholeDomain: setup,
      onValidated: async result => { sealed = result; await publish(store, out, result.manifest, { authority, validated: result }); published = true; } });
    expect(published).toBe(true);
    if (!sealed) throw new Error('Missing validation result');
    const proof = sealed;
    expect(() => assertValidatedBuild(out, proof.manifest, { ...proof })).toThrow('missing or changed');
    await expect(publish(store, out, proof.manifest, { authority, validated: proof, receiptsOnly: true })).rejects.toThrow('does not cover this remote store');
    const manifest = await readV5(path), pointerKey = 'catalog/gfs/latest.json', pointer = store.objects.get(pointerKey)!.bytes.slice();
    expect(manifest.surfaces.every(surface => surface.coverage.maxZoom === 0)).toBe(true);
    await verifySampleServing(store, manifest, publishedProduct);
    const gets = vi.spyOn(store, 'get');
    await rollback(store, 'gfs', manifest.buildId, authority);
    const fine = surface(manifest, 'fine'), terrain = fine.terrain!;
    const terrainManifest = JSON.parse(Buffer.from(store.objects.get(terrain.key)!.bytes).toString()) as { files: { elevationM: Array<{ key: string }>; valid: Array<{ key: string }> } };
    const dependencies = [fine.coverage.maskKey, fine.coverage.maskKey.replace('manifest.json', 'sparse.bin'), fine.coverage.maskKey.replace('manifest.json', 'tiles.bin'), terrain.key, terrainManifest.files.elevationM[0].key, terrainManifest.files.valid[0].key];
    for (const key of dependencies) expect(gets.mock.calls.filter(([read]) => read === key)).toHaveLength(1);
    gets.mockRestore();
    const keys = [...dependencies, fine.samples.shards[0].key, manifest.artifacts[0].tilesKey];
    for (const key of keys) {
      const original = store.objects.get(key)!;
      store.objects.set(key, { ...original, bytes: Uint8Array.from(original.bytes, (value, index) => index === 0 ? value ^ 1 : value) });
      await expect(rollback(store, 'gfs', manifest.buildId, authority)).rejects.toThrow();
      expect(store.objects.get(pointerKey)!.bytes).toEqual(pointer);
      store.objects.delete(key);
      await expect(rollback(store, 'gfs', manifest.buildId, authority)).rejects.toThrow();
      expect(store.objects.get(pointerKey)!.bytes).toEqual(pointer);
      store.objects.set(key, original);
    }
    const shard = fine.samples.shards[0].key, original = store.objects.get(shard)!;
    for (const metadata of [undefined, { sha256: 'f'.repeat(64) }]) {
      store.objects.set(shard, { ...original, metadata });
      await expect(rollback(store, 'gfs', manifest.buildId, authority)).rejects.toThrow(/metadata/);
      await expect(publish(store, out, manifest, { authority, validated: sealed })).rejects.toThrow(/metadata/);
      expect(store.objects.get(pointerKey)!.bytes).toEqual(pointer);
    }
    store.objects.set(shard, original);
    const remoteManifestKey = `builds/gfs/${manifest.buildId}/manifest.json`, remoteManifest = store.objects.get(remoteManifestKey)!;
    for (const field of ['source', 'method', 'clearance', 'zoom'] as const) {
      const changed = structuredClone(manifest);
      if (field === 'source') changed.source.terrain = { dataId: 'f'.repeat(64) };
      else if (field === 'method') changed.tool.terrainMethod = 'wrong';
      else if (field === 'clearance') changed.tool.terrainClearance = 'wrong';
      else surface(changed, 'fine').coverage.maxZoom = 2;
      store.objects.set(remoteManifestKey, { ...remoteManifest, bytes: Buffer.from(JSON.stringify(changed)) });
      await expect(rollback(store, 'gfs', manifest.buildId, authority)).rejects.toThrow(field === 'zoom' ? 'Rollback sparse coverage binding mismatch' : 'Terrain source or method mismatch');
      expect(store.objects.get(pointerKey)!.bytes).toEqual(pointer);
    }
    store.objects.set(remoteManifestKey, remoteManifest);

    const terrainPath = join(out, terrain.key), terrainBytes = await readFile(terrainPath);
    try {
      for (const field of ['dataId', 'method', 'coverageHash', 'gridHash', 'grid', 'source'] as const) {
        const descriptor = JSON.parse(terrainBytes.toString());
        if (field === 'grid') descriptor.grid.width++;
        else if (field === 'source') descriptor.source.verticalDatum = 'wrong';
        else descriptor[field] = field === 'method' ? 'wrong' : 'f'.repeat(64);
        const bytes = Buffer.from(JSON.stringify(descriptor));
        await writeFile(terrainPath, bytes);
        const changed = structuredClone(manifest), changedTerrain = surface(changed, 'fine').terrain!;
        changedTerrain.sha256 = sha256(bytes);
        await expect(validateBuild(out, changed, masterMask, publishedProduct)).rejects.toThrow();
      }
      await writeFile(terrainPath, terrainBytes);
      for (const field of ['dataId', 'verticalDatum', 'surface', 'sha256', 'key'] as const) {
        const changed = structuredClone(manifest), changedTerrain = surface(changed, 'fine').terrain!;
        changedTerrain[field] = field === 'key' ? `terrain/prepared/${'f'.repeat(64)}/manifest.json` : field === 'dataId' || field === 'sha256' ? 'f'.repeat(64) : 'wrong';
        await expect(validateBuild(out, changed, masterMask, publishedProduct)).rejects.toThrow();
      }
      for (const field of ['terrainMethod', 'terrainClearance'] as const) {
        const changed = structuredClone(manifest);
        changed.tool[field] = 'wrong';
        await expect(validateBuild(out, changed, masterMask, publishedProduct)).rejects.toThrow('Terrain source or method mismatch');
      }
      const changed = structuredClone(manifest);
      changed.source.terrain = { dataId: 'f'.repeat(64), key: terrain.key, sha256: terrain.sha256, arrayBytes: 1 };
      await expect(validateBuild(out, changed, masterMask, publishedProduct)).rejects.toThrow('Terrain source or method mismatch');
    } finally { await writeFile(terrainPath, terrainBytes); }

    const old = modelPointerSchema.parse(JSON.parse(Buffer.from(pointer).toString()));
    const oldId = '20200101T000000Z-12345678-1234-4234-8234-123456789abc';
    old.latestBuildId = oldId;
    old.retained[0] = { ...old.retained[0], buildId: oldId, manifestKey: `builds/gfs/${oldId}/manifest.json` };
    const oldPointer = Buffer.from(JSON.stringify(old));
    for (const metadata of [undefined, { sha256: 'f'.repeat(64) }]) {
      const attempt = new PublicationStore();
      await attempt.put(pointerKey, oldPointer, { ifNoneMatch: '*' });
      attempt.objects.set(shard, { ...original, metadata });
      await expect(publish(attempt, out, manifest, { authority, validated: proof, allowSameCycle: true })).rejects.toThrow(/metadata/);
      expect(attempt.objects.get(pointerKey)!.bytes).toEqual(oldPointer);
    }
    const ambiguous = new PublicationStore();
    await ambiguous.put(pointerKey, oldPointer, { ifNoneMatch: '*' });
    ambiguous.failAfterPointer = true;
    await expect(publish(ambiguous, out, manifest, { authority, validated: proof, allowSameCycle: true })).resolves.toBeUndefined();
    expect(modelPointerSchema.parse(JSON.parse(Buffer.from(ambiguous.objects.get(pointerKey)!.bytes).toString())).latestBuildId).toBe(manifest.buildId);
    const both = modelPointerSchema.parse(JSON.parse(Buffer.from(ambiguous.objects.get(pointerKey)!.bytes).toString()));
    both.latestBuildId = oldId;
    await ambiguous.put(pointerKey, Buffer.from(JSON.stringify(both)), { ifMatch: ambiguous.objects.get(pointerKey)!.etag });
    ambiguous.failAfterPointer = true;
    await expect(rollback(ambiguous, 'gfs', manifest.buildId, authority)).resolves.toBeUndefined();
    expect(modelPointerSchema.parse(JSON.parse(Buffer.from(ambiguous.objects.get(pointerKey)!.bytes).toString())).latestBuildId).toBe(manifest.buildId);
    for (const key of [fine.coverage.maskKey, fine.coverage.maskKey.replace('manifest.json', 'sparse.bin'), terrain.key, terrainManifest.files.elevationM[0].key, shard, manifest.artifacts[0].tilesKey, manifest.source.provenanceKey]) {
      const local = join(out, key), contents = await readFile(local);
      try {
        for (const missing of [false, true]) {
          if (missing) await rm(local);
          else await writeFile(local, Uint8Array.from(contents, (value, index) => index === 0 ? value ^ 1 : value));
          const attempt = new PublicationStore();
          await attempt.put(pointerKey, oldPointer, { ifNoneMatch: '*' });
          await expect(publish(attempt, out, manifest, { authority, validated: proof, allowSameCycle: true })).rejects.toThrow();
          expect(attempt.objects.get(pointerKey)!.bytes).toEqual(oldPointer);
          await writeFile(local, contents);
        }
      } finally { await writeFile(local, contents); }
    }
    for (const failKey of [fine.coverage.maskKey, terrain.key, terrainManifest.files.elevationM[0].key, shard, manifest.source.provenanceKey, `builds/gfs/${manifest.buildId}/manifest.json`]) {
      const partial = new PublicationStore();
      await partial.put(pointerKey, oldPointer, { ifNoneMatch: '*' });
      partial.failKey = failKey;
      await expect(publish(partial, out, manifest, { authority, validated: sealed, allowSameCycle: true })).rejects.toThrow('injected upload failure');
      expect(partial.objects.get(pointerKey)!.bytes).toEqual(oldPointer);
      expect(partial.objects.has(`builds/gfs/${manifest.buildId}/manifest.json`)).toBe(false);
    }
    const partial = new PublicationStore();
    await partial.put(pointerKey, oldPointer, { ifNoneMatch: '*' });
    partial.failKey = shard;
    await expect(publish(partial, out, manifest, { authority, validated: sealed, allowSameCycle: true })).rejects.toThrow();
    const inProgress = `builds/gfs/${manifest.buildId}/in-progress.bin`, retained = `builds/gfs/${oldId}/retained.bin`;
    const orphan = 'builds/gfs/20200102T000000Z-12345678-1234-4234-8234-123456789abc/orphan.bin';
    for (const key of [inProgress, retained, orphan]) await partial.put(key, Uint8Array.of(1), { ifNoneMatch: '*' });
    const shared = [...partial.objects.keys()].filter(key => key.startsWith('coverage/') || key.startsWith('terrain/'));
    await cleanup(partial, 'gfs', authority);
    expect(partial.objects.has(inProgress)).toBe(true);
    expect(partial.objects.has(retained)).toBe(true);
    expect(partial.objects.has(orphan)).toBe(false);
    expect(shared.every(key => partial.objects.has(key))).toBe(true);
    expect(partial.objects.get(pointerKey)!.bytes).toEqual(oldPointer);
  }, 60_000);

  it('builds native precipitation and fine lift surfaces sequentially and frozen-parallel with byte-identical shards and tiles', async () => {
    const setup = await fixture(), serialRoot = await root('wd-serial'), parallelRoot = await root('wd-parallel');
    const source = fixtureProvider(), configured = { ...product, frameHours: [2, 4, 8] };
    let sealed = false;
    const serialPath = await buildForecast({ out: serialRoot, cycle: CYCLE, product: configured, mask: nativeMask, provider: source.provider, wholeDomain: setup,
      onValidated: async result => { assertValidatedBuild(serialRoot, result.manifest, result); sealed = true; } });
    expect(sealed).toBe(true);
    const serial = await readV5(serialPath);
    expect(serial.version).toBe(5);
    expect(serial.method.id).toBe(`${TERRAIN_COLUMN_METHOD.id}+${PRECIPITATION_ALL_HOURS_METHOD.id}`);
    expect(serial.tool).toMatchObject({ terrainMethod: TERRAIN_COLUMN_METHOD.id, terrainClearance: TERRAIN_CLEARANCE_METHOD.id, useStoredMslNoLift: true });
    expect(serial.descriptors.layers['usable-lift-msl']).toMatchObject({ methodId: TERRAIN_COLUMN_METHOD.id, verticalReference: 'MSL' });
    expect(serial.descriptors.layers['usable-lift-agl']).toMatchObject({ methodId: TERRAIN_COLUMN_METHOD.id, verticalReference: 'terrain-AGL', label: 'Usable lift depth (terrain AGL)' });
    expect(serial.descriptors.layers['precip-rate']).toMatchObject({ methodId: PRECIPITATION_ALL_HOURS_METHOD.id, verticalReference: 'surface' });
    expect(serial.descriptors.methods[LIFT_METHOD.id]).toBeUndefined();
    const wrongMethod = structuredClone(serial);
    wrongMethod.descriptors = createProductDescriptors(product);
    wrongMethod.method.id = createProductMethodId(product);
    await expect(validateBuild(serialRoot, wrongMethod, nativeMask, configured)).rejects.toThrow('Unsupported model, grid or layers');
    const wrongGround = structuredClone(serial);
    wrongGround.descriptors.layers['usable-lift-agl'].verticalReference = 'model-AGL';
    await expect(validateBuild(serialRoot, wrongGround, nativeMask, configured)).rejects.toThrow('Unsupported model, grid or layers');
    const wrongClearance = structuredClone(serial);
    wrongClearance.tool.terrainClearance = TERRAIN_COLUMN_METHOD.id;
    await expect(validateBuild(serialRoot, wrongClearance, nativeMask, configured)).rejects.toThrow('Terrain source or method mismatch');
    expect(surface(serial, 'native').layers).toEqual(['precip-rate']);
    expect(surface(serial, 'fine').layers).toEqual(['usable-lift-msl', 'usable-lift-agl']);
    expect(surface(serial, 'fine').terrain).toMatchObject({ coverageHash: surface(serial, 'fine').coverage.hash, layoutVersion: 1 });
    expect(serial.metrics.capacity).toMatchObject({ rasterWorkers: 0 });
    expect((serial.metrics.capacity as { estimatedPeakBytes: number }).estimatedPeakBytes).toBeLessThan(BUILD_BUDGETS.workingSetBytes);
    expect(checkPerformance(serial)).toMatchObject({ passed: true, observed: { tiles: 9 } });

    const plan = await createBuildPlan({ out: parallelRoot, cycle: CYCLE, product: configured, mask: nativeMask, provider: source.provider, wholeDomain: setup, shards: 2 });
    expect(plan.version).toBe(2);
    expect(plan.wholeDomain).toMatchObject({ k: 2, nativeCoverageHash: plan.coverageHash });
    expect(plan.groups).toEqual([[2, 4], [8]]);
    for (let shard = 0; shard < plan.groups.length; shard++) await buildShard({ plan, shard, out: parallelRoot, product: configured, mask: nativeMask, provider: source.provider });
    let parallelSealed = false;
    const parallelPath = await finalizeBuild({ plan, out: parallelRoot, product: configured, mask: nativeMask, provider: source.provider,
      onValidated: async result => { assertValidatedBuild(parallelRoot, result.manifest, result); parallelSealed = true; } });
    expect(parallelSealed).toBe(true);
    const parallel = await readV5(parallelPath);
    expect(parallel.tool.useStoredMslNoLift).toBe(true);
    const timings = z.record(z.string(), z.number().nonnegative()).parse(parallel.metrics.phasesMs);
    const scalarMs = ['scalarStageMs', 'scalarMergeMs', 'scalarUploadMs'].map(key => {
      expect(timings[key]).toEqual(expect.any(Number));
      expect(timings[key]).toBeGreaterThanOrEqual(0);
      return timings[key]!;
    });
    expect(scalarMs.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(timings.assemblyMs ?? -1);
    expect(timings.scalarUploadMs).toBe(0);
    expect(source.observed.cycles).toHaveLength(3);
    expect(source.observed.sessions).toBe(0);
    expect(source.observed.peakSessions).toBe(1);
    expect(parallel.frames.map(frame => frame.id)).toEqual(serial.frames.map(frame => frame.id));
    expect(parallel.artifacts.map(artifact => [artifact.layer, artifact.frame])).toEqual(serial.artifacts.map(artifact => [artifact.layer, artifact.frame]));
    for (const id of ['native', 'fine'] as const) {
      const a = await surfaceBytes(serialRoot, serial, id), b = await surfaceBytes(parallelRoot, parallel, id);
      const bytes = a[0]!;
      expect(b).toEqual(a);
      expect(bytes.byteLength).toBe(surface(serial, id).samples.storedCells * surface(serial, id).samples.channelCount * 5);
      let validFlags = 0, positive = 0;
      for (let index = 0; index < bytes.length; index += 5) { if ((bytes[index + 4]! & ~(STATUS_MASK | SUPPORT_MASK)) === 0) validFlags++; if (bytes.readFloatLE(index) > 0) positive++; }
      expect(positive).toBeGreaterThan(0);
      expect(validFlags).toBe(bytes.length / 5);
    }
    const parallelArtifacts = new Map(parallel.artifacts.map(artifact => [`${artifact.layer}/${artifact.frame}`, artifact]));
    for (const artifact of serial.artifacts) {
      const peer = parallelArtifacts.get(`${artifact.layer}/${artifact.frame}`);
      if (!peer) throw new Error(`Missing parallel artifact ${artifact.layer}/${artifact.frame}`);
      expect(await readFile(join(serialRoot, artifact.tilesKey))).toEqual(await readFile(join(parallelRoot, peer.tilesKey)));
    }
    expect(coverageIndices(nativeMask).output.length).toBe(cells - 1);
    expect(plan.wholeDomain).toBeDefined();
  }, 60_000);

  it('reuses a finalized remote seal only for its validated store without repeating object HEADs', async () => {
    const setup = await fixture(), out = await root('wd-remote-seal'), store = new PublicationStore(), source = fixtureProvider();
    const configured: ProductDefinition = { ...product, modelId: 'gfs', frameHours: [12, 24], layers: [...product.layers, 'sfc-temp-c'] };
    const cycle = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
    const plan = await createBuildPlan({ out, cycle, product: configured, mask: nativeMask, provider: source.provider, wholeDomain: setup, shards: 2, store });
    for (let shard = 0; shard < plan.groups.length; shard++) await buildShard({ plan, shard, out, product: configured, mask: nativeMask, provider: source.provider, store });
    let sealed: ValidatedBuild | undefined;
    const path = await finalizeBuild({ plan, out, product: configured, mask: nativeMask, provider: source.provider, store, onValidated: async result => { sealed = result; } });
    if (!sealed) throw new Error('Missing remote validation seal');
    const manifest = await readV5(path), authority = workflowAuthority({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: 'a'.repeat(40), GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/forecast.yml@refs/heads/main', GITHUB_RUN_ID: '123', TARGET_ENV: 'staging', MODEL: 'gfs' });
    const other = new PublicationStore(), foreignRead = vi.spyOn(other, 'get');
    await expect(publish(other, out, manifest, { authority, validated: sealed, receiptsOnly: true })).rejects.toThrow('does not cover this remote store');
    expect(foreignRead).not.toHaveBeenCalled();
    const head = vi.spyOn(store, 'head');
    await publish(store, out, manifest, { authority, validated: sealed, receiptsOnly: true });
    expect(head.mock.calls.filter(([key]) => key.endsWith('.bin') || key.endsWith('.pmtiles'))).toEqual([]);
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(true);
    await verifySampleServing(store, manifest, configured);
  }, 60_000);

  it.each([false, true])('seals the full post-upload shard RSS peak and rejects excess=%s', async excess => {
    const setup = await fixture(), out = await root('wd-upload-rss'), store = new PublicationStore(), source = fixtureProvider();
    const configured: ProductDefinition = { ...product, modelId: 'gfs', frameHours: [2], layers: [...product.layers, 'sfc-temp-c'] };
    const plan = await createBuildPlan({ out, cycle: CYCLE, product: configured, mask: nativeMask, provider: source.provider, wholeDomain: setup, shards: 1, store });
    vi.mocked(createLocalFileReader).mockClear(); vi.mocked(validateSampleGroup).mockClear();
    const usage = process.resourceUsage(), core = 128 * 1024 ** 2, peak = excess ? BUILD_BUDGETS.peakRssBytes + 1024 : BUILD_BUDGETS.workingSetBytes + 512 * 1024 ** 2;
    const buffers: ArrayBufferLike[] = [], hashes = new Set<string>();
    let measured = core;
    const rss = vi.spyOn(process, 'resourceUsage').mockImplementation(() => ({ ...usage, maxRSS: measured / 1024 }));
    const put = store.put.bind(store), upload = vi.spyOn(store, 'put').mockImplementation(async (...args) => {
      await put(...args);
      if (args[0].startsWith('builds/')) measured = peak;
      if (args[0].endsWith('.bin')) { buffers.push(args[1].buffer); hashes.add(sha256(args[1])); }
    });
    try {
      const pending = buildShard({ plan, shard: 0, out, product: configured, mask: nativeMask, provider: source.provider, store });
      if (excess) {
        await expect(pending).rejects.toThrow('peakRssBytes');
        await expect(readFile(join(out, 'shards/0/receipt.json'))).rejects.toThrow();
        const failure = JSON.parse(await readFile(join(out, 'shards/0/worker-failure.json'), 'utf8'));
        expect(failure.error.message).toContain('peakRssBytes');
        expect(failure.error.message).toContain(String(peak));
      } else {
        const receipt = JSON.parse(await readFile(await pending, 'utf8'));
        expect(receipt.metrics.peakRssBytes).toBe(peak);
        expect(receipt.objects.length).toBeGreaterThan(0);
        for (const object of receipt.objects) expect(sha256(store.objects.get(object.key)!.bytes)).toBe(object.sha256);
      }
      expect(upload.mock.calls.some(([key]) => key.startsWith('builds/'))).toBe(true);
      expect(measured).toBe(peak);
      expect(createLocalFileReader).toHaveBeenCalledExactlyOnceWith(MAX_V5_SHARD_BYTES);
      const reader = vi.mocked(createLocalFileReader).mock.results[0].value;
      const validations = vi.mocked(validateSampleGroup).mock.calls, profiles = validations.filter(args => args[4].recordBytes !== undefined);
      expect(validations.length).toBeGreaterThan(1); expect(profiles.length).toBeGreaterThan(0);
      expect(validations.every(args => args[5]?.reader === reader)).toBe(true);
      const uploaded = new Set(upload.mock.calls.map(([key]) => key));
      expect(profiles.every(args => args[4].shards.every(shard => uploaded.has(shard.key)))).toBe(true);
      expect(buffers.length).toBeGreaterThan(1); expect(hashes.size).toBeGreaterThan(1);
      expect(buffers.every(buffer => buffer === buffers[0])).toBe(true);
    } finally { upload.mockRestore(); rss.mockRestore(); }
  }, 60_000);

  it.each([
    { receiptsOnly: true, hours: Array.from({ length: 24 }, (_, i) => (i + 1) * 2) },
    { receiptsOnly: false, hours: [12, 24] }
  ])('finalizes $hours.length frame groups and serves samples with receipt-only mode $receiptsOnly', async ({ receiptsOnly, hours }) => {
    const setup = await fixture(), out = await root('wd-remote'), store = new PublicationStore(), source = fixtureProvider();
    const configured = { ...product, modelId: 'gfs', frameHours: hours };
    const cycle = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
    const plan = await createBuildPlan({ out, cycle, product: configured, mask: nativeMask, provider: source.provider, wholeDomain: setup, shards: hours.length, store });
    expect(plan.groups).toEqual(hours.map(hour => [hour]));
    expect(plan.dependencies?.length).toBeGreaterThan(6);
    let nextShard = 0;
    const runShard = async () => {
      for (;;) {
        const shard = nextShard++;
        if (shard >= plan.groups.length) return;
        await buildShard({ plan, shard, out, product: configured, mask: nativeMask, provider: source.provider, store });
        const receipt = JSON.parse(await readFile(join(out, 'shards', String(shard), 'receipt.json'), 'utf8')) as { objects: Array<{ key: string }> };
        expect(receipt.objects.length).toBeGreaterThan(0);
        if (receiptsOnly) for (const object of receipt.objects) await rm(join(out, object.key));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, plan.groups.length) }, () => runShard()));
    if (receiptsOnly) await rm(join(out, 'terrain'), { recursive: true, force: true });
    const hourKeys = new Set<string>();
    for (let index = 0; index < plan.groups.length; index++) {
      const receipt = JSON.parse(await readFile(join(out, 'shards', String(index), 'receipt.json'), 'utf8')) as { objects: Array<{ key: string }> };
      for (const object of receipt.objects) if (object.key.includes('/samples/src-g')) hourKeys.add(object.key);
    }
    const hourReads = new Map<string, number>(), readHour = store.get.bind(store);
    const hourGet = vi.spyOn(store, 'get').mockImplementation(async (key, range) => {
      if (hourKeys.has(key)) {
        if (range) throw new Error(`Hour shard was range-read: ${key}`);
        hourReads.set(key, (hourReads.get(key) ?? 0) + 1);
      }
      return readHour(key, range);
    });
    let path: string;
    try { path = await finalizeBuild({ plan, out, product: configured, mask: nativeMask, provider: source.provider, store }); }
    finally { hourGet.mockRestore(); }
    expect([...hourReads.values()].every(count => count === 1)).toBe(true);
    expect([...hourReads.keys()].sort()).toEqual(receiptsOnly ? [...hourKeys].sort() : []);
    const manifest = await readV5(path);
    expect(manifest.surfaces.every(surface => surface.samples.format === 'frame-group-block-shards-v1')).toBe(true);
    for (const surface of manifest.surfaces) {
      if (surface.samples.format !== 'frame-group-block-shards-v1') throw new Error('Missing frame groups');
      const frames = surfaceFrameCount(manifest, surface), groups = Math.ceil(frames / 24);
      expect([...new Set(surface.samples.shards.map(shard => shard.group))]).toEqual(Array.from({ length: groups }, (_, index) => index));
      expect(surface.samples.shards.at(-1)).toMatchObject({ group: groups - 1, firstFrame: (groups - 1) * 24, frameCount: frames - (groups - 1) * 24 });
    }
    const manifestBytes = await readFile(path);
    expect(() => parseBoundedJson(manifestBytes, MAX_METADATA_JSON_TOKENS)).not.toThrow();
    expect(checkPerformance(manifest).observed.tiles).toBe(hours.length * configured.layers.length);
    expect(manifest.metrics.frames).toBeUndefined();
    expect(manifest.metrics.acquisition).toBeUndefined();
    const privateReceipt = JSON.parse(await readFile(join(out, 'shards', String(hours.length - 1), 'receipt.json'), 'utf8'));
    expect(Object.keys(privateReceipt.metrics.frames)).toEqual([manifest.frames.at(-1)!.id]);
    expect(privateReceipt.metrics.renderer.fine.tiles).toBe(2);
    store.objects.set(`builds/${manifest.model}/${manifest.buildId}/manifest.json`, { bytes: manifestBytes, etag: 'manifest' });
    await verifySampleServing(store, manifest, configured);
    const provenanceKey = manifest.source.provenanceKey!, provenanceBytes = await readFile(join(out, provenanceKey));
    await store.put(provenanceKey, provenanceBytes, { ifNoneMatch: '*' }, 'application/json', undefined, { sha256: sha256(provenanceBytes) });
    const inputs = { product: configured, mask: nativeMask, provider: source.provider };
    const getObject = store.get.bind(store);
    const get = vi.spyOn(store, 'get').mockImplementation(async (key, range) => {
      if (key.startsWith('builds/')) throw new Error(`Receipt verification read forecast payload ${key}`);
      return getObject(key, range);
    });
    const head = vi.spyOn(store, 'head');
    try {
      await expect(verifyBuildReceipts(out, manifest, store, undefined, inputs)).resolves.not.toHaveLength(0);
      for (const surface of manifest.surfaces) for (const shard of surface.samples.shards) expect(head.mock.calls.filter(([key]) => key === shard.key)).toHaveLength(1);
    } finally { get.mockRestore(); head.mockRestore(); }
    const authority = workflowAuthority({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: 'a'.repeat(40), GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/forecast.yml@refs/heads/main', GITHUB_RUN_ID: '123', TARGET_ENV: 'staging', MODEL: 'gfs' });
    let maintenance: CleanupSummary | undefined;
    const manifestKey = `builds/gfs/${manifest.buildId}/manifest.json`, manifestObject = store.objects.get(manifestKey)!;
    const deletes = vi.spyOn(store, 'delete'), maintenanceReads = vi.spyOn(store, 'get');
    store.objects.delete(manifestKey);
    expect(await cleanup(store, 'gfs', authority, Date.now(), report => { maintenance = report; })).toBe(0);
    expect(maintenance?.status).toBe('complete');
    expect(deletes).not.toHaveBeenCalled();
    expect(maintenanceReads.mock.calls.every(([key]) => key === 'catalog/gfs/latest.json')).toBe(true);
    expect([...hourKeys].every(key => store.objects.has(key))).toBe(true);
    store.objects.set(manifestKey, manifestObject);
    deletes.mockRestore(); maintenanceReads.mockRestore();
    const savedInput = [...hourKeys][0]!, savedBytes = store.objects.get(savedInput)!;
    await store.delete([...hourKeys]);
    expect([...hourKeys].some(key => store.objects.has(key))).toBe(false);
    await expect(verifyBuildReceipts(out, manifest, store, undefined, inputs)).resolves.not.toHaveLength(0);
    await verifySampleServing(store, manifest, configured);
    await expect(rollback(store, 'gfs', manifest.buildId, authority)).resolves.toBeUndefined();

    // Expired build inputs share the ordinary whole-build retention.
    const aged = { ...manifest, expiresAt: new Date(Date.parse(manifest.createdAt) + 2 * 3600000).toISOString() };
    store.objects.set(manifestKey, { bytes: Buffer.from(JSON.stringify(aged)), etag: 'expired-manifest' });
    store.objects.set(savedInput, savedBytes);
    const cleanupAt = Date.parse(manifest.createdAt) + 6 * 3600000 + 1;
    const newerId = new Date(cleanupAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') + '-12345678-1234-4234-8234-123456789abc';
    const latest = { buildId: newerId, manifestKey: `builds/gfs/${newerId}/manifest.json`, cycle: new Date(cleanupAt).toISOString(), expiresAt: new Date(cleanupAt + 86400000).toISOString() };
    store.objects.set('catalog/gfs/latest.json', { bytes: Buffer.from(JSON.stringify({ version: 1, model: 'gfs', latestBuildId: newerId, retained: [latest] })), etag: 'new-pointer' });
    expect(await cleanup(store, 'gfs', authority, cleanupAt, report => { maintenance = report; })).toBe(0);
    expect(store.objects.has(savedInput)).toBe(true);
    expect(manifest.surfaces.every(surface => surface.samples.shards.every(shard => store.objects.has(shard.key)))).toBe(true);
    store.objects.set(manifestKey, { bytes: manifestBytes, etag: 'manifest' });
    const forged = structuredClone(manifest);
    forged.artifacts[0].tilesSha256 = '0'.repeat(64);
    await expect(verifyBuildReceipts(out, forged, store, undefined, inputs)).rejects.toThrow('Manifest forecast receipt mismatch');
    const shard = manifest.surfaces[0].samples.shards[0], object = store.objects.get(shard.key)!;
    object.metadata = {};
    await expect(verifyBuildReceipts(out, manifest, store, undefined, inputs)).rejects.toThrow('Remote object receipt mismatch');
    await expect(validateBuild(out, manifest, nativeMask, configured, {
      store, objects: (await Promise.all(plan.groups.map(async (_, index) => JSON.parse(await readFile(join(out, 'shards', String(index), 'receipt.json'), 'utf8'))))).flatMap(receipt => receipt.objects)
    })).rejects.toThrow('Remote receipt artifact set mismatch');
    store.objects.set(savedInput, savedBytes);
    const deleted = vi.spyOn(store, 'delete');
    const count = await cleanup(store, 'gfs', authority, Date.parse(manifest.createdAt) + RETENTION_DAYS * 86400000 + 1, report => { maintenance = report; });
    const keys = deleted.mock.calls.flatMap(([items]) => items);
    expect(new Set(keys).size).toBe(keys.length);
    expect(count).toBe(keys.length);
    expect(maintenance?.deleted?.objects).toBe(keys.length);
    deleted.mockRestore();
  }, 60_000);

  it('freezes target zoom and worker ceiling while retaining master coverage identities', async () => {
    const configured = { ...product, execution: { ...product.execution, shards: 1, workers: 0 } };
    const master = { ...nativeMask, maxZoom: 1, tiles: Uint8Array.of(31) };
    const setup = await fixture(configured), fineMask = { ...setup.fine.mask, maxZoom: 1, tiles: Uint8Array.of(31) };
    setup.fine = { mask: fineMask, ...describeSparseCoverage(fineMask, configured) };
    const out = await root('wd-frozen-execution'), source = fixtureProvider(), store = new PublicationStore();
    const plan = await createBuildPlan({ out, cycle: CYCLE, product: configured, mask: master, provider: source.provider, wholeDomain: setup, store });
    expect(plan.execution).toEqual({ zoom: 0, workers: 0 });
    expect(plan.wholeDomain!.fineCoverage.maxZoom).toBe(1);
    const changed = { ...configured, maxNativeZoom: 1, execution: { ...configured.execution, workers: 3 } };
    await buildShard({ out, plan, shard: 0, product: changed, mask: master, provider: source.provider, store });
    const path = await finalizeBuild({ out, plan, product: changed, mask: master, provider: source.provider, store });
    const manifest = await readV5(path);
    expect(manifest.surfaces.every(surface => surface.coverage.maxZoom === 0)).toBe(true);
    expect(surface(manifest, 'fine').coverage.hash).toBe(setup.fine.hash);
    expect(manifest.metrics.renderer).toEqual({ native: { tiles: 2 }, fine: { tiles: 4 } });
    expect(manifest.metrics.capacity).toMatchObject({ rasterWorkers: 0, deriveWorkers: 0, tiles: 6 });
    const inputs = { product: changed, mask: master, provider: source.provider };
    await expect(verifyBuildReceipts(out, manifest, store, undefined, inputs)).resolves.not.toHaveLength(0);
    for (let index = 0; index < manifest.surfaces.length; index++) {
      const forged = structuredClone(manifest);
      forged.surfaces[index]!.coverage.maxZoom = 1;
      await expect(verifyBuildReceipts(out, forged, store, undefined, inputs)).rejects.toThrow('Manifest surface receipt mismatch');
    }
  });


  it('uses actual per-shard bytes for v5 performance admission and reports aggregate bytes separately', async () => {
    const manifest = await builtManifest(), shard = 60 * 1024 * 1024, stored = shard / 5;
    const aggregate = sizedManifest(manifest, Array.from({ length: 5 }, () => ({ bytes: shard, storedCells: stored })));
    const fine = surface(aggregate, 'fine').grid;
    fine.width = BUILD_BUDGETS.gridCells + 1;
    const passed = checkPerformance(aggregate);
    expect(passed.passed).toBe(true);
    expect(passed.observed).toMatchObject({ samplePackBytes: shard, gridCells: product.grid.width * product.grid.height,
      fineGridCells: fine.width * fine.height });
    expect(passed.observed.emittedSampleBytes).toBeGreaterThan(256 * 1024 * 1024);
    expect(passed.budgets.samplePackBytes).toBe(64 * 1024 * 1024);
    const native = surface(aggregate, 'native').grid;
    native.width = BUILD_BUDGETS.gridCells + 1;
    expect(checkPerformance(aggregate).failures).toContain(`gridCells: ${native.width * native.height} exceeds ${BUILD_BUDGETS.gridCells}`);
    const oversized = sizedManifest(manifest, [{ bytes: 65 * 1024 * 1024, storedCells: (65 * 1024 * 1024) / 5 }]);
    const rejected = checkPerformance(oversized);
    expect(rejected.passed).toBe(false);
    expect(rejected.failures.some(failure => failure.startsWith('samplePackBytes:'))).toBe(true);
    const unsafe = sizedManifest(manifest, [{ bytes: 7.5, storedCells: 1.5 }]);
    expect(checkPerformance(unsafe).failures).toContain('invalid v5 shard size');
  });

  it('rejects invalid v5 elapsed, RSS, and tile metrics', async () => {
    const manifest = await builtManifest();
    const invalid = structuredClone(manifest);
    invalid.metrics.elapsedMs = -1;
    invalid.metrics.peakRssBytes = BUILD_BUDGETS.peakRssBytes + 1;
    invalid.metrics.renderer = { native: { tiles: -1 }, fine: { tiles: 4 } };
    const result = checkPerformance(invalid);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining(['missing or invalid elapsedMs', `peakRssBytes: ${invalid.metrics.peakRssBytes} exceeds ${BUILD_BUDGETS.peakRssBytes}`, 'missing or invalid renderer tile counts']));
  });

  it('counts distinct native and fine raster work for direct and assembled v5 builds', async () => {
    const manifest = await builtManifest();
    manifest.metrics.capacity = { tiles: 8 };
    for (const renderer of [
      { native: { tiles: 4 }, fine: { tiles: 4 } },
      { shards: [{ native: { tiles: 2 }, fine: { tiles: 2 } }, { native: { tiles: 2 }, fine: { tiles: 2 } }] }
    ]) {
      manifest.metrics.renderer = renderer;
      const result = checkPerformance(manifest);
      expect(result.passed).toBe(true);
      expect(result.observed.tiles).toBe(8);
    }
    manifest.metrics.capacity = { tiles: 9 };
    expect(checkPerformance(manifest).failures).toContain('rendered tile count differs from admitted coverage');
    delete manifest.metrics.renderer;
    expect(checkPerformance(manifest).passed).toBe(false);
  });

  it('keeps the v5 physical tile work limit inclusive and rejects malformed renderer counters', async () => {
    const manifest = await builtManifest();
    delete manifest.metrics.capacity;
    manifest.metrics.renderer = { native: { tiles: 0 }, fine: { tiles: BUILD_BUDGETS.tiles } };
    expect(checkPerformance(manifest)).toMatchObject({ passed: true, observed: { tiles: BUILD_BUDGETS.tiles } });
    manifest.metrics.renderer = { native: { tiles: 0 }, fine: { tiles: BUILD_BUDGETS.tiles + 1 } };
    expect(checkPerformance(manifest).failures).toContain(`tiles: ${BUILD_BUDGETS.tiles + 1} exceeds ${BUILD_BUDGETS.tiles}`);
    for (const renderer of [null, { shards: [] }, { native: { tiles: 4 } },
      { native: { tiles: 1.5 }, fine: { tiles: 4 } }, { native: { tiles: Number.MAX_SAFE_INTEGER }, fine: { tiles: 1 } }]) {
      manifest.metrics.renderer = renderer;
      expect(checkPerformance(manifest).failures).toContain('missing or invalid renderer tile counts');
    }
  });

  it('acquires positive fine donors outside the public native mask without changing output support', async () => {
    const mask: CoverageMask = { grid: product.grid, bounds: product.bounds, maxZoom: 0,
      output: new Uint8Array(Math.ceil(cells / 8)), halo: new Uint8Array(Math.ceil(cells / 8)), tiles: Uint8Array.of(1) };
    setBit(mask.output, 0); setBit(mask.output, product.grid.width);
    const plan = planWholeDomainGrid(product.grid as RegularLatLonGrid, 2);
    const fine = fineCoverage();
    const { required, active } = acquisitionSupport(plan, fine.coverage, mask);
    expect(active.length).toBeGreaterThan(coverageIndices(mask).active.length);
    expect(active).toContain(0);
    for (const cell of active) expect(mask.output[cell >> 3]! & (1 << (cell & 7)) || required[cell >> 3]! & (1 << (cell & 7))).toBeTruthy();
    expect([...sparseActiveIndices(fine.coverage)]).toHaveLength(fine.coverage.width * fine.coverage.height);
  });

  it.each(['Uint8Array', 'Buffer'] as const)('builds with private donor support and preserves %s coverage and native samples', async storage => {
    const setup = await fixture(), out = await root('wd-donor-build'), source = fixtureProvider();
    const bytes = (length: number) => storage === 'Buffer' ? Buffer.alloc(length) : new Uint8Array(length);
    const mask: CoverageMask = { ...nativeMask, output: bytes(nativeMask.output.length), halo: bytes(nativeMask.halo.length) };
    setBit(mask.output, 0);
    for (const i of [1, 17, 18, 19, 35]) setBit(mask.halo, i);
    const before = { output: Uint8Array.from(mask.output), halo: Uint8Array.from(mask.halo) };
    const manifest = await readV5(await buildForecast({ out, cycle: CYCLE, product, mask, provider: source.provider, wholeDomain: setup }));
    expect(Uint8Array.from(mask.output)).toEqual(before.output); expect(Uint8Array.from(mask.halo)).toEqual(before.halo);
    const native = surface(manifest, 'native'), data = await surfaceBytes(out, manifest, 'native');
    const plan = (await import('@av/forecast')).prepareShardedSamplePackLayout(mask.grid, nativeSparseMask(mask).coverage.blockIds, native.samples.channelCount);
    for (let ordinal = 0; ordinal < plan.blockCount; ordinal++) {
      const block = plan.block(ordinal), bytes = data[block.shard]!;
      for (let y = 0; y < block.height; y++) for (let x = 0; x < block.width; x++) {
        const index = (block.row + y) * mask.grid.width + (block.column + x) % mask.grid.width;
        if (!getBit(mask.output, index) && !getBit(mask.halo, index)) {
          const offset = block.byteOffset + (y * block.width + x) * native.samples.channelCount * 5;
          expect(bytes[offset + 4]).toBe(STATUS_OUTSIDE);
        }
      }
    }
    expect(source.open.mock.calls[0]![0].activeIndices.length).toBeGreaterThan(coverageIndices(mask).active.length);
  }, 60_000);

  it('emits lazy native clearance fallback for bridge-exceeded fine cells', async () => {
    const setup = await fixture(), out = await root('wd-fallback'), source = fixtureProvider();
    const prepared = await prepareWholeDomain({ product, mask: nativeMask, out, maxLevels: source.provider.maxLevels, wholeDomain: setup });
    const terrain = await loadWholeDomainTerrain({ ref: prepared.terrain, out, grid: prepared.plan.fine, coverage: prepared.fine.mask.coverage, coverageDescriptor: prepared.fine.bytes });
    const session = await source.provider.open({ cycle: CYCLE, activeIndices: prepared.acquisitionActive, cacheDir: out });
    const frame = await session.acquire(2); await session.close();
    const diagnostics = { ceilingMslM: new Float32Array(cells), buoyancyM2S3: new Float32Array(cells), branch: new Uint8Array(cells) };
    const flags = deriveFrame(frame, nativeMask, { layers: product.layers, daylightOnly: false, diagnostics })['usable-lift-msl']!.flags;
    const descriptor = { intervalStart: frame.intervals.fluxWindow.start, validTime: frame.validAt };
    const options = { daylightOnly: false, nativeClearance: { grid: product.grid, validTime: frame.validAt, diagnostics, flags } };
    const expected = prepared.columns.derive(frame, terrain, descriptor, options);
    const noFallback = preparePackedTerrainColumns(prepared.plan, prepared.fine.mask.coverage, prepared.acquisitionActive, 3, { maxBytes: 10_000_000, clearanceFallback: 'none', expectedGridHash: prepared.fine.descriptor.gridHash }).derive(frame, terrain, descriptor, options);
    expect(expected.metrics.belowGroundBridgeExceededObserved).toBeGreaterThan(0);
    expect(expected.metrics.clearance).toBeGreaterThan(0);
    const target = Array.from(expected.fields['usable-lift-agl'].flags).findIndex((flag, i) => flag !== noFallback.fields['usable-lift-agl'].flags[i]);
    expect(target).toBeGreaterThanOrEqual(0);
    const fineCells = prepared.plan.fine.width * prepared.plan.fine.height;
    const denseMask: CoverageMask = { grid: prepared.plan.fine, output: new Uint8Array(Math.ceil(fineCells / 8)), halo: new Uint8Array(Math.ceil(fineCells / 8)), tiles: Uint8Array.of(1), maxZoom: 0 };
    const denseTerrain = { elevationM: new Float32Array(fineCells), valid: new Uint8Array(fineCells) };
    let targetIndex = -1;
    for (let i = 0; i < fineCells; i++) {
      const lookup = sparseCoverageLookup(prepared.fine.mask.coverage, i % prepared.plan.fine.width, Math.floor(i / prepared.plan.fine.width));
      if (!lookup) continue;
      setBit(lookup.output ? denseMask.output : denseMask.halo, i);
      denseTerrain.elevationM[i] = terrain.elevationM[lookup.offset]!; denseTerrain.valid[i] = terrain.valid[lookup.offset]!;
      if (lookup.offset === target) targetIndex = i;
    }
    const reference = prepareTerrainColumns(nativeMask, denseMask, prepared.acquisitionActive, 3, { clearanceFallback: 'unsupported' }).derive(frame, denseTerrain, descriptor, options);
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    expect(expected.fields['usable-lift-agl'].flags[target]).toBe(reference.fields['usable-lift-agl'].flags[targetIndex]);
    expect(expected.fields['usable-lift-agl'].values[target]).toBe(reference.fields['usable-lift-agl'].values[targetIndex]);
    const result = await buildWholeDomainFrames({ out, cycle: CYCLE, product, mask: nativeMask, provider: source.provider, prepared,
      buildId: 'fallback-test', createdAt: new Date().toISOString(), journalPrefix: 'fallback-journal', hours: [2], deriveOptions: { daylightOnly: false } });
    const fine = result.surfaces.find(item => item.id === 'fine')!, coverage = prepared.fine.mask.coverage;
    let checked = false;
    for (let ordinal = 0; ordinal < fine.layout.blockCount; ordinal++) {
      const block = fine.layout.block(ordinal), bytes = await readFile(join(out, fine.shards![block.shard]!.key));
      for (let y = 0; y < block.height; y++) for (let x = 0; x < block.width; x++) {
        const lookup = sparseCoverageLookup(coverage, block.column + x, block.row + y);
        if (lookup?.offset !== target) continue;
        const offset = block.byteOffset + ((y * block.width + x) * fine.layout.channelCount + 1) * 5;
        expect(bytes[offset + 4]).toBe(expected.fields['usable-lift-agl'].flags[target]);
        expect(bytes.readFloatLE(offset)).toBe(expected.fields['usable-lift-agl'].values[target]);
        checked = true;
      }
    }
    expect(checked).toBe(true);
  }, 60_000);

  it('rejects tampered injected fine coverage before opening the provider', async () => {
    const setup = await fixture(), out = await root('wd-injected'), source = fixtureProvider();
    const bad = { ...setup.fine, hash: '0'.repeat(64) };
    await expect(buildForecast({ out, cycle: CYCLE, product, mask: nativeMask, provider: source.provider, wholeDomain: { ...setup, fine: bad } })).rejects.toThrow('Fine coverage descriptor mismatch');
    expect(source.open).not.toHaveBeenCalled();
  });

  it('preserves pinned descriptor bytes through frozen loading and terrain identity', async () => {
    const setup = await fixture(), out = await root('wd-descriptor-bytes'), source = fixtureProvider();
    const prepared = await prepareWholeDomain({ product, mask: nativeMask, out, maxLevels: source.provider.maxLevels, wholeDomain: setup });
    const variant = (coverage: typeof prepared.fine) => {
      const entries = Object.entries(coverage.descriptor).reverse();
      const bytes = Buffer.from(JSON.stringify(Object.fromEntries(entries), null, 2) + '\n');
      return { ...coverage, bytes, hash: createHash('sha256').update(bytes).digest('hex') };
    };
    const native = variant(prepared.native), fine = variant(prepared.fine);
    expect(fine.hash).not.toBe(prepared.fine.hash);
    await stageFineCoverage(out, native); await stageFineCoverage(out, fine);
    const terrain = await prepareWholeDomainTerrain({ ...setup, out, grid: prepared.plan.fine, coverage: fine.mask.coverage, coverageDescriptor: fine.bytes });
    const frozen = frozenWholeDomain({ ...prepared, native, fine, terrain });
    const loaded = await loadFrozenWholeDomain({ product, frozen, out, maxLevels: source.provider.maxLevels });
    expect(loaded.native.bytes).toEqual(native.bytes);
    expect(loaded.fine.bytes).toEqual(fine.bytes);
    const data = await loadWholeDomainTerrain({ ref: terrain, out, grid: loaded.plan.fine, coverage: loaded.fine.mask.coverage, coverageDescriptor: loaded.fine.bytes });
    expect(data.descriptor.coverageHash).toBe(fine.hash);
  });

  it('rejects frozen fine policy mismatches even when the frozen reference matches', async () => {
    const setup = await fixture(), out = await root('wd-frozen-policy'), source = fixtureProvider();
    const prepared = await prepareWholeDomain({ product, mask: nativeMask, out, maxLevels: source.provider.maxLevels, wholeDomain: setup });
    const descriptors: Array<typeof prepared.fine.descriptor> = [
      { ...prepared.fine.descriptor, id: 'wrong-policy' },
      { ...prepared.fine.descriptor, bounds: [-179, 70, 180, 72] }
    ];
    for (const descriptor of descriptors) {
      const bytes = Buffer.from(JSON.stringify(descriptor)), hash = createHash('sha256').update(bytes).digest('hex');
      const fine = { ...prepared.fine, descriptor, bytes, hash, mask: { ...prepared.fine.mask, maxZoom: descriptor.maxZoom } };
      await stageFineCoverage(out, fine);
      const frozen = frozenWholeDomain({ ...prepared, fine });
      await expect(loadFrozenWholeDomain({ product, frozen, out, maxLevels: source.provider.maxLevels })).rejects.toThrow('Frozen fine coverage differs from its plan');
    }
    await expect(loadFrozenWholeDomain({ product: { ...product, maxNativeZoom: prepared.fine.mask.maxZoom + 1 },
      frozen: frozenWholeDomain(prepared), out, maxLevels: source.provider.maxLevels })).rejects.toThrow('Frozen fine coverage differs from its plan');
    expect(source.open).not.toHaveBeenCalled();
  });

  it('admits before opening and closes unfinished writers without removing preexisting shards', async () => {
    const setup = await fixture(), out = await root('wd-cleanup'), source = fixtureProvider({ failHour: 4 });
    const prepared = await prepareWholeDomain({ product, mask: nativeMask, out, maxLevels: source.provider.maxLevels, wholeDomain: setup });
    const common = { out, cycle: CYCLE, product, mask: nativeMask, provider: source.provider, prepared,
      buildId: 'cleanup-test', createdAt: new Date().toISOString(), journalPrefix: 'cleanup-journal', hours: [2, 4] };
    await expect(buildWholeDomainFrames({ ...common, prepared: { ...prepared, terrain: { ...prepared.terrain, arrayBytes: 3 * 1024 ** 3 } } })).rejects.toThrow('exceeds capacity');
    expect(source.open).not.toHaveBeenCalled();
    const directory = join(out, 'builds', product.modelId, common.buildId, 'surfaces', 'native', 'samples');
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, '0.bin'), 'existing');
    await expect(buildWholeDomainFrames(common)).rejects.toThrow('Fixture acquisition failure');
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(await readFile(join(directory, '0.bin'), 'utf8')).toBe('existing');
    expect(await readdir(directory)).toEqual(['0.bin']);
    const fineDirectory = join(out, 'builds', product.modelId, common.buildId, 'surfaces', 'fine', 'samples');
    expect(await readdir(fineDirectory).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return []; })).toEqual([]);
  }, 60_000);

  it('aborts the provider and preserves the original fine derivation error', async () => {
    const setup = await fixture(), out = await root('wd-derive-failure'), source = fixtureProvider();
    const prepared = await prepareWholeDomain({ product, mask: nativeMask, out, maxLevels: source.provider.maxLevels, wholeDomain: setup });
    const failure = new Error('fine derivation failed');
    const columns = { ...prepared.columns, deriveAsync: async () => { throw failure; } };
    await expect(buildWholeDomainFrames({ out, cycle: CYCLE, product, mask: nativeMask, provider: source.provider,
      prepared: { ...prepared, columns }, buildId: 'derive-error', createdAt: new Date().toISOString(), journalPrefix: 'derive-error-journal', hours: [2] })).rejects.toBe(failure);
    const signal = source.open.mock.calls[0]![0].signal!;
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(failure);
    expect(source.close).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('aborts and drains a blocked next acquisition before returning a derive failure', async () => {
    const setup = await fixture(), out = await root('wd-prefetch-failure'), source = fixtureProvider();
    const prepared = await prepareWholeDomain({ product, mask: nativeMask, out, maxLevels: source.provider.maxLevels, wholeDomain: setup });
    const failure = new Error('fine derivation failed'), events: string[] = [];
    let release!: () => void;
    const drained = new Promise<void>(resolve => { release = resolve; });
    const originalOpen = source.provider.open;
    const provider: ForecastProvider = { ...source.provider, async open(options) {
      const session = await originalOpen(options);
      return { ...session, async acquire(hour, target) {
        if (hour === 2) return session.acquire(hour, target);
        events.push('prefetch');
        return await new Promise<never>((_resolve, reject) => options.signal!.addEventListener('abort', () => {
          events.push('abort'); void drained.then(() => { events.push('drained'); reject(options.signal!.reason); });
        }, { once: true }));
      }, async close() { events.push('close'); await session.close(); } };
    } };
    const columns = { ...prepared.columns, deriveAsync: async () => { expect(events).toEqual(['prefetch']); throw failure; } };
    let settled = false;
    const pending = buildWholeDomainFrames({ out, cycle: CYCLE, product, mask: nativeMask, provider, prepared: { ...prepared, columns },
      buildId: 'prefetch-error', createdAt: new Date().toISOString(), journalPrefix: 'prefetch-error-journal', hours: [2, 4] })
      .catch(error => { settled = true; return error; });
    await vi.waitFor(() => expect(events).toContain('abort'));
    expect(settled).toBe(false); release();
    expect(await pending).toBe(failure);
    expect(events).toContain('drained'); expect(events).toContain('close');
  }, 60_000);

  it('aborts current derivation when the next acquisition fails', async () => {
    const setup = await fixture(), out = await root('wd-prefetch-error'), source = fixtureProvider();
    const prepared = await prepareWholeDomain({ product, mask: nativeMask, out, maxLevels: source.provider.maxLevels, wholeDomain: setup });
    const failure = new Error('next frame unavailable'), controller = new AbortController();
    const originalOpen = source.provider.open;
    const provider: ForecastProvider = { ...source.provider, async open(options) {
      const session = await originalOpen(options);
      return { ...session, async acquire(hour, target) { if (hour !== 2) throw failure; return session.acquire(hour, target); } };
    } };
    const columns = { ...prepared.columns, deriveAsync: vi.fn<typeof prepared.columns.deriveAsync>(async (_frame, _terrain, _time, options) => {
      const signal = options.signal!;
      signal.throwIfAborted();
      return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }) };
    const timer = setTimeout(() => controller.abort(new Error('prefetch failure did not cancel derivation')), 1_000);
    try {
      await expect(buildWholeDomainFrames({ out, cycle: CYCLE, product, mask: nativeMask, provider, prepared: { ...prepared, columns },
        buildId: 'prefetch-error', createdAt: new Date().toISOString(), journalPrefix: 'prefetch-error-journal', hours: [2, 4], signal: controller.signal })).rejects.toBe(failure);
      expect(columns.deriveAsync).toHaveBeenCalledTimes(1);
      expect(source.close).toHaveBeenCalledTimes(1);
    } finally { clearTimeout(timer); }
  }, 60_000);

  it.each(['abort', 'deadline'] as const)('cleans up after %s during an asynchronous fine chunk', async mode => {
    const configured: ProductDefinition = { ...product, terrainSubdivisionFactor: 8 };
    const setup = await fixture(configured), out = await root(`wd-midfine-${mode}`), source = fixtureProvider();
    const prepared = await prepareWholeDomain({ product: configured, mask: nativeMask, out, maxLevels: source.provider.maxLevels, wholeDomain: setup });
    const createdAt = new Date().toISOString();
    const controller = new AbortController(), clock = vi.spyOn(Date, 'now'), sort = vi.spyOn(Float64Array.prototype, 'sort');
    const samples = (surface: string) => join(out, 'builds', configured.modelId, 'midfine-test', 'surfaces', surface, 'samples');
    resources.writers.length = 0; resources.renderers.length = 0;
    let calls = 0, yields = 0, nativeChannels = false, fineChannels = false;
    const deriveAsync = prepared.columns.deriveAsync;
    const columns = { ...prepared.columns, deriveAsync: async (...args: Parameters<typeof deriveAsync>) => {
      expect(args[3].deadlineAt).toBe(Date.parse(createdAt) + BUILD_BUDGETS.elapsedMs);
      if (++calls === 2) {
        sort.mockClear();
        const originalYield = args[3].yieldControl;
        args[3] = { ...args[3], yieldControl: async () => {
          await originalYield();
          if (++yields === 2) {
            nativeChannels = (await readdir(samples('native'))).some(name => name.endsWith('.channels'));
            fineChannels = (await readdir(samples('fine'))).some(name => name.endsWith('.channels'));
            if (mode === 'abort') controller.abort(new Error('cancel during fine chunk'));
            else {
              const deadline = args[3].deadlineAt;
              if (deadline === undefined) throw new Error('Missing deadline');
              clock.mockReturnValue(deadline + 1);
            }
          }
        } };
      }
      return deriveAsync(...args);
    } };
    try {
      await expect(buildWholeDomainFrames({ out, cycle: CYCLE, product: configured, mask: nativeMask, provider: source.provider,
        prepared: { ...prepared, columns }, buildId: 'midfine-test', createdAt, journalPrefix: 'midfine-journal',
        hours: [2, 4], signal: controller.signal, deriveOptions: { daylightOnly: false } })).rejects.toThrow(mode === 'abort' ? 'cancel during fine chunk' : 'Terrain column deadline exceeded');
      expect(calls).toBe(2); expect(yields).toBe(2); expect(sort.mock.calls.length).toBeGreaterThan(0);
      expect(nativeChannels).toBe(true); expect(fineChannels).toBe(true);
      expect(resources.writers.map(writer => writer.surface)).toEqual(['native', 'fine']);
      for (const writer of resources.writers) expect(writer.close).toHaveBeenCalledTimes(1);
      expect(resources.renderers).toHaveLength(2);
      for (const renderer of resources.renderers) expect(renderer.renderArchives).toHaveBeenCalledTimes(1);
      expect(source.close).toHaveBeenCalledTimes(1);
      expect(await readdir(samples('native'))).toEqual([]);
      expect(await readdir(samples('fine'))).toEqual([]);
    } finally { clock.mockRestore(); sort.mockRestore(); }
  }, 60_000);

  it('rejects frozen fine coverage tampering before opening the provider', async () => {
    const setup = await fixture(), out = await root('wd-tamper'), source = fixtureProvider();
    const plan = await createBuildPlan({ out, cycle: CYCLE, product, mask: nativeMask, provider: source.provider, wholeDomain: setup, shards: 1 });
    const tampered = structuredClone(plan) as BuildPlan;
    tampered.wholeDomain!.fineCoverage.gridHash = '0'.repeat(64);
    await expect(buildShard({ plan: tampered, shard: 0, out, product, mask: nativeMask, provider: source.provider })).rejects.toThrow(/recipe or source revision|Frozen fine coverage/);
    expect(source.open).not.toHaveBeenCalled();
    const terrain = structuredClone(plan) as BuildPlan;
    terrain.wholeDomain!.terrain.sha256 = '0'.repeat(64);
    await expect(buildShard({ plan: terrain, shard: 0, out, product, mask: nativeMask, provider: source.provider })).rejects.toThrow();
    expect(source.open).not.toHaveBeenCalled();
    expect((await readBuildPlan(join(out, 'plan.json'))).wholeDomain).toEqual(plan.wholeDomain);
  });

  it('admits live whole-domain bytes and rejects an over-budget working set', () => {
    const plan = planWholeDomainGrid(product.grid as RegularLatLonGrid, 2), fine = fineCoverage();
    const { active } = acquisitionSupport(plan, fine.coverage, nativeMask);
    const native = nativeSparseMask(nativeMask);
    const columns = { byteLength: 1000, workspaceBufferBytes: 1000, workspaceObjectBudgetBytes: 1000, outputBufferBytes: 1000 };
    const input = { product, plan, nativeBlocks: native.coverage.blockIds, nativeActive: active.length, nativeMask, fine,
      nativeMaskBytes: nativeMask.output.byteLength + nativeMask.halo.byteLength + nativeMask.tiles.byteLength,
      frames: product.frameHours.length, nativeLayers: 1, fineLayers: 2, columns, terrainBytes: active.length * 5, maxLevels: 3, retainedGeometryFields: 0 };
    const admitted = admitWholeDomain(input);
    expect(admitted.violations).toEqual([]);
    const layouts = wholeDomainSampleGroupLayouts(input);
    expect(admitted.workingSet.packBuffers).toBe(samplePackWriterBufferBytes(layouts.native!) + samplePackWriterBufferBytes(layouts.fine!));
    vi.mocked(rasterWorkerCount).mockReturnValueOnce(3);
    const threaded = admitWholeDomain(input), nativeCells = plan.native.width * plan.native.height, activeBytes = active.byteLength;
    expect(threaded.deriveWorkers).toBeGreaterThan(0);
    const copyBytes = activeBytes + nativeCells * 10;
    expect(threaded.workingSet.deriveSharedInputs).toBe(input.terrainBytes + fine.coverage.blockIds.byteLength
      + fine.coverage.offsets.byteLength + fine.coverage.output.byteLength + fine.coverage.halo.byteLength + activeBytes + copyBytes);
    expect(threaded.deriveFrameCopyBytes).toBe(copyBytes + BUILD_BUDGETS.workingSetBytes - threaded.estimatedPeakBytes);
    expect(admitted.tiles).toBe(product.frameHours.length * 3);
    expect(admitted.estimatedPeakBytes).toBe(Object.values(admitted.workingSet).reduce((sum, value) => sum + value, 0));
    expect(fine.coverage.offsets[fine.coverage.blockIds.length]).toBe(180);
    expect(admitted.fineStoredCells).toBe((17 + 17 + 5) * 5);
    expect(admitted.fineSampleBytes).toBe(3900);
    expect(admitted.numericBytes).toBe(admitted.nativeSampleBytes + 3900);
    expect(admitted.workingSet.nativeFields).toBe(cells * product.layers.length * 5);
    expect(admitted.workingSet.diagnostics).toBe(cells * 9);
    expect(admitted.prefetchFrameCount).toBe(1);
    const singleFrame = admitWholeDomain({ ...input, columns: { ...columns,
      byteLength: columns.byteLength + BUILD_BUDGETS.workingSetBytes - admitted.estimatedPeakBytes + 1 } });
    expect(singleFrame.prefetchFrameCount).toBe(0);
    expect(singleFrame.workingSet.prefetchFrame).toBe(0);
    expect(singleFrame.estimatedPeakBytes).toBeLessThanOrEqual(BUILD_BUDGETS.workingSetBytes);
    expect(singleFrame.violations).toEqual([]);
    const sparseAdmission = admitWholeDomain({ ...input, nativeActive: 1 });
    expect(sparseAdmission.workingSet.nativeFields).toBe(admitted.workingSet.nativeFields);
    expect(sparseAdmission.workingSet.diagnostics).toBe(admitted.workingSet.diagnostics);
    expect(sparseAdmission.workingSet.nativeFrame).toBeLessThan(admitted.workingSet.nativeFrame);
    const rejected = admitWholeDomain({ ...input, terrainBytes: 3 * 1024 ** 3 });
    expect(rejected.violations).toContain('whole-domain working set exceeds the 2 GiB process budget');
  });

  it('admits exact per-surface tile counts at the cap and rejects the next covered tile', () => {
    const fine = fineCoverage(), plan = planWholeDomainGrid(product.grid as RegularLatLonGrid, 2);
    const tiles = (count: number) => {
      const bytes = new Uint8Array(Math.ceil((4 ** 10 - 1) / 3 / 8));
      for (let i = 0; i < count; i++) setBit(bytes, i);
      return bytes;
    };
    const frames = BUILD_BUDGETS.tiles / 1_000_000;
    const input = { product: { ...product, maxNativeZoom: 9 }, plan, nativeBlocks: nativeSparseMask(nativeMask).coverage.blockIds, nativeActive: cells,
      nativeMask: { maxZoom: 9, tiles: tiles(340_000) }, fine: { ...fine, maxZoom: 9, tiles: tiles(330_000) },
      nativeMaskBytes: 0, frames, nativeLayers: 1, fineLayers: 2, maxLevels: 3, retainedGeometryFields: 0,
      columns: { byteLength: 1000, workspaceBufferBytes: 1000, workspaceObjectBudgetBytes: 1000, outputBufferBytes: 1000 }, terrainBytes: 0 };
    expect(admitWholeDomain(input)).toMatchObject({ tiles: BUILD_BUDGETS.tiles, violations: [] });
    setBit(input.nativeMask.tiles, 340_000);
    expect(admitWholeDomain(input)).toMatchObject({ tiles: BUILD_BUDGETS.tiles + frames, violations: ['tile budget exceeded'] });
  });

  it('rejects full-product tile work during planning before opening any forecast shard', async () => {
    const configured = { ...product, maxNativeZoom: 9, frameHours: Array.from({ length: 24 }, (_, i) => (i + 1) * 2) };
    const allTiles = new Uint8Array(Math.ceil((4 ** 10 - 1) / 3 / 8)).fill(255);
    const mask = { ...nativeMask, maxZoom: 9, tiles: allTiles };
    const setup = await fixture(configured), fineMask = { ...setup.fine.mask, maxZoom: 9, tiles: allTiles };
    const described = describeSparseCoverage(fineMask, configured);
    setup.fine = { mask: fineMask, ...described };
    const source = fixtureProvider(), out = await root('wd-full-tile-cap');
    await expect(createBuildPlan({ out, cycle: CYCLE, product: configured, mask, provider: source.provider, wholeDomain: setup, shards: 8 })).rejects.toThrow('tile budget exceeded');
    expect(source.open).not.toHaveBeenCalled();
    await expect(readFile(join(out, 'plan.json'))).rejects.toThrow('ENOENT');
  });
});

it('emits all native channels and profiles with serial/parallel parity and closed receipt validation', async () => {
  const configured: ProductDefinition = { ...product, layers: LAYER_IDS, frameHours: [2, 4, 8],
    capabilities: { ...product.capabilities, maxVerticalLevels: 3 } };
  const setup = await fixture(configured), source = fixtureProvider(), serialRoot = await root('wd-profiles-serial'), parallelRoot = await root('wd-profiles-parallel');
  const serial = await readV5(await buildForecast({ out: serialRoot, cycle: CYCLE, product: configured,
    mask: nativeMask, provider: source.provider, wholeDomain: setup }));
  expect(serial.artifacts).toHaveLength(9);
  expect(new Set(serial.artifacts.map(artifact => artifact.layer))).toEqual(new Set(['usable-lift-msl', 'usable-lift-agl', 'precip-rate']));
  expect(surface(serial, 'native').layers).toHaveLength(18);
  expect(surface(serial, 'fine').profiles).toBeUndefined();
  const profiles = surface(serial, 'native').profiles!;
  expect(profiles).toMatchObject({ format: 'native-column-profile-v1', levelCount: 3, recordBytes: profileRecordBytes(3) });
  expect(profiles.groups).toHaveLength(1);
  expect(profiles.groups[0]).toMatchObject({ firstFrame: 0, frameCount: 3 });
  const serialBytes = await readFile(join(serialRoot, profiles.groups[0].shards[0].key));
  expect(readProfileRecord(serialBytes.subarray(0, profiles.recordBytes))).toMatchObject({ status: 'valid', levels: expect.any(Array) });
  const missing = structuredClone(serial);
  delete surface(missing, 'native').profiles;
  await expect(validateBuild(serialRoot, missing, nativeMask, configured)).rejects.toThrow('Native profiles are required');

  const store = new PublicationStore(), inputs = { product: configured, mask: nativeMask, provider: source.provider };
  const plan = await createBuildPlan({ out: parallelRoot, cycle: CYCLE, ...inputs, wholeDomain: setup, shards: 2, store });
  for (let shard = 0; shard < plan.groups.length; shard++) await buildShard({ plan, shard, out: parallelRoot, ...inputs, store });
  const parallel = await readV5(await finalizeBuild({ plan, out: parallelRoot, ...inputs, store }));
  const grouped = surface(parallel, 'native').profiles!;
  expect(grouped.groups).toHaveLength(2);
  const numeric = [...surface(parallel, 'native').samples.shards, ...grouped.groups.flatMap(group => group.shards), ...surface(parallel, 'fine').samples.shards];
  expect(forecastObjects(parallel)).toEqual([
    ...numeric.map(shard => ({ key: shard.key, sha256: shard.sha256, bytes: shard.bytes, contentType: 'application/octet-stream' })),
    ...parallel.artifacts.map(tile => ({ key: tile.tilesKey, sha256: tile.tilesSha256, contentType: 'application/vnd.pmtiles' }))
  ]);
  let firstFrame = 0;
  for (const group of grouped.groups) {
    const shard = group.shards[0];
    const bytes = await readFile(join(parallelRoot, shard.key));
    for (let cell = 0; cell < grouped.storedCells; cell++) {
      expect(bytes.subarray(cell * group.frameCount * grouped.recordBytes, (cell + 1) * group.frameCount * grouped.recordBytes))
        .toEqual(serialBytes.subarray((cell * 3 + firstFrame) * profiles.recordBytes, (cell * 3 + firstFrame + group.frameCount) * profiles.recordBytes));
    }
    firstFrame += group.frameCount;
  }
  const receipts = await verifyBuildReceipts(parallelRoot, parallel, store, undefined, inputs);
  expect(receipts.filter(receipt => receipt.key.includes('/profiles/'))).toHaveLength(2);
  store.objects.delete(grouped.groups[0].shards[0].key);
  await expect(verifyBuildReceipts(parallelRoot, parallel, store, undefined, inputs)).rejects.toThrow();

  const path = join(serialRoot, profiles.groups[0].shards[0].key), corrupt = Buffer.from(serialBytes);
  // Native cell 16 appears in the first block's right overlap and the next block's core.
  const overlap = 16 * 3 * profiles.recordBytes;
  corrupt.writeInt16LE(corrupt.readInt16LE(overlap) + 1, overlap);
  await writeFile(path, corrupt);
  const changed = structuredClone(serial);
  surface(changed, 'native').profiles!.groups[0].shards[0].sha256 = sha256(corrupt);
  await expect(validateBuild(serialRoot, changed, nativeMask, configured)).rejects.toThrow('Duplicate sample cell differs');
  await writeFile(path, serialBytes);
}, 60_000);

it('keeps map bytes fixed across skipped hours, source intervals and native-only workflow groups', async () => {
  const configured: ProductDefinition = { ...product, layers: LAYER_IDS, frameHours: [24, 27, 120, 123, 384], mapEndHour: 24,
    intervalHours: 1, intervalChange: { fromHour: 123, hours: 3 }, capabilities: { ...product.capabilities, maxVerticalLevels: 3 } };
  const setup = await fixture(configured), source = fixtureProvider();
  const provider: ForecastProvider = { ...source.provider, async open(options) {
    const session = await source.provider.open(options);
    return { ...session, async acquire(hour, target) {
      const frame = await session.acquire(hour, target), end = Date.parse(frame.validAt), duration = hour >= 123 ? 3 : 1;
      const window = { start: new Date(end - duration * 3_600_000).toISOString(), end: new Date(end).toISOString() };
      frame.intervals = { profileTime: frame.validAt, fluxWindow: window, precipitationWindow: window, fluxSourceWindow: window, precipitationSourceWindow: window, usedCompanion: false };
      return frame;
    } };
  } };
  const serialRoot = await root('wd-horizon-serial'), referenceRoot = await root('wd-horizon-map'), parallelRoot = await root('wd-horizon-parallel');
  const inputs = { product: configured, mask: nativeMask, provider };
  const serial = await readV5(await buildForecast({ out: serialRoot, cycle: CYCLE, ...inputs, wholeDomain: setup }));
  const reference = await readV5(await buildForecast({ out: referenceRoot, cycle: CYCLE, ...inputs, product: { ...configured, frameHours: [24] }, wholeDomain: setup }));
  expect(serial.mapFrameCount).toBe(1);
  publicationPolicy.minHorizonHours = 48;
  try {
    expect(() => assertUsefulHorizon({ ...serial, model: 'gfs' }, Date.parse(serial.cycle))).toThrow('useful forecast horizon');
    expect(() => assertUsefulHorizon({ ...serial, model: 'gfs', mapFrameCount: 3 }, Date.parse(serial.cycle))).not.toThrow();
  } finally { publicationPolicy.minHorizonHours = 6; }
  expect(serial.artifacts).toHaveLength(3);
  expect(surface(serial, 'native').samples.channelCount).toBe(90);
  expect(surface(serial, 'fine').samples.channelCount).toBe(2);
  expect(serial.metrics.capacity).toMatchObject({ frames: 5, mapFrames: 1, tiles: 3 });
  for (const [index, hour] of configured.frameHours.entries()) {
    const frame = serial.frames[index]!;
    expect(Date.parse(frame.intervalEnd) - Date.parse(frame.intervalStart)).toBe((hour >= 123 ? 3 : 1) * 3_600_000);
  }
  expect(await surfaceBytes(serialRoot, serial, 'fine')).toEqual(await surfaceBytes(referenceRoot, reference, 'fine'));
  const nativeBytes = (await surfaceBytes(serialRoot, serial, 'native'))[0]!, referenceNativeBytes = (await surfaceBytes(referenceRoot, reference, 'native'))[0]!;
  for (let cell = 0; cell < surface(serial, 'native').samples.storedCells; cell++) {
    expect(nativeBytes.subarray(cell * 90 * 5, cell * 90 * 5 + 18 * 5)).toEqual(referenceNativeBytes.subarray(cell * 18 * 5, (cell + 1) * 18 * 5));
  }
  for (const artifact of reference.artifacts) expect(await readFile(join(referenceRoot, artifact.tilesKey)))
    .toEqual(await readFile(join(serialRoot, serial.artifacts.find(item => item.layer === artifact.layer)!.tilesKey)));
  const profiles = surface(serial, 'native').profiles!, profileBytes = await readFile(join(serialRoot, profiles.groups[0]!.shards[0]!.key));
  const first = readProfileRecord(profileBytes.subarray(0, profiles.recordBytes)), last = readProfileRecord(profileBytes.subarray(4 * profiles.recordBytes, 5 * profiles.recordBytes));
  expect(first.status).toBe('valid'); expect(last.status).toBe('valid');
  expect(last.levels[0]!.temperatureC).toBe(first.levels[0]!.temperatureC);

  const store = new PublicationStore(), plan = await createBuildPlan({ out: parallelRoot, cycle: CYCLE, ...inputs, wholeDomain: setup, shards: 2, store });
  for (let shard = 0; shard < plan.groups.length; shard++) await buildShard({ plan, shard, out: parallelRoot, ...inputs, store });
  const later = JSON.parse(await readFile(join(parallelRoot, 'shards/1/receipt.json'), 'utf8'));
  expect(later.artifacts).toEqual([]);
  expect(later.surfaces.map((item: { id: string }) => item.id)).toEqual(['native']);
  const parallel = await readV5(await finalizeBuild({ plan, out: parallelRoot, ...inputs, store }));
  expect(parallel.frames).toEqual(serial.frames);
  expect(parallel.mapFrameCount).toBe(1);
  expect(await surfaceBytes(parallelRoot, parallel, 'fine')).toEqual(await surfaceBytes(serialRoot, serial, 'fine'));
  expect(surface(parallel, 'native').profiles!.groups.map(group => [group.firstFrame, group.frameCount])).toEqual([[0, 3], [3, 2]]);
  await expect(verifyBuildReceipts(parallelRoot, parallel, store, undefined, inputs)).resolves.toBeDefined();
  const invalid = structuredClone(parallel); invalid.mapFrameCount = 2;
  await expect(validateBuild(parallelRoot, invalid, nativeMask, configured)).rejects.toThrow();
}, 60_000);
