import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  setBit,
  STATUS_NO_LIFT,
  STATUS_VALID,
  SUPPORT_PARCEL_CROSSING,
  type CoverageMask
} from '@av/contracts';
import {
  selectEvaluationPopulation,
  summarizePopulationFields,
  writeCompletedEvaluationReport
} from './evaluation-report.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const grid = {
  kind: 'regular-latlon' as const, width: 3, height: 3, earthRadiusM: 6371229,
  lon0: 0, lat0: 1, dx: 0.01, dy: -0.01, wrapLongitude: false
};
const bounds: [number, number, number, number] = [0, 0.98, 0.02, 1];

function mask(): CoverageMask {
  const output = new Uint8Array(2);
  for (let index = 0; index < 9; index++) setBit(output, index);
  return { grid, bounds, output, halo: new Uint8Array(2), tiles: Uint8Array.of(1), maxZoom: 0 };
}

function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radians = Math.PI / 180, phi1 = lat1 * radians, phi2 = lat2 * radians;
  const a = Math.sin((lat2 - lat1) * radians / 2) ** 2
    + Math.cos(phi1) * Math.cos(phi2) * Math.sin((lon2 - lon1) * radians / 2) ** 2;
  return 2 * grid.earthRadiusM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

describe('evaluation cell populations', () => {
  it('selects whole-zone output cells and includes the exact spherical boundary', () => {
    const coverage = mask();
    setBit(coverage.output, 4, false);
    const whole = selectEvaluationPopulation(coverage, { kind: 'whole-zone' });
    expect(whole.count).toBe(8);
    expect([...whole.indices]).toEqual([0, 1, 2, 3, 5, 6, 7, 8]);

    const radial = mask(), centerLat = 0.99, centerLon = 0.01, boundary = distanceM(centerLat, centerLon, 1, 0.01);
    const radius = selectEvaluationPopulation(radial, {
      kind: 'spherical-radius', centerLat, centerLon, radiusM: boundary, name: 'aragats-15km'
    });
    expect(radius).toMatchObject({ name: 'aragats-15km', centerLat, centerLon, radiusM: boundary, earthRadiusM: grid.earthRadiusM });
    expect([...radius.indices]).toEqual([1, 3, 4, 5, 7]);
    const smaller = selectEvaluationPopulation(radial, {
      kind: 'spherical-radius', centerLat, centerLon, radiusM: 500
    });
    expect(smaller.count).toBe(1);
    expect(() => selectEvaluationPopulation(coverage, { kind: 'spherical-radius', centerLat, centerLon, radiusM: -1 })).toThrow();
  });

  it('reports empty populations and null numeric statistics', () => {
    const coverage = mask();
    coverage.output.fill(0);
    const empty = selectEvaluationPopulation(coverage, { kind: 'whole-zone' });
    const fields = { values: new Float32Array(9).fill(1), flags: new Uint8Array(9).fill(STATUS_VALID) };
    expect(summarizePopulationFields(empty, fields, fields, 'usable-lift-msl')).toMatchObject({
      commonValidCells: 0, medianAbsoluteDifference: null, p95AbsoluteDifference: null,
      maximumAbsoluteDifference: null, paletteAgreement: { compared: 0, equal: 0, fraction: null }
    });
  });


  it('keeps large whole-zone summaries compact without per-cell indices', () => {
    const largeGrid = {
      kind: 'regular-latlon' as const, width: 325, height: 339, earthRadiusM: 6371229,
      lon0: 0, lat0: 80, dx: 0.01, dy: -0.01, wrapLongitude: false
    };
    const cells = largeGrid.width * largeGrid.height, output = new Uint8Array(Math.ceil(cells / 8)).fill(0xff);
    const coverage: CoverageMask = { grid: largeGrid, bounds: [0, 76.61, 3.24, 80], output, halo: new Uint8Array(output.length), tiles: Uint8Array.of(1), maxZoom: 0 };
    const population = selectEvaluationPopulation(coverage, { kind: 'whole-zone' });
    const values = new Float32Array(cells).fill(1200), flags = new Uint8Array(cells).fill(STATUS_VALID);
    const summary = summarizePopulationFields(population, { values, flags }, { values, flags }, 'usable-lift-msl');
    expect(summary.population).toMatchObject({ name: 'whole-zone', count: cells });
    expect('indices' in summary.population).toBe(false);
    expect(JSON.stringify(summary).length).toBeLessThan(4096);
  });
  it('reports paired validity, status histograms and palette-bin agreement within the population', () => {
    const coverage = mask(), population = selectEvaluationPopulation(coverage, { kind: 'whole-zone', name: 'zone' });
    const left = {
      values: Float32Array.of(0, 350, 700, 10, 20, 30, 40, 50, 60),
      flags: Uint8Array.of(STATUS_VALID, STATUS_VALID, STATUS_VALID, STATUS_NO_LIFT, STATUS_VALID, STATUS_VALID, STATUS_VALID, STATUS_VALID, STATUS_VALID).map(flag => flag | SUPPORT_PARCEL_CROSSING)
    };
    const right = {
      values: Float32Array.of(0, 640, 700, 10, 20, 30, 40, 50, 60),
      flags: Uint8Array.of(STATUS_VALID, STATUS_VALID, STATUS_NO_LIFT, STATUS_VALID, STATUS_VALID, STATUS_VALID, STATUS_VALID, STATUS_VALID, STATUS_VALID)
    };
    const summary = summarizePopulationFields(population, left, right, 'usable-lift-msl');
    expect(summary).toMatchObject({
      commonValidCells: 7, leftValidOnly: 1, rightValidOnly: 1, neitherValid: 0,
      medianAbsoluteDifference: 0, maximumAbsoluteDifference: 290,
      paletteAgreement: { compared: 7, equal: 6, fraction: 6 / 7 }
    });
    expect(summary.p95AbsoluteDifference).toBeCloseTo(203, 12);
    expect(summary.statusHistogram).toEqual([
      { status: STATUS_VALID, left: 8, right: 8, both: 7 },
      { status: STATUS_NO_LIFT, left: 1, right: 1, both: 0 }
    ]);
    expect(summary.population).toEqual({ name: 'zone', count: 9, earthRadiusM: grid.earthRadiusM });
    expect('indices' in summary.population).toBe(false);
    expect(summary.statusTransitions).toEqual([
      { from: STATUS_VALID, to: STATUS_VALID, count: 7 },
      { from: STATUS_VALID, to: STATUS_NO_LIFT, count: 1 },
      { from: STATUS_NO_LIFT, to: STATUS_VALID, count: 1 }
    ]);
    expect(summary.supportTransitions).toEqual([{ from: SUPPORT_PARCEL_CROSSING, to: 0, count: 9 }]);
    const disagreed = summarizePopulationFields(population, left, {
      values: Float32Array.of(0, 350, 700, 10, 20, 30, 40, 50, 60), flags: left.flags
    }, 'usable-lift-msl');
    expect(disagreed.paletteAgreement.fraction).toBe(1);
  });
});

describe('completed evaluation reports', () => {
  const buildId = '20261030T000000Z-e4de530b-0527-4e42-aaf2-e5b124cb77e7';

  it('writes deterministic content separately from runtime measurements', async () => {
    const out = await mkdtemp(join(tmpdir(), 'av-evaluation-report-')); roots.push(out);
    const deterministic = { frame: 'f001', variant: 'topo-6p5-H100', value: { b: 2, a: 1 } };
    const first = await writeCompletedEvaluationReport({ out, buildId, deterministic, runtime: { elapsedMs: 10, peakRssBytes: 100 } });
    const report = JSON.parse(await readFile(first.path, 'utf8'));
    expect(report).toMatchObject({ version: 1, buildId, deterministic, runtime: { elapsedMs: 10, peakRssBytes: 100 } });
    expect(Object.keys(report.deterministic)).toEqual(['frame', 'value', 'variant']);
    expect(Object.keys(report.deterministic.value)).toEqual(['a', 'b']);

    const other = await mkdtemp(join(tmpdir(), 'av-evaluation-report-')); roots.push(other);
    const second = await writeCompletedEvaluationReport({ out: other, buildId, deterministic, runtime: { elapsedMs: 20, peakRssBytes: 200 } });
    expect(second.deterministicSha256).toBe(first.deterministicSha256);
    expect(second.sha256).not.toBe(first.sha256);
    await expect(readFile(join(out, buildId, 'report.json'))).resolves.toBeDefined();
  });

  it('refuses sequential and concurrent overwrite without replacing the completed report', async () => {
    const out = await mkdtemp(join(tmpdir(), 'av-evaluation-report-')); roots.push(out);
    const options = { out, buildId, deterministic: { value: 1 }, runtime: { elapsedMs: 1, peakRssBytes: 1 } };
    const first = await writeCompletedEvaluationReport(options), before = await readFile(first.path);
    await expect(writeCompletedEvaluationReport(options)).rejects.toThrow('already exists');
    expect(await readFile(first.path)).toEqual(before);

    const raceOut = await mkdtemp(join(tmpdir(), 'av-evaluation-report-')); roots.push(raceOut);
    const results = await Promise.allSettled([
      writeCompletedEvaluationReport({ ...options, out: raceOut }),
      writeCompletedEvaluationReport({ ...options, out: raceOut })
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });

  it.each(['../escape', '20261030T000000Z-..', 'not-a-build', '20261030T000000Z-ABCDEF'])('rejects invalid build ID %s before writing', async invalid => {
    const out = await mkdtemp(join(tmpdir(), 'av-evaluation-report-')); roots.push(out);
    await expect(writeCompletedEvaluationReport({
      out, buildId: invalid, deterministic: {}, runtime: { elapsedMs: 0, peakRssBytes: 0 }
    })).rejects.toThrow('Invalid evaluation build ID');
  });
});
