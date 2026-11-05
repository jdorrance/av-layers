/** Algebraic point views from one native column, with missing dependencies preserved. */
import { lenschowNormalizedUpdraft, LENSCHOW_F_MAX, LENSCHOW_PEAK_ZETA, usableLiftDepthM, WXTOFLY_SINK_MPS } from './velocity.js';
import { NATIVE_DIAGNOSTIC_PARAMETERS } from './parameters.js';

export interface SoaringViewInput {
  terrainM?: number | null;
  thermalTopM?: number | null;
  thermalVelocityMps?: number | null;
  thermalTopRhPercent?: number | null;
  surfaceLclM?: number | null;
  mixedLayerLclM?: number | null;
  effectiveCloudLimitM?: number | null;
  wind10mU?: number | null;
  wind10mV?: number | null;
  blMeanWindU?: number | null;
  blMeanWindV?: number | null;
  blTopWindU?: number | null;
  blTopWindV?: number | null;
}

const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

/** Calm vectors have no meteorological direction. */
function wind(u: number | null | undefined, v: number | null | undefined) {
  if (!finite(u) || !finite(v)) return { speedMps: null, directionDeg: null };
  const speedMps = Math.hypot(u, v);
  return { speedMps, directionDeg: speedMps === 0 ? null : (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360 };
}

function ceiling(input: SoaringViewInput, sinkRateMps: number, cloudCap: boolean): number | null {
  const { terrainM, thermalTopM, thermalVelocityMps, effectiveCloudLimitM } = input;
  if (!finite(terrainM) || !finite(thermalTopM) || !finite(thermalVelocityMps)) return null;
  const depth = thermalTopM - terrainM;
  const usable = usableLiftDepthM(depth, thermalVelocityMps, { sinkRateMps });
  if (usable === null) return null;
  const cap = cloudCap && finite(effectiveCloudLimitM) ? Math.min(thermalTopM, effectiveCloudLimitM) : thermalTopM;
  const zeta = (cap - terrainM) / depth;
  if (zeta <= 0 || (zeta <= LENSCHOW_PEAK_ZETA && thermalVelocityMps * lenschowNormalizedUpdraft(zeta) < sinkRateMps)) return null;
  return Math.min(terrainM + usable, cap);
}

/** Cloud flags need only local updraft evaluation; whole-grid callers avoid ceiling solves. */
export function deriveCloudRegime(input: SoaringViewInput) {
  const { terrainM, thermalTopM, thermalVelocityMps: w, effectiveCloudLimitM: cap } = input;
  const difference = (height: number | null | undefined) => finite(thermalTopM) && finite(height) ? thermalTopM - height : null;
  const cuPotentialM = difference(input.surfaceLclM), odPotentialM = difference(input.mixedLayerLclM);
  let cloudCapped: boolean | null = null;
  const sink = NATIVE_DIAGNOSTIC_PARAMETERS.cloudCapSinkRateMps;
  if (finite(terrainM) && finite(thermalTopM) && thermalTopM > terrainM && finite(w) && w > 0 && w * LENSCHOW_F_MAX >= sink && finite(cap)) {
    const zeta = (cap - terrainM) / (thermalTopM - terrainM);
    cloudCapped = zeta <= LENSCHOW_PEAK_ZETA || (zeta < 1 && w * lenschowNormalizedUpdraft(zeta) > sink);
  }
  return { cuPotentialM, odPotentialM,
    cumulus: cuPotentialM === null ? null : cuPotentialM < 0 || (finite(w) && w <= 0) ? false : !finite(w) ? null : true,
    overdeveloped: odPotentialM === null ? null : odPotentialM < 0 || (finite(w) && w <= 0) ? false : !finite(w) ? null : !finite(input.thermalTopRhPercent) ? null
      : input.thermalTopRhPercent >= NATIVE_DIAGNOSTIC_PARAMETERS.overdevelopmentRelativeHumidityPercent,
    cloudCapped };
}

export function deriveSoaringViews(input: SoaringViewInput) {
  const w10 = wind(input.wind10mU, input.wind10mV);
  const mean = wind(input.blMeanWindU, input.blMeanWindV), top = wind(input.blTopWindU, input.blTopWindV);
  const shear = finite(input.blTopWindU) && finite(input.blTopWindV) && finite(input.wind10mU) && finite(input.wind10mV)
    ? Math.hypot(input.blTopWindU - input.wind10mU, input.blTopWindV - input.wind10mV) : null;
  const dryHcritM = ceiling(input, 1, false), usableLiftTopV2M = ceiling(input, 1, true);
  return {
    usableLiftTopV2M, hcritWxtoflyM: ceiling(input, WXTOFLY_SINK_MPS, true), dryHcritM,
    ...deriveCloudRegime(input),
    wind10mSpeedMps: w10.speedMps, wind10mDirDeg: w10.directionDeg,
    blMeanWindSpeedMps: mean.speedMps, blMeanWindDirDeg: mean.directionDeg,
    blTopWindSpeedMps: top.speedMps, blTopWindDirDeg: top.directionDeg,
    blWindShearMps: shear,
    buoyancyShearRatio: shear !== null && finite(input.thermalVelocityMps) && input.thermalVelocityMps >= 0
      ? input.thermalVelocityMps / Math.max(NATIVE_DIAGNOSTIC_PARAMETERS.minimumShearMps, shear) : null
  };
}

export type SoaringViews = ReturnType<typeof deriveSoaringViews>;
