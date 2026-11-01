import { describe, expect, it } from 'vitest';
import { GFS_PRODUCT, type Manifest } from '@av/contracts';
import { BUILD_BUDGETS, checkPerformance, estimateCapacity, prepareBuild } from './capacity.js';
import { loadCoverage } from './validate.js';

const Z7_TILES_BY_ZOOM = [1, 4, 8, 30, 92, 267, 847, 2794];
const Z7_TOTAL_TILES = 97032;

function receipt(): Manifest {
  return {
    buildId: 'fixture',
    cycle: '2026-10-30T00:00:00Z',
    grid: { width: 1440, height: 721 },
    coverage: { maxZoom: 7 },
    artifacts: new Array(24).fill({}),
    samples: { bytes: 44_000_000 },
    metrics: { elapsedMs: 90_000, peakRssBytes: 1_300_000_000, tiles: [...Z7_TILES_BY_ZOOM] }
  } as unknown as Manifest;
}

describe('build capacity admission and performance budgets', () => {
  it('counts the real z0-z7 product before acquisition and leaves hourly retention headroom', async () => {
    const mask = await loadCoverage(), { capacity, layout, indices } = prepareBuild(mask);
    expect(indices.active.length).toBe(226187);
    expect(capacity).toMatchObject({
      tilesByZoom: Z7_TILES_BY_ZOOM,
      tiles: Z7_TOTAL_TILES,
      quarterSamples: Z7_TOTAL_TILES * 256 * 256 * 4,
      samplePackBytes: 43835520,
      point: { reads: 1, worstCaseRangeBytes: 2280, values: 24 },
      violations: []
    });
    expect(estimateCapacity(mask, GFS_PRODUCT, layout.storedCells, { cadenceHours: 1 })).toMatchObject({ retainedPerModel: 168, violations: [] });
    expect(estimateCapacity(mask, GFS_PRODUCT, layout.storedCells, { cadenceHours: 0.5 }).violations).toContain('retention leaves no room for a replacement build');
  });
  it('projects native tile growth and rejects it until a trusted product and budget support it', async () => {
    const mask = await loadCoverage(), { layout } = prepareBuild(mask);
    const doubled = estimateCapacity(mask, GFS_PRODUCT, layout.storedCells, { frames: 16, layers: 6, models: 2 });
    expect(doubled.tiles).toBe(Z7_TOTAL_TILES * 8);
    expect(doubled.totalSamplePackBytes).toBe(43835520 * 8);
    const deeper = estimateCapacity(mask, GFS_PRODUCT, layout.storedCells, { nativeZoom: 8 });
    expect(deeper.violations).toContain('tile budget exceeded');
    expect(deeper.violations.join()).toContain('trusted product');
    expect(() => prepareBuild({ ...mask, maxZoom: 24 })).toThrow('trusted product');
  });
  it('rejects invalid scenarios and oversized point products', async () => {
    const mask = await loadCoverage(), { layout } = prepareBuild(mask);
    for (const frames of [0, -1, 1.5, NaN, Infinity]) expect(() => estimateCapacity(mask, GFS_PRODUCT, layout.storedCells, { frames })).toThrow('Invalid capacity');
    expect(estimateCapacity(mask, GFS_PRODUCT, layout.storedCells, { layers: 100 }).violations.join()).toContain('result budget');
  });
  it('gates post-build performance metrics against build admission budgets', () => {
    const result = checkPerformance(receipt());
    expect(result.passed).toBe(true);
    expect(result.observed.tiles).toBe(Z7_TOTAL_TILES);
    expect(result.budgets).toEqual(BUILD_BUDGETS);
    for (const key of ['elapsedMs', 'peakRssBytes'] as const) {
      for (const value of [undefined, NaN, -1, BUILD_BUDGETS[key] + 1]) {
        const manifest = receipt();
        manifest.metrics[key] = value;
        expect(checkPerformance(manifest).passed).toBe(false);
      }
    }
    const manifest = receipt();
    delete manifest.metrics.tiles;
    expect(checkPerformance(manifest).passed).toBe(false);
    manifest.metrics.tiles = [...Z7_TILES_BY_ZOOM.slice(0, -1), 5000];
    expect(checkPerformance(manifest).passed).toBe(false);
    manifest.metrics.tiles = [...Z7_TILES_BY_ZOOM];
    manifest.samples.bytes = BUILD_BUDGETS.samplePackBytes + 1;
    expect(checkPerformance(manifest).passed).toBe(false);
  });
});
