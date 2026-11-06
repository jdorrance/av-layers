/** Validate a resolved dry column and calculate its convective and usable depths. */
import { dryParcelTemperatureC, mixingRatioFromDewPointKgKg, saturationVaporPressureHpa } from '@av/thermodynamics';
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
  crossingFloat32UnitRoundoff: CROSSING_FLOAT32_UNIT_ROUNDOFF,
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
  surfaceEnvironmentTemperatureC?: number;
  surfacePressureHpa: number;
  humidity: { specificHumidityKgKg: number } | { dewPointC: number };
  sensibleHeatFluxWm2: number;
  latentHeatFluxWm2: number;
  levels: readonly { heightM: number; temperatureC: number }[];
}

export type DepthBranch =
  | 'parcel-crossing'
  | 'profile-top'
  | 'surface-stable'
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
  const ratio = mixingRatioFromDewPointKgKg(dewPointC, pressureHpa);
  return Number.isFinite(ratio) ? ratio : null;
}

export function deriveLift(
  input: ColumnInput,
  levelCount: number,
  options?: ColumnDerivationOptions
): LiftResult {
  return deriveLiftInternal(input, levelCount, options);
}

function deriveLiftInternal(
  input: ColumnInput,
  levelCount: number,
  options: ColumnDerivationOptions | undefined,
  reconstructed?: { heights: Float64Array; temperatures: Float64Array },
  synthetic = false
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
    levelCount > (reconstructed ? reconstructed.heights.length : levels.length)
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
    (input.surfaceEnvironmentTemperatureC !== undefined &&
      (!Number.isFinite(input.surfaceEnvironmentTemperatureC) || input.surfaceEnvironmentTemperatureC <= -KELVIN_OFFSET))
  ) {
    return unavailable();
  }
  if (!levelCount) return unavailable();
  if (!input.humidity) return unavailable();
  let previousHeight = terrainM;
  for (let i = 0; i < levelCount; i++) {
    const height = reconstructed ? reconstructed.heights[i]! : levels[i]!.heightM;
    const temperature = reconstructed ? reconstructed.temperatures[i]! : levels[i]!.temperatureC;
    if (
      !Number.isFinite(height) ||
      !Number.isFinite(temperature) ||
      (synthetic ? temperature <= -KELVIN_OFFSET :
        temperature < MIN_PROFILE_TEMPERATURE || temperature > MAX_PROFILE_TEMPERATURE) ||
      (height < previousHeight || (height === previousHeight && (!synthetic || i === 0))) ||
      (!synthetic && height - previousHeight > maxProfileGap)
    ) {
      return unavailable();
    }
    previousHeight = height;
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

  let depth = (reconstructed ? reconstructed.heights[levelCount - 1]! : levels[levelCount - 1]!.heightM) - terrainM;
  let branch: Exclude<DepthBranch, 'unavailable' | 'non-convective'> = 'profile-top';
  const groundEnvironment = input.surfaceEnvironmentTemperatureC;
  const groundExcess = groundEnvironment === undefined ? undefined : parcelSurfaceTempC - groundEnvironment;
  const groundTolerance = groundEnvironment === undefined ? 0 : Math.max(
    CROSSING_FLOAT32_UNIT_ROUNDOFF * (Math.abs(tk) + Math.abs(groundEnvironment + KELVIN_OFFSET) +
      Math.abs(dryLapseRate) * (2 * Math.abs(terrainM))),
    Number.EPSILON * epsMultiplier * Math.max(1, Math.abs(parcelSurfaceTempC), Math.abs(groundEnvironment))
  );
  if (groundExcess !== undefined && groundExcess < -groundTolerance) {
    depth = 0;
    branch = 'surface-stable';
  }
  for (let i = 0; branch !== 'surface-stable' && i < levelCount; i++) {
    const levelHeight = reconstructed ? reconstructed.heights[i]! : levels[i]!.heightM;
    const levelTemperature = reconstructed ? reconstructed.temperatures[i]! : levels[i]!.temperatureC;
    const height = levelHeight - terrainM;
    const parcelTemperature = dryParcelTemperatureC(
      parcelSurfaceTempC,
      0,
      height,
      dryLapseRate
    );
    const excess = parcelTemperature - levelTemperature;
    // Propagate rounding from the normalized Float32 Kelvin temperatures and MSL heights.
    const inputRounding = CROSSING_FLOAT32_UNIT_ROUNDOFF * (
      Math.abs(tk) + Math.abs(levelTemperature + KELVIN_OFFSET) +
      Math.abs(dryLapseRate) * (Math.abs(terrainM) + Math.abs(levelHeight))
    );
    const eps = Math.max(inputRounding, Number.EPSILON * epsMultiplier *
      Math.max(1, Math.abs(parcelTemperature), Math.abs(levelTemperature)));
    if (excess >= -eps) {
      continue;
    }
    if (i === 0) {
      const lapse = levelCount > 1 && (reconstructed ? reconstructed.heights[1]! : levels[1]!.heightM) > levelHeight
        ? (levelTemperature - (reconstructed ? reconstructed.temperatures[1]! : levels[1]!.temperatureC)) /
          ((reconstructed ? reconstructed.heights[1]! : levels[1]!.heightM) - levelHeight)
        : dryLapseRate;
      const surfaceExcess = groundExcess ?? parcelSurfaceTempC - (levelTemperature + Math.max(0, Math.min(dryLapseRate, lapse)) * height);
      if (surfaceExcess <= eps) {
        depth = 0;
        branch = 'surface-stable';
      } else {
        depth = height * surfaceExcess / (surfaceExcess - excess);
        branch = 'parcel-crossing';
      }
    } else {
      const prevHeight = (reconstructed ? reconstructed.heights[i - 1]! : levels[i - 1]!.heightM) - terrainM;
      const prevExcess =
        dryParcelTemperatureC(parcelSurfaceTempC, 0, prevHeight, dryLapseRate) -
        (reconstructed ? reconstructed.temperatures[i - 1]! : levels[i - 1]!.temperatureC);
      depth =
        prevHeight +
        ((height - prevHeight) * Math.max(0, prevExcess)) / (Math.max(0, prevExcess) - excess);
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

export class ReconstructedProfileWorkspace {
  readonly byteLength: number;
  readonly #heights: Float64Array;
  readonly #temperatures: Float64Array;
  readonly #grounds: Float64Array;
  readonly #groundEnvironments: Float64Array;
  readonly #lowestLapses: Float64Array;
  readonly #surfaceExcesses: Float64Array;
  readonly #counts: Uint32Array;
  readonly #knots: Float64Array;
  readonly #knotTemperatures: Float64Array;
  readonly #knotSupport: Uint8Array;
  readonly #knotOrigin: Uint8Array;
  readonly #knotIndices: Uint8Array;
  readonly #profile: { heights: Float64Array; temperatures: Float64Array };
  readonly #maxLevels: number;
  #count = 0;
  #ground = NaN;
  #groundEnvironment = NaN;
  #surfaceGroundEnvironment = NaN;
  #referenceGround = NaN;
  #groundWeightSum = 0;
  #bridgeUsed = false;
  #minimumDonorTop = NaN;
  #maximumBelowGroundDepth = NaN;
  #failure: 'unsupportedHeight' | 'belowGroundBridgeExceeded' | null = null;
  #admitting = false;
  #knotSlots: number[] = [];
  #knotBridge = NaN;
  #knotCount = 0;
  #knotMode: 'neutral' | 'lowest-layer' = 'neutral';

  constructor(donorCount: number, maxLevels: number) {
    if (!Number.isSafeInteger(donorCount) || donorCount < 0 || !Number.isSafeInteger(maxLevels) || maxLevels < 1 ||
        !Number.isSafeInteger(donorCount * maxLevels)) throw new RangeError('Invalid reconstructed profile capacity');
    this.#maxLevels = maxLevels;
    this.#heights = new Float64Array(donorCount * maxLevels);
    this.#temperatures = new Float64Array(donorCount * maxLevels);
    this.#grounds = new Float64Array(donorCount);
    this.#groundEnvironments = new Float64Array(donorCount);
    this.#lowestLapses = new Float64Array(donorCount);
    this.#surfaceExcesses = new Float64Array(donorCount);
    this.#counts = new Uint32Array(donorCount);
    this.#knots = new Float64Array(4 * (maxLevels + 3));
    this.#knotTemperatures = new Float64Array(this.#knots.length * 4);
    this.#knotSupport = new Uint8Array(this.#knots.length);
    this.#knotOrigin = new Uint8Array(this.#knots.length);
    this.#knotIndices = new Uint8Array(4);
    this.#profile = { heights: new Float64Array(this.#knots.length), temperatures: new Float64Array(this.#knots.length) };
    this.byteLength = this.#heights.byteLength + this.#temperatures.byteLength + this.#grounds.byteLength +
      this.#groundEnvironments.byteLength + this.#lowestLapses.byteLength + this.#surfaceExcesses.byteLength +
      this.#counts.byteLength + this.#knots.byteLength + this.#knotTemperatures.byteLength + this.#knotSupport.byteLength +
      this.#knotOrigin.byteLength + this.#knotIndices.byteLength +
      this.#profile.heights.byteLength + this.#profile.temperatures.byteLength;
  }

  get referenceTerrainM(): number { return this.#referenceGround; }
  get environmentAtGroundC(): number { return this.#groundEnvironment; }
  get surfaceEnvironmentAtGroundC(): number { return this.#surfaceGroundEnvironment; }
  donorGroundEnvironmentC(slot: number): number { return this.#groundEnvironments[slot]!; }
  donorSurfaceExcessC(slot: number): number { return this.#surfaceExcesses[slot]!; }
  groundEnvironmentWeight(slot: number, weight: number): number {
    return this.#grounds[slot]! - this.#ground <= this.#bridgeBound ? weight / this.#groundWeightSum : 0;
  }
  #bridgeBound = NaN;
  get bridgeUsed(): boolean { return this.#bridgeUsed; }
  get minimumDonorTopM(): number { return this.#minimumDonorTop; }
  get maximumBelowGroundDepthM(): number { return this.#maximumBelowGroundDepth; }
  get failure(): 'unsupportedHeight' | 'belowGroundBridgeExceeded' | null { return this.#failure; }
  get levelCount(): number { return this.#count; }

  reset(): void {
    if (this.#admitting) throw new Error('Donor admission is in progress');
    this.#counts.fill(0);
    this.#knotSlots = [];
    this.#count = 0;
    this.#minimumDonorTop = NaN;
    this.#maximumBelowGroundDepth = NaN;
  }

  admit(slot: number, input: ColumnInput, count: number): boolean {
    if (this.#admitting) throw new Error('Donor admission is in progress');
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= this.#counts.length || !Number.isSafeInteger(count) || count < 0 || count > this.#maxLevels) {
      throw new RangeError('Invalid donor slot or level count');
    }
    this.#count = 0;
    this.#counts[slot] = 0;
    this.#knotSlots = [];
    this.#admitting = true;
    try {
      const levels = input.levels, humidity = input.humidity;
      if (!Array.isArray(levels) || count > levels.length) throw new RangeError('Invalid active profile level count');
      const snapshot: ColumnInput = {
        terrainM: input.terrainM, surfaceTemperatureC: input.surfaceTemperatureC,
        surfaceEnvironmentTemperatureC: input.surfaceEnvironmentTemperatureC,
        surfacePressureHpa: input.surfacePressureHpa,
        humidity: 'specificHumidityKgKg' in humidity
          ? { specificHumidityKgKg: humidity.specificHumidityKgKg } : { dewPointC: humidity.dewPointC },
        sensibleHeatFluxWm2: input.sensibleHeatFluxWm2, latentHeatFluxWm2: input.latentHeatFluxWm2,
        levels: []
      };
      const base = slot * this.#maxLevels;
      for (let i = 0; i < count; i++) {
        const level = levels[i]!;
        this.#heights[base + i] = level.heightM;
        this.#temperatures[base + i] = level.temperatureC;
      }
      const profile = { heights: this.#heights.subarray(base, base + count), temperatures: this.#temperatures.subarray(base, base + count) };
      if (deriveLiftInternal(snapshot, count, undefined, profile).status === 'unavailable') return false;
      this.#grounds[slot] = snapshot.terrainM;
      const lapse = count > 1 ? Math.max(0, Math.min(DRY_LAPSE_RATE,
        (this.#temperatures[base]! - this.#temperatures[base + 1]!) / (this.#heights[base + 1]! - this.#heights[base]!))) : DRY_LAPSE_RATE;
      this.#lowestLapses[slot] = lapse;
      this.#groundEnvironments[slot] = this.#temperatures[base]! + lapse * (this.#heights[base]! - snapshot.terrainM);
      this.#surfaceExcesses[slot] = snapshot.surfaceTemperatureC - this.#groundEnvironments[slot]!;
      this.#counts[slot] = count;
      return true;
    } finally {
      this.#admitting = false;
    }
  }

  reconstruct(slots: Uint32Array, weights: Float64Array, offset: number, count: number,
    terrainM: number, bridgeM: number, bridgeMode: 'neutral' | 'lowest-layer' = 'neutral'): boolean {
    if (this.#admitting) throw new Error('Donor admission is in progress');
    this.#count = 0;
    this.#failure = null;
    this.#bridgeUsed = false;
    this.#minimumDonorTop = NaN;
    this.#maximumBelowGroundDepth = NaN;
    this.#surfaceGroundEnvironment = NaN;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count) || count < 1 || count > 4 ||
        offset + count > slots.length || offset + count > weights.length || !Number.isFinite(terrainM) ||
        !Number.isFinite(bridgeM) || bridgeM < 0 || bridgeM > 1500 ||
        (bridgeMode !== 'neutral' && bridgeMode !== 'lowest-layer')) return false;
    let top = Infinity, h0 = 0, weightSum = 0;
    for (let i = 0; i < count; i++) {
      const slot = slots[offset + i]!, weight = weights[offset + i]!, n = this.#counts[slot] ?? 0;
      if (!n || !Number.isFinite(weight) || weight <= 0) return false;
      weightSum += weight;
      h0 += weight * this.#grounds[slot]!;
      top = Math.min(top, this.#heights[slot * this.#maxLevels + n - 1]!);
    }
    this.#minimumDonorTop = top;
    let maximumDepth = 0;
    for (let i = 0; i < count; i++) {
      maximumDepth = Math.max(maximumDepth, this.#grounds[slots[offset + i]!]! - terrainM);
    }
    this.#maximumBelowGroundDepth = maximumDepth;
    if (Math.abs(weightSum - 1) > 1e-12 || terrainM >= top) {
      this.#failure = 'unsupportedHeight';
      return false;
    }
    const environment = (height: number, left = false, dampBelowGround = false): number => {
      let value = 0, supportedWeight = 0;
      for (let i = 0; i < count; i++) {
        const slot = slots[offset + i]!, base = slot * this.#maxLevels, n = this.#counts[slot]!;
        const ground = this.#grounds[slot]!, first = this.#heights[base]!, t = this.#temperatures[base]!;
        if (height < ground - bridgeM || (left && height === ground - bridgeM)) continue;
        if (height > this.#heights[base + n - 1]!) { this.#failure = 'unsupportedHeight'; return NaN; }
        const lapse = this.#lowestLapses[slot]!;
        let temperature: number;
        if (height < ground) {
          this.#bridgeUsed = true;
          const dz = ground - height;
          const effDz = dampBelowGround && bridgeM > 0 ? dz / (1 + dz / (0.5 * bridgeM)) : dz;
          temperature = t + lapse * (first - ground) + (bridgeMode === 'neutral' ? DRY_LAPSE_RATE : lapse) * effDz;
        } else if (height <= first) {
          temperature = t + lapse * (first - height);
        } else {
          let j = 1;
          while (j < n && this.#heights[base + j]! < height) j++;
          const lower = this.#heights[base + j - 1]!, upper = this.#heights[base + j]!;
          temperature = this.#temperatures[base + j - 1]! + (height - lower) / (upper - lower) *
            (this.#temperatures[base + j]! - this.#temperatures[base + j - 1]!);
        }
        value += weights[offset + i]! * temperature;
        supportedWeight += weights[offset + i]!;
      }
      if (supportedWeight === 0) { this.#failure = 'belowGroundBridgeExceeded'; return NaN; }
      value /= supportedWeight;
      if (height === terrainM && !left) this.#groundWeightSum = supportedWeight;
      if (!Number.isFinite(value) || value <= -KELVIN_OFFSET) { this.#failure = 'unsupportedHeight'; return NaN; }
      return value;
    };
    const groundEnvironment = environment(terrainM);
    if (!Number.isFinite(groundEnvironment)) return false;
    const surfaceGroundEnvironment = environment(terrainM, false, true);
    let cached = this.#knotBridge === bridgeM && this.#knotMode === bridgeMode;
    let activeMask = 0;
    for (let i = 0; i < count; i++) {
      const position = this.#knotSlots.indexOf(slots[offset + i]!);
      if (position < 0) { cached = false; break; }
      this.#knotIndices[i] = position;
      activeMask |= 1 << position;
    }
    if (!cached) {
      this.#knotSlots = [];
      this.#knotBridge = bridgeM;
      this.#knotMode = bridgeMode;
      this.#knotCount = 0;
      for (let i = 0; i < count; i++) {
        const slot = slots[offset + i]!, base = slot * this.#maxLevels, n = this.#counts[slot]!;
        const ground = this.#grounds[slot]!;
        this.#knotSlots.push(slot);
        this.#knots[this.#knotCount++] = ground - bridgeM;
        this.#knots[this.#knotCount++] = ground;
        for (let j = 0; j < n; j++) this.#knots[this.#knotCount++] = this.#heights[base + j]!;
      }
      this.#knots.subarray(0, this.#knotCount).sort();
      for (let k = 0; k < this.#knotCount; k++) {
        const height = this.#knots[k]!;
        let support = 0, origin = 0;
        for (let i = 0; i < count; i++) {
          const slot = slots[offset + i]!, base = slot * this.#maxLevels, n = this.#counts[slot]!;
          const ground = this.#grounds[slot]!, first = this.#heights[base]!, t = this.#temperatures[base]!;
          if (height === ground - bridgeM || height === ground) origin |= 1 << i;
          for (let j = 0; j < n; j++) if (height === this.#heights[base + j]!) origin |= 1 << i;
          if (height < ground - bridgeM || height > this.#heights[base + n - 1]!) continue;
          const lapse = this.#lowestLapses[slot]!;
          let temperature: number;
          if (height < ground) {
            temperature = t + lapse * (first - ground) + (bridgeMode === 'neutral' ? DRY_LAPSE_RATE : lapse) * (ground - height);
          } else if (height <= first) {
            temperature = t + lapse * (first - height);
          } else {
            let j = 1;
            while (j < n && this.#heights[base + j]! < height) j++;
            const lower = this.#heights[base + j - 1]!, upper = this.#heights[base + j]!;
            temperature = this.#temperatures[base + j - 1]! + (height - lower) / (upper - lower) *
              (this.#temperatures[base + j]! - this.#temperatures[base + j - 1]!);
          }
          this.#knotTemperatures[k * 4 + i] = temperature;
          support |= 1 << i;
        }
        this.#knotSupport[k] = support;
        this.#knotOrigin[k] = origin;
      }
      activeMask = (1 << count) - 1;
      for (let i = 0; i < count; i++) this.#knotIndices[i] = i;
    }
    const knotEnvironment = (k: number, left: boolean): number => {
      const height = this.#knots[k]!, support = this.#knotSupport[k]!;
      let value = 0, supportedWeight = 0;
      for (let i = 0; i < count; i++) {
        const ground = this.#grounds[slots[offset + i]!]!;
        const position = this.#knotIndices[i]!;
        if (!(support & (1 << position)) || (left && height === ground - bridgeM)) continue;
        if (height < ground) this.#bridgeUsed = true;
        value += weights[offset + i]! * this.#knotTemperatures[k * 4 + position]!;
        supportedWeight += weights[offset + i]!;
      }
      if (supportedWeight === 0) { this.#failure = 'belowGroundBridgeExceeded'; return NaN; }
      value /= supportedWeight;
      if (!Number.isFinite(value) || value <= -KELVIN_OFFSET) { this.#failure = 'unsupportedHeight'; return NaN; }
      return value;
    };
    let previous = terrainM;
    for (let i = 0; i < this.#knotCount; i++) {
      const height = this.#knots[i]!;
      if (!(this.#knotOrigin[i]! & activeMask)) continue;
      if (height <= terrainM || height > top) continue;
      if (height === previous) continue;
      let entry = false;
      for (let j = 0; j < count; j++) if (this.#grounds[slots[offset + j]!]! - bridgeM === height) entry = true;
      if (entry) {
        const left = knotEnvironment(i, true);
        if (!Number.isFinite(left)) { this.#count = 0; return false; }
        this.#profile.heights[this.#count] = height;
        this.#profile.temperatures[this.#count++] = left;
      }
      const temperature = knotEnvironment(i, false);
      if (!Number.isFinite(temperature)) { this.#count = 0; return false; }
      this.#profile.heights[this.#count] = height;
      this.#profile.temperatures[this.#count++] = temperature;
      previous = height;
    }
    if (!this.#count) { this.#failure = 'unsupportedHeight'; return false; }
    this.#ground = terrainM;
    this.#bridgeBound = bridgeM;
    this.#referenceGround = h0;
    this.#groundEnvironment = groundEnvironment;
    this.#surfaceGroundEnvironment = surfaceGroundEnvironment;
    return true;
  }

  solve(input: Omit<ColumnInput, 'levels' | 'surfaceEnvironmentTemperatureC' | 'terrainM'>): LiftResult {
    if (this.#admitting) throw new Error('Donor admission is in progress');
    if (!this.#count) throw new Error('No reconstructed profile');
    return deriveLiftInternal({ ...input, terrainM: this.#ground,
      surfaceEnvironmentTemperatureC: this.#groundEnvironment, levels: [] }, this.#count, undefined, this.#profile, true);
  }
}
