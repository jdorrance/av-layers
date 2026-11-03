/** Dry-air thermodynamic kernels. Inputs and outputs use the units in each name. */
import {
  DRY_AIR_CP,
  DRY_LAPSE_RATE_K_PER_M,
  POISSON_EXPONENT_DRY_AIR,
  STANDARD_PRESSURE_HPA,
  THERMODYNAMIC_CONSTANTS,
  WATER_DRY_AIR_MOLAR_MASS_RATIO,
  ZERO_CELSIUS_K
} from './constants.js';
export * from './constants.js';

const {
  saturationVaporPressureScaleHpa: SATURATION_SCALE_HPA,
  saturationExponent: SATURATION_EXPONENT,
  saturationTemperatureOffsetC: SATURATION_OFFSET_C
} = THERMODYNAMIC_CONSTANTS;

export const kelvinToCelsius = (kelvin: number): number => kelvin - ZERO_CELSIUS_K;

export const celsiusToKelvin = (celsius: number): number => celsius + ZERO_CELSIUS_K;

/**
 * Potential temperature θ (K) from temperature T (K) and pressure P (hPa).
 */
export const potentialTemperatureK = (temperatureK: number, pressureHpa: number): number => {
  if (!Number.isFinite(temperatureK) || !Number.isFinite(pressureHpa) || pressureHpa <= 0) {
    return NaN;
  }
  return temperatureK * (STANDARD_PRESSURE_HPA / pressureHpa) ** POISSON_EXPONENT_DRY_AIR;
};

/**
 * Virtual potential temperature θ_v (K) from temperature T (K), pressure P (hPa),
 * and water-vapor mixing ratio r (kg/kg).
 */
export const virtualPotentialTemperatureK = (
  temperatureK: number,
  pressureHpa: number,
  mixingRatioKgKg = 0
): number => {
  const theta = potentialTemperatureK(temperatureK, pressureHpa);
  if (!Number.isFinite(theta)) {
    return NaN;
  }
  const r = Number.isFinite(mixingRatioKgKg) && mixingRatioKgKg > 0 ? mixingRatioKgKg : 0;
  return theta * (1 + 0.61 * r);
};

/**
 * Bolton (1980) saturation vapor pressure e_s (hPa) over liquid water from temperature (°C),
 * using the shared thermodynamic constants.
 */
export const saturationVaporPressureHpa = (tempC: number): number => {
  if (!Number.isFinite(tempC)) {
    return NaN;
  }
  return (
    SATURATION_SCALE_HPA *
    Math.exp((SATURATION_EXPONENT * tempC) / (tempC + SATURATION_OFFSET_C))
  );
};

/**
 * Saturation mixing ratio w_s (g/kg) from pressure (hPa) and temperature (°C),
 * using `1000 * WATER_DRY_AIR_MOLAR_MASS_RATIO` (622 g/kg).
 */
export const saturationMixingRatioGPerKg = (pressureHpa: number, tempC: number): number => {
  const es = saturationVaporPressureHpa(tempC);
  if (!Number.isFinite(es) || !Number.isFinite(pressureHpa) || pressureHpa <= es) {
    return NaN;
  }
  return (1000 * WATER_DRY_AIR_MOLAR_MASS_RATIO * es) / (pressureHpa - es);
};

/**
 * Dewpoint temperature (°C) from ambient temperature (°C) and relative humidity (%).
 */
export const dewpointFromTempAndRhC = (tempC: number, rhPercent: number): number => {
  if (!Number.isFinite(tempC) || !Number.isFinite(rhPercent) || rhPercent <= 0) {
    return NaN;
  }
  const clampedRh = Math.min(100, Math.max(0.1, rhPercent));
  const es = saturationVaporPressureHpa(tempC);
  const e = (es * clampedRh) / 100;
  const lnRatio = Math.log(e / SATURATION_SCALE_HPA);
  return (SATURATION_OFFSET_C * lnRatio) / (SATURATION_EXPONENT - lnRatio);
};

/**
 * Espy / dry-adiabatic lifted condensation level (LCL) height AGL in meters.
 */
export const lclHeightMetersAgl = (surfaceTempC: number, surfaceDewpointC: number): number => {
  if (!Number.isFinite(surfaceTempC) || !Number.isFinite(surfaceDewpointC)) {
    return NaN;
  }
  const spread = Math.max(0, surfaceTempC - surfaceDewpointC);
  return 125 * spread;
};

/**
 * Dry-adiabatic parcel temperature at target altitude `zM` given initial
 * parcel temperature `t0` at altitude `z0M` and dry lapse rate `dryLapseRateKperM`.
 * Because 1 K/m === 1 °C/m, this linear cooling holds in either °C or K.
 */
export const dryParcelTemperature = (
  t0: number,
  z0M: number,
  zM: number,
  dryLapseRateKperM: number = DRY_LAPSE_RATE_K_PER_M
): number => t0 - dryLapseRateKperM * (zM - z0M);

/**
 * Dry-adiabatic parcel temperature in Celsius (°C) at target altitude `zM` (m)
 * given initial parcel temperature `t0C` (°C) at altitude `z0M` (m).
 */
export const dryParcelTemperatureC = dryParcelTemperature;

/**
 * Dry-adiabatic parcel temperature in Kelvin (K) at target altitude `zM` (m)
 * given initial parcel temperature `t0K` (K) at altitude `z0M` (m).
 */
export const dryParcelTemperatureK = dryParcelTemperature;

/**
 * Surface kinematic sensible heat flux w'θ'_0 (K·m/s) from upward surface sensible
 * heat flux H (W/m²) and air density ρ (kg/m³):
 *
 *   w'θ'_0 = H / (ρ · c_p)
 */
export const surfaceKinematicHeatFluxKmPerS = (
  sensibleHeatFluxWm2: number,
  airDensityKgM3 = 1.15,
  cpJPerKgK: number = DRY_AIR_CP
): number => {
  if (
    !Number.isFinite(sensibleHeatFluxWm2) ||
    !Number.isFinite(airDensityKgM3) ||
    airDensityKgM3 <= 0 ||
    !Number.isFinite(cpJPerKgK) ||
    cpJPerKgK <= 0
  ) {
    return NaN;
  }
  return Math.max(0, sensibleHeatFluxWm2) / (airDensityKgM3 * cpJPerKgK);
};
