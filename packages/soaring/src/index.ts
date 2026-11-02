/**
 * Dry convective boundary-layer depth, Deardorff convective velocity scale w* (m/s),
 * Lenschow vertical velocity profile (m/s), and configurable sink-rate thresholds (m/s).
 *
 * Ported from windgrams/packages/soaring/src/{parcel-depth,convective-lift}.ts and @av/forecast/science.
 *
 * Every soaring parameter with physical units of meters/second (aircraft sink rate,
 * minimum convective velocity scale w*, and Lenschow peak updraft scaling) or dry
 * boundary-layer lapse/closure behavior is exposed as a named, configurable option
 * defaulting to `@av/contracts` `LIFT_METHOD_PARAMETERS`.
 */
import {
  LIFT_METHOD,
  LIFT_METHOD_PARAMETERS,
  PRECIPITATION_METHOD_PARAMETERS,
  STATUS_NO_LIFT,
  STATUS_UNAVAILABLE,
  STATUS_VALID,
  SUPPORT_PARCEL_CROSSING,
  SUPPORT_PBL_CLOSURE,
  SUPPORT_PROFILE_TOP
} from '@av/contracts';
import { dryParcelTemperatureC, saturationVaporPressureHpa } from '@av/thermodynamics';

export const METHOD_ID = LIFT_METHOD.id;

/** Conversion factor from feet per minute (ft/min) to meters per second (m/s). */
export const FEET_PER_MINUTE_TO_MPS = 0.00508;

/** Classic wxtofly / RASP minimum sink rate in feet per minute (225 ft/min). */
export const WXTOFLY_SINK_FPM = 225;

/** Classic wxtofly / RASP minimum sink rate in meters per second (~1.143 m/s). */
export const WXTOFLY_SINK_MPS = WXTOFLY_SINK_FPM * FEET_PER_MINUTE_TO_MPS;

/** Default operational paraglider sink-rate threshold in meters per second (1.2 m/s). */
export const SINK_RATE_MPS = LIFT_METHOD_PARAMETERS.sinkRateMps;

/** Default minimum Deardorff convective velocity scale w* in meters per second (0 m/s). */
export const MINIMUM_THERMAL_VELOCITY_MPS = LIFT_METHOD_PARAMETERS.minimumThermalVelocityMps;

/** Named aircraft sink-rate presets in meters per second (m/s). */
export const SINK_RATE_PRESETS_MPS = Object.freeze({
  sailplane: 1.0,
  wxtofly: WXTOFLY_SINK_MPS,
  paraglider: LIFT_METHOD_PARAMETERS.sinkRateMps
} as const);

export type SinkRatePresetId = keyof typeof SINK_RATE_PRESETS_MPS;

export const LENSCHOW_PEAK_ZETA = LIFT_METHOD_PARAMETERS.lenschowPeakZeta;

const {
  lenschowScale: LENSCHOW_SCALE,
  lenschowShape: LENSCHOW_SHAPE,
  waterDryAirMolarMassRatio: EPSILON,
  dryAirGasConstantJkgK: RD,
  dryAirHeatCapacityJkgK: CP,
  latentHeatVaporizationJkg: LV,
  gravityMps2: G,
  kelvinOffset: KELVIN_OFFSET,
  pascalsPerHectopascal: PA_PER_HPA,
  dryLapseRateKperM: DRY_LAPSE_RATE,
  saturationRelativeTolerance: SATURATION_RELATIVE_TOLERANCE,
  minimumSurfaceTemperatureC: MIN_SURFACE_TEMPERATURE,
  maximumSurfaceTemperatureC: MAX_SURFACE_TEMPERATURE,
  minimumSurfacePressureHpa: MIN_SURFACE_PRESSURE,
  maximumSurfacePressureHpa: MAX_SURFACE_PRESSURE,
  minimumProfileTemperatureC: MIN_PROFILE_TEMPERATURE,
  maximumProfileTemperatureC: MAX_PROFILE_TEMPERATURE,
  maximumProfileGapM: MAX_PROFILE_GAP,
  crossingEpsilonMultiplier: CROSSING_EPSILON_MULTIPLIER,
  maximumBisectionIterations: MAX_BISECTION_ITERATIONS
} = LIFT_METHOD_PARAMETERS;

export const LENSCHOW_F_MAX =
  LENSCHOW_SCALE * Math.cbrt(LENSCHOW_PEAK_ZETA) * (1 - LENSCHOW_SHAPE * LENSCHOW_PEAK_ZETA);

const DELTA = (1 - EPSILON) / EPSILON;

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

export interface DryParcelOptions {
  /** Dry-adiabatic lapse rate Γ_d in K/m (default: 0.0098 K/m). */
  readonly dryLapseRateKperM?: number;
  /** Optional surface parcel excess temperature ΔT in °C / K (default: 0 K). */
  readonly parcelSurfaceDeltaTC?: number;
  /** Maximum allowed vertical gap between resolved profile levels in meters (default: 1000 m). */
  readonly maximumProfileGapM?: number;
  /** Relative floating-point epsilon multiplier for parcel crossing comparison (default: 8). */
  readonly crossingEpsilonMultiplier?: number;
}

export interface ColumnDerivationOptions extends UsableLiftOptions, DryParcelOptions {
  /** Gravitational acceleration g in m/s² (default: 9.80665 m/s²). */
  readonly gravityMps2?: number;
}

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

export type DepthBranch =
  | 'parcel-crossing'
  | 'profile-top'
  | 'model-pbl-fallback'
  | 'non-convective'
  | 'unavailable';

export interface ColumnResult {
  msl: { value: number | null; flags: number };
  agl: { value: number | null; flags: number };
  branch: DepthBranch;
  depthM: number | null;
  thermalVelocityMps: number | null;
}

export function dewPointMixingRatioKgKg(dewPointC: number, pressureHpa: number): number | null {
  if (
    !Number.isFinite(dewPointC) ||
    dewPointC < MIN_SURFACE_TEMPERATURE ||
    dewPointC > MAX_SURFACE_TEMPERATURE ||
    !Number.isFinite(pressureHpa) ||
    pressureHpa <= 0
  ) {
    return null;
  }
  const e = saturationVaporPressureHpa(dewPointC);
  return e < pressureHpa ? (EPSILON * e) / (pressureHpa - e) : null;
}

export function lenschowNormalizedUpdraft(
  zeta: number,
  options?: LenschowOptions
): number {
  const scale = options?.lenschowScale ?? LENSCHOW_SCALE;
  const shape = options?.lenschowShape ?? LENSCHOW_SHAPE;
  return Number.isFinite(zeta) && zeta > 0 ? scale * Math.cbrt(zeta) * (1 - shape * zeta) : 0;
}

/** The adapter has already normalized the trailing interval to liquid-equivalent mm/h. */
export function precipitationRateStatus(
  value: number,
  minimumRateMmPerHour: number = PRECIPITATION_METHOD_PARAMETERS.minimumRateMmPerHour
): number {
  return Number.isFinite(value) && value >= minimumRateMmPerHour
    ? STATUS_VALID
    : STATUS_UNAVAILABLE;
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

export function deriveColumn(
  input: ColumnInput,
  levelCount: number,
  options?: ColumnDerivationOptions
): ColumnResult {
  const {
    terrainM,
    surfaceTemperatureC: t,
    surfacePressureHpa: p,
    sensibleHeatFluxWm2: sh,
    latentHeatFluxWm2: lh,
    levels
  } = input;
  const unavailable = (): ColumnResult => ({
    msl: { value: null, flags: STATUS_UNAVAILABLE },
    agl: { value: null, flags: STATUS_UNAVAILABLE },
    branch: 'unavailable',
    depthM: null,
    thermalVelocityMps: null
  });
  if (
    !Array.isArray(levels) ||
    !Number.isSafeInteger(levelCount) ||
    levelCount < 0 ||
    levelCount > levels.length
  ) {
    throw new RangeError('Invalid active profile level count');
  }
  const maxProfileGap = options?.maximumProfileGapM ?? MAX_PROFILE_GAP;
  if (
    ![terrainM, t, p, sh, lh].every(Number.isFinite) ||
    t < MIN_SURFACE_TEMPERATURE ||
    t > MAX_SURFACE_TEMPERATURE ||
    p < MIN_SURFACE_PRESSURE ||
    p > MAX_SURFACE_PRESSURE ||
    !input.humidity ||
    !levelCount
  ) {
    return unavailable();
  }
  let previousHeight = terrainM;
  for (let i = 0; i < levelCount; i++) {
    const level = levels[i]!;
    if (
      !Number.isFinite(level.heightM) ||
      !Number.isFinite(level.temperatureC) ||
      level.temperatureC < MIN_PROFILE_TEMPERATURE ||
      level.temperatureC > MAX_PROFILE_TEMPERATURE ||
      level.heightM <= previousHeight ||
      level.heightM - previousHeight > maxProfileGap
    ) {
      return unavailable();
    }
    previousHeight = level.heightM;
  }
  let r: number | null;
  if ('specificHumidityKgKg' in input.humidity) {
    const q = input.humidity.specificHumidityKgKg;
    r = Number.isFinite(q) && q >= 0 && q < 1 ? q / (1 - q) : null;
  } else {
    r = dewPointMixingRatioKgKg(input.humidity.dewPointC, p);
  }
  if (
    r === null ||
    (p * r) / (EPSILON + r) > saturationVaporPressureHpa(t) * (1 + SATURATION_RELATIVE_TOLERANCE)
  ) {
    return unavailable();
  }
  const q = r / (1 + r);
  const tk = t + KELVIN_OFFSET;
  const tv = (tk * (1 + r / EPSILON)) / (1 + r);
  const rho = (p * PA_PER_HPA) / (RD * tv);
  const virtualFlux =
    ((1 + DELTA * q) * sh) / (rho * CP) + (DELTA * tk * lh) / (rho * LV);
  if (virtualFlux <= 0) {
    return {
      msl: { value: terrainM, flags: STATUS_NO_LIFT },
      agl: { value: 0, flags: STATUS_NO_LIFT },
      branch: 'non-convective',
      depthM: 0,
      thermalVelocityMps: 0
    };
  }

  const dryLapseRate = options?.dryLapseRateKperM ?? DRY_LAPSE_RATE;
  const parcelSurfaceTempC = t + (options?.parcelSurfaceDeltaTC ?? 0);
  const epsMultiplier = options?.crossingEpsilonMultiplier ?? CROSSING_EPSILON_MULTIPLIER;
  const gravityMps2 = options?.gravityMps2 ?? G;

  let depth = levels[levelCount - 1]!.heightM - terrainM;
  let branch: DepthBranch = 'profile-top';
  for (let i = 0; i < levelCount; i++) {
    const level = levels[i]!;
    const height = level.heightM - terrainM;
    const parcelTemperature = dryParcelTemperatureC(
      parcelSurfaceTempC,
      0,
      height,
      dryLapseRate
    );
    const excess = parcelTemperature - level.temperatureC;
    if (
      excess >
      Number.EPSILON *
        epsMultiplier *
        Math.max(1, Math.abs(parcelTemperature), Math.abs(level.temperatureC))
    ) {
      continue;
    }
    if (i === 0) {
      if (!Number.isFinite(input.pblHeightM) || (input.pblHeightM as number) <= 0) {
        return unavailable();
      }
      depth = Math.min(height, input.pblHeightM as number);
      branch = 'model-pbl-fallback';
    } else {
      const prev = levels[i - 1]!;
      const prevHeight = prev.heightM - terrainM;
      const prevExcess =
        dryParcelTemperatureC(parcelSurfaceTempC, 0, prevHeight, dryLapseRate) -
        prev.temperatureC;
      depth =
        prevHeight +
        ((height - prevHeight) * prevExcess) / (prevExcess - Math.min(0, excess));
      branch = 'parcel-crossing';
    }
    break;
  }
  const velocity = Math.cbrt((gravityMps2 * depth * virtualFlux) / tv);
  const usable = usableLiftDepthM(depth, velocity, options);
  const support =
    branch === 'parcel-crossing'
      ? SUPPORT_PARCEL_CROSSING
      : branch === 'profile-top'
        ? SUPPORT_PROFILE_TOP
        : SUPPORT_PBL_CLOSURE;
  return usable === null
    ? {
        msl: { value: terrainM, flags: STATUS_NO_LIFT | support },
        agl: { value: 0, flags: STATUS_NO_LIFT | support },
        branch,
        depthM: depth,
        thermalVelocityMps: velocity
      }
    : {
        msl: { value: terrainM + usable, flags: STATUS_VALID | support },
        agl: { value: usable, flags: STATUS_VALID | support },
        branch,
        depthM: depth,
        thermalVelocityMps: velocity
      };
}
