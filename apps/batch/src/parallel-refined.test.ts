import { INDEXED_PRODUCT } from '../../../tests/model-fixtures.js';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TERRAIN_CLEARANCE_METHOD, canonicalGridJson, manifestV5Schema, planWholeDomainGrid, setBit, sparseCoverageFromDense, type CoverageMask, type Manifest, type ProductDefinition, type RegularLatLonGrid, type SparseCoverageMask } from '@av/contracts';
import { buildForecast } from './build.js';
import { BUILD_BUDGETS } from './capacity.js';
import { describeSparseCoverage } from './coverage.js';
import { buildShard, createBuildPlan, finalizeBuild, type BuildPlan } from './parallel.js';
import { assertValidatedBuild, localPath } from './validate.js';
import * as refinementConfig from './refinement/config.js';
import { seedTerrainCatalog, TerrainTestStorage } from './terrain/test-fixtures.js';
import { CYCLE, cleanupTemporaryRoots, fixtureProvider, mask, product, readManifest, temporaryRoot, tilePixels } from '../parallel-fixtures.js';

const fallback = vi.hoisted(() => ({ legacy: false, compared: 0, filled: 0, mappingBytes: [] as number[] }));
const metricsHooks = vi.hoisted(() => ({ afterPrepare: undefined as (() => void) | undefined, afterMerge: undefined as (() => void) | undefined, afterValidate: undefined as (() => void) | undefined }));
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
  return { ...actual, validateBuild: async (...args: Parameters<typeof actual.validateBuild>) => {
    const result = await actual.validateBuild(...args); metricsHooks.afterValidate?.(); return result;
  } };
});
vi.mock('@av/forecast/refinement', async importOriginal => {
  const actual = await importOriginal<typeof import('@av/forecast/refinement')>();
  return { ...actual, prepareTerrainColumns: (...args: Parameters<typeof actual.prepareTerrainColumns>) => {
    const columns = actual.prepareTerrainColumns(...args);
    if (!fallback.legacy) fallback.mappingBytes.push(columns.byteLength + columns.workspaceBytes);
    const dense = fallback.legacy ? actual.prepareTerrainClearance(args[0], args[1]) : undefined;
    return { ...columns, derive: (...deriveArgs: Parameters<typeof columns.derive>) => {
      const [frame, terrain, time, options] = deriveArgs;
      if (!dense) {
        const result = columns.derive(...deriveArgs);
        fallback.compared++;
        fallback.filled += result.metrics.filledBelowGroundBridgeExceeded ?? 0;
        return result;
      }
      const native = options?.nativeClearance;
      if (!native) throw new Error('Missing native clearance inputs');
      const fields = dense.derive(native.diagnostics, native.flags, terrain, time, options.daylightOnly);
      return columns.derive(frame, terrain, time, { ...options, nativeClearance: undefined, clearance: {
        methodId: TERRAIN_CLEARANCE_METHOD.id, validTime: native.validTime, grid: args[1].grid, fields
      } });
    } };
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
  vi.unstubAllEnvs();
  await cleanupTemporaryRoots();
});

describe('refined hour-group builds', () => {
  let fixtureRoot: string, serialRoot: string, shardRoot: string, legacyRoot: string, ungatedRoot: string, legacyUngatedRoot: string;
  let plan: BuildPlan, serial: Manifest, legacy: Manifest, ungated: Manifest, legacyUngated: Manifest;
  let serialMappingBytes: number;
  let restoreConfig: () => void;
  const source = fixtureProvider();
  const zones = { type: 'FeatureCollection', features: [
    { type: 'Feature', id: 'east', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0.3, 71.2], [0.34, 71.2], [0.34, 71.24], [0.3, 71.24], [0.3, 71.2]]] } },
    { type: 'Feature', id: 'west', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0.1, 71.1], [0.14, 71.1], [0.14, 71.14], [0.1, 71.14], [0.1, 71.1]]] } }
  ] };

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'av-refined-parallel-'));
    serialRoot = join(fixtureRoot, 'serial'); shardRoot = join(fixtureRoot, 'parallel'); legacyRoot = join(fixtureRoot, 'legacy');
    ungatedRoot = join(fixtureRoot, 'ungated'); legacyUngatedRoot = join(fixtureRoot, 'legacy-ungated');
    const configured = refinementConfig.configuredRefinements;
    const resolveConfig = vi.spyOn(refinementConfig, 'configuredRefinements').mockImplementation(product => configured(product, zones));
    restoreConfig = () => resolveConfig.mockRestore();
    const storage = new TerrainTestStorage(), refinement = { storage, catalogRef: seedTerrainCatalog(storage) };
    fallback.legacy = true;
    legacy = await readManifest(await buildForecast({ out: legacyRoot, cycle: CYCLE, product, mask, provider: fixtureProvider().provider, refinement }));
    fallback.legacy = false;
    fallback.mappingBytes = [];
    serial = await readManifest(await buildForecast({ out: serialRoot, cycle: CYCLE, product, mask, provider: source.provider, refinement }));
    serialMappingBytes = fallback.mappingBytes.reduce((sum, value) => sum + value, 0);
    fallback.legacy = true;
    legacyUngated = await readManifest(await buildForecast({ out: legacyUngatedRoot, cycle: CYCLE, product, mask, provider: fixtureProvider().provider, refinement, deriveOptions: { daylightOnly: false } }));
    fallback.legacy = false;
    ungated = await readManifest(await buildForecast({ out: ungatedRoot, cycle: CYCLE, product, mask, provider: fixtureProvider().provider, refinement, deriveOptions: { daylightOnly: false } }));
    plan = await createBuildPlan({ out: shardRoot, cycle: CYCLE, product, mask, provider: source.provider, refinement, shards: 2 });
    expect(source.acquire.mock.calls.map(([hour]) => hour)).toEqual(product.frameHours);
    expect(resolveConfig).toHaveBeenCalledTimes(5);
    expect(plan.refinements?.map(input => input.id)).toEqual(['east', 'west']);
    resolveConfig.mockImplementation(() => { throw new Error('Workers must use the frozen regions'); });
    storage.objects.clear();
    const workerRoots = plan.groups.map((_, shard) => join(fixtureRoot, `worker-${shard}`));
    await Promise.all(workerRoots.map(async (out, shard) => {
      await cp(shardRoot, out, { recursive: true });
      const downloadedPlan = JSON.parse(await readFile(join(out, 'plan.json'), 'utf8')) as BuildPlan;
      await buildShard({ plan: downloadedPlan, shard, out, product, mask, provider: source.provider });
    }));
    for (const out of workerRoots) for (const directory of ['builds', 'shards']) {
      await cp(join(out, directory), join(shardRoot, directory), { recursive: true });
    }
  }, 60_000);
  afterAll(async () => {
    fallback.legacy = false;
    restoreConfig?.();
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  });

  async function copyCompleted(): Promise<string> {
    const out = await temporaryRoot();
    await cp(shardRoot, out, { recursive: true });
    return out;
  }
  const manifestPath = (out: string) => join(out, 'builds', product.modelId, plan.buildId, 'manifest.json');
  const finalize = (out: string, onValidated?: Parameters<typeof finalizeBuild>[0]['onValidated']) =>
    finalizeBuild({ plan, out, product, mask, provider: source.provider, onValidated });

  it('merges byte-identical fine AGL packs without acquiring extra forecast hours or rereading terrain', async () => {
    const out = await copyCompleted(), onValidated = vi.fn();
    const manifest = await readManifest(await finalize(out, onValidated));
    expect(manifest.version).toBe(4);
    expect(manifest.frames).toEqual(serial.frames);
    expect(manifest.patches?.map(patch => patch.id)).toEqual(['east', 'west']);
    expect(await readFile(localPath(out, manifest.samples.key))).toEqual(await readFile(localPath(serialRoot, serial.samples.key)));
    expect(await readFile(localPath(serialRoot, serial.samples.key))).toEqual(await readFile(localPath(legacyRoot, legacy.samples.key)));
    for (const [index, patch] of manifest.patches!.entries()) {
      const expected = serial.patches![index], input = plan.refinements![index];
      expect(patch.layers).toEqual([...TERRAIN_CLEARANCE_METHOD.outputs]);
      expect(patch.samples.channelCount).toBe(product.frameHours.length * TERRAIN_CLEARANCE_METHOD.outputs.length);
      expect(patch.grid).toEqual(input.grid);
      expect(patch.coverage).toEqual(input.coverage);
      expect(patch.terrain).toEqual(expected.terrain);
      expect(patch.terrain).toMatchObject({ key: input.terrain.key, sha256: input.terrain.sha256 });
      expect(patch.descriptors).toEqual(expected.descriptors);
      const bytes = await readFile(localPath(out, patch.samples.key));
      expect(bytes).toEqual(await readFile(localPath(serialRoot, expected.samples.key)));
      expect(bytes).toEqual(await readFile(localPath(legacyRoot, legacy.patches![index].samples.key)));
      expect(Array.from({ length: bytes.length / 5 }, (_, i) => bytes.readFloatLE(i * 5)).some(value => value > 0)).toBe(true);
    }
    for (let index = 0; index < manifest.artifacts.length; index++) {
      expect(await tilePixels(out, manifest.artifacts[index])).toEqual(await tilePixels(serialRoot, serial.artifacts[index]));
      expect(await tilePixels(out, manifest.artifacts[index])).toEqual(await tilePixels(legacyRoot, legacy.artifacts[index]));
    }
    const capacity = serial.metrics.capacity as { refinement: { gridCells: number }; workingSet: { refinementMapping: number; derivedFields: number } };
    expect(capacity.workingSet.refinementMapping).toBe(serialMappingBytes);
    expect(capacity.workingSet.derivedFields).toBe((mask.grid.width * mask.grid.height * product.layers.length + capacity.refinement.gridCells * TERRAIN_CLEARANCE_METHOD.outputs.length) * 5);
    expect(fallback.compared).toBeGreaterThan(0);
    expect(fallback.filled).toBeGreaterThan(0);
    expect([...source.observed.hours].sort((a, b) => a - b)).toEqual([2, 2, 4, 4, 6, 6, 8, 8]);
    expect(terrainReader.opened).toBe(2);
    expect(onValidated).toHaveBeenCalledOnce();
    expect(() => assertValidatedBuild(out, manifest, onValidated.mock.calls[0][0])).not.toThrow();
  }, 60_000);

  it('preserves legacy fallback with daylight gating disabled', async () => {
    expect(await readFile(localPath(ungatedRoot, ungated.samples.key))).toEqual(await readFile(localPath(legacyUngatedRoot, legacyUngated.samples.key)));
    for (const [index, patch] of ungated.patches!.entries()) {
      expect(await readFile(localPath(ungatedRoot, patch.samples.key))).toEqual(await readFile(localPath(legacyUngatedRoot, legacyUngated.patches![index].samples.key)));
    }
    for (const [index, artifact] of ungated.artifacts.entries()) {
      expect(await tilePixels(ungatedRoot, artifact)).toEqual(await tilePixels(legacyUngatedRoot, legacyUngated.artifacts[index]));
    }
  }, 60_000);

  it.each(['omitted', 'missing', 'extra', 'reordered'])('rejects %s refinement receipts before publishing', async kind => {
    const out = await copyCompleted(), path = join(out, 'shards/0/receipt.json'), onValidated = vi.fn();
    const receipt = JSON.parse(await readFile(path, 'utf8'));
    if (kind === 'omitted') delete receipt.refinements;
    else if (kind === 'missing') receipt.refinements.pop();
    else if (kind === 'extra') receipt.refinements.push({ id: 'unexpected', sampleSha256: '0'.repeat(64) });
    else receipt.refinements.reverse();
    await writeFile(path, JSON.stringify(receipt));
    await expect(finalize(out, onValidated)).rejects.toThrow(/refinement set mismatch/);
    expect(onValidated).not.toHaveBeenCalled();
    await expect(readFile(manifestPath(out))).rejects.toThrow();
  });

  it.each(['missing', 'truncated', 'wrong-hash'])('rejects a %s fine shard pack instead of filling or ignoring it', async kind => {
    const out = await copyCompleted(), path = join(out, 'shards/0/refinements/east/samples.bin'), onValidated = vi.fn();
    if (kind === 'missing') await rm(path);
    else {
      const bytes = await readFile(path);
      if (kind === 'wrong-hash') { bytes[0] ^= 1; await writeFile(path, bytes); }
      else await writeFile(path, bytes.subarray(0, bytes.length - 5));
    }
    await expect(finalize(out, onValidated)).rejects.toThrow();
    expect(onValidated).not.toHaveBeenCalled();
    await expect(readFile(manifestPath(out))).rejects.toThrow();
  });

  it.each(['geometry', 'terrain-reference'])('binds frozen %s to the recipe before opening a provider', async kind => {
    const out = await temporaryRoot(), provider = fixtureProvider(), changed = structuredClone(plan);
    if (kind === 'terrain-reference') changed.refinements![0].terrain.sha256 = '0'.repeat(64);
    else changed.refinements![0].bounds[0] += 0.001;
    await expect(buildShard({ plan: changed, shard: 0, out, product, mask, provider: provider.provider })).rejects.toThrow(/recipe or source revision/);
    expect(provider.open).not.toHaveBeenCalled();
    expect(await readdir(out)).toEqual([]);
  });

  it('rejects missing staged terrain before any acquisition', async () => {
    const out = await copyCompleted(), provider = fixtureProvider();
    await rm(join(out, 'shards'), { recursive: true });
    await rm(localPath(out, plan.refinements![0].terrain.key));
    await expect(buildShard({ plan, shard: 0, out, product, mask, provider: provider.provider })).rejects.toThrow();
    expect(provider.open).not.toHaveBeenCalled();
  });
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
    provenance: { hour: number; intervals: { fluxWindow: { end: string } }; receipt: unknown }[];
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
    if (kind === 'missing') delete changed.preparation;
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

  const tampering: [string, (receipt: WholeReceipt) => void, RegExp][] = [
    ['provenance-missing', receipt => { receipt.provenance.pop(); }, /provenance/],
    ['provenance-duplicate', receipt => { receipt.provenance.push(structuredClone(receipt.provenance[0]!)); }, /provenance/],
    ['provenance-hour', receipt => { receipt.provenance[0]!.hour += 1; }, /provenance/],
    ['provenance-intervals', receipt => { receipt.provenance[0]!.intervals.fluxWindow.end = CYCLE; }, /provenance/],
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
