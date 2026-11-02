/**
 * Pure atmospheric thermodynamics, dry-adiabatic lapse rate, and buoyancy equations.
 *
 * Ported from windgrams/packages/meteorology/src/thermodynamics.ts and @av/forecast/science.
 */

export const ZERO_CELSIUS_K = 273.15;
export const GRAVITY_MPS2 = 9.80665;
export const DRY_AIR_GAS_CONSTANT = 287.05;
export const DRY_AIR_CP = 1004;
export const STANDARD_PRESSURE_HPA = 1000;
export const POISSON_EXPONENT_DRY_AIR = DRY_AIR_GAS_CONSTANT / DRY_AIR_CP; // ~0.285714

/**
 * Standard dry-adiabatic lapse rate Γ_d = g / c_p in K/m (≈ 0.00976–0.0098 K/m).
 */
export const DRY_LAPSE_RATE_K_PER_M = 0.0098;

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
 * Bolton (1980) saturation vapor pressure e_s (hPa) over liquid water from temperature (°C).
 */
export const saturationVaporPressureHpa = (tempC: number): number => {
  if (!Number.isFinite(tempC)) {
    return NaN;
  }
  return 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5));
};

/**
 * Saturation mixing ratio w_s (g/kg) from pressure (hPa) and temperature (°C).
 */
export const saturationMixingRatioGPerKg = (pressureHpa: number, tempC: number): number => {
  const es = saturationVaporPressureHpa(tempC);
  if (!Number.isFinite(es) || !Number.isFinite(pressureHpa) || pressureHpa <= es) {
    return NaN;
  }
  return (621.97 * es) / (pressureHpa - es);
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
  const lnRatio = Math.log(e / 6.112);
  return (243.5 * lnRatio) / (17.67 - lnRatio);
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
 * Dry-adiabatic parcel temperature (K) at target altitude `zM` given initial
 * parcel temperature `t0K` at altitude `z0M` and dry lapse rate `dryLapseRateKperM`.
 */
export const dryParcelTemperatureK = (
  t0K: number,
  z0M: number,
  zM: number,
  dryLapseRateKperM = DRY_LAPSE_RATE_K_PER_M
): number => t0K - dryLapseRateKperM * (zM - z0M);

/**
 * Surface kinematic sensible heat flux w'θ'_0 (K·m/s) from upward surface sensible
 * heat flux H (W/m²) and air density ρ (kg/m³):
 *
 *   w'θ'_0 = H / (ρ · c_p)
 */
export const surfaceKinematicHeatFluxKmPerS = (
  sensibleHeatFluxWm2: number,
  airDensityKgM3 = 1.15,
  cpJPerKgK = DRY_AIR_CP
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
