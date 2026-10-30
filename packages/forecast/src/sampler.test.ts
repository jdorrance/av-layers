import { describe, expect, it } from 'vitest';
import { GFS_GRID, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, SUPPORT_PARCEL_CROSSING, SUPPORT_PROFILE_TOP, type Grid } from '@av/contracts';
import { cellsFromRange, packCells, planSample, sampleCells, sampleGrid, unpackCells } from './sampler.js';
const grid: Grid = { width: 2, height: 2, lon0: 0, lat0: 1, dx: 1, dy: -1, wrapLongitude: false };
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
