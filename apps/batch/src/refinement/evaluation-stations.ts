import { getBit, prepareCoverageTester, TERRAIN_CLEARANCE_METHOD, type CoverageMask } from '@av/contracts';
import { deriveSelectedFrameDiagnostics, type FrameDiagnostics } from '@av/forecast/frame';
import type { NormalizedFrame } from '@av/forecast/inputs';
import { prepareTerrainClearance, type PreparedTerrainClearance, type PreparedTerrainColumns, type TerrainColumnClearance, type TerrainColumnProbe } from '@av/forecast/refinement';
import { planSample } from '@av/forecast/sampler';
import z from 'zod';

export const MAX_STATION_OBSERVATION_BYTES = 16 * 1024 * 1024;
const MAX_STATION_OBSERVATIONS = 100_000;
const MAX_STATION_ELEVATION_MISMATCH_M = 150;
const DRY_ADIABATIC_LAPSE_K_PER_M = 0.0098;

const STATION_ID = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/;
const UTC_TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;

const observationSchema = z.object({
  stationId: z.string().regex(STATION_ID),
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
  elevationM: z.number().finite().min(-500).max(5000),
  validAt: z.string().regex(UTC_TIMESTAMP).refine(value => {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19);
  }),
  temperatureC: z.number().finite().min(-90).max(60),
  precipitationState: z.enum(['dry', 'wet', 'unknown']),
  observationSource: z.string().min(1).max(64)
});

export type StationObservation = z.infer<typeof observationSchema>;

export interface StationObservationParseOptions {
  readonly maxBytes?: number;
  readonly maxRows?: number;
}

export function parseStationObservations(
  bytes: Uint8Array,
  options: StationObservationParseOptions = {}
): readonly StationObservation[] {
  const maxBytes = options.maxBytes ?? MAX_STATION_OBSERVATION_BYTES;
  const maxRows = options.maxRows ?? MAX_STATION_OBSERVATIONS;
  if (!(bytes instanceof Uint8Array)) throw new Error('Station observations must be bytes');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_STATION_OBSERVATION_BYTES) {
    throw new RangeError('Station observation byte budget exceeded');
  }
  if (bytes.byteLength > maxBytes) throw new RangeError('Station observation byte budget exceeded');
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_STATION_OBSERVATIONS) {
    throw new RangeError('Station observation row budget exceeded');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Station observations are not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('Station observations must be an array');
  if (parsed.length > maxRows) throw new RangeError('Station observation row budget exceeded');
  const result: StationObservation[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < parsed.length; index++) {
    const observation = observationSchema.parse(parsed[index]);
    const key = `${observation.stationId}\n${observation.validAt}`;
    if (seen.has(key)) throw new Error(`Duplicate station observation at index ${index}`);
    seen.add(key);
    result.push(observation);
  }
  return result;
}

export type ElevationOffsetBand = '<=-250' | '-250..-100' | '-100..0' | '0..200' | '>=200';

export const ELEVATION_OFFSET_BANDS: readonly ElevationOffsetBand[] = ['<=-250', '-250..-100', '-100..0', '0..200', '>=200'];

function elevationOffsetBand(offsetM: number): ElevationOffsetBand {
  if (!Number.isFinite(offsetM)) throw new RangeError('Elevation offset must be finite');
  if (offsetM <= -250) return '<=-250';
  if (offsetM <= -100) return '-250..-100';
  if (offsetM <= 0) return '-100..0';
  if (offsetM < 200) return '0..200';
  return '>=200';
}

export interface TemperatureMetrics {
  readonly count: number;
  readonly biasC: number | null;
  readonly maeC: number | null;
  readonly rmseC: number | null;
  readonly uniqueStations: number;
  readonly uniqueDays: number;
}

interface MutableMetrics {
  count: number;
  sumError: number;
  sumAbsolute: number;
  sumSquared: number;
  stations: Set<string>;
  days: Set<string>;
}

function emptyMutableMetrics(): MutableMetrics {
  return { count: 0, sumError: 0, sumAbsolute: 0, sumSquared: 0, stations: new Set(), days: new Set() };
}

function addPair(metrics: MutableMetrics, predictionC: number, observation: StationObservation): void {
  if (!Number.isFinite(predictionC)) return;
  const error = predictionC - observation.temperatureC;
  metrics.count++;
  metrics.sumError += error;
  metrics.sumAbsolute += Math.abs(error);
  metrics.sumSquared += error * error;
  metrics.stations.add(observation.stationId);
  metrics.days.add(observation.validAt.slice(0, 10));
}

function finalize(metrics: MutableMetrics): TemperatureMetrics {
  if (!metrics.count) {
    return { count: 0, biasC: null, maeC: null, rmseC: null, uniqueStations: 0, uniqueDays: 0 };
  }
  return {
    count: metrics.count,
    biasC: metrics.sumError / metrics.count,
    maeC: metrics.sumAbsolute / metrics.count,
    rmseC: Math.sqrt(metrics.sumSquared / metrics.count),
    uniqueStations: metrics.stations.size,
    uniqueDays: metrics.days.size
  };
}

export interface StationTarget {
  readonly latitude: number;
  readonly longitude: number;
  readonly stationElevationM: number;
  readonly demElevationM: number;
  readonly mask: CoverageMask;
  readonly terrain: { readonly elevationM: Float32Array; readonly valid: Uint8Array };
}

export interface SparseFrameDiagnostics {
  readonly validAt: string;
  readonly diagnostics: FrameDiagnostics;
  readonly flags: Uint8Array;
  readonly bufferBytes: number;
  readonly sourceIndices: Uint32Array;
}

export function prepareSparseFrameDiagnostics(
  frame: NormalizedFrame,
  sourceMask: CoverageMask,
  targets: readonly StationTarget[]
): SparseFrameDiagnostics {
  const activeSet = new Set<number>(frame.activeIndices);
  const donorSet = new Set<number>();
  for (const target of targets) {
    const plan = planSample(sourceMask.grid, target.latitude, target.longitude);
    if (!plan) continue;
    for (const contributor of plan.contributors) {
      if (contributor.weight <= 0) continue;
      const index = contributor.index;
      if (!activeSet.has(index)) continue;
      if (!getBit(sourceMask.output, index) && !getBit(sourceMask.halo, index)) continue;
      donorSet.add(index);
    }
  }
  const sourceIndices = Uint32Array.from([...donorSet].sort((a, b) => a - b));
  if (!sourceIndices.length) throw new Error('Station clearance has no active source contributors');
  const result = deriveSelectedFrameDiagnostics(frame, sourceIndices);
  const value: SparseFrameDiagnostics = {
    validAt: frame.validAt,
    diagnostics: result.diagnostics,
    flags: result.flags,
    bufferBytes: result.bufferBytes,
    sourceIndices
  };
  return value;
}

interface KernelStationVariant {
  readonly id: string;
  readonly temperature?: 'probe';
  readonly clearance?: boolean;
  readonly prepare: (target: StationTarget, frame: NormalizedFrame, maxLevels: number) => PreparedTerrainColumns;
}

interface DerivedStationVariant {
  readonly id: string;
  readonly temperature: 'uncorrected' | 'dry-adiabatic';
  readonly prepare?: never;
}

export type StationVariant = KernelStationVariant | DerivedStationVariant;

export interface StationPredictionRow {
  readonly variantId: string;
  readonly observation: StationObservation;
  readonly band: ElevationOffsetBand;
  readonly hourUtc: number;
  readonly predictionC: number;
}

export interface StationReplayOptions {
  readonly frame: NormalizedFrame;
  readonly sourceMask: CoverageMask;
  readonly targetMask: CoverageMask;
  readonly terrain: { readonly elevationM: Float32Array; readonly valid: Uint8Array };
  readonly observations: readonly StationObservation[];
  readonly variants: readonly StationVariant[];
  readonly maxLevels: number;
  readonly demSampling?: 'bilinear' | 'nearest';
  readonly maxElevationMismatchM?: number;
  readonly onPrediction?: (row: StationPredictionRow) => void;
  readonly onProbe?: (variantId: string, observation: StationObservation, probe: TerrainColumnProbe) => void;
}

export interface StationPopulationCounts {
  readonly observations: number;
  readonly exactTime: number;
  readonly inTarget: number;
  readonly demAvailable: number;
  readonly elevationAccepted: number;
  readonly nativeAvailable: number;
  readonly gateEligible: number;
  readonly unknownPrecipitation: number;
  readonly rainy: number;
}

export interface StationExclusionCounts {
  readonly timeMismatch: number;
  readonly outsideTarget: number;
  readonly demUnavailable: number;
  readonly elevationMismatch: number;
  readonly nativeUnavailable: number;
  readonly precipitationUnknown: number;
  readonly rainy: number;
}

export interface StationVariantExclusionCounts {
  readonly probeUnavailable: number;
  readonly invalidProbe: number;
  readonly temperatureMissing: number;
}

interface StationVariantResult {
  readonly id: string;
  readonly diagnostic: TemperatureMetrics;
  readonly gate: TemperatureMetrics;
  readonly byElevationOffset: Readonly<Record<ElevationOffsetBand, TemperatureMetrics>>;
  readonly byHourUtc: readonly TemperatureMetrics[];
  readonly exclusions: StationVariantExclusionCounts;
}

export interface StationReplayResult {
  readonly frameValidAt: string;
  readonly counts: StationPopulationCounts;
  readonly exclusions: StationExclusionCounts;
  readonly variants: readonly StationVariantResult[];
  readonly memory: {
    readonly sparseDiagnosticsBufferBytes: number;
    readonly sparseDonorIndices: number;
    readonly sparseIndexBufferBytes: number;
    readonly clearanceMappingBytes: number;
  };
}

interface NativeSample {
  readonly temperatureK: number;
  readonly terrainM: number;
}

interface AcceptedStation {
  readonly observation: StationObservation;
  readonly band: ElevationOffsetBand;
  readonly hourUtc: number;
  readonly native: NativeSample;
  readonly target: StationTarget;
}

interface VariantAccumulator {
  readonly diagnostic: MutableMetrics;
  readonly gate: MutableMetrics;
  readonly bands: Record<ElevationOffsetBand, MutableMetrics>;
  readonly hours: MutableMetrics[];
  probeUnavailable: number;
  invalidProbe: number;
  temperatureMissing: number;
}

function emptyVariantAccumulator(): VariantAccumulator {
  return {
    diagnostic: emptyMutableMetrics(),
    gate: emptyMutableMetrics(),
    bands: Object.fromEntries(ELEVATION_OFFSET_BANDS.map(band => [band, emptyMutableMetrics()])) as Record<ElevationOffsetBand, MutableMetrics>,
    hours: Array.from({ length: 24 }, emptyMutableMetrics),
    probeUnavailable: 0,
    invalidProbe: 0,
    temperatureMissing: 0
  };
}

function stationMask(latitude: number, longitude: number, earthRadiusM: number): CoverageMask {
  return {
    grid: {
      kind: 'regular-latlon',
      width: 1,
      height: 1,
      earthRadiusM,
      lon0: longitude,
      lat0: latitude,
      dx: 1e-6,
      dy: -1e-6,
      wrapLongitude: false
    },
    bounds: [longitude, latitude, longitude, latitude],
    output: Uint8Array.of(1),
    halo: Uint8Array.of(0),
    tiles: Uint8Array.of(0),
    maxZoom: 0
  };
}

function sampleTargetDem(
  targetMask: CoverageMask,
  terrain: StationReplayOptions['terrain'],
  latitude: number,
  longitude: number,
  mode: 'bilinear' | 'nearest'
): number | null {
  if (terrain.elevationM.length !== targetMask.grid.width * targetMask.grid.height
      || terrain.valid.length !== terrain.elevationM.length) return null;
  const plan = planSample(targetMask.grid, latitude, longitude);
  if (!plan || !plan.contributors.length) return null;
  if (mode === 'nearest') {
    let selected = plan.contributors[0]!;
    for (const contributor of plan.contributors) {
      if (contributor.weight > selected.weight) selected = contributor;
    }
    const index = selected.index;
    if (!getBit(targetMask.output, index) && !getBit(targetMask.halo, index)) return null;
    if (terrain.valid[index] !== 1 || !Number.isFinite(terrain.elevationM[index])) return null;
    return terrain.elevationM[index]!;
  }
  let total = 0;
  let weightSum = 0;
  for (const contributor of plan.contributors) {
    if (contributor.weight <= 0) continue;
    const index = contributor.index;
    if (!getBit(targetMask.output, index) && !getBit(targetMask.halo, index)) return null;
    const elevation = terrain.elevationM[index];
    if (terrain.valid[index] !== 1 || !Number.isFinite(elevation)) return null;
    total += elevation! * contributor.weight;
    weightSum += contributor.weight;
  }
  return weightSum > 0 && Number.isFinite(total) ? total / weightSum : null;
}

function sampleNative(
  frame: NormalizedFrame,
  activeSlot: ReadonlyMap<number, number>,
  latitude: number,
  longitude: number
): NativeSample | null {
  const plan = planSample(frame.grid, latitude, longitude);
  if (!plan || !plan.contributors.length) return null;
  let temperature = 0;
  let terrain = 0;
  let weightSum = 0;
  for (const contributor of plan.contributors) {
    if (contributor.weight <= 0) continue;
    const slot = activeSlot.get(contributor.index);
    if (slot === undefined) return null;
    if (frame.missing.temp2m[slot] !== 0 || frame.missing.terrain[slot] !== 0) return null;
    const t = frame.temp2mK[slot];
    const h = frame.terrainM[slot];
    if (!Number.isFinite(t) || !Number.isFinite(h)) return null;
    temperature += t! * contributor.weight;
    terrain += h! * contributor.weight;
    weightSum += contributor.weight;
  }
  if (weightSum <= 0) return null;
  return { temperatureK: temperature / weightSum, terrainM: terrain / weightSum };
}

function validateOptions(options: StationReplayOptions): void {
  if (!Number.isSafeInteger(options.maxLevels) || options.maxLevels < 1) throw new RangeError('Station replay maxLevels must be positive');
  if (!Array.isArray(options.observations)) throw new Error('Station observations must be an array');
  if (!Array.isArray(options.variants) || options.variants.length === 0) throw new Error('Station replay requires variants');
  if (new Set(options.variants.map(variant => variant.id)).size !== options.variants.length) throw new Error('Station variant ids must be unique');
  const mismatch = options.maxElevationMismatchM ?? MAX_STATION_ELEVATION_MISMATCH_M;
  if (!Number.isFinite(mismatch) || mismatch < 0 || mismatch > 1000) throw new RangeError('Station elevation mismatch limit is invalid');
  if (options.demSampling !== undefined && !['bilinear', 'nearest'].includes(options.demSampling)) throw new Error('Unknown DEM sampling mode');
  const cellCount = options.targetMask.grid.width * options.targetMask.grid.height;
  if (options.terrain.elevationM.length !== cellCount || options.terrain.valid.length !== cellCount) {
    throw new RangeError('Station target terrain differs from target grid');
  }
  if (options.frame.activeIndices.length !== options.frame.terrainM.length
      || options.frame.activeIndices.length !== options.frame.temp2mK.length
      || options.frame.activeIndices.length !== options.frame.missing.terrain.length
      || options.frame.activeIndices.length !== options.frame.missing.temp2m.length) {
    throw new RangeError('Station frame compact arrays differ from active indices');
  }
}

export function evaluateStations(options: StationReplayOptions): StationReplayResult {
  validateOptions(options);
  const frameMs = Date.parse(options.frame.validAt);
  if (!Number.isFinite(frameMs)) throw new Error('Station frame validAt is invalid');
  const mismatchLimit = options.maxElevationMismatchM ?? MAX_STATION_ELEVATION_MISMATCH_M;
  const demMode = options.demSampling ?? 'bilinear';
  const targetCovered = prepareCoverageTester(options.targetMask);
  const activeSlot = new Map<number, number>();
  for (let slot = 0; slot < options.frame.activeIndices.length; slot++) {
    activeSlot.set(options.frame.activeIndices[slot]!, slot);
  }
  const counts = {
    observations: options.observations.length,
    exactTime: 0,
    inTarget: 0,
    demAvailable: 0,
    elevationAccepted: 0,
    nativeAvailable: 0,
    gateEligible: 0,
    unknownPrecipitation: 0,
    rainy: 0
  };
  const exclusions = {
    timeMismatch: 0,
    outsideTarget: 0,
    demUnavailable: 0,
    elevationMismatch: 0,
    nativeUnavailable: 0,
    precipitationUnknown: 0,
    rainy: 0
  };
  const accepted: AcceptedStation[] = [];
  for (const observation of options.observations) {
    if (Date.parse(observation.validAt) !== frameMs) {
      exclusions.timeMismatch++;
      continue;
    }
    counts.exactTime++;
    if (!targetCovered(observation.lat, observation.lon)) {
      exclusions.outsideTarget++;
      continue;
    }
    counts.inTarget++;
    const demElevationM = sampleTargetDem(options.targetMask, options.terrain, observation.lat, observation.lon, demMode);
    if (demElevationM === null) {
      exclusions.demUnavailable++;
      continue;
    }
    counts.demAvailable++;
    if (Math.abs(observation.elevationM - demElevationM) > mismatchLimit) {
      exclusions.elevationMismatch++;
      continue;
    }
    counts.elevationAccepted++;
    const native = sampleNative(options.frame, activeSlot, observation.lat, observation.lon);
    if (!native) {
      exclusions.nativeUnavailable++;
      continue;
    }
    counts.nativeAvailable++;
    if (observation.precipitationState === 'unknown') {
      exclusions.precipitationUnknown++;
      counts.unknownPrecipitation++;
    } else if (observation.precipitationState === 'wet') {
      exclusions.rainy++;
      counts.rainy++;
    } else {
      counts.gateEligible++;
    }
    const mask = stationMask(observation.lat, observation.lon, options.targetMask.grid.earthRadiusM);
    accepted.push({
      observation,
      band: elevationOffsetBand(observation.elevationM - native.terrainM),
      hourUtc: new Date(frameMs).getUTCHours(),
      native,
      target: {
        latitude: observation.lat,
        longitude: observation.lon,
        stationElevationM: observation.elevationM,
        demElevationM,
        mask,
        terrain: { elevationM: Float32Array.of(observation.elevationM), valid: Uint8Array.of(1) }
      }
    });
  }

  const sparseCache = new WeakMap<NormalizedFrame, SparseFrameDiagnostics>();
  const clearancePlans = new WeakMap<StationTarget, PreparedTerrainClearance>();
  let clearanceMappingBytes = 0;
  const sparse = accepted.length && options.variants.some(variant => 'clearance' in variant && variant.clearance)
    ? prepareSparseFrameDiagnostics(options.frame, options.sourceMask, accepted.map(station => station.target))
    : undefined;
  if (sparse) sparseCache.set(options.frame, sparse);
  const variants = options.variants.map(variant => {
    const accumulator = emptyVariantAccumulator();
    for (const station of accepted) {
      let predictionC: number;
      if (variant.temperature === 'uncorrected') {
        predictionC = station.native.temperatureK - 273.15;
      } else if (variant.temperature === 'dry-adiabatic') {
        predictionC = station.native.temperatureK - 273.15
          - DRY_ADIABATIC_LAPSE_K_PER_M * (station.observation.elevationM - station.native.terrainM);
      } else {
        const prepare = variant.prepare;
        if (!prepare) throw new Error(`Station variant ${variant.id} has no kernel`);
        const kernel = prepare(station.target, options.frame, options.maxLevels);
        const time = { intervalStart: options.frame.intervals.profileTime, validTime: options.frame.validAt };
        let clearance: TerrainColumnClearance | undefined;
        if (variant.clearance) {
          const diagnostics = sparseCache.get(options.frame)!;
          let plan = clearancePlans.get(station.target);
          if (!plan) {
            plan = prepareTerrainClearance(options.sourceMask, station.target.mask);
            clearancePlans.set(station.target, plan);
            clearanceMappingBytes += plan.byteLength;
          }
          clearance = { methodId: TERRAIN_CLEARANCE_METHOD.id, validTime: options.frame.validAt, grid: station.target.mask.grid,
            fields: plan.derive(diagnostics.diagnostics, diagnostics.flags, station.target.terrain, time, false) };
        }
        const result = kernel.derive(options.frame, station.target.terrain, time, {
          daylightOnly: false,
          probeIndices: [0],
          clearance
        });
        const probe = result.probes.find(candidate => candidate.index === 0);
        if (!probe) {
          accumulator.probeUnavailable++;
          continue;
        }
        options.onProbe?.(variant.id, station.observation, probe);
        const temperatureK = probe.surfaceTemperatureK;
        if (probe.provenance === 'clearance' || temperatureK === null) {
          accumulator.temperatureMissing++;
          continue;
        }
        if (probe.provenance !== 'column' || probe.reason !== null
            || !Number.isFinite(temperatureK) || temperatureK < 150 || temperatureK > 350) {
          accumulator.invalidProbe++;
          continue;
        }
        predictionC = temperatureK - 273.15;
      }
      options.onPrediction?.({ variantId: variant.id, observation: station.observation, band: station.band, hourUtc: station.hourUtc, predictionC });
      addPair(accumulator.diagnostic, predictionC, station.observation);
      if (station.observation.precipitationState !== 'dry') continue;
      addPair(accumulator.gate, predictionC, station.observation);
      addPair(accumulator.bands[station.band], predictionC, station.observation);
      addPair(accumulator.hours[station.hourUtc]!, predictionC, station.observation);
    }
    return {
      id: variant.id,
      diagnostic: finalize(accumulator.diagnostic),
      gate: finalize(accumulator.gate),
      byElevationOffset: Object.fromEntries(ELEVATION_OFFSET_BANDS.map(band => [band, finalize(accumulator.bands[band])])) as Record<ElevationOffsetBand, TemperatureMetrics>,
      byHourUtc: accumulator.hours.map(finalize),
      exclusions: {
        probeUnavailable: accumulator.probeUnavailable,
        invalidProbe: accumulator.invalidProbe,
        temperatureMissing: accumulator.temperatureMissing
      }
    };
  });

  return {
    frameValidAt: options.frame.validAt,
    counts,
    exclusions,
    variants,
    memory: {
      sparseDiagnosticsBufferBytes: sparse?.bufferBytes ?? 0,
      sparseDonorIndices: sparse?.sourceIndices.length ?? 0,
      sparseIndexBufferBytes: sparse?.sourceIndices.byteLength ?? 0,
      clearanceMappingBytes
    }
  };
}
