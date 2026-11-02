import { describe, expect, it } from 'vitest';
import { STATUS_MASK, STATUS_NO_LIFT, STATUS_VALID } from '@av/contracts';
import {
  LENSCHOW_F_MAX,
  MINIMUM_THERMAL_VELOCITY_MPS,
  SINK_RATE_MPS,
  SINK_RATE_PRESETS_MPS,
  WXTOFLY_SINK_MPS,
  deriveColumn,
  minimumConvectiveVelocityForSinkMps,
  usableLiftDepthM
} from './index.js';

describe('@av/soaring configurable m/s thresholds and presets', () => {
  it('exposes explicit m/s presets for sailplane, wxtofly, and paraglider sink rates', () => {
    expect(SINK_RATE_PRESETS_MPS.sailplane).toBe(1.0);
    expect(SINK_RATE_PRESETS_MPS.wxtofly).toBeCloseTo(1.143, 6);
    expect(WXTOFLY_SINK_MPS).toBeCloseTo(1.143, 6);
    expect(SINK_RATE_PRESETS_MPS.paraglider).toBe(1.2);
    expect(SINK_RATE_MPS).toBe(1.2);
    expect(MINIMUM_THERMAL_VELOCITY_MPS).toBe(0);
  });

  it('computes minimum convective velocity w* (m/s) for any sink rate (m/s)', () => {
    const minWStarParaglider = minimumConvectiveVelocityForSinkMps(SINK_RATE_PRESETS_MPS.paraglider);
    const minWStarSailplane = minimumConvectiveVelocityForSinkMps(SINK_RATE_PRESETS_MPS.sailplane);
    expect(minWStarParaglider).toBeCloseTo(1.2 / LENSCHOW_F_MAX, 8);
    expect(minWStarSailplane).toBeLessThan(minWStarParaglider);

    // Just below the minimum w* threshold yields null usable lift depth
    expect(usableLiftDepthM(2000, minWStarParaglider * 0.999)).toBeNull();
    // Above the minimum w* threshold yields positive usable lift depth
    expect(usableLiftDepthM(2000, minWStarParaglider * 1.05)).toBeGreaterThan(600);
  });

  it('allows overriding sinkRateMps, minimumThermalVelocityMps, and dryLapseRateKperM in deriveColumn', () => {
    const column = {
      terrainM: 500,
      surfacePressureHpa: 950,
      surfaceTemperatureC: 25,
      humidity: { specificHumidityKgKg: 0.007 },
      pblHeightM: 1800,
      sensibleHeatFluxWm2: 20,
      latentHeatFluxWm2: 5,
      levels: [
        { heightM: 700, temperatureC: 22.85 },
        { heightM: 1300, temperatureC: 16.95 },
        { heightM: 1900, temperatureC: 11.25 },
        { heightM: 2500, temperatureC: 7.65 },
        { heightM: 3100, temperatureC: 5.35 }
      ]
    };

    const defaultOut = deriveColumn(column, column.levels.length);
    const wxtoflyOut = deriveColumn(column, column.levels.length, {
      sinkRateMps: SINK_RATE_PRESETS_MPS.wxtofly
    });
    const sailplaneOut = deriveColumn(column, column.levels.length, {
      sinkRateMps: SINK_RATE_PRESETS_MPS.sailplane
    });
    const heavySinkOut = deriveColumn(column, column.levels.length, {
      sinkRateMps: 2.5
    });
    const highMinWStarOut = deriveColumn(column, column.levels.length, {
      minimumThermalVelocityMps: 5.0
    });

    expect(defaultOut.agl.flags & STATUS_MASK).toBe(STATUS_VALID);
    expect(wxtoflyOut.agl.flags & STATUS_MASK).toBe(STATUS_VALID);
    expect(sailplaneOut.agl.flags & STATUS_MASK).toBe(STATUS_VALID);
    // Lower sink rate (1.0 m/s < 1.143 m/s < 1.2 m/s) achieves progressively higher usable lift ceiling
    expect(wxtoflyOut.agl.value!).toBeGreaterThan(defaultOut.agl.value!);
    expect(sailplaneOut.agl.value!).toBeGreaterThan(wxtoflyOut.agl.value!);
    // High sink rate or high minimum w* floor suppresses lift to STATUS_NO_LIFT
    expect(heavySinkOut.agl.flags & STATUS_MASK).toBe(STATUS_NO_LIFT);
    expect(heavySinkOut.agl.value).toBe(0);
    expect(highMinWStarOut.agl.flags & STATUS_MASK).toBe(STATUS_NO_LIFT);
    expect(highMinWStarOut.agl.value).toBe(0);
  });
});
