import { INDEXED_PRODUCT } from '../../../tests/model-fixtures.js';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalGridJson, manifestV5Schema, planWholeDomainGrid, setBit, sparseCoverageFromDense, type CoverageMask, type ProvenanceFrameReference, type ProductDefinition, type RegularLatLonGrid, type SparseCoverageMask } from '@av/contracts';
import { buildForecast } from './build.js';
import { BUILD_BUDGETS } from './capacity.js';
import { describeSparseCoverage } from './coverage.js';
import { buildShard, createBuildPlan, finalizeBuild, type BuildPlan } from './parallel.js';
import { assertValidatedBuild, sha256 } from './validate.js';
import { seedTerrainCatalog, TerrainTestStorage } from './terrain/test-fixtures.js';
import { CYCLE, cleanupTemporaryRoots, fixtureProvider, temporaryRoot } from '../parallel-fixtures.js';

const metricsHooks = vi.hoisted(() => ({ afterPrepare: undefined as (() => void) | undefined, afterMerge: undefined as (() => void) | undefined, afterValidate: undefined as (() => void) | undefined, afterShardValidate: undefined as (() => void) | undefined }));
vi.mock('./whole-domain/prepare.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./whole-domain/prepare.js')>();
  return { ...actual, loadWholeDomainTerrain: async (...args: Parameters<typeof actual.loadWholeDomainTerrain>) => {
    const result = await actual.loadWholeDomainTerrain(...args); metricsHooks.afterMerge?.(); return result;
  }, prepareWholeDomain: async (...args: Parameters<typeof actual.prepareWholeDomain>) => {
    const result = await actual.prepareWholeDomain(...args); metricsHooks.afterPrepare?.(); return result;
  } };
});
vi.mock('./sample-pack-v5.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./sample-pack-v5.js')>();
  return { ...actual, mergeShardedSamplePacks: async (...args: Parameters<typeof actual.mergeShardedSamplePacks>) => {
    const result = await actual.mergeShardedSamplePacks(...args); metricsHooks.afterMerge?.(); return result;
  } };
});
vi.mock('./validate.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./validate.js')>();
  return { ...actual, validateSampleGroup: async (...args: Parameters<typeof actual.validateSampleGroup>) => {
    const result = await actual.validateSampleGroup(...args); metricsHooks.afterShardValidate?.(); return result;
  }, validateBuild: async (...args: Parameters<typeof actual.validateBuild>) => {
    const result = await actual.validateBuild(...args); metricsHooks.afterValidate?.(); return result;
  } };
});
vi.mock('./raster-pool.js', async importOriginal => ({
  ...await importOriginal<typeof import('./raster-pool.js')>(),
  rasterWorkerCount: () => 0
}));
const terrainReader = vi.hoisted(() => ({
  opened: 0, close() {},
  async sample(lat: number, lon: number) { return { elevationM: lon < 0.2 ? -1100 : 200 + lat + 50 * lon, source: 'dem' as const }; },
  stats: () => ({ requests: 1, bytesRead: 100, decodedPixels: 4, outputPixels: 100, cacheHits: 0 })
}));
vi.mock('./terrain/reader.js', async importOriginal => ({
  ...await importOriginal<typeof import('./terrain/reader.js')>(),
  createTerrainReader: async (options: { catalog: { tiles: readonly { id: string }[] } }) => {
    terrainReader.opened++;
    const block = options.catalog.tiles[0] ? `${options.catalog.tiles[0].id}/0/0` : '';
    return { ...terrainReader, sourceBlocks: () => block,
      sampleBatch: async (points: readonly { latitude: number; longitude: number }[]) =>
        points.map(({ latitude, longitude }) => ({ elevationM: longitude < 0.2 ? -1100 : 200 + latitude + 50 * longitude, source: 'dem' as const })) };
  }
}));
vi.mock('./terrain/source.js', async importOriginal => ({
  ...await importOriginal<typeof import('./terrain/source.js')>(),
  verifyTerrainCatalogInventory: async () => {}
}));

afterEach(async () => {
  metricsHooks.afterPrepare = undefined; metricsHooks.afterMerge = undefined; metricsHooks.afterValidate = undefined;
  metricsHooks.afterShardValidate = undefined;
  vi.unstubAllEnvs();
  await cleanupTemporaryRoots();
});

describe('whole-domain parallel receipt integrity', () => {
  const wholeProduct: ProductDefinition = {
    ...INDEXED_PRODUCT,
    modelId: 'whole-domain-receipt-fixture', id: 'whole-domain-receipt-recipe',
    source: { modelFamily: 'fixture-model', configurationId: 'whole-domain-receipt-provider', domainId: 'synthetic' },
    label: 'Whole-domain receipt fixture', attribution: 'Synthetic test data',
    coverageDescription: 'Synthetic wrapping grid at a fine subdivision', coverageId: 'whole-domain-receipt-coverage',
    bounds: [-180, 70, 180, 72], grid: { kind: 'regular-latlon', width: 18, height: 3, earthRadiusM: 6371229, lon0: -180, lat0: 72, dx: 20, dy: -1, wrapLongitude: true },
    maxNativeZoom: 0, frameHours: [2, 4], intervalHours: 2, terrainSubdivisionFactor: 2,
    layers: ['usable-lift-msl', 'usable-lift-agl', 'precip-rate']
  };
  const wholeCells = wholeProduct.grid.width * wholeProduct.grid.height;
  const wholeMask: CoverageMask = {
    grid: wholeProduct.grid, bounds: wholeProduct.bounds, maxZoom: 0,
    output: new Uint8Array(Math.ceil(wholeCells / 8)), halo: new Uint8Array(Math.ceil(wholeCells / 8)), tiles: Uint8Array.of(1)
  };
  for (let index = 0; index < wholeCells - 1; index++) setBit(wholeMask.output, index);
  setBit(wholeMask.halo, wholeCells - 1);
  function fineCoverage(): SparseCoverageMask {
    const plan = planWholeDomainGrid(wholeProduct.grid as RegularLatLonGrid, 2), count = plan.fine.width * plan.fine.height;
    const output = new Uint8Array(Math.ceil(count / 8));
    for (let index = 0; index < count; index++) setBit(output, index);
    return { grid: plan.fine, bounds: wholeProduct.bounds, maxZoom: 0, tiles: Uint8Array.of(1),
      coverage: sparseCoverageFromDense({ width: plan.fine.width, height: plan.fine.height, wrapLongitude: plan.fine.wrapLongitude,
        gridHash: createHash('sha256').update(canonicalGridJson(plan.fine)).digest('hex'), output, halo: new Uint8Array(output.length) }) };
  }
  type WholeReceipt = {
    planHash: string; shard: number;
    artifacts: { layer: string; frame: string; tilesKey: string; tilesSha256: string }[];
    provenance: ProvenanceFrameReference[];
    surfaces: { id: 'native' | 'fine'; channelCount: number; shards: { firstBlock: number; blockCount: number; storedCells: number; bytes: number; key: string; sha256: string }[] }[];
    metrics: { frames: Record<string, unknown> };
  };
  let fixtureRoot: string, receiptRoot: string, plan: BuildPlan, source: ReturnType<typeof fixtureProvider>;
  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'av-wd-receipt-'));
    receiptRoot = join(fixtureRoot, 'parallel');
    source = fixtureProvider();
    const storage = new TerrainTestStorage(), catalogRef = seedTerrainCatalog(storage), fine = fineCoverage();
    const description = describeSparseCoverage(fine, wholeProduct);
    const wholeDomain = { storage, catalogRef, fine: { mask: fine, descriptor: description.descriptor, bytes: description.bytes, hash: description.hash } };
    plan = await createBuildPlan({ out: receiptRoot, cycle: CYCLE, product: wholeProduct, mask: wholeMask, provider: source.provider, wholeDomain, shards: 2 });
    for (let shard = 0; shard < plan.groups.length; shard++) {
      await buildShard({ plan, shard, out: receiptRoot, product: wholeProduct, mask: wholeMask, provider: source.provider });
    }
  }, 60_000);
  afterAll(async () => { if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

  async function copyCompleted(): Promise<string> {
    const out = await temporaryRoot();
    await cp(receiptRoot, out, { recursive: true });
    return out;
  }
  const manifestPath = (out: string) => join(out, 'builds', wholeProduct.modelId, plan.buildId, 'manifest.json');
  const receiptPath = (out: string, shard: number) => join(out, 'shards', String(shard), 'receipt.json');
  async function mutate(out: string, shard: number, change: (receipt: WholeReceipt) => void) {
    const path = receiptPath(out, shard), receipt = JSON.parse(await readFile(path, 'utf8')) as WholeReceipt;
    change(receipt);
    await writeFile(path, JSON.stringify(receipt));
  }
  const finalize = (out: string, onValidated?: Parameters<typeof finalizeBuild>[0]['onValidated']) =>
    finalizeBuild({ plan, out, product: wholeProduct, mask: wholeMask, provider: source.provider, onValidated });

  it('publishes honest whole-domain receipts', async () => {
    const out = await copyCompleted(), onValidated = vi.fn();
    const now = Date.now.bind(Date), clock = vi.spyOn(Date, 'now');
    let offset = 0;
    clock.mockImplementation(() => now() + offset);
    metricsHooks.afterMerge = () => { offset += 25; };
    metricsHooks.afterValidate = () => { offset += 50; };
    let manifest;
    try { manifest = manifestV5Schema.parse(JSON.parse(await readFile(await finalize(out, onValidated), 'utf8'))); }
    finally { clock.mockRestore(); }
    expect(manifest.version).toBe(5);
    expect(manifest.artifacts).toHaveLength(manifest.frames.length * manifest.layers.length);
    expect(manifest.metrics.phasesMs).toMatchObject({ preparationMs: plan.preparation!.elapsedMs, assemblyMs: expect.any(Number), validateMs: expect.any(Number) });
    const phases = manifest.metrics.phasesMs as { assemblyMs: number; validateMs: number };
    expect(phases.assemblyMs).toBeGreaterThanOrEqual(25);
    expect(phases.validateMs).toBeGreaterThanOrEqual(50);
    expect(manifest.metrics.peakRssBytes).toBeGreaterThanOrEqual(plan.preparation!.peakRssBytes);
    expect(onValidated).toHaveBeenCalledOnce();
    expect(() => assertValidatedBuild(out, manifest, onValidated.mock.calls[0][0])).not.toThrow();
  }, 60_000);

  it.each(['over-budget', 'higher', 'lower'] as const)('gates the post-validation shard RSS peak when it is %s', async kind => {
    const out = await copyCompleted();
    await rm(join(out, 'shards'), { recursive: true }); await rm(join(out, 'builds'), { recursive: true });
    const usage = process.resourceUsage(), core = 1024 ** 3;
    let measured = core;
    const rss = vi.spyOn(process, 'resourceUsage').mockImplementation(() => ({ ...usage, maxRSS: measured / 1024 }));
    const peak = kind === 'over-budget' ? BUILD_BUDGETS.peakRssBytes + 1024 : kind === 'higher' ? core * 1.5 : core / 2;
    metricsHooks.afterShardValidate = () => { measured = peak; };
    try {
      const pending = buildShard({ plan, shard: 0, out, product: wholeProduct, mask: wholeMask, provider: source.provider });
      if (kind === 'over-budget') {
        await expect(pending).rejects.toThrow('peakRssBytes');
        await expect(readFile(receiptPath(out, 0))).rejects.toThrow();
        const failure = JSON.parse(await readFile(join(out, 'shards/0/worker-failure.json'), 'utf8'));
        expect(failure.error.message).toContain('peakRssBytes');
        expect(failure.error.message).toContain(String(peak));
      } else {
        const receipt = JSON.parse(await readFile(await pending, 'utf8'));
        expect(receipt.metrics.peakRssBytes).toBe(Math.max(core, peak));
      }
      expect(measured).toBe(peak);
    } finally { rss.mockRestore(); }
  }, 60_000);

  it.each(['assembly-rss', 'validation-rss', 'validation-elapsed'])('rejects over-budget %s before publication', async kind => {
    const out = await copyCompleted(), onValidated = vi.fn();
    const originalUsage = process.resourceUsage.bind(process), originalNow = Date.now.bind(Date);
    const rss = vi.spyOn(process, 'resourceUsage'), clock = vi.spyOn(Date, 'now');
    rss.mockImplementation(originalUsage); clock.mockImplementation(originalNow);
    const exceedRss = () => rss.mockImplementation(() => ({ ...originalUsage(), maxRSS: BUILD_BUDGETS.peakRssBytes / 1024 + 1 }));
    if (kind === 'assembly-rss') metricsHooks.afterMerge = exceedRss;
    else if (kind === 'validation-rss') metricsHooks.afterValidate = exceedRss;
    else metricsHooks.afterValidate = () => clock.mockImplementation(() => originalNow() + BUILD_BUDGETS.elapsedMs + 1);
    try {
      await expect(finalize(out, onValidated)).rejects.toThrow(/performance budget/);
      expect(onValidated).not.toHaveBeenCalled();
      await expect(readFile(manifestPath(out))).rejects.toThrow();
    } finally { rss.mockRestore(); clock.mockRestore(); }
  }, 60_000);

  it.each(['rss', 'elapsed'])('rejects over-budget planning %s before writing a plan', async kind => {
    const out = await temporaryRoot(), storage = new TerrainTestStorage(), catalogRef = seedTerrainCatalog(storage), fine = fineCoverage();
    const description = describeSparseCoverage(fine, wholeProduct), originalUsage = process.resourceUsage.bind(process), originalNow = Date.now.bind(Date);
    const rss = vi.spyOn(process, 'resourceUsage'), clock = vi.spyOn(Date, 'now');
    rss.mockImplementation(originalUsage); clock.mockImplementation(originalNow);
    metricsHooks.afterPrepare = kind === 'rss'
      ? () => rss.mockImplementation(() => ({ ...originalUsage(), maxRSS: BUILD_BUDGETS.peakRssBytes / 1024 + 1 }))
      : () => clock.mockImplementation(() => originalNow() + BUILD_BUDGETS.elapsedMs + 1);
    try {
      await expect(createBuildPlan({ out, cycle: CYCLE, product: wholeProduct, mask: wholeMask, provider: source.provider,
        wholeDomain: { storage, catalogRef, fine: { mask: fine, descriptor: description.descriptor, bytes: description.bytes, hash: description.hash } }, shards: 2 })).rejects.toThrow();
      await expect(readFile(join(out, 'plan.json'))).rejects.toThrow();
    } finally { rss.mockRestore(); clock.mockRestore(); }
  }, 60_000);

  it.each(['missing', 'rss', 'elapsed'])('rejects invalid frozen planning %s before worker acquisition', async kind => {
    const out = await copyCompleted(), changed = structuredClone(plan), provider = fixtureProvider();
    if (kind === 'missing') Reflect.deleteProperty(changed, 'preparation');
    else if (kind === 'rss') changed.preparation!.peakRssBytes = BUILD_BUDGETS.peakRssBytes + 1;
    else changed.preparation!.elapsedMs = BUILD_BUDGETS.elapsedMs + 1;
    await expect(buildShard({ plan: changed, shard: 0, out, product: wholeProduct, mask: wholeMask, provider: provider.provider })).rejects.toThrow('Invalid forecast plan');
    expect(provider.open).not.toHaveBeenCalled();
  });

  it('includes sequential preparation and validation in sealed metrics', async () => {
    const out = await temporaryRoot(), storage = new TerrainTestStorage(), catalogRef = seedTerrainCatalog(storage), fine = fineCoverage();
    const description = describeSparseCoverage(fine, wholeProduct), onValidated = vi.fn();
    const originalNow = Date.now.bind(Date), clock = vi.spyOn(Date, 'now');
    let offset = 0;
    clock.mockImplementation(() => originalNow() + offset);
    metricsHooks.afterPrepare = () => { offset += 25; };
    metricsHooks.afterValidate = () => { offset += 50; };
    try {
      const path = await buildForecast({ out, cycle: CYCLE, product: wholeProduct, mask: wholeMask, provider: fixtureProvider().provider, onValidated,
        wholeDomain: { storage, catalogRef, fine: { mask: fine, descriptor: description.descriptor, bytes: description.bytes, hash: description.hash } } });
      const manifest = manifestV5Schema.parse(JSON.parse(await readFile(path, 'utf8')));
      const phases = manifest.metrics.phasesMs as { preparationMs: number; assemblyMs: number; validateMs: number };
      expect(phases.preparationMs).toBeGreaterThanOrEqual(25);
      expect(phases.assemblyMs).toBeGreaterThanOrEqual(0);
      expect(phases.validateMs).toBeGreaterThanOrEqual(50);
      expect(manifest.metrics.elapsedMs).toBeGreaterThanOrEqual(75);
      expect(() => assertValidatedBuild(out, manifest, onValidated.mock.calls[0][0])).not.toThrow();
    } finally { clock.mockRestore(); }
  }, 60_000);

  it('rejects altered source intervals even when the chunk digest is updated', async () => {
    const out = await copyCompleted(), path = receiptPath(out, 0), receipt = JSON.parse(await readFile(path, 'utf8')) as WholeReceipt;
    const reference = receipt.provenance[0]!, chunkPath = join(out, reference.key), chunk = JSON.parse(await readFile(chunkPath, 'utf8'));
    chunk.intervals.fluxWindow.end = CYCLE;
    const bytes = Buffer.from(JSON.stringify(chunk));
    reference.bytes = bytes.length; reference.sha256 = sha256(bytes);
    await writeFile(chunkPath, bytes); await writeFile(path, JSON.stringify(receipt));
    const onValidated = vi.fn();
    await expect(finalize(out, onValidated)).rejects.toThrow(/Provenance frame/);
    expect(onValidated).not.toHaveBeenCalled();
  });

  const tampering: [string, (receipt: WholeReceipt) => void, RegExp][] = [
    ['provenance-missing', receipt => { receipt.provenance.pop(); }, /provenance/],
    ['provenance-duplicate', receipt => { receipt.provenance.push(structuredClone(receipt.provenance[0]!)); }, /provenance/],
    ['provenance-hour', receipt => { receipt.provenance[0]!.hour += 1; }, /provenance/],
    ['provenance-key', receipt => { receipt.provenance[0]!.key = 'builds/other/provenance/f002.json'; }, /provenance/],
    ['artifact-missing', receipt => { receipt.artifacts.pop(); }, /artifact count/],
    ['artifact-duplicate', receipt => { receipt.artifacts.push(structuredClone(receipt.artifacts[0]!)); }, /artifact count/],
    ['artifact-order', receipt => { receipt.artifacts.reverse(); }, /artifact record/],
    ['artifact-key', receipt => { receipt.artifacts[0]!.tilesKey = 'builds/tampered/tampered/x.pmtiles'; }, /artifact record/],
    ['artifact-layer', receipt => { receipt.artifacts[0]!.layer = receipt.artifacts[1]!.layer; }, /artifact record/],
    ['artifact-frame', receipt => { receipt.artifacts[0]!.frame = 'f999'; }, /artifact record/],
    ['metric-frames', receipt => { receipt.metrics.frames = { f999: {} }; }, /metric frames/],
    ['surface-missing', receipt => { receipt.surfaces.pop(); }, /surface set/],
    ['surface-duplicate', receipt => { receipt.surfaces = [receipt.surfaces[0]!, structuredClone(receipt.surfaces[0]!)]; }, /surface set/],
    ['surface-order', receipt => { receipt.surfaces.reverse(); }, /surface set/],
    ['surface-channel-count', receipt => { receipt.surfaces[0]!.channelCount += 1; }, /channel count/],
    ['surface-key', receipt => { receipt.surfaces[0]!.shards[0]!.key = 'builds/tampered/tampered/samples/0.bin'; }, /surface key/],
    ['surface-block-range', receipt => { receipt.surfaces[0]!.shards[0]!.blockCount += 1; }, /block/],
    ['surface-stored-cells', receipt => { receipt.surfaces[0]!.shards[0]!.storedCells += 1; }, /block|size/]
  ];
  it.each(tampering)('rejects tampered %s receipts before publishing', async (_name, change, error) => {
    const out = await copyCompleted(), onValidated = vi.fn();
    await mutate(out, 0, change);
    await expect(finalize(out, onValidated)).rejects.toThrow(error);
    expect(onValidated).not.toHaveBeenCalled();
    await expect(readFile(manifestPath(out))).rejects.toThrow();
  });
});
