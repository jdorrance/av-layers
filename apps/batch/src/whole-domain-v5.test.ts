import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GFS_PRODUCT, LIFT_METHOD, PRECIPITATION_METHOD, TERRAIN_CLEARANCE_METHOD, TERRAIN_COLUMN_METHOD, canonicalGridJson, coverageIndices, createProductDescriptors, createProductMethodId, getBit, manifestV5Schema, modelPointerSchema, planWholeDomainGrid, setBit, sparseCoverageFromDense, sparseCoverageLookup, STATUS_MASK, STATUS_OUTSIDE, STATUS_UNAVAILABLE, SUPPORT_MASK, type CoverageMask, type ProductDefinition, type RegularLatLonGrid, type SparseCoverageMask } from '@av/contracts';
import { deriveFrame, prepareShardedSamplePackLayout } from '@av/forecast';
import { preparePackedTerrainColumns, prepareTerrainColumns } from '@av/forecast/refinement';
import { buildForecast } from './build.js';
import { describeSparseCoverage } from './coverage.js';
import { createBuildPlan, buildShard, finalizeBuild, readBuildPlan, verifyBuildReceipts, type BuildPlan } from './parallel.js';
import { seedTerrainCatalog, TerrainTestStorage } from './terrain/test-fixtures.js';
import { acquisitionSupport, loadBundledFineCoverage, nativeSparseMask, sparseActiveIndices, stageFineCoverage, wholeDomainPlan } from './whole-domain/coverage.js';
import { admitWholeDomain } from './whole-domain/capacity.js';
import { BUILD_BUDGETS, checkPerformance } from './capacity.js';
import { fixtureProvider } from '../parallel-fixtures.js';
import { normalizedFixtureFrame } from '../../../scripts/fixtures/normalized-provider.js';
import type { ForecastProvider } from './provider.js';
import { frozenWholeDomain, loadFrozenWholeDomain, loadWholeDomainTerrain, prepareWholeDomain } from './whole-domain/prepare.js';
import { prepareWholeDomainTerrain } from './whole-domain/terrain.js';
import { buildWholeDomainFrames } from './whole-domain/frames.js';
import { assertValidatedBuild, sha256, validateBuild, type ValidatedBuild } from './validate.js';
import { workflowAuthority } from './authority.js';
import { cleanup, publish, rollback } from './publication.js';
import { readLocalFile } from './local-file.js';
import type { ArchiveTarget } from './render.js';
import type { ObjectStorage } from './storage.js';

const shardTarget = vi.hoisted(() => ({ bytes: 0 }));
const resources = vi.hoisted(() => ({ writers: [] as Array<{ surface: string; close: () => Promise<void> }>, renderers: [] as Array<{ renderArchives: (targets: readonly ArchiveTarget[]) => Promise<void> }> }));
vi.mock('@av/forecast', async importOriginal => {
  const actual = await importOriginal<typeof import('@av/forecast')>();
  return { ...actual, prepareShardedSamplePackLayout: (...args: Parameters<typeof actual.prepareShardedSamplePackLayout>) =>
    actual.prepareShardedSamplePackLayout(args[0], args[1], args[2], shardTarget.bytes || args[3]) };
});
vi.mock('./local-file.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./local-file.js')>();
  return { ...actual, readLocalFile: vi.fn(actual.readLocalFile) };
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
vi.mock('./raster-pool.js', async importOriginal => ({ ...await importOriginal<typeof import('./raster-pool.js')>(), rasterWorkerCount: () => 0 }));
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
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function root(name: string): Promise<string> { const path = await mkdtemp(join(tmpdir(), `av-${name}-`)); temporary.push(path); return path; }

class PublicationStore implements ObjectStorage {
  objects = new Map<string, { bytes: Uint8Array; etag: string; metadata?: Record<string, string> }>();
  failKey = '';
  failAfterPointer = false;
  async get(key: string, range?: { offset: number; length: number }) {
    const item = this.objects.get(key);
    return item ? { bytes: range ? item.bytes.slice(range.offset, range.offset + range.length) : item.bytes.slice(), etag: item.etag } : null;
  }
  async head(key: string) { const item = this.objects.get(key); return item ? { size: item.bytes.length, etag: item.etag, metadata: item.metadata } : null; }
  async put(key: string, bytes: Uint8Array, condition: { ifMatch?: string; ifNoneMatch?: '*' }, _type?: string, _md5?: string, metadata?: Record<string, string>) {
    if (key === this.failKey) throw new Error('injected upload failure');
    const previous = this.objects.get(key);
    if ((condition.ifNoneMatch && previous) || (condition.ifMatch && condition.ifMatch !== previous?.etag)) throw new Error('precondition failed');
    this.objects.set(key, { bytes: bytes.slice(), etag: `"${createHash('md5').update(bytes).digest('hex')}"`, metadata });
    if (key === 'catalog/gfs/latest.json' && this.failAfterPointer) { this.failAfterPointer = false; throw new Error('lost pointer response'); }
  }
  async list(prefix: string) { return [...this.objects].filter(([key]) => key.startsWith(prefix)).map(([key, item]) => ({ key, size: item.bytes.length, lastModified: new Date(0) })); }
  async delete(keys: string[]) { for (const key of keys) this.objects.delete(key); }
}

async function verifySampleServing(store: PublicationStore, manifest: Awaited<ReturnType<typeof readV5>>, configured: ProductDefinition) {
  const bucket = { async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const object = store.objects.get(key);
    if (!object) return null;
    const range = options?.range, bytes = range ? object.bytes.slice(range.offset, range.offset + range.length) : object.bytes;
    return { key, size: object.bytes.length, httpEtag: object.etag, customMetadata: object.metadata, range,
      body: new Response(Uint8Array.from(bytes).buffer).body, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
  } };
  const entry = { buildId: manifest.buildId, manifestKey: `builds/${manifest.model}/${manifest.buildId}/manifest.json`, cycle: manifest.cycle, expiresAt: manifest.expiresAt };
  if (!store.objects.has('catalog/gfs/latest.json')) store.objects.set('catalog/gfs/latest.json', { bytes: Buffer.from(JSON.stringify({ version: 1, model: 'gfs', latestBuildId: manifest.buildId, retained: [entry] })), etag: 'pointer' });
  const apiPath = '../../api/src/index.js';
  const { createApp } = await import(apiPath) as { createApp(options: { products: Record<string, ProductDefinition> }): { fetch(request: Request, env: unknown, context: unknown): Promise<Response> } };
  const app = createApp({ products: { gfs: configured } });
  for (const frame of [manifest.frames[0].id, 'all']) {
    const url = new URL(`https://example.com/v1/models/gfs/runs/${manifest.buildId}/sample?lat=71&lon=10&frame=${frame}&layers=usable-lift-msl`);
    const response = await app.fetch(new Request(url, { headers: { 'cf-connecting-ip': '192.0.2.1' } }), { BUCKET: bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) }, AV_RESPONSE_CACHE: 'off' }, { waitUntil() {}, passThroughOnException() {} });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { frames: unknown[] };
    expect(body.frames.length).toBe(frame === 'all' ? manifest.frames.length : 1);
  }
}

const product: ProductDefinition = {
  ...GFS_PRODUCT,
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
async function builtManifest() {
  const setup = await fixture(), out = await root('wd-perf');
  const path = await buildForecast({ out, cycle: CYCLE, product, mask: nativeMask, provider: fixtureProvider().provider, wholeDomain: setup });
  return readV5(path);
}

describe('whole-domain v5 production', () => {
  it('rejects independently valid duplicate cells while allowing a nonduplicate change', async () => {
    const setup = await fixture(), out = await root('wd-duplicate');
    const path = await buildForecast({ out, cycle: CYCLE, product, mask: nativeMask, provider: fixtureProvider().provider, wholeDomain: setup });
    const manifest = await readV5(path), native = surface(manifest, 'native');
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
        const result = validateBuild(out, changed, nativeMask, undefined, product);
        if (duplicate) await expect(result).rejects.toThrow('Duplicate sample cell differs');
        else await expect(result).resolves.toBeDefined();
      }
      const bytes = Buffer.from(original), a = first.byteOffset + 16 * stride, b = last.byteOffset;
      for (const offset of [a, b]) { bytes.writeUInt32LE(0x7fc00000, offset); bytes[offset + 4] = STATUS_UNAVAILABLE; }
      const changed = structuredClone(manifest);
      await writeFile(shardPath, bytes);
      surface(changed, 'native').samples.shards[0].sha256 = sha256(bytes);
      await expect(validateBuild(out, changed, nativeMask, undefined, product)).resolves.toBeDefined();
      bytes.writeUInt32LE(0x7fc00001, a);
      await writeFile(shardPath, bytes);
      surface(changed, 'native').samples.shards[0].sha256 = sha256(bytes);
      await expect(validateBuild(out, changed, nativeMask, undefined, product)).rejects.toThrow('Duplicate sample cell differs');
      bytes.writeUInt32LE(0x7fc00000, a);
      bytes[a + 4] = 0;
      bytes.writeFloatLE(1, a); bytes.writeFloatLE(1, b);
      await writeFile(shardPath, bytes);
      surface(changed, 'native').samples.shards[0].sha256 = sha256(bytes);
      await expect(validateBuild(out, changed, nativeMask, undefined, product)).rejects.toThrow('Duplicate sample cell differs');
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
      await expect(validateBuild(out, changed, nativeMask, undefined, product)).rejects.toThrow('Duplicate sample cell differs');
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
    await expect(validateBuild(out, manifest, mask, undefined, configured)).rejects.toThrow('Duplicate sample cell differs');
  }, 60_000);

  it('binds bundled fine coverage to product policy before loading sparse assets', async () => {
    const plan = wholeDomainPlan(GFS_PRODUCT);
    if (!plan) throw new Error('Missing GFS whole-domain plan');
    const fine = await loadBundledFineCoverage(GFS_PRODUCT, plan);
    expect(fine.descriptor.id).toBe(GFS_PRODUCT.coverageId);
    expect(fine.descriptor.bounds).toEqual(GFS_PRODUCT.bounds);
    expect(fine.descriptor.maxZoom).toBe(GFS_PRODUCT.maxNativeZoom);
    vi.mocked(readLocalFile).mockClear();
    for (const changed of [
      { ...GFS_PRODUCT, coverageId: 'wrong-policy' },
      { ...GFS_PRODUCT, bounds: [-179, -50, 180, 65] as const },
      { ...GFS_PRODUCT, maxNativeZoom: GFS_PRODUCT.maxNativeZoom - 1 }
    ]) await expect(loadBundledFineCoverage(changed, plan)).rejects.toThrow('Fine coverage does not match');
    expect(vi.mocked(readLocalFile).mock.calls).toHaveLength(3);
    expect(vi.mocked(readLocalFile).mock.calls.every(([path]) => path.endsWith('/manifest.json'))).toBe(true);
  }, 60_000);

  it('publishes a sealed build and refuses rollback to corrupted dependencies', async () => {
    const setup = await fixture(), out = await root('wd-publication'), store = new PublicationStore();
    const publishedProduct = { ...product, modelId: 'gfs', frameHours: [12, 24] };
    const cycle = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
    const authority = workflowAuthority({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: 'a'.repeat(40), GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/forecast.yml@refs/heads/main', GITHUB_RUN_ID: '123', TARGET_ENV: 'staging', MODEL: 'gfs' });
    let published = false, sealed: ValidatedBuild | undefined;
    const path = await buildForecast({ out, cycle, product: publishedProduct, mask: nativeMask, provider: fixtureProvider().provider, wholeDomain: setup,
      onValidated: async result => { sealed = result; await publish(store, out, result.manifest, { authority, validated: result }); published = true; } });
    expect(published).toBe(true);
    if (!sealed) throw new Error('Missing validation result');
    const proof = sealed;
    expect(() => assertValidatedBuild(out, proof.manifest, { ...proof })).toThrow('missing or changed');
    const manifest = await readV5(path), pointerKey = 'catalog/gfs/latest.json', pointer = store.objects.get(pointerKey)!.bytes.slice();
    await verifySampleServing(store, manifest, publishedProduct);
    await rollback(store, 'gfs', manifest.buildId, authority);
    const fine = surface(manifest, 'fine'), terrain = fine.terrain!;
    const terrainManifest = JSON.parse(Buffer.from(store.objects.get(terrain.key)!.bytes).toString()) as { files: { elevationM: Array<{ key: string }> } };
    const keys = [fine.coverage.maskKey, fine.coverage.maskKey.replace('manifest.json', 'sparse.bin'), fine.coverage.maskKey.replace('manifest.json', 'tiles.bin'), terrain.key, terrainManifest.files.elevationM[0].key, fine.samples.shards[0].key, manifest.artifacts[0].tilesKey];
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
    for (const field of ['source', 'method', 'clearance'] as const) {
      const changed = structuredClone(manifest);
      if (field === 'source') changed.source.terrain = { dataId: 'f'.repeat(64) };
      else if (field === 'method') changed.tool.terrainMethod = 'wrong';
      else changed.tool.terrainClearance = 'wrong';
      store.objects.set(remoteManifestKey, { ...remoteManifest, bytes: Buffer.from(JSON.stringify(changed)) });
      await expect(rollback(store, 'gfs', manifest.buildId, authority)).rejects.toThrow('Terrain source or method mismatch');
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
        await expect(validateBuild(out, changed, nativeMask, undefined, publishedProduct)).rejects.toThrow();
      }
      await writeFile(terrainPath, terrainBytes);
      for (const field of ['dataId', 'verticalDatum', 'surface', 'sha256', 'key'] as const) {
        const changed = structuredClone(manifest), changedTerrain = surface(changed, 'fine').terrain!;
        changedTerrain[field] = field === 'key' ? `terrain/prepared/${'f'.repeat(64)}/manifest.json` : field === 'dataId' || field === 'sha256' ? 'f'.repeat(64) : 'wrong';
        await expect(validateBuild(out, changed, nativeMask, undefined, publishedProduct)).rejects.toThrow();
      }
      for (const field of ['terrainMethod', 'terrainClearance'] as const) {
        const changed = structuredClone(manifest);
        changed.tool[field] = 'wrong';
        await expect(validateBuild(out, changed, nativeMask, undefined, publishedProduct)).rejects.toThrow('Terrain source or method mismatch');
      }
      const changed = structuredClone(manifest);
      changed.source.terrain = { dataId: 'f'.repeat(64), key: terrain.key, sha256: terrain.sha256, arrayBytes: 1 };
      await expect(validateBuild(out, changed, nativeMask, undefined, publishedProduct)).rejects.toThrow('Terrain source or method mismatch');
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
    expect(serial.method.id).toBe(`${TERRAIN_COLUMN_METHOD.id}+${PRECIPITATION_METHOD.id}`);
    expect(serial.tool).toMatchObject({ terrainMethod: TERRAIN_COLUMN_METHOD.id, terrainClearance: TERRAIN_CLEARANCE_METHOD.id });
    expect(serial.descriptors.layers['usable-lift-msl']).toMatchObject({ methodId: TERRAIN_COLUMN_METHOD.id, verticalReference: 'MSL' });
    expect(serial.descriptors.layers['usable-lift-agl']).toMatchObject({ methodId: TERRAIN_COLUMN_METHOD.id, verticalReference: 'terrain-AGL', label: 'Usable lift depth (terrain AGL)' });
    expect(serial.descriptors.layers['precip-rate']).toMatchObject({ methodId: PRECIPITATION_METHOD.id, verticalReference: 'surface' });
    expect(serial.descriptors.methods[LIFT_METHOD.id]).toBeUndefined();
    const wrongMethod = structuredClone(serial);
    wrongMethod.descriptors = createProductDescriptors(product);
    wrongMethod.method.id = createProductMethodId(product);
    await expect(validateBuild(serialRoot, wrongMethod, nativeMask, undefined, configured)).rejects.toThrow('Unsupported model, grid or layers');
    const wrongGround = structuredClone(serial);
    wrongGround.descriptors.layers['usable-lift-agl'].verticalReference = 'model-AGL';
    await expect(validateBuild(serialRoot, wrongGround, nativeMask, undefined, configured)).rejects.toThrow('Unsupported model, grid or layers');
    const wrongClearance = structuredClone(serial);
    wrongClearance.tool.terrainClearance = TERRAIN_COLUMN_METHOD.id;
    await expect(validateBuild(serialRoot, wrongClearance, nativeMask, undefined, configured)).rejects.toThrow('Terrain source or method mismatch');
    expect(surface(serial, 'native').layers).toEqual(['precip-rate']);
    expect(surface(serial, 'fine').layers).toEqual(['usable-lift-msl', 'usable-lift-agl']);
    expect(surface(serial, 'fine').terrain).toMatchObject({ coverageHash: surface(serial, 'fine').coverage.hash, layoutVersion: 1 });
    expect(serial.metrics.capacity).toMatchObject({ rasterWorkers: 0 });
    expect((serial.metrics.capacity as { estimatedPeakBytes: number }).estimatedPeakBytes).toBeLessThan(2 * 1024 ** 3);
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
    expect(source.observed.cycles).toHaveLength(3);
    expect(source.observed.sessions).toBe(0);
    expect(source.observed.peakSessions).toBe(1);
    expect(parallel.frames.map(frame => frame.id)).toEqual(serial.frames.map(frame => frame.id));
    expect(parallel.artifacts.map(artifact => [artifact.layer, artifact.frame])).toEqual(serial.artifacts.map(artifact => [artifact.layer, artifact.frame]));
    for (const id of ['native', 'fine'] as const) {
      const a = await surfaceBytes(serialRoot, serial, id), b = await surfaceBytes(parallelRoot, parallel, id);
      const bytes = a[0]!;
      const layers = surface(serial, id).layers.length, channels = surface(serial, id).samples.channelCount;
      expect(b).toHaveLength(plan.groups.length);
      for (let cell = 0; cell < surface(serial, id).samples.storedCells; cell++) {
        let frame = 0;
        for (let group = 0; group < b.length; group++) {
          const groupChannels = plan.groups[group].length * layers;
          expect(b[group].subarray(cell * groupChannels * 5, (cell + 1) * groupChannels * 5))
            .toEqual(bytes.subarray((cell * channels + frame * layers) * 5, (cell * channels + frame * layers + groupChannels) * 5));
          frame += plan.groups[group].length;
        }
      }
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

  it.each([true, false])('finalizes frame groups and serves samples with receipt-only mode %s', async receiptsOnly => {
    const setup = await fixture(), out = await root('wd-remote'), store = new PublicationStore(), source = fixtureProvider();
    const configured = { ...product, modelId: 'gfs', frameHours: [12, 24] };
    const cycle = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
    const plan = await createBuildPlan({ out, cycle, product: configured, mask: nativeMask, provider: source.provider, wholeDomain: setup, shards: 2, store });
    expect(plan.dependencies?.length).toBeGreaterThan(6);
    for (let shard = 0; shard < plan.groups.length; shard++) {
      await buildShard({ plan, shard, out, product: configured, mask: nativeMask, provider: source.provider, store });
      const receipt = JSON.parse(await readFile(join(out, 'shards', String(shard), 'receipt.json'), 'utf8')) as { objects: Array<{ key: string }> };
      expect(receipt.objects.length).toBeGreaterThan(0);
      if (receiptsOnly) for (const object of receipt.objects) await rm(join(out, object.key));
    }
    if (receiptsOnly) await rm(join(out, 'terrain'), { recursive: true, force: true });
    const path = await finalizeBuild({ plan, out, product: configured, mask: nativeMask, provider: source.provider, store: receiptsOnly ? store : undefined });
    const manifest = await readV5(path);
    expect(manifest.surfaces.every(surface => surface.samples.format === 'frame-group-block-shards-v1')).toBe(true);
    const manifestBytes = await readFile(path);
    store.objects.set(`builds/${manifest.model}/${manifest.buildId}/manifest.json`, { bytes: manifestBytes, etag: 'manifest' });
    await verifySampleServing(store, manifest, configured);
    const inputs = { product: configured, mask: nativeMask, provider: source.provider };
    const getObject = store.get.bind(store);
    const get = vi.spyOn(store, 'get').mockImplementation(async (key, range) => {
      if (key.startsWith('builds/')) throw new Error(`Receipt verification read forecast payload ${key}`);
      return getObject(key, range);
    });
    try { await expect(verifyBuildReceipts(out, manifest, store, undefined, inputs)).resolves.not.toHaveLength(0); }
    finally { get.mockRestore(); }
    const forged = structuredClone(manifest);
    forged.artifacts[0].tilesSha256 = '0'.repeat(64);
    await expect(verifyBuildReceipts(out, forged, store, undefined, inputs)).rejects.toThrow('Manifest forecast receipt mismatch');
    const shard = manifest.surfaces[0].samples.shards[0], object = store.objects.get(shard.key)!;
    object.metadata = {};
    await expect(verifyBuildReceipts(out, manifest, store, undefined, inputs)).rejects.toThrow('Remote object receipt mismatch');
    await expect(validateBuild(out, manifest, nativeMask, undefined, configured, {
      store, objects: (await Promise.all(plan.groups.map(async (_, index) => JSON.parse(await readFile(join(out, 'shards', String(index), 'receipt.json'), 'utf8'))))).flatMap(receipt => receipt.objects)
    })).rejects.toThrow('Remote object receipt mismatch');
  }, 60_000);


  it('uses actual per-shard bytes for v5 performance admission and reports aggregate bytes separately', async () => {
    const manifest = await builtManifest(), shard = 60 * 1024 * 1024, stored = shard / 5;
    const aggregate = sizedManifest(manifest, Array.from({ length: 5 }, () => ({ bytes: shard, storedCells: stored })));
    const passed = checkPerformance(aggregate);
    expect(passed.passed).toBe(true);
    expect(passed.observed).toMatchObject({ samplePackBytes: shard, gridCells: product.grid.width * product.grid.height });
    expect(passed.observed.emittedSampleBytes).toBeGreaterThan(256 * 1024 * 1024);
    expect(passed.budgets.samplePackBytes).toBe(64 * 1024 * 1024);
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
    invalid.metrics.peakRssBytes = 3 * 1024 ** 3;
    invalid.metrics.tiles = [];
    const result = checkPerformance(invalid);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining(['missing or invalid elapsedMs', 'peakRssBytes: 3221225472 exceeds 2147483648', 'missing or invalid tile counts']));
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

  it('builds with private donor support and keeps donor-only cells outside native samples', async () => {
    const setup = await fixture(), out = await root('wd-donor-build'), source = fixtureProvider();
    const mask: CoverageMask = { ...nativeMask, output: new Uint8Array(nativeMask.output.length), halo: new Uint8Array(nativeMask.halo.length) };
    setBit(mask.output, 0);
    for (const i of [1, 17, 18, 19, 35]) setBit(mask.halo, i);
    const before = { output: mask.output.slice(), halo: mask.halo.slice() };
    const manifest = await readV5(await buildForecast({ out, cycle: CYCLE, product, mask, provider: source.provider, wholeDomain: setup }));
    expect(mask.output).toEqual(before.output); expect(mask.halo).toEqual(before.halo);
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
      { ...prepared.fine.descriptor, bounds: [-179, 70, 180, 72] },
      { ...prepared.fine.descriptor, maxZoom: product.maxNativeZoom + 1 }
    ];
    for (const descriptor of descriptors) {
      const bytes = Buffer.from(JSON.stringify(descriptor)), hash = createHash('sha256').update(bytes).digest('hex');
      const fine = { ...prepared.fine, descriptor, bytes, hash, mask: { ...prepared.fine.mask, maxZoom: descriptor.maxZoom } };
      await stageFineCoverage(out, fine);
      const frozen = frozenWholeDomain({ ...prepared, fine });
      await expect(loadFrozenWholeDomain({ product, frozen, out, maxLevels: source.provider.maxLevels })).rejects.toThrow('Frozen fine coverage differs from its plan');
    }
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
    const input = { product, plan, nativeBlocks: native.coverage.blockIds, nativeActive: active.length, fine,
      nativeMaskBytes: nativeMask.output.byteLength + nativeMask.halo.byteLength + nativeMask.tiles.byteLength,
      frames: product.frameHours.length, nativeLayers: 1, fineLayers: 2, columns, terrainBytes: active.length * 5, maxLevels: 3, retainedGeometryFields: 0 };
    const admitted = admitWholeDomain(input);
    expect(admitted.violations).toEqual([]);
    expect(admitted.estimatedPeakBytes).toBe(Object.values(admitted.workingSet).reduce((sum, value) => sum + value, 0));
    expect(admitted.fineStoredCells).toBeGreaterThan(0);
    expect(admitted.workingSet.nativeFields).toBe(cells * product.layers.length * 5);
    expect(admitted.workingSet.diagnostics).toBe(cells * 9);
    const sparseAdmission = admitWholeDomain({ ...input, nativeActive: 1 });
    expect(sparseAdmission.workingSet.nativeFields).toBe(admitted.workingSet.nativeFields);
    expect(sparseAdmission.workingSet.diagnostics).toBe(admitted.workingSet.diagnostics);
    expect(sparseAdmission.workingSet.nativeFrame).toBeLessThan(admitted.workingSet.nativeFrame);
    const rejected = admitWholeDomain({ ...input, terrainBytes: 3 * 1024 ** 3 });
    expect(rejected.violations).toContain('whole-domain working set exceeds the 2 GiB process budget');
  });
});
