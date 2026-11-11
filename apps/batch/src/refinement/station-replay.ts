import profile from '../../../../packages/contracts/config/station-replay.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { link, mkdir, open, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getProduct } from '@av/contracts/models';
import {
  coverageIndices,
  MAX_PROVENANCE_BYTES,
  sameGrid } from '@av/contracts';
import { validateNormalizedFrame } from '@av/forecast';
import type { NormalizedFrame } from '@av/forecast/inputs';
import {
  prepareTerrainColumns,
  type PreparedTerrainColumns,
  type TerrainColumnEvaluationOptions
} from '@av/forecast/refinement';
import type { ForecastProvider, ForecastSession } from '../provider.js';
import { getForecastProvider } from '../providers.js';
import { buildIdentity, type BuildIdentity } from '../identity.js';
import { readLocalFile } from '../local-file.js';
import {
  loadEvaluationInput,
  normalizeSourceEvidence,
  type EvaluationControl
} from './evaluation-input.js';
import {
  ELEVATION_OFFSET_BANDS,
  MAX_STATION_OBSERVATION_BYTES,
  evaluateStations,
  parseStationObservations,
  type ElevationOffsetBand,
  type StationExclusionCounts,
  type StationObservation,
  type StationPopulationCounts,
  type StationPredictionRow,
  type StationTarget,
  type StationVariant,
  type StationVariantExclusionCounts,
  type TemperatureMetrics
} from './evaluation-stations.js';

const OGIMET_RAW_SHA256 = 'f996a85895f7738210f68c4416319484bf3958d7554712ef3ea5958bf32fd37d';
const CYCLES = Array.from({ length: 10 }, (_, index) => `2026-10-${String(15 + index).padStart(2, '0')}T00:00:00.000Z`);
const HOURS = [6, 9, 12, 15] as const;
const MAX_COMPILED_COLUMN_BUFFER_BYTES = 32 * 1024 * 1024;
for (const entry of profile.models) {
  if (!getProduct(entry.modelId)) throw new Error(`Unknown replay model ${entry.modelId}`);
}

interface VariantDefinition {
  readonly id: string;
  readonly model: string;
  readonly kind: 'kernel' | 'uncorrected' | 'dry-adiabatic';
  readonly options?: TerrainColumnEvaluationOptions;
  readonly clearance?: boolean;
}

export interface PooledTemperatureMetrics {
  readonly count: number;
  readonly biasC: number | null;
  readonly maeC: number | null;
  readonly rmseC: number | null;
  readonly uniqueStations: number;
  readonly uniqueDays: number;
  readonly byYear: Readonly<Record<string, number>>;
}

export interface PairedGateSummary {
  readonly count: number;
  readonly uniqueStations: number;
  readonly uniqueDays: number;
  readonly candidateBiasC: number | null;
  readonly candidateMaeC: number | null;
  readonly candidateRmseC: number | null;
  readonly baselineBiasC: number | null;
  readonly baselineMaeC: number | null;
  readonly baselineRmseC: number | null;
  readonly coldBiasReductionC: number | null;
}

interface FrameVariantReport {
  readonly id: string;
  readonly diagnostic: TemperatureMetrics;
  readonly gate: TemperatureMetrics;
  readonly byElevationOffset: Readonly<Record<ElevationOffsetBand, TemperatureMetrics>>;
  readonly byHourUtc: readonly TemperatureMetrics[];
  readonly exclusions: StationVariantExclusionCounts;
}

export interface FrameDiagnosticReport {
  readonly method: 'neutral-probe-native-excess-v1';
  readonly probes: number;
  readonly medianReferenceTerrainM: number | null;
  readonly medianTerrainM: number | null;
  readonly surfaceExcessSamples: number;
  readonly medianSurfaceExcessK: number | null;
  readonly donorExcessSamples: number;
  readonly positiveDonorExcessSamples: number;
}

interface FrameReport {
  readonly model: string;
  readonly cycle: string;
  readonly hour: number;
  readonly validAt: string;
  readonly status: 'ok' | 'failed';
  readonly error?: string;
  readonly source?: {
    readonly intervals: unknown;
    readonly receipt: unknown;
    readonly sourceReceiptSha256: string;
  };
  readonly counts?: StationPopulationCounts;
  readonly exclusions?: StationExclusionCounts;
  readonly variants?: readonly FrameVariantReport[];
  readonly diagnostics?: FrameDiagnosticReport;
}

export interface HourBandAggregate {
  readonly hourUtc: number;
  readonly gate: PooledTemperatureMetrics;
  readonly byElevationOffset: Readonly<Record<ElevationOffsetBand, PooledTemperatureMetrics>>;
}

export interface VariantAggregate {
  readonly id: string;
  readonly model: string;
  readonly kind: VariantDefinition['kind'];
  readonly options: TerrainColumnEvaluationOptions | null;
  readonly gate: PooledTemperatureMetrics;
  readonly diagnostic: PooledTemperatureMetrics;
  readonly byElevationOffset: Readonly<Record<ElevationOffsetBand, PooledTemperatureMetrics>>;
  readonly byHourUtc: readonly HourBandAggregate[];
  readonly exclusions: {
    readonly probeUnavailable: number;
    readonly invalidProbe: number;
    readonly temperatureMissing: number;
    readonly framesWithExclusions: number;
  };
}

export interface TemperatureGateEvidence {
  readonly model: string;
  readonly variant: string;
  readonly baseline: string;
  readonly status: 'pass' | 'fail' | 'inconclusive';
  readonly reason: string;
  readonly minimumStationHours: 100;
  readonly minimumStations: 3;
  readonly targetMaeC: number;
  readonly paired: PairedGateSummary;
  readonly stationHours: number;
  readonly uniqueStations: number;
  readonly uniqueDays: number;
  readonly candidateBiasC: number | null;
  readonly baselineBiasC: number | null;
  readonly candidateMaeC: number | null;
  readonly baselineMaeC: number | null;
  readonly coldBiasReductionC: number | null;
  readonly noRegression: boolean | null;
}

export interface StationReplayReport {
  readonly schemaVersion: 1;
  readonly status: 'complete' | 'incomplete';
  readonly generatedAt: string;
  readonly observations: {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly rows: number;
    readonly receiptPath: string;
    readonly receiptBytes: number;
    readonly receiptFileSha256: string;
    readonly receiptRawSha256: string;
    readonly rawPath: string;
    readonly rawBytes: number;
    readonly rawSha256: string;
    readonly inventoryPath: string | null;
    readonly inventoryFileSha256: string | null;
    readonly inventoryObservationsSha256: string | null;
    readonly firstValidAt: string | null;
    readonly lastValidAt: string | null;
  };
  readonly candidate: {
    readonly revision: string;
    readonly dirty: boolean;
    readonly stable: true;
    readonly componentsBefore: BuildIdentity['components'];
    readonly componentsAfter: BuildIdentity['components'];
  };
  readonly controls: readonly {
    readonly model: string;
    readonly path: string;
    readonly manifestSha256: string;
    readonly buildId: string;
    readonly cycle: string;
    readonly patchId: string;
    readonly sourceDirty: boolean;
    readonly sourceRevision: string;
    readonly sourceGrid: unknown;
    readonly targetGrid: unknown;
    readonly terrainDataId: string;
  }[];
  readonly selection: {
    readonly timeMatch: 'exact-frame-validAt';
    readonly demSampling: 'bilinear';
    readonly maxElevationMismatchM: 150;
    readonly precipitation: 'dry-only-gate; unknown-and-wet-diagnostic';
    readonly elevationOffsetBands: readonly ElevationOffsetBand[];
  };
  readonly variantDefinitions: readonly {
    readonly id: string;
    readonly model: string;
    readonly kind: VariantDefinition['kind'];
    readonly options: TerrainColumnEvaluationOptions | null;
  }[];
  readonly variants: readonly VariantAggregate[];
  readonly temperatureGate: readonly TemperatureGateEvidence[];
  readonly frames: readonly FrameReport[];
  readonly totals: {
    readonly requestedFrames: number;
    readonly completedFrames: number;
    readonly failedFrames: number;
    readonly models: readonly string[];
    readonly cycles: readonly string[];
    readonly hours: readonly number[];
    readonly observationRows: number;
  };
  readonly runtime: {
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly wallMs: number;
    readonly cpuUserMs: number;
    readonly cpuSystemMs: number;
    readonly rssStartBytes: number;
    readonly rssEndBytes: number;
    readonly rssPeakObservedBytes: number;
    readonly maxRssBytes: number;
    readonly peakSparseDiagnosticsBufferBytes: number;
    readonly peakSparseIndexBufferBytes: number;
    readonly peakClearanceMappingBytes: number;
    readonly peakCompiledColumnBufferBytes: number;
    readonly peakSelectedAndMappingBufferBytes: number;
    readonly rssScope: 'process-observed; not a full-build memory bound';
  };
  readonly sessionErrors: readonly string[];
  readonly constraints: readonly string[];
}

export interface RunStationReplayOptions {
  readonly observations: string;
  readonly out: string;
  readonly controls: Readonly<Record<string, { manifestPath: string; cacheDir?: string }>>;
  readonly signal?: AbortSignal;
  readonly providerFactory?: (model: string) => ForecastProvider;
}

export interface StationReplayRunResult {
  readonly report: StationReplayReport;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameTyped(left: Float32Array | Uint8Array, right: Float32Array | Uint8Array): boolean {
  return left.length === right.length
    && Buffer.compare(Buffer.from(left.buffer, left.byteOffset, left.byteLength), Buffer.from(right.buffer, right.byteOffset, right.byteLength)) === 0;
}

function emptyPooled(): PooledTemperatureMetrics {
  return { count: 0, biasC: null, maeC: null, rmseC: null, uniqueStations: 0, uniqueDays: 0, byYear: {} };
}

export function poolPredictionRows(
  rows: readonly StationPredictionRow[],
  predicate: (row: StationPredictionRow) => boolean = () => true
): PooledTemperatureMetrics {
  let count = 0, sumError = 0, sumAbsolute = 0, sumSquared = 0;
  const stations = new Set<string>(), days = new Set<string>(), years = new Map<string, number>();
  for (const row of rows) {
    if (!predicate(row)) continue;
    if (!Number.isFinite(row.predictionC)) throw new Error('Prediction temperature must be finite');
    const error = row.predictionC - row.observation.temperatureC;
    count++;
    sumError += error;
    sumAbsolute += Math.abs(error);
    sumSquared += error * error;
    stations.add(row.observation.stationId);
    const day = row.observation.validAt.slice(0, 10);
    days.add(day);
    years.set(day.slice(0, 4), (years.get(day.slice(0, 4)) ?? 0) + 1);
  }
  if (!count) return emptyPooled();
  return {
    count,
    biasC: sumError / count,
    maeC: sumAbsolute / count,
    rmseC: Math.sqrt(sumSquared / count),
    uniqueStations: stations.size,
    uniqueDays: days.size,
    byYear: Object.fromEntries(years)
  };
}

export function pairedGateSummary(
  candidateRows: readonly StationPredictionRow[],
  baselineRows: readonly StationPredictionRow[],
  predicate: (row: StationPredictionRow) => boolean = () => true
): PairedGateSummary {
  const baseline = new Map<string, StationPredictionRow>();
  for (const row of baselineRows) {
    if (!predicate(row)) continue;
    const key = `${row.observation.stationId}\n${row.observation.validAt}`;
    if (baseline.has(key)) throw new Error(`Duplicate paired baseline prediction for ${key}`);
    baseline.set(key, row);
  }
  let count = 0, candidateError = 0, baselineError = 0, candidateAbsolute = 0, baselineAbsolute = 0, candidateSquared = 0, baselineSquared = 0;
  const stations = new Set<string>(), days = new Set<string>(), candidateKeys = new Set<string>();
  for (const row of candidateRows) {
    if (!predicate(row)) continue;
    const key = `${row.observation.stationId}\n${row.observation.validAt}`;
    if (candidateKeys.has(key)) throw new Error(`Duplicate paired candidate prediction for ${key}`);
    candidateKeys.add(key);
    const match = baseline.get(key);
    if (!match) continue;
    const observation = row.observation.temperatureC;
    candidateError += row.predictionC - observation;
    baselineError += match.predictionC - observation;
    candidateAbsolute += Math.abs(row.predictionC - observation);
    baselineAbsolute += Math.abs(match.predictionC - observation);
    candidateSquared += (row.predictionC - observation) ** 2;
    baselineSquared += (match.predictionC - observation) ** 2;
    stations.add(row.observation.stationId);
    days.add(row.observation.validAt.slice(0, 10));
    count++;
  }
  if (!count) {
    return { count: 0, uniqueStations: 0, uniqueDays: 0, candidateBiasC: null, candidateMaeC: null, candidateRmseC: null, baselineBiasC: null, baselineMaeC: null, baselineRmseC: null, coldBiasReductionC: null };
  }
  const candidateBiasC = candidateError / count, baselineBiasC = baselineError / count;
  return {
    count,
    uniqueStations: stations.size,
    uniqueDays: days.size,
    candidateBiasC,
    candidateMaeC: candidateAbsolute / count,
    candidateRmseC: Math.sqrt(candidateSquared / count),
    baselineBiasC,
    baselineMaeC: baselineAbsolute / count,
    baselineRmseC: Math.sqrt(baselineSquared / count),
    coldBiasReductionC: candidateBiasC - baselineBiasC
  };
}

function poolBands(
  rows: readonly StationPredictionRow[],
  predicate: (row: StationPredictionRow) => boolean
): Record<ElevationOffsetBand, PooledTemperatureMetrics> {
  return {
    '<=-250': poolPredictionRows(rows, row => predicate(row) && row.band === '<=-250'),
    '-250..-100': poolPredictionRows(rows, row => predicate(row) && row.band === '-250..-100'),
    '-100..0': poolPredictionRows(rows, row => predicate(row) && row.band === '-100..0'),
    '0..200': poolPredictionRows(rows, row => predicate(row) && row.band === '0..200'),
    '>=200': poolPredictionRows(rows, row => predicate(row) && row.band === '>=200')
  };
}

export function runWithStagedPredictions<T>(
  run: (onPrediction: (row: StationPredictionRow) => void) => T,
  commit: (rows: readonly StationPredictionRow[]) => void
): T {
  const staged: StationPredictionRow[] = [];
  const result = run(row => staged.push(row));
  commit(staged);
  return result;
}

function replayModel(model: string) {
  const entry = profile.models.find(entry => entry.modelId === model);
  if (!entry) throw new Error(`Unknown replay model ${model}`);
  return entry;
}

export function resourceMaxRssBytes(maxRssRaw: number): number {
  return maxRssRaw * 1024;
}

export function temperatureGateEvidence(input: {
  readonly model: string;
  readonly variant: string;
  readonly baseline: string;
  readonly paired: PairedGateSummary;
}): TemperatureGateEvidence {
  const enoughHours = input.paired.count >= 100;
  const enoughSites = input.paired.uniqueStations >= 3;
  const enoughEvidence = enoughHours && enoughSites
    && input.paired.candidateBiasC !== null && input.paired.baselineBiasC !== null
    && input.paired.candidateMaeC !== null && input.paired.baselineMaeC !== null;
  const targetMaeC = replayModel(input.model).referenceMaeC;
  const meetsTarget = enoughEvidence && input.paired.candidateMaeC! <= targetMaeC;
  const noRegression = enoughEvidence && input.paired.candidateMaeC! <= input.paired.baselineMaeC!;
  const pass = enoughEvidence && meetsTarget && noRegression;
  const reason = !enoughHours || !enoughSites
    ? 'insufficient paired station-hours or sites for temperature gate'
    : !enoughEvidence
      ? 'insufficient paired temperatures'
      : pass
        ? 'candidate meets fixed MAE target and does not regress against uncorrected'
        : 'candidate exceeds fixed MAE target or regresses against uncorrected';
  return {
    model: input.model,
    variant: input.variant,
    baseline: input.baseline,
    status: !enoughEvidence ? 'inconclusive' : pass ? 'pass' : 'fail',
    reason,
    minimumStationHours: 100,
    minimumStations: 3,
    targetMaeC,
    paired: input.paired,
    stationHours: input.paired.count,
    uniqueStations: input.paired.uniqueStations,
    uniqueDays: input.paired.uniqueDays,
    candidateBiasC: input.paired.candidateBiasC,
    baselineBiasC: input.paired.baselineBiasC,
    candidateMaeC: input.paired.candidateMaeC,
    baselineMaeC: input.paired.baselineMaeC,
    coldBiasReductionC: input.paired.coldBiasReductionC,
    noRegression: enoughEvidence ? noRegression : null
  };
}

export async function writeImmutableReport(path: string, bytes: Uint8Array): Promise<{ path: string; sha256: string; bytes: number }> {
  const target = resolve(path), temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  const file = await open(temporary, 'wx');
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Station replay report already exists: ${target}`);
      throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return { path: target, sha256: sha256(bytes), bytes: bytes.byteLength };
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function variantDefinitions(model: string): VariantDefinition[] {
  const { prefix } = replayModel(model);
  return [
    { id: `${prefix}-neutral-b1000`, model, kind: 'kernel', options: { bridgeMode: 'neutral', maximumBelowGroundExtrapolationM: 1000 } },
    { id: `${prefix}-supported-clearance`, model, kind: 'kernel', clearance: true, options: { bridgeMode: 'neutral', maximumBelowGroundExtrapolationM: 1000, clearanceFallback: 'unsupported' } },
    { id: `${prefix}-uncorrected`, model, kind: 'uncorrected' },
    { id: `${prefix}-dry-adiabatic`, model, kind: 'dry-adiabatic' }
  ];
}

export interface FrozenObservationSource {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly rows: number;
  readonly receiptPath: string;
  readonly receiptBytes: number;
  readonly receiptFileSha256: string;
  readonly receiptRawSha256: string;
  readonly rawPath: string;
  readonly rawBytes: number;
  readonly rawSha256: string;
  readonly inventoryPath: string | null;
  readonly inventoryFileSha256: string | null;
  readonly inventoryObservationsSha256: string | null;
  readonly firstValidAt: string | null;
  readonly lastValidAt: string | null;
  readonly observations: readonly StationObservation[];
}

export async function loadFrozenObservationSource(
  path: string,
  expected: { readonly rawSha256?: string; readonly start?: string; readonly endExclusive?: string } = {}
): Promise<FrozenObservationSource> {
  const observationsPath = resolve(path), observationsBytes = await readLocalFile(observationsPath, MAX_STATION_OBSERVATION_BYTES);
  const observationsSha256 = sha256(observationsBytes), directory = dirname(observationsPath);
  const receiptPath = resolve(directory, 'receipt.json'), rawPath = resolve(directory, 'ogimet-synop.csv');
  const [receiptBytes, rawBytes] = await Promise.all([readLocalFile(receiptPath, 64 * 1024), readLocalFile(rawPath, 4 * 1024 * 1024)]);
  const receiptFileSha256 = sha256(receiptBytes), rawSha256 = sha256(rawBytes);
  const receipt = JSON.parse(receiptBytes.toString('utf8')) as {
    sha256?: unknown;
    bytes?: unknown;
    start?: unknown;
    endExclusive?: unknown;
  };
  const expectedRaw = expected.rawSha256 ?? OGIMET_RAW_SHA256;
  const expectedStart = expected.start ?? '2026-10-15T00:00:00.000Z';
  const expectedEnd = expected.endExclusive ?? '2026-10-25T00:00:00.000Z';
  if (rawSha256 !== expectedRaw) throw new Error(`Frozen raw CSV hash mismatch: ${rawSha256}`);
  if (receipt.sha256 !== rawSha256) throw new Error('Receipt sha256 does not match the actual raw CSV bytes');
  if (receipt.bytes !== rawBytes.byteLength) throw new Error('Receipt byte count does not match the actual raw CSV bytes');
  if (receipt.start !== expectedStart || receipt.endExclusive !== expectedEnd) throw new Error('Frozen receipt interval mismatch');
  let inventoryPath: string | null = null, inventoryFileSha256: string | null = null, inventoryObservationsSha256: string | null = null;
  try {
    const candidate = resolve(directory, '..', 'source-inventory.json'), inventoryBytes = await readLocalFile(candidate, MAX_PROVENANCE_BYTES);
    const inventory = JSON.parse(inventoryBytes.toString('utf8')) as { observationsSha256?: unknown };
    if (typeof inventory.observationsSha256 === 'string') {
      if (inventory.observationsSha256 !== observationsSha256) throw new Error(`Frozen observations differ from source inventory: ${observationsSha256}`);
      inventoryPath = candidate;
      inventoryFileSha256 = sha256(inventoryBytes);
      inventoryObservationsSha256 = inventory.observationsSha256;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const observations = parseStationObservations(observationsBytes);
  return {
    path: observationsPath,
    bytes: observationsBytes.byteLength,
    sha256: observationsSha256,
    rows: observations.length,
    receiptPath,
    receiptBytes: receiptBytes.byteLength,
    receiptFileSha256,
    receiptRawSha256: rawSha256,
    rawPath,
    rawBytes: rawBytes.byteLength,
    rawSha256,
    inventoryPath,
    inventoryFileSha256,
    inventoryObservationsSha256,
    firstValidAt: observations[0]?.validAt ?? null,
    lastValidAt: observations.at(-1)?.validAt ?? null,
    observations
  };
}

async function controlInfo(control: EvaluationControl, path: string, model: string) {
  const manifestPath = resolve(path);
  if (control.manifest.model !== model) throw new Error(`Control model ${control.manifest.model} is not ${model}`);
  if (control.manifest.recipe.sourceDirty !== false) throw new Error(`${model} control sourceDirty must be false`);
  if (control.targetMask.grid.width !== profile.target.width || control.targetMask.grid.height !== profile.target.height) {
    throw new Error(`${model} control target grid must be the current ${profile.target.width}x${profile.target.height} full zone`);
  }
  return {
    model,
    path: manifestPath,
    manifestSha256: control.manifestSha256,
    buildId: control.manifest.buildId,
    cycle: control.manifest.cycle,
    patchId: control.patch.id,
    sourceDirty: control.manifest.recipe.sourceDirty,
    sourceRevision: control.manifest.recipe.sourceRevision,
    sourceGrid: control.sourceMask.grid,
    targetGrid: control.targetMask.grid,
    terrainDataId: control.terrain.descriptor.dataId
  };
}

function assertControlPair(first: EvaluationControl, second: EvaluationControl): void {
  if (!sameGrid(first.targetMask.grid, second.targetMask.grid)) throw new Error('Control target grids differ');
  if (!sameTyped(first.terrain.elevationM, second.terrain.elevationM) || !sameTyped(first.terrain.valid, second.terrain.valid)) {
    throw new Error('Control target terrain differs');
  }
}

export function assertBuildComponentsUnchanged(before: BuildIdentity['components'], after: BuildIdentity['components']): void {
  for (const component of ['adapter', 'science', 'contracts'] as const) {
    if (before[component] !== after[component]) throw new Error(`Candidate ${component} source changed during replay`);
  }
}

export async function runStationReplay(options: RunStationReplayOptions): Promise<StationReplayRunResult> {
  const startedAt = new Date().toISOString(), wallStart = process.hrtime.bigint(), cpuStart = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  let rssPeak = rssStart;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Station replay is offline: network access disabled'); }) as typeof fetch;
  try {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const frozen = await loadFrozenObservationSource(options.observations);
    const modelInputs = await Promise.all(profile.models.map(async entry => {
      const input = options.controls[entry.modelId];
      if (!input?.manifestPath) throw new Error(`Missing replay control for ${entry.modelId}`);
      const path = resolve(input.manifestPath);
      return { model: entry.modelId, path, control: await loadEvaluationInput({ manifestPath: path, signal: options.signal }),
        cacheDir: resolve(input.cacheDir ?? entry.defaultCache) };
    }));
    for (const input of modelInputs.slice(1)) assertControlPair(modelInputs[0].control, input.control);
    const first = modelInputs[0], product = getProduct(first.model)!;
    const coverageHash = first.control.manifest.patches?.[0]?.coverage.hash;
    if (!coverageHash) throw new Error('Control coverage hash is missing');
    const identityBefore = await buildIdentity(product, coverageHash, undefined, [], repoRoot);
    const controls = await Promise.all(modelInputs.map(input => controlInfo(input.control, input.path, input.model)));
    const observationsByTime = new Map<number, StationObservation[]>();
    for (const observation of frozen.observations) {
      const key = Date.parse(observation.validAt);
      const bucket = observationsByTime.get(key) ?? [];
      bucket.push(observation);
      observationsByTime.set(key, bucket);
    }

    const providerFactory = options.providerFactory ?? getForecastProvider;
    const frames: FrameReport[] = [], sessionErrors: string[] = [];
    let peakSparseDiagnosticsBufferBytes = 0, peakSparseIndexBufferBytes = 0, peakClearanceMappingBytes = 0, peakCompiledColumnBufferBytes = 0, peakSelectedAndMappingBufferBytes = 0;
    const rowsByVariant = new Map<string, StationPredictionRow[]>();
    const exclusionsByVariant = new Map<string, { probeUnavailable: number; invalidProbe: number; temperatureMissing: number; framesWithExclusions: number }>();
    const definitionsByModel = new Map<string, VariantDefinition[]>();

    for (const input of modelInputs) {
      const definitions = variantDefinitions(input.model);
      definitionsByModel.set(input.model, definitions);
      for (const definition of definitions) {
        rowsByVariant.set(definition.id, []);
        exclusionsByVariant.set(definition.id, { probeUnavailable: 0, invalidProbe: 0, temperatureMissing: 0, framesWithExclusions: 0 });
      }
      const provider = providerFactory(input.model);
      const product = getProduct(input.model);
      if (!product) throw new Error(`No product for ${input.model}`);
      const active = coverageIndices(input.control.sourceMask).active;
      if (!active.length) throw new Error(`${input.model} control source coverage is empty`);
      const prepared = new Map<string, PreparedTerrainColumns>();
      let compiledColumnBufferBytes = 0;
      const kernelFor = (definition: VariantDefinition, target: StationTarget): PreparedTerrainColumns => {
        const key = `${definition.id}|${target.latitude}|${target.longitude}`;
        const cached = prepared.get(key);
        if (cached) return cached;
        const value = prepareTerrainColumns(input.control.sourceMask, target.mask, active, provider.maxLevels, definition.options);
        if (compiledColumnBufferBytes + value.byteLength <= MAX_COMPILED_COLUMN_BUFFER_BYTES) {
          prepared.set(key, value);
          compiledColumnBufferBytes += value.byteLength;
          peakCompiledColumnBufferBytes = Math.max(peakCompiledColumnBufferBytes, compiledColumnBufferBytes);
        }
        return value;
      };
      const stationVariants: StationVariant[] = definitions.map(definition => definition.kind === 'kernel'
        ? { id: definition.id, clearance: definition.clearance, prepare: target => kernelFor(definition, target) }
        : { id: definition.id, temperature: definition.kind });
      const neutral = definitions.find(definition => definition.id.endsWith('-neutral-b1000'))!;

      for (const cycle of CYCLES) {
        options.signal?.throwIfAborted();
        let session: ForecastSession | null = null;
        try {
          session = await provider.open({ cycle, activeIndices: active, cacheDir: input.cacheDir, signal: options.signal, offline: true, readOnlyCache: true });
          if (Date.parse(session.cycle) !== Date.parse(cycle)) throw new Error(`Provider cycle ${session.cycle} differs from ${cycle}`);
        } catch (error) {
          const message = `${input.model} ${cycle} open: ${error instanceof Error ? error.message : String(error)}`;
          sessionErrors.push(message);
          for (const hour of HOURS) {
            frames.push({ model: input.model, cycle, hour, validAt: new Date(Date.parse(cycle) + hour * 3_600_000).toISOString(), status: 'failed', error: message });
          }
          continue;
        }
        try {
          for (const hour of HOURS) {
            options.signal?.throwIfAborted();
            const validAt = new Date(Date.parse(cycle) + hour * 3_600_000).toISOString();
            let frame: NormalizedFrame | null = null;
            try {
              frame = await session.acquire(hour);
              if (Date.parse(frame.cycle) !== Date.parse(cycle) || frame.hour !== hour || Date.parse(frame.validAt) !== Date.parse(validAt)) {
                throw new Error(`Acquired frame identity mismatch for ${input.model} ${cycle} f${hour}`);
              }
              validateNormalizedFrame(frame, active, input.control.sourceMask.grid, provider.maxLevels, product.layers, product.capabilities.verticalCoordinate);
              const currentFrame = frame;
              const frameObservations = observationsByTime.get(Date.parse(validAt)) ?? [];
              runWithStagedPredictions(
                onPrediction => {
                  const heights: number[] = [], terrains: number[] = [], surfaceExcesses: number[] = [];
                  let probes = 0, donorExcessSamples = 0, positiveDonorExcessSamples = 0;
                  const result = evaluateStations({
                    frame: currentFrame,
                    sourceMask: input.control.sourceMask,
                    targetMask: input.control.targetMask,
                    terrain: input.control.terrain,
                    observations: frameObservations,
                    variants: stationVariants,
                    maxLevels: provider.maxLevels,
                    demSampling: 'bilinear',
                    maxElevationMismatchM: 150,
                    onPrediction,
                    onProbe: (variantId, observation, probe) => {
                      if (variantId !== neutral.id || observation.precipitationState !== 'dry') return;
                      probes++;
                      if (probe.referenceTerrainM !== null && Number.isFinite(probe.referenceTerrainM)) heights.push(probe.referenceTerrainM);
                      if (Number.isFinite(probe.terrainM)) terrains.push(probe.terrainM);
                      if (probe.surfaceExcessK !== null && Number.isFinite(probe.surfaceExcessK)) surfaceExcesses.push(probe.surfaceExcessK);
                      for (const excess of probe.donorSurfaceExcessK) if (Number.isFinite(excess)) {
                        donorExcessSamples++;
                        if (excess > 0) positiveDonorExcessSamples++;
                      }
                    }
                  });
                  peakSparseDiagnosticsBufferBytes = Math.max(peakSparseDiagnosticsBufferBytes, result.memory.sparseDiagnosticsBufferBytes);
                  peakSparseIndexBufferBytes = Math.max(peakSparseIndexBufferBytes, result.memory.sparseIndexBufferBytes);
                  peakClearanceMappingBytes = Math.max(peakClearanceMappingBytes, result.memory.clearanceMappingBytes);
                  peakSelectedAndMappingBufferBytes = Math.max(peakSelectedAndMappingBufferBytes,
                    result.memory.sparseDiagnosticsBufferBytes + result.memory.sparseIndexBufferBytes + result.memory.clearanceMappingBytes + compiledColumnBufferBytes);
                  const diagnostics: FrameDiagnosticReport = {
                    method: 'neutral-probe-native-excess-v1', probes,
                    medianReferenceTerrainM: median(heights), medianTerrainM: median(terrains),
                    surfaceExcessSamples: surfaceExcesses.length, medianSurfaceExcessK: median(surfaceExcesses),
                    donorExcessSamples, positiveDonorExcessSamples
                  };
                  const normalizedReceipt = normalizeSourceEvidence(currentFrame.receipt);
                  const source = {
                    intervals: currentFrame.intervals,
                    receipt: normalizedReceipt,
                    sourceReceiptSha256: sha256(Buffer.from(JSON.stringify(normalizedReceipt)))
                  };
                  const variantReports: FrameVariantReport[] = result.variants.map(variant => ({
                    id: variant.id,
                    diagnostic: variant.diagnostic,
                    gate: variant.gate,
                    byElevationOffset: variant.byElevationOffset,
                    byHourUtc: variant.byHourUtc,
                    exclusions: variant.exclusions
                  }));
                  frames.push({
                    model: input.model,
                    cycle,
                    hour,
                    validAt,
                    status: 'ok',
                    source,
                    counts: result.counts,
                    exclusions: result.exclusions,
                    variants: variantReports,
                    diagnostics
                  });
                  for (const variant of variantReports) {
                    const bucket = exclusionsByVariant.get(variant.id)!;
                    bucket.probeUnavailable += variant.exclusions.probeUnavailable;
                    bucket.invalidProbe += variant.exclusions.invalidProbe;
                    bucket.temperatureMissing += variant.exclusions.temperatureMissing;
                    if (variant.exclusions.probeUnavailable || variant.exclusions.invalidProbe || variant.exclusions.temperatureMissing) bucket.framesWithExclusions++;
                  }
                  return result;
                },
                staged => {
                  for (const row of staged) rowsByVariant.get(row.variantId)!.push(row);
                }
              );
            } catch (error) {
              frames.push({
                model: input.model,
                cycle,
                hour,
                validAt,
                status: 'failed',
                error: `${input.model} ${cycle} f${hour}: ${error instanceof Error ? error.message : String(error)}`
              });
            } finally {
              frame = null;
              rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
            }
          }
        } finally {
          try {
            await session.close();
          } catch (error) {
            sessionErrors.push(`${input.model} ${cycle} close: ${error instanceof Error ? error.message : String(error)}`);
          }
          session = null;
        }
      }
    }

    const variantAggregates: VariantAggregate[] = [];
    for (const [model, definitions] of definitionsByModel) {
      for (const definition of definitions) {
        const rows = rowsByVariant.get(definition.id) ?? [];
        const dry = (row: StationPredictionRow) => row.observation.precipitationState === 'dry';
        const exclusions = exclusionsByVariant.get(definition.id)!;
        variantAggregates.push({
          id: definition.id,
          model,
          kind: definition.kind,
          options: definition.options ?? null,
          gate: poolPredictionRows(rows, dry),
          diagnostic: poolPredictionRows(rows),
          byElevationOffset: poolBands(rows, dry),
          byHourUtc: Array.from({ length: 24 }, (_, hourUtc) => ({
            hourUtc,
            gate: poolPredictionRows(rows, row => dry(row) && row.hourUtc === hourUtc),
            byElevationOffset: poolBands(rows, row => dry(row) && row.hourUtc === hourUtc)
          })),
          exclusions: {
            probeUnavailable: exclusions.probeUnavailable,
            invalidProbe: exclusions.invalidProbe,
            temperatureMissing: exclusions.temperatureMissing,
            framesWithExclusions: exclusions.framesWithExclusions
          }
        });
      }
    }
    const temperatureGate: TemperatureGateEvidence[] = [];
    for (const [model, definitions] of definitionsByModel) {
      const baselineId = `${replayModel(model).prefix}-uncorrected`;
      for (const { id: candidateId } of definitions.filter(variant => variant.kind === 'kernel')) {
        const paired = pairedGateSummary(
          rowsByVariant.get(candidateId) ?? [],
          rowsByVariant.get(baselineId) ?? [],
          row => row.observation.precipitationState === 'dry'
        );
        temperatureGate.push(temperatureGateEvidence({ model, variant: candidateId, baseline: baselineId, paired }));
      }
    }
    const identityAfter = await buildIdentity(product, coverageHash, undefined, [], repoRoot);
    assertBuildComponentsUnchanged(identityBefore.components, identityAfter.components);
    const candidate: StationReplayReport['candidate'] = {
      revision: identityBefore.recipe.sourceRevision,
      dirty: identityBefore.recipe.sourceDirty,
      stable: true,
      componentsBefore: identityBefore.components,
      componentsAfter: identityAfter.components
    };
    const completedFrames = frames.filter(frame => frame.status === 'ok').length;
    const failedFrames = frames.length - completedFrames;
    const finishedAt = new Date().toISOString();
    const wallMs = Number(process.hrtime.bigint() - wallStart) / 1_000_000;
    const cpu = process.cpuUsage(cpuStart);
    const rssEnd = process.memoryUsage().rss;
    const maxRssRaw = process.resourceUsage().maxRSS;
    const report: StationReplayReport = {
      schemaVersion: 1,
      status: failedFrames === 0 ? 'complete' : 'incomplete',
      generatedAt: finishedAt,
      observations: {
        path: frozen.path,
        sha256: frozen.sha256,
        bytes: frozen.bytes,
        rows: frozen.rows,
        receiptPath: frozen.receiptPath,
        receiptBytes: frozen.receiptBytes,
        receiptFileSha256: frozen.receiptFileSha256,
        receiptRawSha256: frozen.receiptRawSha256,
        rawPath: frozen.rawPath,
        rawBytes: frozen.rawBytes,
        rawSha256: frozen.rawSha256,
        inventoryPath: frozen.inventoryPath,
        inventoryFileSha256: frozen.inventoryFileSha256,
        inventoryObservationsSha256: frozen.inventoryObservationsSha256,
        firstValidAt: frozen.firstValidAt,
        lastValidAt: frozen.lastValidAt
      },
      candidate,
      controls,
      selection: {
        timeMatch: 'exact-frame-validAt',
        demSampling: 'bilinear',
        maxElevationMismatchM: 150,
        precipitation: 'dry-only-gate; unknown-and-wet-diagnostic',
        elevationOffsetBands: ELEVATION_OFFSET_BANDS
      },
      variantDefinitions: [...definitionsByModel.values()].flat().map(definition => ({
        id: definition.id,
        model: definition.model,
        kind: definition.kind,
        options: definition.options ?? null
      })),
      variants: variantAggregates,
      temperatureGate,
      frames,
      totals: {
        requestedFrames: CYCLES.length * HOURS.length * profile.models.length,
        completedFrames,
        failedFrames,
        models: profile.models.map(entry => entry.modelId),
        cycles: CYCLES,
        hours: [...HOURS],
        observationRows: frozen.rows
      },
      runtime: {
        startedAt,
        finishedAt,
        wallMs,
        cpuUserMs: cpu.user / 1000,
        cpuSystemMs: cpu.system / 1000,
        rssStartBytes: rssStart,
        rssEndBytes: rssEnd,
        rssPeakObservedBytes: rssPeak,
        maxRssBytes: resourceMaxRssBytes(maxRssRaw),
        peakSparseDiagnosticsBufferBytes,
        peakSparseIndexBufferBytes,
        peakClearanceMappingBytes,
        peakCompiledColumnBufferBytes,
        peakSelectedAndMappingBufferBytes,
        rssScope: 'process-observed; not a full-build memory bound'
      },
      sessionErrors,
      constraints: [
        'Global fetch is replaced with an offline throw for the run and restored in finally.',
        'Cached hindcast acquisitions use explicit frozen cycles; no cycle discovery.',
        'Cache misses fail their frame explicitly; no network fallback and no silent day skip.',
        `Both controls must be the current ${profile.target.width}x${profile.target.height} full zone with sourceDirty false.`,
        'Old 128x128 pilot grid eligibility is not used.',
        'Live station snapshots are not hindcast inputs.',
        'Per-frame probe diagnostics describe native surface excess.'
      ]
    };
    const bytes = Buffer.from(JSON.stringify(report, (_key, value) => typeof value === 'number' && !Number.isFinite(value) ? null : value, 2));
    const written = await writeImmutableReport(options.out, bytes);
    return { report, ...written };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function requiredString(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = values[name];
  if (typeof value !== 'string' || !value) throw new Error(`Missing --${name}`);
  return value;
}

async function main(): Promise<void> {
  const flags = ['observations', 'out', ...profile.models.flatMap(entry => [entry.controlFlag, entry.cacheFlag])];
  const { values } = parseArgs({
    options: Object.fromEntries(flags.map(flag => [flag, { type: 'string' as const }])), allowPositionals: false
  });
  const result = await runStationReplay({
    observations: requiredString(values, 'observations'),
    out: requiredString(values, 'out'),
    controls: Object.fromEntries(profile.models.map(entry => [entry.modelId, {
      manifestPath: requiredString(values, entry.controlFlag), cacheDir: values[entry.cacheFlag] as string | undefined
    }]))
  });
  process.stdout.write(JSON.stringify({
    status: result.report.status,
    path: result.path,
    sha256: result.sha256,
    bytes: result.bytes,
    frames: result.report.totals,
    runtime: result.report.runtime,
    temperatureGate: result.report.temperatureGate
  }) + '\n');
  if (result.report.status !== 'complete') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
