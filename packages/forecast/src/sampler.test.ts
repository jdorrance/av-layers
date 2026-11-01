import { describe, expect, it } from 'vitest';
import { GFS_GRID, LAYERS, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, SUPPORT_PARCEL_CROSSING, SUPPORT_PROFILE_TOP, type Grid } from '@av/contracts';
import { cellsFromRange, packCells, planSample, prepareGridSampling, sampleCells, sampleGrid, unpackCells } from './sampler.js';
const grid: Grid = { kind: 'regular-latlon', earthRadiusM: 6371229, width: 2, height: 2, lon0: 0, lat0: 1, dx: 1, dy: -1, wrapLongitude: false };
describe('scalar sampling', () => {
  it('interpolates physical no-lift with terrain as MSL reference', () => {
    const flags = Uint8Array.of(SUPPORT_PARCEL_CROSSING, STATUS_NO_LIFT | SUPPORT_PROFILE_TOP, STATUS_NO_LIFT, STATUS_NO_LIFT);
    const agl = { values: Float32Array.of(310, 0, 0, 0), flags };
    const msl = { values: Float32Array.of(410, 100, 100, 100), flags };
    expect(sampleGrid(grid, agl, 1, 0.5, 'usable-lift-agl')).toMatchObject({ value: 155, status: 0, support: SUPPORT_PARCEL_CROSSING | SUPPORT_PROFILE_TOP, interpolated: true });
    expect(sampleGrid(grid, msl, 1, 0.5, 'usable-lift-msl').value).toBe(255);
    expect(sampleGrid(grid, msl, 0, 0.5, 'usable-lift-msl')).toMatchObject({ value: null, status: STATUS_NO_LIFT });
  });
  it('ignores zero-weight neighbors and snaps close to nodes', () => {
    const field = { values: Float32Array.of(4, NaN, NaN, NaN), flags: Uint8Array.of(0, 2, 2, 2) };
    expect(sampleGrid(grid, field, 1 - 1e-11, 1e-11, 'precip-rate')).toMatchObject({ value: 4, interpolated: false });
  });
  it('uses immutable supplied layer semantics instead of the current global registry', () => {
    const field = { values: Float32Array.of(100, 300, 100, 300), flags: Uint8Array.of(STATUS_NO_LIFT, 0, STATUS_NO_LIFT, 0) };
    const spec = { ...LAYERS['usable-lift-msl'], noLiftSampleValue: 17, zeroOnNoLiftInterpolation: true };
    expect(sampleGrid(grid, field, 1, 0, spec).value).toBe(17);
    expect(sampleGrid(grid, field, 1, 0.5, spec).value).toBe(150);
    expect(sampleGrid(grid, field, 1, 0.5, 'usable-lift-msl').value).toBe(200);
    const mask = { grid, output: Uint8Array.of(15), halo: Uint8Array.of(0), tiles: Uint8Array.of(1), maxZoom: 0 };
    const prepared = prepareGridSampling(mask, Float64Array.of(1), Float64Array.of(0.5));
    const result = { value: null as number | null, status: 3, support: 0, interpolated: false };
    prepared.bind(field, spec)(0, 0, result);
    expect(result).toEqual(sampleGrid(grid, field, 1, 0.5, spec));
  });
  it('falls back to nearest contributor without renormalizing, row then column on ties', () => {
    const field = { values: Float32Array.of(10, 20, 30, 40), flags: Uint8Array.of(0, STATUS_UNAVAILABLE, 0, 0) };
    expect(sampleGrid(grid, field, 0.5, 0.5, 'precip-rate')).toMatchObject({ value: 10, interpolated: false });
    expect(sampleGrid(grid, field, 0.9, 0.9, 'precip-rate')).toMatchObject({ value: null, status: STATUS_UNAVAILABLE });
    field.flags[0] = STATUS_OUTSIDE;
    expect(sampleGrid(grid, field, 0.9, 0.1, 'precip-rate').status).toBe(STATUS_OUTSIDE);
  });
  it('uses wrapped column as tie-breaker', () => {
    const g = { ...grid, wrapLongitude: true };
    const f = { values: Float32Array.of(8, 9, 0, 0), flags: Uint8Array.of(0, STATUS_UNAVAILABLE, 0, 0) };
    expect(sampleGrid(g, f, 1, 1.5, 'precip-rate')).toMatchObject({ value: 8, status: 0 });
    expect(planSample(g, 1, 2)?.contributors[0].column).toBe(0);
    expect(planSample(grid, 1, -0.1)).toBeNull();
  });
  it('keeps row-major contributors and exact fractional weights', () => {
    expect(planSample(grid, 0.25, 0.6)).toEqual({
      contributors: [
        { row: 0, column: 0, index: 0, weight: 0.1 },
        { row: 0, column: 1, index: 1, weight: 0.15 },
        { row: 1, column: 0, index: 2, weight: 0.30000000000000004 },
        { row: 1, column: 1, index: 3, weight: 0.44999999999999996 }
      ],
      byteRange: { offset: 0, length: 20 }
    });
  });
  it('retains repeated wrapped contributors in a one-column grid', () => {
    const singleColumn = { ...grid, width: 1, wrapLongitude: true };
    expect(planSample(singleColumn, 0.25, 0.5)).toEqual({
      contributors: [
        { row: 0, column: 0, index: 0, weight: 0.125 },
        { row: 0, column: 0, index: 0, weight: 0.125 },
        { row: 1, column: 0, index: 1, weight: 0.375 },
        { row: 1, column: 0, index: 1, weight: 0.375 }
      ],
      byteRange: { offset: 0, length: 10 }
    });
    const field = { values: Float32Array.of(10, 30), flags: new Uint8Array(2) };
    expect(sampleGrid(singleColumn, field, 0.25, 0.5, 'precip-rate')).toEqual({ value: 25, status: 0, support: 0, interpolated: true });
    expect(planSample(singleColumn, 1, 0)?.contributors).toEqual([{ row: -0, column: 0, index: 0, weight: 1 }]);
  });
  it('packs little-endian independent layer cells and enforces range length', () => {
    const field = { values: Float32Array.of(1, -2), flags: Uint8Array.of(4, 8) }, bytes = packCells(field);
    expect([...bytes]).toEqual([0, 0, 128, 63, 4, 0, 0, 0, 192, 8]);
    expect([...unpackCells(bytes).values]).toEqual([1, -2]);
    const plan = planSample(grid, 1, 0.5)!;
    expect(cellsFromRange(plan, bytes)).toEqual([{ value: 1, flags: 4 }, { value: -2, flags: 8 }]);
    expect(() => cellsFromRange(plan, bytes.subarray(1))).toThrow(); expect(() => unpackCells(bytes.subarray(1))).toThrow();
    expect(sampleCells(plan, cellsFromRange(plan, bytes), 'usable-lift-agl').value).toBe(-0.5);
  });
  it('rejects lift-only rain flags and corrupt nearest values', () => {
    const plan = planSample(grid, 1, 0.5)!;
    expect(() => sampleCells(plan, [{ value: 1, flags: 4 }, { value: 2, flags: 0 }], 'precip-rate')).toThrow();
    expect(() => sampleCells(plan, [{ value: NaN, flags: 0 }, { value: 0, flags: STATUS_UNAVAILABLE }], 'precip-rate')).toThrow();
  });
  it('coalesces interior and dateline two-row reads', () => {
    expect(planSample(GFS_GRID, 10.125, 0.125)?.byteRange.length).toBe(7210);
    expect(planSample(GFS_GRID, 10.125, 179.875)?.byteRange.length).toBe(14400);
    expect(planSample(GFS_GRID, 10.125, -180)?.contributors).toHaveLength(2);
    expect(planSample(GFS_GRID, 90, -180)?.byteRange.length).toBe(5);
  });
});
