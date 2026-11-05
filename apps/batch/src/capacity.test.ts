import { INDEXED_PRODUCT } from '../../../tests/model-fixtures.js';
import { describe, expect, it } from 'vitest';
import { MAX_NATIVE_ZOOM, MAX_SAMPLE_VALUES, type CoverageMask, type Manifest, type ManifestV5 } from '@av/contracts';
import { BUILD_BUDGETS, checkPerformance, estimateCapacity, normalizedFrameBytes, prepareBuild } from './capacity.js';
import { rasterWorkerCount, RASTER_WORKER_RESERVE_BYTES } from './raster-pool.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBundledFineCoverage, wholeDomainPlan } from './whole-domain/coverage.js';
import { fixtureManifest, fixturePatch } from '../../../tests/forecast-fixture.js';

const TILES_BY_ZOOM = [1, 4];
const TOTAL_TILES = 30;
const SAMPLE_PACK_BYTES = 180;

it('counts auxiliary fields in the shared normalized-frame memory estimate', () => {
  const resources = { maxLevels: 25, auxiliarySurfaceFields: 8, auxiliaryLevelFields: 4 };
  expect(normalizedFrameBytes(100, 'isobaric', resources)).toBe(100 * (7 + 8 + 6 * 25) * 5);
  expect(normalizedFrameBytes(100, 'model-levels', resources)).toBe(100 * (7 + 8 + 7 * 25) * 5);
  const { mask, product } = input();
  const { capacity, indices } = prepareBuild(mask, product, resources);
  expect(capacity.workingSet.normalizedFrame).toBe(normalizedFrameBytes(indices.active.length, product.capabilities.verticalCoordinate, resources));
  expect(() => normalizedFrameBytes(100, 'isobaric', { ...resources, auxiliaryLevelFields: -1 })).toThrow('dimensions');
});

it('admits aggregate scalar and profile bytes independently of the per-shard limit', () => {
  const cells = 64 * 17 * 17, recordBytes = 8 + 14 * 256, shardsPerGroup = 130;
  const sampleShards = Array.from({ length: shardsPerGroup }, () => ({ frameCount: 8, storedCells: cells, bytes: cells * 8 * 5 }));
  const profileShards = Array.from({ length: shardsPerGroup }, () => ({ storedCells: cells, bytes: cells * recordBytes }));
  const manifest = { version: 5, buildId: 'budget', cycle: '2026-11-05T00:00:00Z', artifacts: [{}],
    metrics: { elapsedMs: 1, peakRssBytes: 1, tiles: [1] },
    surfaces: [{ kind: 'native', grid: { width: 5000, height: 500 }, coverage: { maxZoom: 0 }, layers: ['sfc-temp-c'],
      samples: { storedCells: cells * shardsPerGroup, channelCount: 8, shards: sampleShards },
      profiles: { recordBytes, groups: Array.from({ length: 8 }, () => ({ frameCount: 1, shards: profileShards })) } }] } as unknown as ManifestV5;
  const over = checkPerformance(manifest);
  expect(over.observed.numericBytes).toBe(over.observed.emittedSampleBytes + over.observed.profileBytes);
  expect(over.observed.profileBytes).toBeGreaterThan(BUILD_BUDGETS.numericBytes);
  expect(over.failures).toEqual([expect.stringContaining('numericBytes:')]);
  manifest.surfaces[0]!.profiles!.groups.pop();
  expect(checkPerformance(manifest).passed).toBe(true);
});
function input() {
  const grid = { kind: 'regular-latlon' as const, width: 2, height: 2, earthRadiusM: 6371229, lon0: -180, lat0: 1, dx: 180, dy: -1, wrapLongitude: true };
  const product = { ...INDEXED_PRODUCT, grid, maxNativeZoom: 1, frameHours: [1, 2], intervalHours: 1,
    execution: { ...INDEXED_PRODUCT.execution, workers: 1 } };
  const mask: CoverageMask = { grid, maxZoom: 1, output: Uint8Array.of(15), halo: Uint8Array.of(0), tiles: Uint8Array.of(31) };
  return { mask, product };
}

function receipt(): Manifest {
  return {
    buildId: 'fixture',
    cycle: '2026-10-30T00:00:00Z',
    grid: { width: 2, height: 2 },
    coverage: { maxZoom: 1 },
    artifacts: new Array(6).fill({}),
    samples: { bytes: SAMPLE_PACK_BYTES },
    metrics: { elapsedMs: 90_000, peakRssBytes: 1_300_000_000, tiles: [...TILES_BY_ZOOM] }
  } as unknown as Manifest;
}

describe('build capacity admission and performance budgets', () => {
  it('rejects missing fine coverage independently of bundled assets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'capacity-coverage-'));
    try {
      const product = { ...INDEXED_PRODUCT, coverageDir: directory };
      await expect(loadBundledFineCoverage(product, wholeDomainPlan(product)!)).rejects.toThrow('Fine coverage is missing');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('rejects empty public coverage before opening a provider', async () => {
    const { mask, product } = input();
    expect(() => prepareBuild({ ...mask, output: new Uint8Array(mask.output.length), halo: new Uint8Array(mask.halo.length) }, product, { maxLevels: 1 })).toThrow('before acquisition');
  });
  it('counts selected frames and layers before acquisition', () => {
    const { mask, product } = input(), { capacity, layout, indices } = prepareBuild(mask, product, { maxLevels: 1 });
    expect(indices.active.length).toBe(4);
    expect(capacity).toMatchObject({
      tilesByZoom: TILES_BY_ZOOM,
      tiles: TOTAL_TILES,
      quarterSamples: TOTAL_TILES * 256 * 256 * 4,
      samplePackBytes: SAMPLE_PACK_BYTES,
      point: { reads: 1, worstCaseRangeBytes: 570, values: 6 },
      violations: []
    });
    expect(estimateCapacity(mask, product, layout.storedCells, { cadenceHours: 1 })).toMatchObject({ retainedPerModel: 168, violations: [] });
    expect(estimateCapacity(mask, product, layout.storedCells, { cadenceHours: 0.5 }).violations).toContain('retention leaves no room for a replacement build');
    expect(capacity.rasterWorkers).toBe(rasterWorkerCount(undefined, product.execution.workers));
    expect(capacity.workingSet.rasterWorkerRuntimes).toBe(capacity.rasterWorkers * RASTER_WORKER_RESERVE_BYTES);
    expect(capacity.workingSet.rasterSharedInputs).toBe(capacity.rasterWorkers ? mask.grid.width * mask.grid.height * 3 * 5 + mask.output.byteLength + mask.halo.byteLength + mask.tiles.byteLength : 0);
    expect(capacity.estimatedPeakBytes).toBe(Object.values(capacity.workingSet).reduce((total, bytes) => total + bytes, 0));
  });
  it('projects tile growth and rejects untrusted targets and excessive work', () => {
    const { mask, product } = input(), { layout } = prepareBuild(mask, product, { maxLevels: 1 });
    const doubled = estimateCapacity(mask, product, layout.storedCells, { frames: 4, layers: 6, models: 2 });
    expect(doubled.tiles).toBe(TOTAL_TILES * 8);
    expect(doubled.totalSamplePackBytes).toBe(SAMPLE_PACK_BYTES * 8);
    const deeper = estimateCapacity(mask, product, layout.storedCells, { nativeZoom: product.maxNativeZoom + 12 });
    expect(deeper.tiles).toBeGreaterThan(BUILD_BUDGETS.tiles);
    expect(deeper.violations.join()).toContain('configured product target');
    expect(deeper.violations).toContain('tile budget exceeded');
    expect(() => prepareBuild({ ...mask, maxZoom: MAX_NATIVE_ZOOM + 1 }, product, { maxLevels: 1 })).toThrow('zoom');
  });
  it('accounts for per-column model pressures and retained provider geometry', () => {
    const { mask, product: base } = input(), provider = { maxLevels: 3, retainedGeometryFields: 4 };
    const product = { ...base, capabilities: { ...base.capabilities, verticalCoordinate: 'model-levels' as const } };
    const { capacity, indices } = prepareBuild(mask, product, provider);
    const bytesPerField = new Float32Array(indices.active.length).byteLength + new Uint8Array(indices.active.length).byteLength;
    const isobaric = { ...product, capabilities: { ...product.capabilities, verticalCoordinate: 'isobaric' as const } };
    const sharedPressure = prepareBuild(mask, isobaric, provider).capacity;
    expect(capacity.workingSet.normalizedFrame - sharedPressure.workingSet.normalizedFrame).toBe(bytesPerField * provider.maxLevels);
    expect(capacity.workingSet.retainedGeometry).toBe(bytesPerField * (provider.maxLevels + 1));
    expect(capacity.estimatedPeakBytes).toBeLessThan(BUILD_BUDGETS.peakRssBytes);
    for (const retainedGeometryFields of [-1, 0.5, NaN, 258]) {
      expect(() => prepareBuild(mask, product, { ...provider, retainedGeometryFields })).toThrow('retained geometry budget');
    }
  });
  it('reserves prepared terrain validation and resident arrays only when requested', async () => {
    const { mask, product } = input(), provider = { maxLevels: 1 };
    const baseline = prepareBuild(mask, product, provider).capacity;
    const staged = prepareBuild(mask, product, { ...provider, terrainBytes: 5120 }).capacity;
    expect(baseline.workingSet.preparedTerrain).toBe(0);
    expect(staged.estimatedPeakBytes - baseline.estimatedPeakBytes).toBe(10240);
    for (const terrainBytes of [-1, 0.5, NaN, 20_000_001]) {
      expect(() => prepareBuild(mask, product, { ...provider, terrainBytes })).toThrow('prepared terrain byte budget');
    }
  });
  it('rejects invalid scenarios and oversized point products', async () => {
    const { mask, product } = input(), { layout } = prepareBuild(mask, product, { maxLevels: 1 });
    for (const frames of [0, -1, 1.5, NaN, Infinity]) expect(() => estimateCapacity(mask, product, layout.storedCells, { frames })).toThrow('Invalid capacity');
    expect(estimateCapacity(mask, product, layout.storedCells, { layers: MAX_SAMPLE_VALUES }).violations.join()).toContain('result budget');
  });
  it.each([2_413_241, 2_427_607])('admits the measured hourly build duration %i ms', elapsedMs => {
    const manifest = receipt();
    manifest.metrics.elapsedMs = elapsedMs;
    expect(checkPerformance(manifest).passed).toBe(true);
  });
  it('gates post-build performance metrics against build admission budgets', () => {
    const result = checkPerformance(receipt());
    expect(result.passed).toBe(true);
    expect(result.observed.tiles).toBe(TOTAL_TILES);
    expect(result.budgets).toEqual(BUILD_BUDGETS);
    for (const key of ['elapsedMs', 'peakRssBytes'] as const) {
      for (const value of [undefined, NaN, -1, BUILD_BUDGETS[key] + 1]) {
        const manifest = receipt();
        manifest.metrics[key] = value;
        expect(checkPerformance(manifest).passed).toBe(false);
      }
    }
    const manifest = receipt();
    manifest.metrics.elapsedMs = BUILD_BUDGETS.elapsedMs;
    expect(checkPerformance(manifest).passed).toBe(true);
    delete manifest.metrics.tiles;
    expect(checkPerformance(manifest).passed).toBe(false);
    manifest.metrics.tiles = [...TILES_BY_ZOOM.slice(0, -1), Math.ceil(BUILD_BUDGETS.tiles / manifest.artifacts.length)];
    expect(checkPerformance(manifest).passed).toBe(false);
    manifest.metrics.tiles = [...TILES_BY_ZOOM];
    manifest.samples.bytes = BUILD_BUDGETS.samplePackBytes + 1;
    expect(checkPerformance(manifest).passed).toBe(false);
  });
  it('checks v5 frame-group shard bytes using each group channel count', () => {
    const manifest = { version: 5, buildId: 'fixture', cycle: '2026-10-30T00:00:00Z',
      metrics: { elapsedMs: 1000, peakRssBytes: 1000, tiles: [1] }, artifacts: [{}],
      surfaces: [{ kind: 'fine', grid: { width: 10, height: 10 }, coverage: { maxZoom: 0 }, layers: ['usable-lift-msl', 'usable-lift-agl'],
        samples: { format: 'frame-group-block-shards-v1', storedCells: 10, channelCount: 6,
          shards: [{ group: 0, firstFrame: 0, frameCount: 2, storedCells: 10, bytes: 200 },
            { group: 1, firstFrame: 2, frameCount: 1, storedCells: 10, bytes: 100 }] } }] } as unknown as ManifestV5;
    const result = checkPerformance(manifest);
    expect(result.passed).toBe(true);
    expect(result.observed.emittedSampleBytes).toBe(300);
    manifest.surfaces[0]!.samples.shards[1]!.bytes++;
    expect(checkPerformance(manifest).failures).toContain('invalid v5 shard size');
  });
  it('applies one aggregate grid and numeric byte budget to base plus refinements', () => {
    const manifest = receipt(), patch = fixturePatch(fixtureManifest());
    manifest.patches = [patch];
    const result = checkPerformance(manifest);
    expect(result.observed.gridCells).toBe(4 + 9);
    expect(result.observed.samplePackBytes).toBe(manifest.samples.bytes + patch.samples.bytes);
    patch.samples.bytes = BUILD_BUDGETS.samplePackBytes - manifest.samples.bytes + 1;
    expect(checkPerformance(manifest).passed).toBe(false);
  });
});
