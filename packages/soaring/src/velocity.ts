/** Lenschow updraft profile and usable depth above ground for a chosen sink rate. */
import { DEFAULT_SOARING_PARAMETERS } from './parameters.js';

const {
  lenschowScale: LENSCHOW_SCALE,
  lenschowShape: LENSCHOW_SHAPE,
  maximumBisectionIterations: MAX_BISECTION_ITERATIONS
} = DEFAULT_SOARING_PARAMETERS;

/** Conversion factor from feet per minute (ft/min) to meters per second (m/s). */
export const FEET_PER_MINUTE_TO_MPS = 0.00508;
export const KNOTS_PER_MPS = 3600 / 1852;

/** Classic wxtofly / RASP minimum sink rate in feet per minute (225 ft/min). */
export const WXTOFLY_SINK_FPM = 225;

/** Classic wxtofly / RASP minimum sink rate in meters per second (~1.143 m/s). */
export const WXTOFLY_SINK_MPS = WXTOFLY_SINK_FPM * FEET_PER_MINUTE_TO_MPS;

/** Default operational paraglider sink-rate threshold in meters per second (1.2 m/s). */
export const SINK_RATE_MPS = DEFAULT_SOARING_PARAMETERS.sinkRateMps;

/** Default minimum Deardorff convective velocity scale w* in meters per second (0 m/s). */
export const MINIMUM_THERMAL_VELOCITY_MPS = DEFAULT_SOARING_PARAMETERS.minimumThermalVelocityMps;

/** Named aircraft sink-rate presets in meters per second (m/s). */
export const SINK_RATE_PRESETS_MPS = Object.freeze({
  sailplane: 1.0,
  wxtofly: WXTOFLY_SINK_MPS,
  paraglider: DEFAULT_SOARING_PARAMETERS.sinkRateMps
} as const);

export type SinkRatePresetId = keyof typeof SINK_RATE_PRESETS_MPS;

export const LENSCHOW_PEAK_ZETA = DEFAULT_SOARING_PARAMETERS.lenschowPeakZeta;

export const LENSCHOW_F_MAX =
  LENSCHOW_SCALE * Math.cbrt(LENSCHOW_PEAK_ZETA) * (1 - LENSCHOW_SHAPE * LENSCHOW_PEAK_ZETA);

/**
 * Minimum Deardorff convective velocity scale w* (m/s) required for the peak of the
 * Lenschow vertical velocity profile to reach `sinkRateMps` (m/s).
 */
export function minimumConvectiveVelocityForSinkMps(
  sinkRateMps: number = SINK_RATE_MPS,
  lenschowFMax: number = LENSCHOW_F_MAX
): number {
  if (
    !Number.isFinite(sinkRateMps) ||
    sinkRateMps <= 0 ||
    !Number.isFinite(lenschowFMax) ||
    lenschowFMax <= 0
  ) {
    return 0;
  }
  return sinkRateMps / lenschowFMax;
}

export interface LenschowOptions {
  /** Dimensionless Lenschow profile scale factor (default: 4). */
  readonly lenschowScale?: number;
  /** Dimensionless Lenschow profile upper-PBL decay factor (default: 0.8). */
  readonly lenschowShape?: number;
}

export interface UsableLiftOptions extends LenschowOptions {
  /** Minimum aircraft sink rate to overcome in meters per second (default: 1.2 m/s). */
  readonly sinkRateMps?: number;
  /**
   * Optional explicit floor on the Deardorff convective velocity scale w* in meters per second
   * (default: 0 m/s). Even when 0, the Lenschow profile requires `w* >= sinkRateMps / LENSCHOW_F_MAX`
   * to produce usable lift.
   */
  readonly minimumThermalVelocityMps?: number;
  /** Normalized height ζ ∈ (0, 1) where the Lenschow profile peaks (default: 0.3125). */
  readonly lenschowPeakZeta?: number;
  /** Bisection iterations when solving for the upper ζ crossing where w(ζ) = sinkRateMps (default: 60). */
  readonly maximumBisectionIterations?: number;
}

export function lenschowNormalizedUpdraft(
  zeta: number,
  options?: LenschowOptions
): number {
  const scale = options?.lenschowScale ?? LENSCHOW_SCALE;
  const shape = options?.lenschowShape ?? LENSCHOW_SHAPE;
  return Number.isFinite(zeta) && zeta > 0 ? scale * Math.cbrt(zeta) * (1 - shape * zeta) : 0;
}

export function usableLiftDepthM(
  depthM: number,
  velocityMps: number,
  options?: UsableLiftOptions
): number | null {
  const sinkRateMps = options?.sinkRateMps ?? SINK_RATE_MPS;
  const minimumThermalVelocityMps =
    options?.minimumThermalVelocityMps ?? MINIMUM_THERMAL_VELOCITY_MPS;
  const peakZeta = options?.lenschowPeakZeta ?? LENSCHOW_PEAK_ZETA;
  const maxIterations = options?.maximumBisectionIterations ?? MAX_BISECTION_ITERATIONS;
  const fMax =
    options?.lenschowScale !== undefined ||
    options?.lenschowShape !== undefined ||
    options?.lenschowPeakZeta !== undefined
      ? lenschowNormalizedUpdraft(peakZeta, options)
      : LENSCHOW_F_MAX;

  if (
    !Number.isFinite(depthM) ||
    !Number.isFinite(velocityMps) ||
    !Number.isFinite(sinkRateMps) ||
    depthM <= 0 ||
    velocityMps <= 0 ||
    sinkRateMps <= 0 ||
    velocityMps < minimumThermalVelocityMps ||
    velocityMps * fMax < sinkRateMps
  ) {
    return null;
  }
  if (velocityMps * lenschowNormalizedUpdraft(1, options) >= sinkRateMps) return depthM;
  let lo: number = peakZeta;
  let hi = 1;
  for (let i = 0; i < maxIterations; i++) {
    const previousLo = lo;
    const previousHi = hi;
    const mid = (lo + hi) / 2;
    if (velocityMps * lenschowNormalizedUpdraft(mid, options) >= sinkRateMps) lo = mid;
    else hi = mid;
    // The next deterministic iteration cannot change an identical bracket.
    if (lo === previousLo && hi === previousHi) break;
  }
  return (depthM * (lo + hi)) / 2;
}
