import { loadCoverage } from './coverage.js';
import { describe, expect, it } from 'vitest';
import { GFS_PRODUCT, ICON_EU_PRODUCT, type Manifest, type ManifestV5 } from '@av/contracts';
import { getForecastProvider } from './providers.js';
import { BUILD_BUDGETS, checkPerformance, estimateCapacity, prepareBuild } from './capacity.js';
import { GFS_PRESSURE_LEVELS_HPA } from './gfs/constants.js';
import { rasterWorkerCount, RASTER_WORKER_RESERVE_BYTES } from './raster-pool.js';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBundledFineCoverage, wholeDomainPlan } from './whole-domain/coverage.js';
import { fileURLToPath } from 'node:url';
import { fixtureManifest, fixturePatch } from '../../../tests/forecast-fixture.js';

const TILES_BY_ZOOM = [1, 4, 8, 29, 84, 233, 708, 2235, 7680, 27916];
const TOTAL_TILES = 2_800_656;

function receipt(): Manifest {
  return {
    buildId: 'fixture',
    cycle: '2026-10-30T00:00:00Z',
    grid: { width: 1440, height: 721 },
    coverage: { maxZoom: GFS_PRODUCT.maxNativeZoom },
    artifacts: new Array(72).fill({}),
    samples: { bytes: 132_000_000 },
    metrics: { elapsedMs: 90_000, peakRssBytes: 1_300_000_000, tiles: [...TILES_BY_ZOOM] }
  } as unknown as Manifest;
}

describe('build capacity admission and performance budgets', () => {
  it('rejects missing fine coverage independently of bundled assets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'capacity-coverage-'));
    try {
      const product = { ...GFS_PRODUCT, coverageDir: directory };
      await expect(loadBundledFineCoverage(product, wholeDomainPlan(product)!)).rejects.toThrow('Fine coverage is missing');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('rejects scenario overrides instead of silently ignoring them for configured whole-domain capacity', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./cli.ts', import.meta.url)), 'capacity', '--frames', '48', '--layers', '8', '--models', '4'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('scenario overrides are unsupported');
    expect(result.stdout).not.toContain('currentProductAdmission');
  });
  it.each(['gfs', 'icon-eu'])('admits raster workers for the real %s whole-domain configuration', model => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./cli.ts', import.meta.url)), 'capacity', '--model', model], { encoding: 'utf8', timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.capacity.violations).toEqual([]);
    expect(report.capacity.tiles).toBe(model === 'gfs' ? 2_756_928 : 1_386_768);
    const expectedWorkers = model === 'icon-eu' ? Math.min(2, rasterWorkerCount()) : rasterWorkerCount();
    expect(report.capacity.rasterWorkers).toBe(expectedWorkers);
    expect(report.capacity.deriveWorkers).toBe(expectedWorkers);
    const levels = model === 'gfs' ? 21 : 30, fieldsPerLevel = model === 'gfs' ? 2 : 3;
    const nativeActive = report.capacity.workingSet.nativeFrame / ((7 + fieldsPerLevel * levels) * 5);
    expect(nativeActive).toBeGreaterThan(4);
    expect(report.capacity.workingSet.deriveWorkerColumns).toBeGreaterThanOrEqual(report.capacity.deriveWorkers * 4 * (levels * 16 + 45));
    expect(report.capacity.estimatedPeakBytes).toBeLessThanOrEqual(BUILD_BUDGETS.peakRssBytes);
  }, 70_000);
  it('rejects empty public coverage before opening a provider', async () => {
    const mask = await loadCoverage(GFS_PRODUCT);
    expect(() => prepareBuild({ ...mask, output: new Uint8Array(mask.output.length), halo: new Uint8Array(mask.halo.length) }, GFS_PRODUCT, { maxLevels: GFS_PRESSURE_LEVELS_HPA.length })).toThrow('before acquisition');
  });
  it('counts the real configured product before acquisition and leaves hourly retention headroom', async () => {
    const mask = await loadCoverage(GFS_PRODUCT), { capacity, layout, indices } = prepareBuild(mask, GFS_PRODUCT, { maxLevels: GFS_PRESSURE_LEVELS_HPA.length });
    expect(indices.active.length).toBe(164788);
    expect(capacity).toMatchObject({
      tilesByZoom: TILES_BY_ZOOM,
      tiles: TOTAL_TILES,
      quarterSamples: TOTAL_TILES * 256 * 256 * 4,
      samplePackBytes: 105392520,
      point: { reads: 1, worstCaseRangeBytes: 6840, values: 72 },
      violations: []
    });
    expect(estimateCapacity(mask, GFS_PRODUCT, layout.storedCells, { cadenceHours: 1 })).toMatchObject({ retainedPerModel: 168, violations: [] });
    expect(estimateCapacity(mask, GFS_PRODUCT, layout.storedCells, { cadenceHours: 0.5 }).violations).toContain('retention leaves no room for a replacement build');
    expect(capacity.rasterWorkers).toBe(rasterWorkerCount());
    expect(capacity.workingSet.rasterWorkerRuntimes).toBe(capacity.rasterWorkers * RASTER_WORKER_RESERVE_BYTES);
    expect(capacity.workingSet.rasterSharedInputs).toBe(capacity.rasterWorkers ? mask.grid.width * mask.grid.height * 3 * 5 + mask.output.byteLength + mask.halo.byteLength + mask.tiles.byteLength : 0);
    expect(capacity.estimatedPeakBytes).toBe(Object.values(capacity.workingSet).reduce((total, bytes) => total + bytes, 0));
  });
  it('projects native tile growth and rejects it until a trusted product and budget support it', async () => {
    const mask = await loadCoverage(GFS_PRODUCT), { layout } = prepareBuild(mask, GFS_PRODUCT, { maxLevels: GFS_PRESSURE_LEVELS_HPA.length });
    const doubled = estimateCapacity(mask, GFS_PRODUCT, layout.storedCells, { frames: 48, layers: 6, models: 2 });
    expect(doubled.tiles).toBe(TOTAL_TILES * 8);
    expect(doubled.totalSamplePackBytes).toBe(105392520 * 8);
    const deeper = estimateCapacity(mask, GFS_PRODUCT, layout.storedCells, { nativeZoom: GFS_PRODUCT.maxNativeZoom + 1 });
    expect(deeper.tiles).toBeGreaterThan(BUILD_BUDGETS.tiles);
    expect(deeper.violations.join()).toContain('trusted product');
    expect(deeper.violations).toContain('tile budget exceeded');
    expect(() => prepareBuild({ ...mask, maxZoom: 24 }, GFS_PRODUCT, { maxLevels: GFS_PRESSURE_LEVELS_HPA.length })).toThrow('trusted product');
  });
  it('admits ICON with per-column pressures and retained geometry, but rejects an oversized provider cache', async () => {
    const mask = await loadCoverage(ICON_EU_PRODUCT), provider = getForecastProvider('icon-eu');
    const { capacity, indices } = prepareBuild(mask, ICON_EU_PRODUCT, provider);
    const bytesPerField = new Float32Array(indices.active.length).byteLength + new Uint8Array(indices.active.length).byteLength;
    const isobaric = { ...ICON_EU_PRODUCT, capabilities: { ...ICON_EU_PRODUCT.capabilities, verticalCoordinate: 'isobaric' as const } };
    const sharedPressure = prepareBuild(mask, isobaric, provider).capacity;
    expect(capacity.workingSet.normalizedFrame - sharedPressure.workingSet.normalizedFrame).toBe(bytesPerField * provider.maxLevels);
    expect(capacity.workingSet.retainedGeometry).toBe(bytesPerField * (provider.maxLevels + 1));
    expect(capacity.estimatedPeakBytes).toBeLessThan(BUILD_BUDGETS.peakRssBytes);
    expect(() => prepareBuild(mask, ICON_EU_PRODUCT, { ...provider, retainedGeometryFields: 257 })).toThrow('working-set budget');
    for (const retainedGeometryFields of [-1, 0.5, NaN, 258]) {
      expect(() => prepareBuild(mask, ICON_EU_PRODUCT, { ...provider, retainedGeometryFields })).toThrow('retained geometry budget');
    }
  });
  it('reserves prepared terrain validation and resident arrays only when requested', async () => {
    const mask = await loadCoverage(GFS_PRODUCT), provider = getForecastProvider('gfs');
    const baseline = prepareBuild(mask, GFS_PRODUCT, provider).capacity;
    const staged = prepareBuild(mask, GFS_PRODUCT, { ...provider, terrainBytes: 5120 }).capacity;
    expect(baseline.workingSet.preparedTerrain).toBe(0);
    expect(staged.estimatedPeakBytes - baseline.estimatedPeakBytes).toBe(10240);
    for (const terrainBytes of [-1, 0.5, NaN, 20_000_001]) {
      expect(() => prepareBuild(mask, GFS_PRODUCT, { ...provider, terrainBytes })).toThrow('prepared terrain byte budget');
    }
  });
  it('rejects invalid scenarios and oversized point products', async () => {
    const mask = await loadCoverage(GFS_PRODUCT), { layout } = prepareBuild(mask, GFS_PRODUCT, { maxLevels: GFS_PRESSURE_LEVELS_HPA.length });
    for (const frames of [0, -1, 1.5, NaN, Infinity]) expect(() => estimateCapacity(mask, GFS_PRODUCT, layout.storedCells, { frames })).toThrow('Invalid capacity');
    expect(estimateCapacity(mask, GFS_PRODUCT, layout.storedCells, { layers: 100 }).violations.join()).toContain('result budget');
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
    expect(result.observed.gridCells).toBe(1440 * 721 + 9);
    expect(result.observed.samplePackBytes).toBe(manifest.samples.bytes + patch.samples.bytes);
    patch.samples.bytes = BUILD_BUDGETS.samplePackBytes - manifest.samples.bytes + 1;
    expect(checkPerformance(manifest).passed).toBe(false);
  });
});
