import { describe, expect, it } from 'vitest';
import {
  MAX_GRID_CELLS,
  setBit,
  STATUS_NO_LIFT,
  STATUS_OUTSIDE,
  STATUS_UNAVAILABLE,
  STATUS_VALID,
  SUPPORT_PARCEL_CROSSING,
  SUPPORT_PROFILE_TOP,
  type CoverageMask,
  type Grid,
  type RegularLatLonGrid
} from '@av/contracts';
import { prepareTerrainClearance as prepareTerrainClearanceV2, terrainClearanceMappingBytes } from './refinement.js';
import { deriveFrame, FRAME_BRANCH } from './frame.js';
import { usableLiftDepthM } from '@av/soaring/velocity';
import { normalizedFixtureFrame } from '../../../scripts/fixtures/normalized-provider.js';
import type { GridField } from './sampler.js';

const sourceGrid: RegularLatLonGrid = {
  kind: 'regular-latlon', earthRadiusM: 6371229,
  width: 2, height: 2, lon0: 0, lat0: 1, dx: 1, dy: -1, wrapLongitude: false
};
const targetGrid: RegularLatLonGrid = { ...sourceGrid, width: 1, height: 1, lon0: 0.5, lat0: 0.5 };
const day = { intervalStart: '2026-03-20T11:00:00Z', validTime: '2026-03-20T12:00:00Z' };
const night = { intervalStart: '2026-03-19T23:00:00Z', validTime: '2026-03-20T00:00:00Z' };

function mask(grid: Grid = sourceGrid, output = Array.from({ length: grid.width * grid.height }, (_, i) => i), halo: number[] = []): CoverageMask {
  const result = {
    grid: { ...grid }, output: new Uint8Array(Math.ceil(grid.width * grid.height / 8)),
    halo: new Uint8Array(Math.ceil(grid.width * grid.height / 8)), tiles: Uint8Array.of(1), maxZoom: 0
  };
  for (const index of output) setBit(result.output, index);
  for (const index of halo) setBit(result.halo, index);
  return result;
}

function field(values = [2800, 3200, 3400, 3600], flags = values.map(() => STATUS_VALID)): GridField {
  return { values: Float32Array.from(values), flags: Uint8Array.from(flags) };
}

function terrain(elevationM = [1800], valid = elevationM.map(() => 1)) {
  return { elevationM: Float32Array.from(elevationM), valid: Uint8Array.from(valid) };
}

type DeriveArgs = Parameters<ReturnType<typeof prepareTerrainClearanceV2>['derive']>;
function prepareV2(source: CoverageMask, target: CoverageMask) {
  const prepared = prepareTerrainClearanceV2(source, target);
  return {
    byteLength: prepared.byteLength,
    derive(...args: DeriveArgs) { return prepared.derive(...args)['usable-lift-agl']; },
    deriveAll(...args: DeriveArgs) { return prepared.derive(...args); }
  };
}

function prepareTerrainClearance(source: CoverageMask, target: CoverageMask) {
  const prepared = prepareV2(source, target);
  return {
    byteLength: prepared.byteLength,
    derive(field: GridField, dem: ReturnType<typeof terrain>, time: typeof day, daylightOnly?: boolean) {
      const diagnostics = {
        ceilingMslM: field.values,
        buoyancyM2S3: new Float32Array(field.values.length).fill(1e10),
        branch: new Uint8Array(field.values.length).fill(FRAME_BRANCH.parcelCrossing)
      };
      return prepared.derive(diagnostics, field.flags, dem, time, daylightOnly);
    },
    deriveAll(field: GridField, dem: ReturnType<typeof terrain>, time: typeof day, daylightOnly?: boolean) {
      const diagnostics = {
        ceilingMslM: field.values,
        buoyancyM2S3: new Float32Array(field.values.length).fill(1e10),
        branch: new Uint8Array(field.values.length).fill(FRAME_BRANCH.parcelCrossing)
      };
      return prepared.deriveAll(diagnostics, field.flags, dem, time, daylightOnly);
    }
  };
}

describe('terrain-referenced clearance', () => {
  it('recomputes velocity and usable depth over local terrain', () => {
    const prepared = prepareV2(mask(), mask(targetGrid));
    const diagnostics = { ceilingMslM: new Float32Array(4).fill(1000), buoyancyM2S3: new Float32Array(4).fill(1.3 ** 3 / 1000), branch: new Uint8Array(4).fill(FRAME_BRANCH.parcelCrossing) };
    const flags = new Uint8Array(4).fill(SUPPORT_PARCEL_CROSSING);
    const lower = prepared.derive(diagnostics, flags, terrain([600]), day);
    expect(lower.values[0]).toBeCloseTo(333.64, 2);
    const upper = prepared.derive(diagnostics, flags, terrain([950]), day);
    expect(upper.values[0]).toBe(0); expect(upper.flags[0]).toBe(STATUS_NO_LIFT | SUPPORT_PARCEL_CROSSING);
  });

  it('publishes MSL at terrain elevation plus AGL with shared support', () => {
    const prepared = prepareTerrainClearance(mask(), mask(targetGrid));
    const fields = prepared.deriveAll(field(undefined, [SUPPORT_PARCEL_CROSSING, SUPPORT_PROFILE_TOP, STATUS_VALID, STATUS_VALID]), terrain(), day);
    const agl = fields['usable-lift-agl'], msl = fields['usable-lift-msl'];
    expect(agl.values[0]).toBe(1450);
    expect(msl.values[0]).toBe(Math.fround(1800 + agl.values[0]));
    expect(msl.flags[0]).toBe(agl.flags[0]);
    expect(msl.flags[0]).toBe(SUPPORT_PARCEL_CROSSING | SUPPORT_PROFILE_TOP);
  });

  it('emits terrain MSL and zero AGL at night or for non-convective columns', () => {
    const prepared = prepareTerrainClearance(mask(), mask(targetGrid));
    const dark = prepared.deriveAll(field(), terrain(), night);
    expect(dark['usable-lift-agl'].values[0]).toBe(0);
    expect(dark['usable-lift-msl'].values[0]).toBe(1800);
    expect(dark['usable-lift-msl'].flags[0]).toBe(STATUS_NO_LIFT);
    expect(dark['usable-lift-agl'].flags[0]).toBe(STATUS_NO_LIFT);
    const zero = prepareV2(mask(), mask(targetGrid)).deriveAll(
      { ceilingMslM: new Float32Array(4).fill(2500), buoyancyM2S3: new Float32Array(4), branch: new Uint8Array(4).fill(FRAME_BRANCH.nonConvective) },
      new Uint8Array(4).fill(STATUS_NO_LIFT), terrain([700]), day
    );
    expect(zero['usable-lift-agl'].values[0]).toBe(0);
    expect(zero['usable-lift-msl'].values[0]).toBe(700);
    expect(zero['usable-lift-msl'].flags[0]).toBe(zero['usable-lift-agl'].flags[0]);
  });

  it('emits unavailable NaN for both outputs when terrain or clearance is invalid', () => {
    const prepared = prepareTerrainClearance(mask(), mask(targetGrid));
    const invalid = prepared.deriveAll(field(), terrain([0], [0]), day);
    expect(invalid['usable-lift-agl'].values[0]).toBeNaN();
    expect(invalid['usable-lift-msl'].values[0]).toBeNaN();
    expect(invalid['usable-lift-agl'].flags[0]).toBe(STATUS_UNAVAILABLE);
    expect(invalid['usable-lift-msl'].flags[0]).toBe(STATUS_UNAVAILABLE);
    const overflow = prepared.deriveAll(field([3e38, 3e38, 3e38, 3e38]), terrain([-3e38]), day);
    expect(overflow['usable-lift-agl'].values[0]).toBeNaN();
    expect(overflow['usable-lift-msl'].values[0]).toBeNaN();
  });

  it('includes native no-lift columns with positive depth in valley interpolation', () => {
    const prepared = prepareV2(mask(), mask(targetGrid));
    const diagnostics = { ceilingMslM: new Float32Array(4).fill(1000), buoyancyM2S3: new Float32Array(4).fill(0.46 ** 3 / 1000), branch: new Uint8Array(4).fill(FRAME_BRANCH.profileTop) };
    const flags = new Uint8Array(4).fill(STATUS_NO_LIFT | SUPPORT_PROFILE_TOP);
    const result = prepared.derive(diagnostics, flags, terrain([-9000]), day);
    expect(result.flags[0]).toBe(STATUS_VALID | SUPPORT_PROFILE_TOP);
    expect(result.values[0]).toBeGreaterThan(0);
    diagnostics.buoyancyM2S3[2] = NaN;
    expect(prepared.derive(diagnostics, flags, terrain([-9000]), day).flags[0]).toBe(STATUS_UNAVAILABLE);
  });

  it('rejects a convective corner mixed with zero-depth columns over a valley', () => {
    const prepared = prepareV2(mask(), mask(targetGrid));
    const diagnostics = {
      ceilingMslM: Float32Array.of(2000, 2000, 2000, 2400),
      buoyancyM2S3: Float32Array.of(0, 0, 0, 0.8 ** 3 / 400),
      branch: Uint8Array.of(FRAME_BRANCH.nonConvective, FRAME_BRANCH.surfaceStable, FRAME_BRANCH.nonConvective, FRAME_BRANCH.parcelCrossing)
    };
    const result = prepared.derive(diagnostics, Uint8Array.of(STATUS_NO_LIFT, STATUS_NO_LIFT, STATUS_NO_LIFT, STATUS_NO_LIFT | SUPPORT_PARCEL_CROSSING), terrain([1000]), day);
    expect(result.flags[0]).toBe(STATUS_UNAVAILABLE);
    expect(result.values[0]).toBeNaN();
  });

  it('interpolates all convective branches including native post-cut no-lift', () => {
    const prepared = prepareV2(mask(), mask(targetGrid));
    const diagnostics = {
      ceilingMslM: Float32Array.of(2400, 2600, 2800, 3000),
      buoyancyM2S3: Float32Array.of(0.8 ** 3 / 400, 1.6 ** 3 / 600, 1.6 ** 3 / 800, 1.6 ** 3 / 1000),
      branch: Uint8Array.of(FRAME_BRANCH.parcelCrossing, FRAME_BRANCH.profileTop, FRAME_BRANCH.parcelCrossing, FRAME_BRANCH.profileTop)
    };
    const flags = Uint8Array.of(STATUS_NO_LIFT | SUPPORT_PARCEL_CROSSING, STATUS_VALID | SUPPORT_PROFILE_TOP, STATUS_VALID | SUPPORT_PARCEL_CROSSING, STATUS_VALID | SUPPORT_PROFILE_TOP);
    const result = prepared.derive(diagnostics, flags, terrain([1000]), day);
    const meanBuoyancy = [...diagnostics.buoyancyM2S3].reduce((a, b) => a + b) / 4;
    const expected = usableLiftDepthM(1700, Math.cbrt(meanBuoyancy * 1700));
    expect(result.flags[0]).toBe(STATUS_VALID | SUPPORT_PARCEL_CROSSING | SUPPORT_PROFILE_TOP);
    expect(result.values[0]).toBeGreaterThan(0);
    expect(result.values[0]).toBeCloseTo(expected!, 3);
  });

  it('ignores unsupported branches at zero-weight native nodes', () => {
    const prepared = prepareV2(mask(), mask({ ...targetGrid, lon0: 0, lat0: 1 }));
    const diagnostics = {
      ceilingMslM: Float32Array.of(2400, NaN, NaN, NaN),
      buoyancyM2S3: Float32Array.of(1, NaN, NaN, NaN),
      branch: Uint8Array.of(FRAME_BRANCH.parcelCrossing, FRAME_BRANCH.unavailable, FRAME_BRANCH.skippedDark, FRAME_BRANCH.nonConvective)
    };
    const result = prepared.derive(diagnostics, Uint8Array.of(STATUS_VALID, STATUS_UNAVAILABLE, STATUS_UNAVAILABLE, STATUS_NO_LIFT), terrain([1000]), day);
    expect(result.flags[0]).toBe(STATUS_VALID);
    expect(result.values[0]).toBeGreaterThan(0);
  });

  it.each([FRAME_BRANCH.unavailable, 6, FRAME_BRANCH.skippedDark, 7])('rejects unsupported branch %s', branch => {
    const prepared = prepareV2(mask(), mask(targetGrid));
    const diagnostics = { ceilingMslM: new Float32Array(4).fill(2400), buoyancyM2S3: new Float32Array(4).fill(1), branch: new Uint8Array(4).fill(FRAME_BRANCH.parcelCrossing) };
    diagnostics.branch[0] = branch;
    expect(prepared.derive(diagnostics, new Uint8Array(4), terrain([1000]), day).flags[0]).toBe(STATUS_UNAVAILABLE);
  });

  it('rejects inconsistent zero-depth branch diagnostics', () => {
    const prepared = prepareV2(mask(), mask(targetGrid));
    const diagnostics = { ceilingMslM: new Float32Array(4).fill(2000), buoyancyM2S3: new Float32Array(4), branch: new Uint8Array(4).fill(FRAME_BRANCH.nonConvective) };
    const flags = new Uint8Array(4).fill(STATUS_NO_LIFT);
    diagnostics.buoyancyM2S3[0] = 1;
    expect(prepared.derive(diagnostics, flags, terrain([1000]), day).flags[0]).toBe(STATUS_UNAVAILABLE);
    diagnostics.buoyancyM2S3[0] = 0;
    flags[0] = STATUS_VALID;
    expect(prepared.derive(diagnostics, flags, terrain([1000]), day).flags[0]).toBe(STATUS_UNAVAILABLE);
  });

  it('requires branch diagnostics matching the native grid', () => {
    const prepared = prepareV2(mask(), mask(targetGrid));
    const diagnostics = { ceilingMslM: new Float32Array(4), buoyancyM2S3: new Float32Array(4), branch: new Uint8Array(3) };
    expect(() => prepared.derive(diagnostics, new Uint8Array(4), terrain(), day)).toThrow(/input size/);
    expect(() => prepared.derive({ ...diagnostics, branch: undefined } as unknown as typeof diagnostics, new Uint8Array(4), terrain(), day)).toThrow(/input size/);
  });
  it('interpolates native MSL before subtracting target DEM and retains admitted support', () => {
    const prepared = prepareTerrainClearance(mask(), mask(targetGrid));
    const source = field(undefined, [SUPPORT_PARCEL_CROSSING, SUPPORT_PROFILE_TOP, STATUS_VALID, STATUS_VALID]);
    const result = prepared.derive(source, terrain(), day);
    expect([...result.values]).toEqual([1450]); // mean ceiling 3250 - DEM 1800
    expect([...result.flags]).toEqual([SUPPORT_PARCEL_CROSSING | SUPPORT_PROFILE_TOP]);
    expect(prepared.byteLength).toBe(53);
    expect([...source.values]).toEqual([2800, 3200, 3400, 3600]);
  });

  it('uses unequal bilinear weights without rounding or renormalization', () => {
    const prepared = prepareTerrainClearance(mask(), mask({ ...targetGrid, lon0: 0.6, lat0: 0.25 }));
    const result = prepared.derive(field([10, 20, 30, 40]), terrain([0]), day);
    expect(result.values[0]).toBe(31); // weights 0.1, 0.15, 0.3, 0.45
  });

  it('keeps evaluated non-convective zero-buoyancy cells at zero above a lower DEM', () => {
    const prepared = prepareV2(mask(), mask(targetGrid));
    const diagnostics = { ceilingMslM: new Float32Array(4).fill(2500), buoyancyM2S3: new Float32Array(4), branch: Uint8Array.of(FRAME_BRANCH.nonConvective, FRAME_BRANCH.surfaceStable, FRAME_BRANCH.nonConvective, FRAME_BRANCH.surfaceStable) };
    expect(prepared.derive(diagnostics, new Uint8Array(4).fill(STATUS_NO_LIFT), terrain([700]), day)).toEqual({
      values: Float32Array.of(0), flags: Uint8Array.of(STATUS_NO_LIFT)
    });
  });

  it.each([2000, 2200])('marks a valid ceiling at or below DEM %s as zero clearance', elevation => {
    const prepared = prepareTerrainClearance(mask(), mask(targetGrid));
    const result = prepared.derive(field([2000, 2000, 2000, 2000], [SUPPORT_PROFILE_TOP, 0, 0, 0]), terrain([elevation]), day);
    expect(result.values[0]).toBe(0);
    expect(result.flags[0]).toBe(STATUS_NO_LIFT | SUPPORT_PROFILE_TOP);
  });

  it('retains valid terrain elevations below sea level', () => {
    const prepared = prepareTerrainClearance(mask(), mask(targetGrid));
    const result = prepared.derive(field([0, 0, 0, 0]), terrain([-100]), day);
    expect(result.values[0]).toBe(100);
    expect(result.flags[0]).toBe(STATUS_VALID);
  });

  it.each([STATUS_UNAVAILABLE, STATUS_OUTSIDE, 32])('refuses a positive-weight contributor with state/flag %s', flag => {
    const prepared = prepareTerrainClearance(mask(), mask({ ...targetGrid, lon0: 0.1, lat0: 0.9 }));
    const result = prepared.derive(field(undefined, [SUPPORT_PARCEL_CROSSING, 0, 0, flag]), terrain(), day);
    expect(result.values[0]).toBeNaN();
    expect(result.flags[0]).toBe(STATUS_UNAVAILABLE);
  });

  it('does not treat an unmasked nonfinite ceiling as a usable observation', () => {
    const prepared = prepareTerrainClearance(mask(), mask(targetGrid));
    const result = prepared.derive(field([2800, NaN, 3400, 3600]), terrain(), day);
    expect(result.values[0]).toBeNaN();
    expect(result.flags[0]).toBe(STATUS_UNAVAILABLE);
  });

  it.each([[0, 0], [1800, 2], [NaN, 1], [Infinity, 1]])('keeps invalid DEM (%s, %s) unavailable', (elevation, valid) => {
    const prepared = prepareTerrainClearance(mask(), mask(targetGrid));
    const result = prepared.derive(field(), terrain([elevation], [valid]), day);
    expect(result.values[0]).toBeNaN();
    expect(result.flags[0]).toBe(STATUS_UNAVAILABLE);
  });

  it('never publishes an infinite Float32 difference', () => {
    const prepared = prepareTerrainClearance(mask(), mask(targetGrid));
    const result = prepared.derive(field([3e38, 3e38, 3e38, 3e38]), terrain([-3e38]), day);
    expect(result.values[0]).toBeNaN();
    expect(result.flags[0]).toBe(STATUS_UNAVAILABLE);
  });
});

describe('coverage and geometry', () => {
  it('preserves row-major native node values and support when grids coincide', () => {
    const prepared = prepareTerrainClearance(mask(), mask());
    const source = field(undefined, [SUPPORT_PARCEL_CROSSING, SUPPORT_PROFILE_TOP, STATUS_VALID, 0]);
    const result = prepared.derive(source, terrain([1800, 1800, 1800, 1800]), day);
    expect([...result.values]).toEqual([1000, 1400, 1600, 1800]);
    expect(result.flags).toEqual(source.flags);
  });

  it('requires every native contributor to be in output or halo coverage', () => {
    const target = mask(targetGrid);
    const missing = prepareTerrainClearance(mask(sourceGrid, [0, 1, 2]), target);
    expect(missing.derive(field(), terrain(), day).flags[0]).toBe(STATUS_UNAVAILABLE);
    const complete = prepareTerrainClearance(mask(sourceGrid, [0, 1, 2], [3]), target);
    expect(complete.derive(field(), terrain(), day).values[0]).toBe(1450);
  });

  it('calculates target output and halo while leaving other cells outside', () => {
    const grid = { ...targetGrid, width: 3, lon0: 0, lat0: 1, dx: 0.5 };
    const prepared = prepareTerrainClearance(mask(), mask(grid, [0], [2]));
    const result = prepared.derive(field(), terrain([1000, 1000, 1000]), day);
    expect([...result.values]).toEqual([1800, 0, 2200]);
    expect([...result.flags]).toEqual([STATUS_VALID, STATUS_OUTSIDE, STATUS_VALID]);
    expect(prepared.byteLength).toBe(106);
    expect(terrainClearanceMappingBytes(2)).toBe(prepared.byteLength);
  });

  it('uses only the actual grid node when all other contributors have zero weight', () => {
    const prepared = prepareTerrainClearance(mask(sourceGrid, [0]), mask({ ...targetGrid, lon0: 0, lat0: 1 }));
    const result = prepared.derive(field([2800, NaN, NaN, NaN], [0, 2, 2, 2]), terrain(), day);
    expect(result.values[0]).toBe(1000);
    expect(result.flags[0]).toBe(STATUS_VALID);
  });

  it.each([day, night])('does not extrapolate beyond native support at $validTime', time => {
    const prepared = prepareTerrainClearance(mask(), mask({ ...targetGrid, lon0: 1.01 }));
    const result = prepared.derive(field(), terrain(), time);
    expect(result.flags[0]).toBe(STATUS_UNAVAILABLE);
    expect(result.values[0]).toBeNaN();
  });

  it('handles longitude wrapping across the source seam', () => {
    const grid = { ...sourceGrid, width: 4, height: 1, lon0: -180, lat0: 0, dx: 90, wrapLongitude: true };
    const prepared = prepareTerrainClearance(mask(grid), mask({ ...targetGrid, lon0: 135, lat0: 0 }));
    expect(prepared.derive(field([100, 200, 300, 400]), terrain([50]), day, false).values[0]).toBe(200);
  });

  it('handles signed storage axes', () => {
    const grid = { ...sourceGrid, lon0: 1, lat0: 0, dx: -1, dy: 1 };
    const prepared = prepareTerrainClearance(mask(grid), mask({ ...targetGrid, lon0: 0.6, lat0: 0.25 }));
    expect(prepared.derive(field([10, 20, 30, 40]), terrain([0]), day).values[0]).toBe(19);
  });

  const projected: Grid = {
    kind: 'lambert-conformal', earthRadiusM: 6371229, width: 1, height: 1,
    centralMeridianDeg: 0, latitudeOfOriginDeg: 45, standardParallel1Deg: 30, standardParallel2Deg: 60,
    x0M: 0, y0M: 0, dxM: 1000, dyM: -1000, wrapLongitude: false
  };

  it('supports projected target coordinates', () => {
    const source = { ...sourceGrid, lon0: -1, lat0: 46, dx: 2, dy: -2 };
    const prepared = prepareTerrainClearance(mask(source), mask(projected));
    expect(prepared.derive(field(), terrain(), day).values[0]).toBe(1450);
  });

  it('supports projected source coordinates', () => {
    const source = { ...projected, width: 2, height: 2, x0M: -1000, y0M: 1000, dxM: 2000, dyM: -2000 };
    const prepared = prepareTerrainClearance(mask(source), mask({ ...targetGrid, lon0: 0, lat0: 45 }));
    expect(prepared.derive(field(), terrain(), day).values[0]).toBe(1450);
  });
});

describe('daylight and ownership', () => {
  it.each([
    { ...day, intervalStart: 'invalid' },
    { ...day, validTime: 'invalid' },
    { intervalStart: day.validTime, validTime: day.intervalStart }
  ])('rejects an invalid daylight interval $intervalStart to $validTime', time => {
    const prepared = prepareTerrainClearance(mask(), mask(targetGrid));
    expect(() => prepared.derive(field(), terrain(), time)).toThrow(/valid daylight interval/);
    expect(prepared.derive(field(), terrain(), time, false).values[0]).toBe(1450);
  });

  it('allows a single valid daylight instant', () => {
    const prepared = prepareTerrainClearance(mask(), mask(targetGrid));
    expect(prepared.derive(field(), terrain(), { intervalStart: day.validTime, validTime: day.validTime }).values[0]).toBe(1450);
  });

  it('uses the same interval start/midpoint/end admission as forecast frames', () => {
    const prepared = prepareTerrainClearance(mask(), mask(targetGrid));
    const interval = { intervalStart: day.validTime, validTime: '2026-03-21T00:00:00Z' };
    expect(prepared.derive(field(), terrain(), interval).values[0]).toBe(1450);
    expect(prepared.derive(field(), terrain(), night).flags[0]).toBe(STATUS_NO_LIFT);
    expect(prepared.derive(field(), terrain(), night, false).values[0]).toBe(1450);
  });

  it('skips weather at night but still requires known terrain', () => {
    const prepared = prepareTerrainClearance(mask(), mask(targetGrid));
    const missingWeather = field([NaN, NaN, NaN, NaN], [2, 2, 2, 2]);
    expect(prepared.derive(missingWeather, terrain(), night)).toEqual({ values: Float32Array.of(0), flags: Uint8Array.of(STATUS_NO_LIFT) });
    const missingTerrain = prepared.derive(missingWeather, terrain([0], [0]), night);
    expect(missingTerrain.values[0]).toBeNaN();
    expect(missingTerrain.flags[0]).toBe(STATUS_UNAVAILABLE);
  });

  it('requires dark-skipped native physics for sunlit targets but not dark targets', () => {
    const prepared = prepareV2(mask(), mask(targetGrid));
    const diagnostics = { ceilingMslM: new Float32Array(4).fill(3000), buoyancyM2S3: new Float32Array(4).fill(1), branch: new Uint8Array(4).fill(FRAME_BRANCH.parcelCrossing) };
    diagnostics.branch[0] = FRAME_BRANCH.skippedDark;
    diagnostics.ceilingMslM[0] = NaN;
    diagnostics.buoyancyM2S3[0] = NaN;
    const flags = Uint8Array.of(STATUS_NO_LIFT, STATUS_VALID, STATUS_VALID, STATUS_VALID);
    expect(prepared.derive(diagnostics, flags, terrain(), day).flags[0]).toBe(STATUS_UNAVAILABLE);
    expect(prepared.derive(diagnostics, flags, terrain(), night)).toEqual({ values: Float32Array.of(0), flags: Uint8Array.of(STATUS_NO_LIFT) });
    diagnostics.ceilingMslM[0] = 3000;
    diagnostics.buoyancyM2S3[0] = 0;
    expect(prepared.derive(diagnostics, flags, terrain(), day).flags[0]).toBe(STATUS_UNAVAILABLE);
  });

  it('rejects a dark native contributor at a sunlit twilight target', () => {
    const grid = { ...sourceGrid, width: 2, height: 1, lon0: 1, lat0: 0 };
    const source = mask(grid), target = mask({ ...targetGrid, lon0: 1.5, lat0: 0 });
    const frame = normalizedFixtureFrame(grid, Uint32Array.of(0, 1), '2026-03-20T00:00:00Z', 6, 1);
    frame.intervals.fluxWindow.start = frame.validAt;
    const diagnostics = { ceilingMslM: new Float32Array(2), buoyancyM2S3: new Float32Array(2), branch: new Uint8Array(2) };
    const native = deriveFrame(frame, source, { layers: ['usable-lift-agl'], diagnostics })['usable-lift-agl']!;
    expect(diagnostics.branch[0]).toBe(FRAME_BRANCH.skippedDark);
    expect(diagnostics.branch[1]).not.toBe(FRAME_BRANCH.skippedDark);
    const result = prepareV2(source, target).derive(diagnostics, native.flags, terrain(), { intervalStart: frame.validAt, validTime: frame.validAt });
    expect(result.flags[0]).toBe(STATUS_UNAVAILABLE);
    expect(result.values[0]).toBeNaN();
  });

  it('snapshots coverage and geometry without retaining mutable mask inputs', () => {
    const source = mask(), target = mask(targetGrid);
    const prepared = prepareTerrainClearance(source, target);
    source.output.fill(0); source.halo.fill(0); target.output.fill(0); target.halo.fill(0);
    source.grid.width = 10; target.grid.height = 10;
    if (target.grid.kind === 'regular-latlon') target.grid.lon0 = 180;
    expect(prepared.derive(field(), terrain(), day).values[0]).toBe(1450);
  });

  it('leaves input arrays untouched and returns independent fields for every call', () => {
    const prepared = prepareTerrainClearance(mask(), mask(targetGrid));
    const source = field(), dem = terrain(), originalSource = structuredClone(source), originalTerrain = structuredClone(dem);
    const first = prepared.derive(source, dem, day);
    expect(source).toEqual(originalSource);
    expect(dem).toEqual(originalTerrain);
    first.values[0] = -100; first.flags[0] = STATUS_OUTSIDE;
    source.values.fill(4000); dem.elevationM[0] = 2000;
    const second = prepared.derive(source, dem, day);
    expect(second.values[0]).toBe(2000);
    expect(second.flags[0]).toBe(STATUS_VALID);
    expect(first.values[0]).toBe(-100);
    expect(first.flags[0]).toBe(STATUS_OUTSIDE);
  });

  it('allocates no mapping for an empty target mask', () => {
    const prepared = prepareTerrainClearance(mask(), mask(targetGrid, []));
    expect(prepared.byteLength).toBe(0);
    expect(terrainClearanceMappingBytes(0)).toBe(prepared.byteLength);
    expect(prepared.derive(field(), terrain(), day).flags[0]).toBe(STATUS_OUTSIDE);
  });

  it('rejects malformed grids and masks before allocating the mapping', () => {
    const source = mask(), target = mask(targetGrid);
    expect(() => prepareTerrainClearance({ ...source, grid: { ...sourceGrid, width: MAX_GRID_CELLS + 1, height: 1 } }, target)).toThrow(/budget/);
    expect(() => prepareTerrainClearance(source, { ...target, grid: { ...targetGrid, dx: 0 } })).toThrow();
    expect(() => prepareTerrainClearance({ ...source, halo: new Uint8Array(0) }, target)).toThrow(/coverage size/);
    expect(() => prepareTerrainClearance(source, { ...target, output: new Uint8Array(0) })).toThrow(/coverage size/);
  });

  it.each([-1, 0.5, NaN, Infinity, MAX_GRID_CELLS + 1])('rejects inadmissible mapping allocation counts %s', count => {
    expect(() => terrainClearanceMappingBytes(count)).toThrow(/active cell budget/);
  });

  it('rejects mismatched source and terrain array dimensions', () => {
    const prepared = prepareTerrainClearance(mask(), mask(targetGrid));
    expect(() => prepared.derive(field([3000]), terrain(), day)).toThrow(/input size/);
    expect(() => prepared.derive({ ...field(), flags: new Uint8Array(0) }, terrain(), day)).toThrow(/input size/);
    expect(() => prepared.derive(field(), terrain([1800, 1800]), day)).toThrow(/input size/);
    expect(() => prepared.derive(field(), { ...terrain(), valid: new Uint8Array(0) }, day)).toThrow(/input size/);
  });
});
