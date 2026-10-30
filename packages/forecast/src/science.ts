import { STATUS_NO_LIFT, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_PARCEL_CROSSING, SUPPORT_PBL_CLOSURE, SUPPORT_PROFILE_TOP } from '@av/contracts';

export const METHOD_ID = 'dry-lenschow-pbl-1p2-v1';
export const SINK_RATE_MPS = 1.2;
export const LENSCHOW_PEAK_ZETA = 0.3125;
export const LENSCHOW_F_MAX = 4 * Math.cbrt(LENSCHOW_PEAK_ZETA) * (1 - 0.8 * LENSCHOW_PEAK_ZETA);
const EPSILON = 0.622, RD = 287.05, CP = 1004, LV = 2501000, G = 9.80665, DELTA = (1 - EPSILON) / EPSILON;
const SATURATION_RELATIVE_TOLERANCE = 1e-6;
const saturationVaporPressureHpa = (temperatureC: number) => 6.112 * Math.exp(17.67 * temperatureC / (temperatureC + 243.5));

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
  if (!Number.isFinite(dewPointC) || dewPointC < -100 || dewPointC > 60 || !Number.isFinite(pressureHpa) || pressureHpa <= 0) return null;
  const e = saturationVaporPressureHpa(dewPointC);
  return e < pressureHpa ? EPSILON * e / (pressureHpa - e) : null;
}
export function lenschowNormalizedUpdraft(zeta: number): number { return Number.isFinite(zeta) && zeta > 0 ? 4 * Math.cbrt(zeta) * (1 - 0.8 * zeta) : 0; }
export function usableLiftDepthM(depthM: number, velocityMps: number): number | null {
  if (!Number.isFinite(depthM) || !Number.isFinite(velocityMps) || depthM <= 0 || velocityMps <= 0 || velocityMps * LENSCHOW_F_MAX < SINK_RATE_MPS) return null;
  if (velocityMps * lenschowNormalizedUpdraft(1) >= SINK_RATE_MPS) return depthM;
  let lo = LENSCHOW_PEAK_ZETA, hi = 1;
  for (let i = 0; i < 60; i++) {
    const previousLo = lo, previousHi = hi, mid = (lo + hi) / 2;
    if (velocityMps * lenschowNormalizedUpdraft(mid) >= SINK_RATE_MPS) lo = mid; else hi = mid;
    // The next deterministic iteration cannot change an identical bracket.
    if (lo === previousLo && hi === previousHi) break;
  }
  return depthM * (lo + hi) / 2;
}
export function deriveColumn(input: ColumnInput): ColumnResult {
  const { terrainM, surfaceTemperatureC: t, surfacePressureHpa: p, sensibleHeatFluxWm2: sh, latentHeatFluxWm2: lh, levels } = input;
  const unavailable = (): ColumnResult => ({ msl: { value: null, flags: STATUS_UNAVAILABLE }, agl: { value: null, flags: STATUS_UNAVAILABLE }, branch: 'unavailable', depthM: null, thermalVelocityMps: null });
  if (![terrainM, t, p, sh, lh].every(Number.isFinite) || t < -100 || t > 60 || p < 100 || p > 1100 || !input.humidity || !Array.isArray(levels) || !levels.length) return unavailable();
  let previousHeight = terrainM;
  for (const level of levels) {
    if (!Number.isFinite(level.heightM) || !Number.isFinite(level.temperatureC) || level.temperatureC < -120 || level.temperatureC > 60 || level.heightM <= previousHeight || level.heightM - previousHeight > 1000) return unavailable();
    previousHeight = level.heightM;
  }
  let r: number | null;
  if ('specificHumidityKgKg' in input.humidity) {
    const q = input.humidity.specificHumidityKgKg;
    r = Number.isFinite(q) && q >= 0 && q < 1 ? q / (1 - q) : null;
  } else r = dewPointMixingRatioKgKg(input.humidity.dewPointC, p);
  if (r === null || p * r / (EPSILON + r) > saturationVaporPressureHpa(t) * (1 + SATURATION_RELATIVE_TOLERANCE)) return unavailable();
  const q = r / (1 + r), tk = t + 273.15;
  const tv = tk * (1 + r / EPSILON) / (1 + r);
  const rho = p * 100 / (RD * tv);
  const virtualFlux = (1 + DELTA * q) * sh / (rho * CP) + DELTA * tk * lh / (rho * LV);
  if (virtualFlux <= 0) return { msl: { value: terrainM, flags: STATUS_NO_LIFT }, agl: { value: 0, flags: STATUS_NO_LIFT }, branch: 'non-convective', depthM: 0, thermalVelocityMps: 0 };
  let depth = levels[levels.length - 1].heightM - terrainM;
  let branch: DepthBranch = 'profile-top';
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i], height = level.heightM - terrainM;
    const parcelTemperature = t - 0.0098 * height;
    const excess = parcelTemperature - level.temperatureC;
    if (excess > Number.EPSILON * 8 * Math.max(1, Math.abs(parcelTemperature), Math.abs(level.temperatureC))) continue;
    if (i === 0) {
      if (!Number.isFinite(input.pblHeightM) || (input.pblHeightM as number) <= 0) return unavailable();
      depth = Math.min(height, input.pblHeightM as number); branch = 'model-pbl-fallback';
    } else {
      const prev = levels[i - 1], prevHeight = prev.heightM - terrainM;
      const prevExcess = t - 0.0098 * prevHeight - prev.temperatureC;
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
