import { INDEXED_PRODUCT } from '../../../tests/model-fixtures.js';
import { describe, expect, it } from 'vitest';
import { type CoverageMask, type ManifestV5 } from '@av/contracts';
import { assertForecastInputs, BUILD_BUDGETS, checkPerformance, estimateRetention, MAX_V5_SHARD_BYTES, normalizedFrameBytes } from './capacity.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBundledFineCoverage, wholeDomainPlan } from './whole-domain/coverage.js';

const TILES_BY_ZOOM = [1, 4];
const TOTAL_TILES = 30;
const SAMPLE_PACK_BYTES = 180;

it('counts auxiliary fields in the shared normalized-frame memory estimate', () => {
  const resources = { maxLevels: 25, auxiliarySurfaceFields: 8, auxiliaryLevelFields: 4 };
  expect(normalizedFrameBytes(100, 'isobaric', resources)).toBe(100 * (7 + 8 + 6 * 25) * 5);
  expect(normalizedFrameBytes(100, 'model-levels', resources)).toBe(100 * (7 + 8 + 7 * 25) * 5);
  expect(() => normalizedFrameBytes(100, 'isobaric', { ...resources, auxiliaryLevelFields: -1 })).toThrow('dimensions');
});

it('bounds scheduled starts for stepped, overlapping and manual-only schedules', () => {
  const schedules = ['*/30 1-5/2,5 * * 1-5', '15 8 * * *'];
  expect(estimateRetention(schedules, { retentionDays: 1.5 })).toMatchObject({
    cadenceHours: 24 / 7, retainedPerModel: 14, retentionBasis: 'schedule', violations: []
  });
  expect(estimateRetention([])).toMatchObject({ cadenceHours: null, retainedPerModel: 0, violations: [] });
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

function receipt(): ManifestV5 {
  return {
    buildId: 'fixture',
    cycle: '2026-10-30T00:00:00Z',
    version: 5, artifacts: new Array(6).fill({}),
    surfaces: [{ kind: 'native', grid: { width: 2, height: 2 }, coverage: { maxZoom: 1 }, layers: ['precip-rate'],
      samples: { storedCells: 6, channelCount: 6, shards: [{ storedCells: 6, bytes: SAMPLE_PACK_BYTES }] } }],
    metrics: { elapsedMs: 90_000, peakRssBytes: 1_300_000_000, tiles: [...TILES_BY_ZOOM] }
  } as unknown as ManifestV5;
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
    expect(() => assertForecastInputs({ ...mask, output: new Uint8Array(mask.output.length), halo: new Uint8Array(mask.halo.length) }, product)).toThrow('before acquisition');
  });
  it('keeps enough retention room for the next scheduled build', () => {
    const schedule = ['25 0,6,12,18 * * *'];
    expect(estimateRetention(schedule)).toMatchObject({ cadenceHours: 6, retainedPerModel: 28, violations: [] });
    expect(estimateRetention(schedule, { cadenceHours: 1 })).toMatchObject({ retainedPerModel: 168, violations: [] });
    expect(estimateRetention(schedule, { cadenceHours: 0.5 }).violations).toContain('retention leaves no room for a replacement build');
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
    expect(result.budgets).toEqual({ ...BUILD_BUDGETS, samplePackBytes: MAX_V5_SHARD_BYTES });
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
    manifest.surfaces[0]!.samples.shards[0]!.bytes = MAX_V5_SHARD_BYTES + 1;
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
});
