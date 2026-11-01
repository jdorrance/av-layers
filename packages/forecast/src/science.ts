import { LIFT_METHOD, LIFT_METHOD_PARAMETERS, PRECIPITATION_METHOD_PARAMETERS, STATUS_NO_LIFT, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_PARCEL_CROSSING, SUPPORT_PBL_CLOSURE, SUPPORT_PROFILE_TOP } from '@av/contracts';

export const METHOD_ID = LIFT_METHOD.id;
export const SINK_RATE_MPS = LIFT_METHOD_PARAMETERS.sinkRateMps;
export const LENSCHOW_PEAK_ZETA = LIFT_METHOD_PARAMETERS.lenschowPeakZeta;
const {
  lenschowScale: LENSCHOW_SCALE, lenschowShape: LENSCHOW_SHAPE,
  waterDryAirMolarMassRatio: EPSILON, dryAirGasConstantJkgK: RD, dryAirHeatCapacityJkgK: CP, latentHeatVaporizationJkg: LV, gravityMps2: G,
  kelvinOffset: KELVIN_OFFSET, pascalsPerHectopascal: PA_PER_HPA, dryLapseRateKperM: DRY_LAPSE_RATE,
  saturationRelativeTolerance: SATURATION_RELATIVE_TOLERANCE, saturationVaporPressureScaleHpa: SATURATION_SCALE, saturationExponent: SATURATION_EXPONENT, saturationTemperatureOffsetC: SATURATION_OFFSET,
  minimumSurfaceTemperatureC: MIN_SURFACE_TEMPERATURE, maximumSurfaceTemperatureC: MAX_SURFACE_TEMPERATURE,
  minimumSurfacePressureHpa: MIN_SURFACE_PRESSURE, maximumSurfacePressureHpa: MAX_SURFACE_PRESSURE,
  minimumProfileTemperatureC: MIN_PROFILE_TEMPERATURE, maximumProfileTemperatureC: MAX_PROFILE_TEMPERATURE, maximumProfileGapM: MAX_PROFILE_GAP,
  crossingEpsilonMultiplier: CROSSING_EPSILON_MULTIPLIER, maximumBisectionIterations: MAX_BISECTION_ITERATIONS
} = LIFT_METHOD_PARAMETERS;
export const LENSCHOW_F_MAX = LENSCHOW_SCALE * Math.cbrt(LENSCHOW_PEAK_ZETA) * (1 - LENSCHOW_SHAPE * LENSCHOW_PEAK_ZETA);
const DELTA = (1 - EPSILON) / EPSILON;
const saturationVaporPressureHpa = (temperatureC: number) => SATURATION_SCALE * Math.exp(SATURATION_EXPONENT * temperatureC / (temperatureC + SATURATION_OFFSET));

export interface ColumnInput {
  terrainM: number;
  surfaceTemperatureC: number;
  surfacePressureHpa: number;
  humidity: { specificHumidityKgKg: number } | { dewPointC: number };
  sensibleHeatFluxWm2: number;
  latentHeatFluxWm2: number;
  pblHeightM?: number | null;
  levels: readonly { heightM: number; temperatureC: number }[];
}
export type DepthBranch = 'parcel-crossing' | 'profile-top' | 'model-pbl-fallback' | 'non-convective' | 'unavailable';
export interface ColumnResult {
  msl: { value: number | null; flags: number };
  agl: { value: number | null; flags: number };
  branch: DepthBranch;
  depthM: number | null;
  thermalVelocityMps: number | null;
}
export function dewPointMixingRatioKgKg(dewPointC: number, pressureHpa: number): number | null {
  if (!Number.isFinite(dewPointC) || dewPointC < MIN_SURFACE_TEMPERATURE || dewPointC > MAX_SURFACE_TEMPERATURE || !Number.isFinite(pressureHpa) || pressureHpa <= 0) return null;
  const e = saturationVaporPressureHpa(dewPointC);
  return e < pressureHpa ? EPSILON * e / (pressureHpa - e) : null;
}
export function lenschowNormalizedUpdraft(zeta: number): number { return Number.isFinite(zeta) && zeta > 0 ? LENSCHOW_SCALE * Math.cbrt(zeta) * (1 - LENSCHOW_SHAPE * zeta) : 0; }
/** The adapter has already normalized the trailing interval to liquid-equivalent mm/h. */
export function precipitationRateStatus(value: number): number {
  return Number.isFinite(value) && value >= PRECIPITATION_METHOD_PARAMETERS.minimumRateMmPerHour ? STATUS_VALID : STATUS_UNAVAILABLE;
}
export function usableLiftDepthM(depthM: number, velocityMps: number): number | null {
  if (!Number.isFinite(depthM) || !Number.isFinite(velocityMps) || depthM <= 0 || velocityMps <= 0 || velocityMps * LENSCHOW_F_MAX < SINK_RATE_MPS) return null;
  if (velocityMps * lenschowNormalizedUpdraft(1) >= SINK_RATE_MPS) return depthM;
  let lo: number = LENSCHOW_PEAK_ZETA, hi = 1;
  for (let i = 0; i < MAX_BISECTION_ITERATIONS; i++) {
    const previousLo = lo, previousHi = hi, mid = (lo + hi) / 2;
    if (velocityMps * lenschowNormalizedUpdraft(mid) >= SINK_RATE_MPS) lo = mid; else hi = mid;
    // The next deterministic iteration cannot change an identical bracket.
    if (lo === previousLo && hi === previousHi) break;
  }
  return depthM * (lo + hi) / 2;
}
export function deriveColumn(input: ColumnInput, levelCount: number): ColumnResult {
  const { terrainM, surfaceTemperatureC: t, surfacePressureHpa: p, sensibleHeatFluxWm2: sh, latentHeatFluxWm2: lh, levels } = input;
  const unavailable = (): ColumnResult => ({ msl: { value: null, flags: STATUS_UNAVAILABLE }, agl: { value: null, flags: STATUS_UNAVAILABLE }, branch: 'unavailable', depthM: null, thermalVelocityMps: null });
  if (!Array.isArray(levels) || !Number.isSafeInteger(levelCount) || levelCount < 0 || levelCount > levels.length) throw new RangeError('Invalid active profile level count');
  if (![terrainM, t, p, sh, lh].every(Number.isFinite) || t < MIN_SURFACE_TEMPERATURE || t > MAX_SURFACE_TEMPERATURE || p < MIN_SURFACE_PRESSURE || p > MAX_SURFACE_PRESSURE || !input.humidity || !levelCount) return unavailable();
  let previousHeight = terrainM;
  for (let i = 0; i < levelCount; i++) {
    const level = levels[i];
    if (!Number.isFinite(level.heightM) || !Number.isFinite(level.temperatureC) || level.temperatureC < MIN_PROFILE_TEMPERATURE || level.temperatureC > MAX_PROFILE_TEMPERATURE || level.heightM <= previousHeight || level.heightM - previousHeight > MAX_PROFILE_GAP) return unavailable();
    previousHeight = level.heightM;
  }
  let r: number | null;
  if ('specificHumidityKgKg' in input.humidity) {
    const q = input.humidity.specificHumidityKgKg;
    r = Number.isFinite(q) && q >= 0 && q < 1 ? q / (1 - q) : null;
  } else r = dewPointMixingRatioKgKg(input.humidity.dewPointC, p);
  if (r === null || p * r / (EPSILON + r) > saturationVaporPressureHpa(t) * (1 + SATURATION_RELATIVE_TOLERANCE)) return unavailable();
  const q = r / (1 + r), tk = t + KELVIN_OFFSET;
  const tv = tk * (1 + r / EPSILON) / (1 + r);
  const rho = p * PA_PER_HPA / (RD * tv);
  const virtualFlux = (1 + DELTA * q) * sh / (rho * CP) + DELTA * tk * lh / (rho * LV);
  if (virtualFlux <= 0) return { msl: { value: terrainM, flags: STATUS_NO_LIFT }, agl: { value: 0, flags: STATUS_NO_LIFT }, branch: 'non-convective', depthM: 0, thermalVelocityMps: 0 };
  let depth = levels[levelCount - 1].heightM - terrainM;
  let branch: DepthBranch = 'profile-top';
  for (let i = 0; i < levelCount; i++) {
    const level = levels[i], height = level.heightM - terrainM;
    const parcelTemperature = t - DRY_LAPSE_RATE * height;
    const excess = parcelTemperature - level.temperatureC;
    if (excess > Number.EPSILON * CROSSING_EPSILON_MULTIPLIER * Math.max(1, Math.abs(parcelTemperature), Math.abs(level.temperatureC))) continue;
    if (i === 0) {
      if (!Number.isFinite(input.pblHeightM) || (input.pblHeightM as number) <= 0) return unavailable();
      depth = Math.min(height, input.pblHeightM as number); branch = 'model-pbl-fallback';
    } else {
      const prev = levels[i - 1], prevHeight = prev.heightM - terrainM;
      const prevExcess = t - DRY_LAPSE_RATE * prevHeight - prev.temperatureC;
      depth = prevHeight + (height - prevHeight) * prevExcess / (prevExcess - Math.min(0, excess)); branch = 'parcel-crossing';
    }
    break;
  }
  const velocity = Math.cbrt(G * depth * virtualFlux / tv);
  const usable = usableLiftDepthM(depth, velocity);
  const support = branch === 'parcel-crossing' ? SUPPORT_PARCEL_CROSSING : branch === 'profile-top' ? SUPPORT_PROFILE_TOP : SUPPORT_PBL_CLOSURE;
  return usable === null
    ? { msl: { value: terrainM, flags: STATUS_NO_LIFT | support }, agl: { value: 0, flags: STATUS_NO_LIFT | support }, branch, depthM: depth, thermalVelocityMps: velocity }
    : { msl: { value: terrainM + usable, flags: STATUS_VALID | support }, agl: { value: usable, flags: STATUS_VALID | support }, branch, depthM: depth, thermalVelocityMps: velocity };
}
