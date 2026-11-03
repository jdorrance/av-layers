import { describe, expect, it } from 'vitest';
import {
  LENSCHOW_F_MAX,
  MINIMUM_THERMAL_VELOCITY_MPS,
  SINK_RATE_MPS,
  SINK_RATE_PRESETS_MPS,
  WXTOFLY_SINK_MPS,
  deriveLift,
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

  it('allows overriding sinkRateMps, minimumThermalVelocityMps, and dryLapseRateKperM in deriveLift', () => {
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

    const defaultOut = deriveLift(column, column.levels.length);
    const wxtoflyOut = deriveLift(column, column.levels.length, {
      sinkRateMps: SINK_RATE_PRESETS_MPS.wxtofly
    });
    const sailplaneOut = deriveLift(column, column.levels.length, {
      sinkRateMps: SINK_RATE_PRESETS_MPS.sailplane
    });
    const heavySinkOut = deriveLift(column, column.levels.length, {
      sinkRateMps: 2.5
    });
    const highMinWStarOut = deriveLift(column, column.levels.length, {
      minimumThermalVelocityMps: 5.0
    });

    expect(defaultOut.status).toBe('valid');
    expect(wxtoflyOut.status).toBe('valid');
    expect(sailplaneOut.status).toBe('valid');
    // Lower sink rate (1.0 m/s < 1.143 m/s < 1.2 m/s) achieves progressively higher usable lift ceiling
    expect(wxtoflyOut.usableDepthM!).toBeGreaterThan(defaultOut.usableDepthM!);
    expect(sailplaneOut.usableDepthM!).toBeGreaterThan(wxtoflyOut.usableDepthM!);
    // High sink rate or high minimum w* floor suppresses lift to 'no-lift'
    expect(heavySinkOut.status).toBe('no-lift');
    expect(heavySinkOut.usableDepthM).toBe(0);
    expect(highMinWStarOut.status).toBe('no-lift');
    expect(highMinWStarOut.usableDepthM).toBe(0);
  });
});
