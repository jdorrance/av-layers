/** Native-column diagnostics use model terrain, ascending levels and Earth-relative wind. */
import {
  boltonLclHeightMetersAgl, dewPointFromMixingRatioC, mixingRatioFromDewPointKgKg,
  relativeHumidityFromTempAndDewpointPercent, THERMODYNAMIC_CONSTANTS as C
} from '@av/thermodynamics';
import { NATIVE_DIAGNOSTIC_PARAMETERS as P } from './parameters.js';
import { deriveCloudRegime } from './views.js';

export interface NativeDiagnosticLevel {
  heightM: number;
  temperatureC: number;
  pressureHpa?: number | null;
  dewPointC?: number | null;
  uMps?: number | null;
  vMps?: number | null;
}

export interface NativeDiagnosticInput {
  /** All fields refer to one normalized frame. False skips the convective solver. */
  daylight?: boolean;
  terrainM: number;
  surfaceTemperatureC: number;
  surfaceDewPointC?: number | null;
  surfacePressureHpa?: number | null;
  sensibleHeatFluxWm2?: number | null;
  latentHeatFluxWm2?: number | null;
  pblHeightM?: number | null;
  wind10mU?: number | null;
  wind10mV?: number | null;
  /** Ascending levels above model terrain; missing optional measurements retain null. */
  levels: readonly NativeDiagnosticLevel[];
}

export type NativeDepthBranch = 'parcel-crossing' | 'profile-top' | 'model-pbl-fallback' | 'heat-flux-fallback' | 'non-convective' | 'unavailable';
const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
const value = (n: number): number | null => Number.isFinite(n) ? n : null;
function checkLevelCount(input: NativeDiagnosticInput, count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > input.levels.length) throw new RangeError('Invalid active profile level count');
}

function parcelDepth(input: NativeDiagnosticInput, count: number): { depthM: number | null; branch: NativeDepthBranch } {
  const { terrainM, surfaceTemperatureC: t, levels, pblHeightM, sensibleHeatFluxWm2: sh, latentHeatFluxWm2: lh } = input;
  const result = (depthM: number | null, branch: NativeDepthBranch) => ({ depthM, branch });
  let previousHeight = terrainM, above = 0;
  for (let i = 0; i < count; i++) {
    const l = levels[i];
    if (!finite(l.heightM) || !finite(l.temperatureC) || l.temperatureC <= -C.kelvinOffset || l.heightM <= previousHeight) return result(null, 'unavailable');
    previousHeight = l.heightM;
    if (l.heightM > terrainM + P.minimumLevelAglM) above++;
  }
  if (!finite(terrainM) || !finite(t) || t <= -C.kelvinOffset || above < P.minimumThermalLevels) return result(null, 'unavailable');
  if (input.daylight === false) return result(0, 'non-convective');
  let previous: NativeDiagnosticLevel | undefined;
  for (let i = 0; i < count; i++) {
    const level = levels[i], height = level.heightM - terrainM;
    if (height <= P.minimumLevelAglM) continue;
    const excess = t - height * C.dryLapseRateKperM - level.temperatureC;
    if (excess > 0) { previous = level; continue; }
    if (previous) {
      const previousAgl = previous.heightM - terrainM;
      const previousExcess = t - previousAgl * C.dryLapseRateKperM - previous.temperatureC;
      return result(previousAgl + previousExcess / (previousExcess - excess) * (height - previousAgl), 'parcel-crossing');
    }
    if (!finite(sh) || !finite(lh)) return result(null, 'unavailable');
    if (sh + P.shallowLatentHeatCoefficient * (t + C.kelvinOffset) * lh <= 0) return result(0, 'non-convective');
    if (finite(pblHeightM) && pblHeightM > 0) return result(Math.min(height, pblHeightM), 'model-pbl-fallback');
    const boost = Math.min(P.maximumShallowTemperatureC, Math.max(0, sh) * P.shallowTemperaturePerFlux);
    return boost === 0 ? result(0, 'non-convective') : result(excess >= -boost ? height : height * boost / -excess, 'heat-flux-fallback');
  }
  return result(levels[count - 1].heightM - terrainM, 'profile-top');
}

function thermalVelocity(input: NativeDiagnosticInput, depth: number | null, pressure: number | null): number | null {
  const { surfaceTemperatureC: t, surfaceDewPointC: td, sensibleHeatFluxWm2: sh, latentHeatFluxWm2: lh } = input;
  if (!finite(depth) || depth < 0 || !finite(pressure) || pressure <= 0 || !finite(t) || t <= -C.kelvinOffset || !finite(td)) return null;
  const r = mixingRatioFromDewPointKgKg(Math.min(t, td), pressure);
  if (!finite(r)) return null;
  if (input.daylight === false) return 0;
  if (!finite(sh) || !finite(lh)) return null;
  const tk = t + C.kelvinOffset, q = r / (1 + r), delta = (1 - C.waterDryAirMolarMassRatio) / C.waterDryAirMolarMassRatio;
  const tv = tk * (1 + r / C.waterDryAirMolarMassRatio) / (1 + r);
  const density = pressure * C.pascalsPerHectopascal / (C.dryAirGasConstantJkgK * tv);
  const flux = (1 + delta * q) * sh / (density * C.dryAirHeatCapacityJkgK) + delta * tk * lh / (density * C.latentHeatVaporizationJkg);
  return value(flux <= 0 ? 0 : Math.cbrt(C.gravityMps2 * depth * flux / tv));
}

/** Integrate complete thermodynamic segments in pressure mass, clipping the upper bracket. */
function mixedLayerLcl(input: NativeDiagnosticInput, count: number, top: number | null, pressure: number | null): number | null {
  const { terrainM, surfaceTemperatureC: t, surfaceDewPointC: td, levels } = input;
  if (!finite(top) || top < terrainM || !finite(td) || !finite(t) || t <= -C.kelvinOffset) return null;
  if (top === terrainM) return value(terrainM + boltonLclHeightMetersAgl(t, td));
  if (!finite(pressure) || pressure <= 0) return null;
  // Retain the consumer's mixed-layer exponent independently of the exact dry-air ratio.
  const kappa = P.mixedLayerPoissonExponent;
  let z = terrainM, p = pressure, theta = (t + C.kelvinOffset) * (1000 / pressure) ** kappa;
  let r = mixingRatioFromDewPointKgKg(Math.min(t, td), pressure), sumTheta = 0, sumR = 0;
  if (!finite(r)) return null;
  for (let i = 0; i < count; i++) {
    const l = levels[i];
    if (l.heightM <= terrainM + P.minimumLevelAglM) continue;
    if (!finite(l.heightM) || l.heightM <= z || !finite(l.pressureHpa) || l.pressureHpa <= 0 || l.pressureHpa >= p ||
      !finite(l.temperatureC) || l.temperatureC <= -C.kelvinOffset || !finite(l.dewPointC)) return null;
    let upperP = l.pressureHpa;
    let upperTheta = (l.temperatureC + C.kelvinOffset) * (1000 / upperP) ** kappa;
    let upperR = mixingRatioFromDewPointKgKg(Math.min(l.temperatureC, l.dewPointC), upperP);
    if (!finite(upperR)) return null;
    if (l.heightM > top) {
      upperP = p * Math.exp((top - z) / (l.heightM - z) * Math.log(upperP / p));
      const fraction = (p - upperP) / (p - l.pressureHpa);
      upperTheta = theta + fraction * (upperTheta - theta);
      upperR = r + fraction * (upperR - r);
    }
    const dp = p - upperP;
    sumTheta += 0.5 * (theta + upperTheta) * dp;
    sumR += 0.5 * (r + upperR) * dp;
    if (l.heightM >= top) {
      const mass = pressure - upperP;
      const mixedT = sumTheta / mass * (pressure / 1000) ** kappa - C.kelvinOffset;
      return value(terrainM + boltonLclHeightMetersAgl(mixedT, Math.min(mixedT, dewPointFromMixingRatioC(sumR / mass, pressure))));
    }
    z = l.heightM; p = upperP; theta = upperTheta; r = upperR;
  }
  return null;
}

/** Integrate ground to top, anchoring the source 10 m vector at ground as Windgrams V2 does. */
function layerWind(input: NativeDiagnosticInput, count: number, top: number | null) {
  const empty = { blMeanWindU: null, blMeanWindV: null, blTopWindU: null, blTopWindV: null };
  const { terrainM, levels, wind10mU, wind10mV } = input;
  if (!finite(top) || top < terrainM || !finite(wind10mU) || !finite(wind10mV)) return empty;
  if (top === terrainM) return { blMeanWindU: wind10mU, blMeanWindV: wind10mV, blTopWindU: wind10mU, blTopWindV: wind10mV };
  let z = terrainM, u = wind10mU, v = wind10mV, sumU = 0, sumV = 0;
  for (let i = 0; i < count; i++) {
    const level = levels[i];
    if (level.heightM <= terrainM + P.minimumLevelAglM) continue;
    const upperZ = level.heightM, upperU = level.uMps, upperV = level.vMps;
    if (!finite(upperZ) || upperZ <= z || !finite(upperU) || !finite(upperV)) return empty;
    const nextZ = Math.min(top, upperZ), fraction = (nextZ - z) / (upperZ - z);
    const nextU = u + fraction * (upperU - u), nextV = v + fraction * (upperV - v), dz = nextZ - z;
    sumU += 0.5 * (u + nextU) * dz; sumV += 0.5 * (v + nextV) * dz;
    if (upperZ >= top) return { blMeanWindU: sumU / (top - terrainM), blMeanWindV: sumV / (top - terrainM), blTopWindU: nextU, blTopWindV: nextV };
    z = nextZ; u = nextU; v = nextV;
  }
  return empty;
}

/** Missing levels invalidate dependent integrals; unknown depth remains distinct from zero. */
export function deriveNativeColumnDiagnostics(input: NativeDiagnosticInput, levelCount = input.levels.length) {
  checkLevelCount(input, levelCount);
  const depth = parcelDepth(input, levelCount);
  const { terrainM } = input;
  const pressure = surfacePressure(input, levelCount);
  const thermalTopM = depth.depthM !== null ? terrainM + depth.depthM : null;
  const top = depth.depthM !== null && depth.depthM > 0 ? thermalTopM
    : finite(input.pblHeightM) && input.pblHeightM >= 0 ? terrainM + input.pblHeightM : depth.depthM === 0 ? terrainM : null;
  const cloud = cloudDiagnostics(input, levelCount, top, pressure);
  const thermalVelocityMps = thermalVelocity(input, depth.depthM, pressure);
  const thermalTopRhPercent = topHumidity(input, levelCount, thermalTopM);
  const regime = deriveCloudRegime({ terrainM, thermalTopM, thermalVelocityMps, thermalTopRhPercent, ...cloud });
  return {
    thermalDepthM: depth.depthM, thermalTopM, thermalVelocityMps, depthBranch: depth.branch,
    thermalTopRhPercent, ...cloud,
    cumulus: regime.cumulus, overdeveloped: regime.overdeveloped, cloudCapped: regime.cloudCapped,
    ...layerWind(input, levelCount, top)
  };
}

function surfacePressure(input: NativeDiagnosticInput, levelCount: number): number | null {
  const { terrainM, surfaceTemperatureC: t } = input;
  let pressure = finite(input.surfacePressureHpa) && input.surfacePressureHpa > 0 ? input.surfacePressureHpa : null;
  if (pressure === null) {
    let first: NativeDiagnosticLevel | undefined;
    for (let i = 0; i < levelCount; i++) {
      const level = input.levels[i];
      if (level.heightM > terrainM + P.minimumLevelAglM && finite(level.pressureHpa) && level.pressureHpa > 0) { first = level; break; }
    }
    if (first && finite(first.pressureHpa) && finite(first.temperatureC) && finite(t) && 0.5 * (t + first.temperatureC) + C.kelvinOffset > 0) {
      pressure = value(first.pressureHpa * Math.exp(C.gravityMps2 * (first.heightM - terrainM) /
        (C.dryAirGasConstantJkgK * (0.5 * (t + first.temperatureC) + C.kelvinOffset))));
    }
  }
  return pressure;
}

function cloudDiagnostics(input: NativeDiagnosticInput, levelCount: number, top: number | null, pressure: number | null) {
  const { terrainM, surfaceTemperatureC: t, surfaceDewPointC: td } = input;
  const surfaceLclM = finite(terrainM) && finite(td) ? value(terrainM + boltonLclHeightMetersAgl(t, td)) : null;
  let effectiveCloudLimitM = surfaceLclM;
  for (let i = 0; i < levelCount; i++) {
    const l = input.levels[i];
    if (finite(l.heightM) && l.heightM > terrainM + P.minimumLevelAglM && finite(l.temperatureC) && finite(l.dewPointC) && l.temperatureC - l.dewPointC <= P.nearSaturationSpreadC) {
      effectiveCloudLimitM = effectiveCloudLimitM === null ? l.heightM : Math.min(effectiveCloudLimitM, l.heightM);
      break;
    }
  }
  return { surfaceLclM, mixedLayerLclM: mixedLayerLcl(input, levelCount, top, pressure), effectiveCloudLimitM };
}

export type NativeColumnDiagnostics = ReturnType<typeof deriveNativeColumnDiagnostics>;

/** Integrate a chosen native layer without resolving thermal depth again. Heights use MSL. */
export function nativeColumnWindAtHeight(input: NativeDiagnosticInput, heightM: number | null, levelCount = input.levels.length) {
  checkLevelCount(input, levelCount);
  return layerWind(input, levelCount, heightM);
}

/** Parcel and mixed-layer cloud levels for an explicitly selected MSL layer top. */
export function nativeColumnCloudDiagnostics(input: NativeDiagnosticInput, layerTopM: number | null, levelCount = input.levels.length) {
  checkLevelCount(input, levelCount);
  return cloudDiagnostics(input, levelCount, layerTopM, surfacePressure(input, levelCount));
}

/** Relative humidity at one MSL height, using its adjacent native temperature/dewpoint bracket. */
export function nativeColumnHumidityAtHeight(input: NativeDiagnosticInput, heightM: number | null, levelCount = input.levels.length): number | null {
  checkLevelCount(input, levelCount);
  return topHumidity(input, levelCount, heightM);
}

function topHumidity(input: NativeDiagnosticInput, count: number, top: number | null): number | null {
  if (!finite(top)) return null;
  let height = input.terrainM, t = input.surfaceTemperatureC, td = input.surfaceDewPointC;
  const rh = (temp: number, dew: number) => value(relativeHumidityFromTempAndDewpointPercent(temp, dew));
  if (top === height) return finite(t) && finite(td) ? rh(t, td) : null;
  for (let i = 0; i < count; i++) {
    const level = input.levels[i];
    if (level.heightM <= input.terrainM + P.minimumLevelAglM) continue;
    if (!finite(level.heightM) || level.heightM <= height) return null;
    if (level.heightM === top) return finite(level.temperatureC) && finite(level.dewPointC) ? rh(level.temperatureC, level.dewPointC) : null;
    if (level.heightM >= top) {
      if (!finite(t) || !finite(td) || !finite(level.temperatureC) || !finite(level.dewPointC)) return null;
      const fraction = (top - height) / (level.heightM - height);
      return rh(t + fraction * (level.temperatureC - t), td + fraction * (level.dewPointC - td));
    }
    height = level.heightM; t = level.temperatureC; td = level.dewPointC;
  }
  return null;
}
