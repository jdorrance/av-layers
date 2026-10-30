import { describe, expect, it } from 'vitest';
import { GFS_PRODUCT, type Manifest } from '@av/contracts';
import { BUILD_BUDGETS, checkPerformance, estimateCapacity, prepareBuild } from './capacity.js';
import { loadCoverage } from './validate.js';

function receipt(): Manifest {
  return { buildId: 'fixture', cycle: '2026-10-30T00:00:00Z', grid: { width: 1440, height: 721 }, coverage: { maxZoom: 5 }, artifacts: new Array(24).fill({}), samples: { bytes: 44_000_000 }, metrics: { elapsedMs: 90_000, peakRssBytes: 1_300_000_000, tiles: [1, 4, 8, 30, 92, 267] } } as unknown as Manifest;
}

describe('build capacity admission and performance budgets', () => {
  it('counts the real product before acquisition and leaves hourly retention headroom', async () => {
    const mask = await loadCoverage(), { capacity, layout, indices } = prepareBuild(mask);
    expect(indices.active.length).toBe(226187);
    expect(capacity).toMatchObject({ tiles: 9648, quarterSamples: 2529165312, samplePackBytes: 43835520, point: { reads: 1, worstCaseRangeBytes: 2280, values: 24 }, violations: [] });
    expect(estimateCapacity(mask, GFS_PRODUCT, layout.storedCells, { cadenceHours: 1 })).toMatchObject({ retainedPerModel: 168, violations: [] });
    expect(estimateCapacity(mask, GFS_PRODUCT, layout.storedCells, { cadenceHours: 0.5 }).violations).toContain('retention leaves no room for a replacement build');
  });
  it('projects native tile growth and rejects it until a trusted product and budget support it', async () => {
    const mask = await loadCoverage(), { layout } = prepareBuild(mask);
    const doubled = estimateCapacity(mask, GFS_PRODUCT, layout.storedCells, { frames: 16, layers: 6, models: 2 });
    expect(doubled.tiles).toBe(9648 * 8);
    expect(doubled.totalSamplePackBytes).toBe(43835520 * 8);
    const deeper = estimateCapacity(mask, GFS_PRODUCT, GFS_PRODUCT.maxNativeZoom, { nativeZoom: 8 });
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
    expect(result.observed.tiles).toBe(9648);
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
    manifest.metrics.tiles = [1, 4, 8, 30, 92, 5000];
    expect(checkPerformance(manifest).passed).toBe(false);
    manifest.metrics.tiles = [1, 4, 8, 30, 92, 267];
    manifest.samples.bytes = BUILD_BUDGETS.samplePackBytes + 1;
    expect(checkPerformance(manifest).passed).toBe(false);
  });
});
