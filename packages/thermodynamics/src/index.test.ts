import { describe, expect, it } from 'vitest';
import {
  DRY_AIR_CP,
  DRY_AIR_GAS_CONSTANT,
  DRY_LAPSE_RATE_K_PER_M,
  GRAVITY_MPS2,
  ZERO_CELSIUS_K,
  celsiusToKelvin,
  dewpointFromTempAndRhC,
  dryParcelTemperatureK,
  kelvinToCelsius,
  lclHeightMetersAgl,
  potentialTemperatureK,
  saturationMixingRatioGPerKg,
  saturationVaporPressureHpa,
  surfaceKinematicHeatFluxKmPerS,
  virtualPotentialTemperatureK
} from './index.js';

describe('@av/thermodynamics', () => {
  it('converts temperatures and computes dry-adiabatic parcel cooling', () => {
    expect(celsiusToKelvin(0)).toBe(ZERO_CELSIUS_K);
    expect(kelvinToCelsius(ZERO_CELSIUS_K + 20)).toBeCloseTo(20, 6);
    expect(dryParcelTemperatureK(300, 500, 1500)).toBeCloseTo(
      300 - 1000 * DRY_LAPSE_RATE_K_PER_M,
      6
    );
    expect(GRAVITY_MPS2 / DRY_AIR_CP).toBeCloseTo(0.009767, 5);
    expect(DRY_AIR_GAS_CONSTANT).toBe(287.05);
  });

  it('computes potential temperature, vapor pressure, dewpoint, and LCL', () => {
    expect(potentialTemperatureK(293.15, 1000)).toBeCloseTo(293.15, 6);
    expect(potentialTemperatureK(283.15, 850)).toBeGreaterThan(295);
    expect(virtualPotentialTemperatureK(293.15, 1000, 0.01)).toBeGreaterThan(293.15);

    const es20 = saturationVaporPressureHpa(20);
    expect(es20).toBeCloseTo(23.37, 1);
    expect(saturationMixingRatioGPerKg(1000, 20)).toBeGreaterThan(14);

    const dp = dewpointFromTempAndRhC(20, 50);
    expect(dp).toBeCloseTo(9.27, 1);
    expect(lclHeightMetersAgl(20, 10)).toBe(1250);
  });

  it('computes surface kinematic sensible heat flux in K*m/s', () => {
    expect(surfaceKinematicHeatFluxKmPerS(240, 1.15, 1004)).toBeCloseTo(240 / (1.15 * 1004), 6);
    expect(surfaceKinematicHeatFluxKmPerS(-50)).toBe(0);
  });
});
