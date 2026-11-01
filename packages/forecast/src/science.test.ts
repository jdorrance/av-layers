import { describe, expect, it } from 'vitest';
import { STATUS_MASK, STATUS_NO_LIFT, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_PARCEL_CROSSING, SUPPORT_PBL_CLOSURE, SUPPORT_PROFILE_TOP } from '@av/contracts';
import { deriveColumn as deriveCountedColumn, dewPointMixingRatioKgKg, LENSCHOW_F_MAX, precipitationRateStatus, usableLiftDepthM, type ColumnInput } from './science.js';

const base: ColumnInput = { terrainM: 0, surfaceTemperatureC: 20, surfacePressureHpa: 1000, humidity: { specificHumidityKgKg: 0.008 }, sensibleHeatFluxWm2: 250, latentHeatFluxWm2: 100, pblHeightM: 300, levels: [{ heightM: 500, temperatureC: 13 }, { heightM: 1000, temperatureC: 9 }, { heightM: 1500, temperatureC: 8 }] };
const deriveColumn = (input: ColumnInput) => deriveCountedColumn(input, input.levels.length);

describe('dry column science', () => {
  it('admits zero and positive normalized rain and marks negative or non-finite rates unavailable', () => {
    for (const rate of [0, -0, 0.001, 27.5]) expect(precipitationRateStatus(rate)).toBe(STATUS_VALID);
    for (const rate of [-0.001, -1, NaN, Infinity, -Infinity]) expect(precipitationRateStatus(rate)).toBe(STATUS_UNAVAILABLE);
  });
  it('uses only the explicit active level count and rejects invalid scratch counts', () => {
    const levels = [...base.levels.map(level => ({ ...level })), { heightM: NaN, temperatureC: NaN }];
    for (const count of [3, 1, 2, 0, 3]) {
      expect(deriveCountedColumn({ ...base, levels }, count)).toEqual(deriveColumn({ ...base, levels: base.levels.slice(0, count) }));
    }
    for (const count of [-1, 0.5, 5, NaN, Infinity]) expect(() => deriveCountedColumn({ ...base, levels }, count)).toThrow('level count');
  });
  it('preserves the fixed-iteration lift-depth result at thresholds and across seeded brackets', () => {
    // Frozen algorithm before the stagnation optimization; exact doubles matter.
    const reference = (depth: number, velocity: number): number | null => {
      const curve = (z: number) => 4 * Math.cbrt(z) * (1 - 0.8 * z);
      if (!Number.isFinite(depth) || !Number.isFinite(velocity) || depth <= 0 || velocity <= 0 || velocity * LENSCHOW_F_MAX < 1.2) return null;
      if (velocity * curve(1) >= 1.2) return depth;
      let lo = 0.3125, hi = 1;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (velocity * curve(mid) >= 1.2) lo = mid; else hi = mid;
      }
      return depth * (lo + hi) / 2;
    };
    let seed = 0x6352e7;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (const depth of [Number.MIN_VALUE, 1, 10_000, Number.MAX_VALUE, NaN, -1]) {
      for (const velocity of [0, 1.2 / LENSCHOW_F_MAX, (1.2 / LENSCHOW_F_MAX) * (1 + Number.EPSILON), 1.5, 10, NaN]) {
        expect(usableLiftDepthM(depth, velocity)).toBe(reference(depth, velocity));
      }
    }
    for (let i = 0; i < 10_000; i++) {
      const depth = 10 ** (random() * 8 - 3), velocity = 0.5 + random() * 1.2;
      expect(usableLiftDepthM(depth, velocity)).toBe(reference(depth, velocity));
    }
  });
  it('validates upper levels even when crossing or non-convection could return early', () => {
    const levels = [{ heightM: 500, temperatureC: 20 }, { heightM: 400, temperatureC: 0 }];
    for (const sensibleHeatFluxWm2 of [-100, 250]) {
      expect(deriveColumn({ ...base, sensibleHeatFluxWm2, levels }).branch).toBe('unavailable');
    }
  });
  it('resolves a crossing above PBL and does not require PBL', () => {
    const a = deriveColumn({ ...base, pblHeightM: null });
    expect(a.branch).toBe('parcel-crossing'); expect(a.depthM).toBeGreaterThan(300); expect(a.depthM).toBeCloseTo(1153.8461538, 4);
    expect(a.msl.flags).toBe(STATUS_VALID | SUPPORT_PARCEL_CROSSING);
  });
  it('preserves equality at the surface anchor and handles first-level equality via closure', () => {
    const x = deriveColumn({ ...base, levels: [{ heightM: 500, temperatureC: 15.1 }], pblHeightM: 250 });
    expect(x.branch).toBe('model-pbl-fallback'); expect(x.depthM).toBe(250); expect(x.msl.flags & SUPPORT_PBL_CLOSURE).toBeTruthy();
    expect(deriveColumn({ ...base, pblHeightM: undefined, levels: [{ heightM: 500, temperatureC: 16 }] }).branch).toBe('unavailable');
  });
  it('flags profile-top without extending or requiring PBL', () => {
    const x = deriveColumn({ ...base, pblHeightM: null, levels: [{ heightM: 500, temperatureC: 13 }, { heightM: 1000, temperatureC: 8 }] });
    expect(x.depthM).toBe(1000); expect(x.branch).toBe('profile-top'); expect(x.msl.flags & SUPPORT_PROFILE_TOP).toBeTruthy();
  });
  it('requires explicit surface pressure, humidity, flux and profile coverage', () => {
    for (const x of [ { ...base, surfacePressureHpa: NaN }, { ...base, humidity: { specificHumidityKgKg: NaN } }, { ...base, sensibleHeatFluxWm2: NaN }, { ...base, levels: [] }, { ...base, levels: [{ heightM: 1001, temperatureC: 0 }] }, { ...base, levels: [{ heightM: 500, temperatureC: 0 }, { heightM: 1501, temperatureC: -10 }] } ]) expect(deriveColumn(x).msl.flags & STATUS_MASK).toBe(STATUS_UNAVAILABLE);
  });
  it('reports verified cooling as no-lift with internal terrain and negative terrain correctly', () => {
    const x = deriveColumn({ ...base, terrainM: -100, sensibleHeatFluxWm2: -100, latentHeatFluxWm2: 0 });
    expect(x.msl).toEqual({ value: -100, flags: STATUS_NO_LIFT }); expect(x.agl.value).toBe(0);
    const y = deriveColumn({ ...base, terrainM: -100, levels: base.levels.map(l => ({ ...l, heightM: l.heightM - 100 })) });
    expect(y.msl.value! - y.agl.value!).toBeCloseTo(-100, 8);
  });
  it('uses equivalent direct specific humidity and dew point mixing ratios', () => {
    const r = dewPointMixingRatioKgKg(10, 1000)!;
    const a = deriveColumn({ ...base, humidity: { dewPointC: 10 } });
    const b = deriveColumn({ ...base, humidity: { specificHumidityKgKg: r / (1 + r) } });
    expect(a.thermalVelocityMps).toBeCloseTo(b.thermalVelocityMps!, 12); expect(a.agl.value).toBeCloseTo(b.agl.value!, 10);
  });
  it('admits equivalent humidity below, at, and within 1 ppm vapor-pressure saturation tolerance', () => {
    for (const dewPointC of [10, 20, 20.000005]) {
      const r = dewPointMixingRatioKgKg(dewPointC, 1000)!;
      const dew = deriveColumn({ ...base, humidity: { dewPointC } });
      const specific = deriveColumn({ ...base, humidity: { specificHumidityKgKg: r / (1 + r) } });
      expect(dew.msl.flags & STATUS_MASK).toBe(STATUS_VALID);
      expect(specific.msl.flags).toBe(dew.msl.flags);
      expect(specific.thermalVelocityMps).toBeCloseTo(dew.thermalVelocityMps!, 12);
    }
  });
  it('rejects equivalent humidity beyond 1 ppm vapor-pressure saturation tolerance', () => {
    for (const dewPointC of [20.0001, 30]) {
      const r = dewPointMixingRatioKgKg(dewPointC, 1000)!;
      for (const humidity of [{ dewPointC }, { specificHumidityKgKg: r / (1 + r) }]) {
        expect(deriveColumn({ ...base, humidity }).msl.flags & STATUS_MASK).toBe(STATUS_UNAVAILABLE);
      }
    }
    expect(deriveColumn({ ...base, humidity: { specificHumidityKgKg: 0.08 } }).msl.flags & STATUS_MASK).toBe(STATUS_UNAVAILABLE);
  });
  it('applies the same 1 ppm threshold to both representations across the boundary', () => {
    const saturation = 6.112 * Math.exp(17.67 * 20 / (20 + 243.5));
    for (const [relativeExcess, expected] of [[0.9e-6, STATUS_VALID], [1.1e-6, STATUS_UNAVAILABLE]] as const) {
      const vaporPressure = saturation * (1 + relativeExcess);
      const logarithm = Math.log(vaporPressure / 6.112);
      const dewPointC = 243.5 * logarithm / (17.67 - logarithm);
      const r = 0.622 * vaporPressure / (1000 - vaporPressure);
      const specificHumidityKgKg = r / (1 + r);
      expect(deriveColumn({ ...base, humidity: { dewPointC } }).msl.flags & STATUS_MASK).toBe(expected);
      expect(deriveColumn({ ...base, humidity: { specificHumidityKgKg } }).msl.flags & STATUS_MASK).toBe(expected);
    }
    const r = dewPointMixingRatioKgKg(20, 1000)!;
    expect(deriveColumn({ ...base, humidity: { specificHumidityKgKg: Math.fround(r / (1 + r)) } }).msl.flags & STATUS_MASK).toBe(STATUS_VALID);
  });
  it('rejects missing and invalid humidity without a dry-air fallback', () => {
    for (const humidity of [{ specificHumidityKgKg: -0.01 }, { specificHumidityKgKg: 1 }, { specificHumidityKgKg: Infinity }, { specificHumidityKgKg: NaN }, { dewPointC: -101 }, { dewPointC: 61 }, { dewPointC: NaN }]) {
      const result = deriveColumn({ ...base, humidity });
      expect(result.msl.flags & STATUS_MASK).toBe(STATUS_UNAVAILABLE);
      expect(result.agl.flags & STATUS_MASK).toBe(STATUS_UNAVAILABLE);
    }
    expect(deriveColumn({ ...base, humidity: undefined as unknown as ColumnInput['humidity'] }).branch).toBe('unavailable');
  });
  it('admits physically possible warm saturated humidity above 0.1 kg/kg in either representation', () => {
    const r = dewPointMixingRatioKgKg(60, 1000)!;
    const specificHumidityKgKg = r / (1 + r);
    expect(specificHumidityKgKg).toBeGreaterThan(0.1);
    const dew = deriveColumn({ ...base, surfaceTemperatureC: 60, humidity: { dewPointC: 60 } });
    const specific = deriveColumn({ ...base, surfaceTemperatureC: 60, humidity: { specificHumidityKgKg } });
    expect(dew.msl.flags & STATUS_MASK).toBe(STATUS_VALID);
    expect(specific.thermalVelocityMps).toBeCloseTo(dew.thermalVelocityMps!, 12);
  });
  it('applies the 1.2 m/s threshold at peak and resolved top', () => {
    expect(usableLiftDepthM(1000, 1.2 / LENSCHOW_F_MAX - 1e-6)).toBeNull();
    expect(usableLiftDepthM(1000, 1.2 / LENSCHOW_F_MAX)).toBeCloseTo(312.5, 3);
    expect(usableLiftDepthM(1000, 1.5)).toBe(1000);
    expect(usableLiftDepthM(1000, 1)).toBeGreaterThan(312.5); expect(usableLiftDepthM(1000, 1)).toBeLessThan(1000);
  });
});
