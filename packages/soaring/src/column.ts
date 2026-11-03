/** Validate a resolved dry column and calculate its convective and usable depths. */
import { dryParcelTemperatureC, saturationVaporPressureHpa } from '@av/thermodynamics';
import { THERMODYNAMIC_CONSTANTS } from '@av/thermodynamics/constants';
import { DEFAULT_SOARING_PARAMETERS } from './parameters.js';
import { usableLiftDepthM, type UsableLiftOptions } from './velocity.js';

const {
  waterDryAirMolarMassRatio: EPSILON,
  dryAirGasConstantJkgK: RD,
  dryAirHeatCapacityJkgK: CP,
  latentHeatVaporizationJkg: LV,
  gravityMps2: G,
  kelvinOffset: KELVIN_OFFSET,
  pascalsPerHectopascal: PA_PER_HPA,
  dryLapseRateKperM: DRY_LAPSE_RATE
} = THERMODYNAMIC_CONSTANTS;
const {
  saturationRelativeTolerance: SATURATION_RELATIVE_TOLERANCE,
  minimumSurfaceTemperatureC: MIN_SURFACE_TEMPERATURE,
  maximumSurfaceTemperatureC: MAX_SURFACE_TEMPERATURE,
  minimumSurfacePressureHpa: MIN_SURFACE_PRESSURE,
  maximumSurfacePressureHpa: MAX_SURFACE_PRESSURE,
  minimumProfileTemperatureC: MIN_PROFILE_TEMPERATURE,
  maximumProfileTemperatureC: MAX_PROFILE_TEMPERATURE,
  maximumProfileGapM: MAX_PROFILE_GAP,
  crossingEpsilonMultiplier: CROSSING_EPSILON_MULTIPLIER
} = DEFAULT_SOARING_PARAMETERS;
const DELTA = (1 - EPSILON) / EPSILON;

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

/** Physical lift result; publication status bits belong to the forecast boundary. */
export type LiftResult =
  | {
      status: 'unavailable';
      branch: 'unavailable';
      usableDepthM: null;
      depthM: null;
      thermalVelocityMps: null;
    }
  | {
      status: 'valid' | 'no-lift';
      branch: Exclude<DepthBranch, 'unavailable'>;
      usableDepthM: number;
      depthM: number;
      thermalVelocityMps: number;
    };

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

export function deriveLift(
  input: ColumnInput,
  levelCount: number,
  options?: ColumnDerivationOptions
): LiftResult {
  const {
    terrainM,
    surfaceTemperatureC: t,
    surfacePressureHpa: p,
    sensibleHeatFluxWm2: sh,
    latentHeatFluxWm2: lh,
    levels
  } = input;
  const unavailable = (): LiftResult => ({
    status: 'unavailable',
    usableDepthM: null,
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
      status: 'no-lift',
      usableDepthM: 0,
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
  let branch: Exclude<DepthBranch, 'unavailable' | 'non-convective'> = 'profile-top';
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
  return {
    status: usable === null ? 'no-lift' : 'valid',
    usableDepthM: usable ?? 0,
    branch,
    depthM: depth,
    thermalVelocityMps: velocity
  };
}
