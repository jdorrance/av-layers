import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getProduct } from '@av/contracts/models';
import {
  coverageIndices,
  getBit,
  LAYERS,
  MAX_MANIFEST_BYTES,
  STATUS_MASK,
  STATUS_NO_LIFT,
  STATUS_OUTSIDE,
  STATUS_UNAVAILABLE,
  STATUS_VALID,
  TERRAIN_CLEARANCE_METHOD,
  prepareGridGeometry,
  type LayerId,
  type Manifest } from '@av/contracts';
import {
  deriveFrame,
  MAX_PREPARED_SAMPLES,
  preparePointSampling,
  type GridField,
  prepareSamplePackLayout,
  validateNormalizedFrame,
  type NormalizedFrame,
  type Sample
} from '@av/forecast';
import { prepareTerrainColumns, type TerrainColumnProbe } from '@av/forecast/refinement';
import type { ForecastProvider, ForecastSession } from '../provider.js';
import { getForecastProvider } from '../providers.js';
import { buildIdentity } from '../identity.js';
import { readLocalFile } from '../local-file.js';
import { localPath } from '../validate.js';
import { createSamplePackBuilder } from '../sample-pack.js';
import { createRasterizer, RASTER_SAMPLING } from '../raster.js';
import { encodeWebp } from '../webp.js';
import {
  decodeSamplePack,
  loadEvaluationInput,
  sameSourceEvidence,
  selectSourceFrames,
  type EvaluationControl,
  type SourceFrameEvidence
} from './evaluation-input.js';
import {
  selectEvaluationPopulation,
  summarizePopulationFields,
  writeCompletedEvaluationReport,
  type EvaluationPopulation,
  type PopulationFieldSummary,
  type WrittenEvaluationReport
} from './evaluation-report.js';

type KernelOptions = NonNullable<Parameters<typeof prepareTerrainColumns>[4]>;
type KernelPreparation = ReturnType<typeof prepareTerrainColumns>;
type LiftFields = Record<'usable-lift-msl' | 'usable-lift-agl', GridField>;
type ProbeTrace = TerrainColumnProbe;

export interface RunEvaluationOptions {
  readonly controlManifest: string;
  readonly cacheDir: string;
  readonly out: string;
  readonly frames?: readonly string[];
  readonly patchId?: string;
  readonly provider?: ForecastProvider;
  readonly signal?: AbortSignal;
}

export interface RenderModeRuntime {
  readonly rasterMs: number;
  readonly encodeMs: number;
  readonly bytes: number;
}

export interface RenderRuntime {
  readonly step: RenderModeRuntime;
  readonly smooth: RenderModeRuntime;
  readonly bytesRatio: number;
}

export interface EvaluationRunResult {
  readonly report: WrittenEvaluationReport;
  readonly deterministic: EvaluationReportContent;
  readonly runtime: { readonly elapsedMs: number; readonly peakRssBytes: number; readonly render: RenderRuntime };
}

interface VariantDefinition {
  readonly id: string;
  readonly kind: 'stored' | 'native' | 'kernel';
  readonly options?: KernelOptions;
}

interface VariantFrame {
  readonly frame: Manifest['frames'][number];
  readonly fields: LiftFields;
  readonly metrics: Record<string, number>;
  readonly probes: readonly ProbeTrace[];
}

interface ProbeTarget {
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly index: number;
}

interface PopulationComparison {
  readonly baseline: 'stored-clearance' | 'native';
  readonly populations: Readonly<Record<string, Readonly<Record<string, PopulationFieldSummary>>>>;
}

interface VariantFrameReport {
  readonly variant: string;
  readonly frame: string;
  readonly validTime: string;
  readonly parameters: KernelOptions | null;
  readonly metrics: Record<string, number>;
  readonly fields: { readonly key: string; readonly sha256: string; readonly bytes: number };
  readonly comparisons: readonly PopulationComparison[];
  readonly probes: readonly (ProbeTrace & { readonly name: string; readonly lat: number; readonly lon: number })[];
  readonly renderInvariance: {
    readonly fieldSha256Before: string;
    readonly fieldSha256After: string;
    readonly fieldSha256Identical: true;
    readonly packSha256Before: string;
    readonly packSha256After: string;
    readonly packSha256Identical: true;
  };
  readonly images: readonly ImageArtifact[];
}

interface ImageArtifact {
  readonly key: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly pairKey: string;
  readonly view: 'aragats-z8-159-96' | 'aragats-z9-318-193' | 'zone-overview';
  readonly style: 'step' | 'linear-rgb';
  readonly valueUnits: string;
  readonly fieldSha256: string;
  readonly layer: LayerId;
  readonly width: number;
  readonly height: number;
  readonly extent:
    | { readonly kind: 'tile'; readonly z: number; readonly x: number; readonly y: number }
    | { readonly kind: 'overview'; readonly z: number; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
}

export interface EvaluationReportContent {
  readonly version: 1;
  readonly candidate: {
    readonly sourceRevision: string;
    readonly sourceDirty: boolean;
    readonly sourceHashes: { readonly adapter: string; readonly science: string; readonly contracts: string };
  };
  readonly control: {
    readonly buildId: string;
    readonly model: string;
    readonly cycle: string;
    readonly manifestSha256: string;
    readonly provenanceSha256: string;
    readonly method: Manifest['method'];
    readonly patch: { readonly id: string; readonly method: EvaluationControl['patch']['method']; readonly grid: Manifest['grid']; readonly terrain: unknown };
    readonly frames: readonly Manifest['frames'][number][];
    readonly rawSourceReceiptsMatch: true;
  };
  readonly probeTargets: readonly Omit<ProbeTarget, 'index'>[];
  readonly variants: readonly VariantFrameReport[];
  readonly scientificGate: { readonly status: 'inconclusive'; readonly reason: string };
}

const PROBES = [
  { name: 'Aragats', lat: 40.52, lon: 44.19 },
  { name: 'Yerevan', lat: 40.18, lon: 44.51 },
  { name: 'Aparan', lat: 40.59, lon: 44.36 },
  { name: 'Sevan', lat: 40.56, lon: 45.01 }
] as const;
const ARAGATS = { centerLat: 40.52, centerLon: 44.19, radiusM: 15_000 };
const FIELD_LAYERS = ['usable-lift-msl', 'usable-lift-agl'] as const;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeArtifact(root: string, key: string, bytes: Uint8Array): Promise<{ key: string; sha256: string; bytes: number }> {
  const path = localPath(root, key), temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  const file = await open(temporary, 'wx');
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Evaluation artifact already exists: ${key}`);
      throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return { key, sha256: sha256(bytes), bytes: bytes.byteLength };
}

function sameInstant(actual: unknown, expected: string): boolean {
  return typeof actual === 'string' && Date.parse(actual) === Date.parse(expected);
}

function modelGroundField(derived: LiftFields): GridField {
  const msl = derived['usable-lift-msl'], agl = derived['usable-lift-agl'];
  const values = msl.values.slice(), flags = msl.flags.slice();
  for (let i = 0; i < flags.length; i++) {
    const status = flags[i] & STATUS_MASK;
    if (status === STATUS_VALID) values[i] -= agl.values[i];
    else if (status === STATUS_NO_LIFT) flags[i] &= ~STATUS_MASK;
  }
  return { values, flags };
}

export function sampleNativeTargetFields(
  masks: Pick<EvaluationControl, 'sourceMask' | 'targetMask'>,
  derived: LiftFields
): LiftFields {
  const grid = masks.targetMask.grid, cells = grid.width * grid.height, geometry = prepareGridGeometry(grid);
  const active: number[] = [];
  for (let index = 0; index < cells; index++) {
    if (getBit(masks.targetMask.output, index) || getBit(masks.targetMask.halo, index)) active.push(index);
  }
  const output: LiftFields = {
    'usable-lift-msl': { values: new Float32Array(cells).fill(Number.NaN), flags: new Uint8Array(cells).fill(STATUS_OUTSIDE) },
    'usable-lift-agl': { values: new Float32Array(cells).fill(Number.NaN), flags: new Uint8Array(cells).fill(STATUS_OUTSIDE) }
  };
  let groundField: GridField | undefined;
  const sample: Sample = { value: null, status: 3, support: 0, interpolated: false };
  const ground: Sample = { value: null, status: 3, support: 0, interpolated: false };
  for (let start = 0; start < active.length; start += MAX_PREPARED_SAMPLES) {
    const indices = active.slice(start, start + MAX_PREPARED_SAMPLES);
    const lats = new Float64Array(indices.length), lons = new Float64Array(indices.length);
    for (let slot = 0; slot < indices.length; slot++) {
      const index = indices[slot]!, point = geometry.gridToGeographic(index % grid.width, Math.floor(index / grid.width));
      if (!point) continue;
      lats[slot] = point.lat;
      lons[slot] = point.lon;
    }
    const sampling = preparePointSampling(masks.sourceMask, lats, lons);
    let nativeGround: ReturnType<typeof sampling.bind> | undefined;
    for (const layer of FIELD_LAYERS) {
      const into = sampling.bind(derived[layer], layer, RASTER_SAMPLING.useStoredMslNoLift), target = output[layer];
      for (let slot = 0; slot < indices.length; slot++) {
        const index = indices[slot]!;
        into(slot, 0, sample);
        if (sample.status === STATUS_OUTSIDE) {
          target.values[index] = Number.NaN;
          target.flags[index] = STATUS_UNAVAILABLE;
        } else if (layer === 'usable-lift-msl' && sample.status === STATUS_NO_LIFT) {
          groundField ??= modelGroundField(derived);
          nativeGround ??= sampling.bind(groundField, 'usable-lift-msl', RASTER_SAMPLING.useStoredMslNoLift);
          nativeGround(slot, 0, ground);
          if (ground.value === null || !Number.isFinite(ground.value)) throw new Error('Native no-lift sample has no finite model-ground height');
          target.values[index] = ground.value;
          target.flags[index] = sample.status | sample.support;
        } else {
          target.values[index] = typeof sample.value === 'number' ? sample.value : Number.NaN;
          target.flags[index] = sample.status | sample.support;
        }
      }
    }
  }
  return output;
}

function nativeFields(control: EvaluationControl, frame: NormalizedFrame): LiftFields {
  const native = deriveFrame(frame, control.sourceMask, { layers: [...FIELD_LAYERS], daylightOnly: true });
  const msl = native['usable-lift-msl'], agl = native['usable-lift-agl'];
  if (!msl || !agl) throw new Error('Native derivation omitted a lift layer');
  return sampleNativeTargetFields(control, { 'usable-lift-msl': msl, 'usable-lift-agl': agl });
}

function probeDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radians = Math.PI / 180, phi1 = lat1 * radians, phi2 = lat2 * radians;
  const a = Math.sin((lat2 - lat1) * radians / 2) ** 2
    + Math.cos(phi1) * Math.cos(phi2) * Math.sin((lon2 - lon1) * radians / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function selectProbes(control: EvaluationControl, population: EvaluationPopulation): ProbeTarget[] {
  const geometry = prepareGridGeometry(control.targetMask.grid), claimed = new Set<number>();
  return PROBES.map(probe => {
    let best: { index: number; distance: number } | undefined;
    for (const index of population.indices) {
      const point = geometry.gridToGeographic(index % control.targetMask.grid.width, Math.floor(index / control.targetMask.grid.width));
      if (!point) continue;
      const distance = probeDistance(probe.lat, probe.lon, point.lat, point.lon);
      if (!claimed.has(index) && (!best || distance < best.distance)) best = { index, distance };
    }
    if (!best) throw new Error(`No distinct target cell for probe ${probe.name}`);
    claimed.add(best.index);
    return { ...probe, index: best.index };
  });
}

function flatMetrics(metrics: object): Record<string, number> {
  return Object.fromEntries(Object.entries(metrics).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])));
}

function probeReport(probes: readonly ProbeTrace[], targets: readonly ProbeTarget[]) {
  const named = new Map(targets.map(target => [target.index, target]));
  return probes.map(probe => {
    const target = named.get(probe.index);
    return {
      ...structuredClone(probe),
      name: target?.name ?? 'unknown',
      lat: target?.lat ?? Number.NaN,
      lon: target?.lon ?? Number.NaN
    };
  });
}

function comparison(
  baseline: 'stored-clearance' | 'native',
  left: LiftFields,
  right: LiftFields,
  populations: readonly (readonly [string, EvaluationPopulation])[]
): PopulationComparison {
  return {
    baseline,
    populations: Object.fromEntries(populations.map(([name, population]) => [name, Object.fromEntries(
      FIELD_LAYERS.map(layer => [layer, summarizePopulationFields(population, left[layer], right[layer], layer)])
    )]))
  };
}

function tileRanges(bounds: readonly [number, number, number, number], z: number) {
  const span = 2 ** z;
  const column = (lon: number) => Math.max(0, Math.min(span - 1, Math.floor((lon + 180) / 360 * span)));
  const row = (lat: number) => Math.max(0, Math.min(span - 1, Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * span)));
  return { x0: column(bounds[0]), x1: column(bounds[2]), y0: row(bounds[3]), y1: row(bounds[1]) };
}

async function renderOverview(
  rasterizer: ReturnType<typeof createRasterizer>,
  field: GridField,
  layer: LayerId,
  mask: EvaluationControl['targetMask']
): Promise<{ rgba: Uint8Array; width: number; height: number; z: number; x0: number; y0: number; x1: number; y1: number }> {
  if (!mask.bounds) throw new Error('Zone overview requires target bounds');
  const z = Math.min(mask.maxZoom, 7), range = tileRanges(mask.bounds, z), width = (range.x1 - range.x0 + 1) * 256, height = (range.y1 - range.y0 + 1) * 256;
  if (width * height > 4096 * 4096) throw new Error('Zone overview exceeds render budget');
  const rgba = new Uint8Array(width * height * 4);
  for (let y = range.y0; y <= range.y1; y++) for (let x = range.x0; x <= range.x1; x++) {
    const tile = rasterizer.renderTilePixels(field, layer, z, x, y).rgba;
    for (let row = 0; row < 256; row++) {
      const source = row * 256 * 4, target = ((y - range.y0) * 256 + row) * width * 4 + (x - range.x0) * 256 * 4;
      rgba.set(tile.subarray(source, source + 256 * 4), target);
    }
  }
  return { rgba, width, height, z, ...range };
}

function fieldSha256(fields: LiftFields): string {
  const hash = createHash('sha256');
  for (const layer of FIELD_LAYERS) {
    const field = fields[layer];
    hash.update(Buffer.from(field.values.buffer, field.values.byteOffset, field.values.byteLength));
    hash.update(Buffer.from(field.flags.buffer, field.flags.byteOffset, field.flags.byteLength));
  }
  return hash.digest('hex');
}

async function renderVariantImages(
  out: string,
  buildId: string,
  variant: VariantDefinition,
  frame: Manifest['frames'][number],
  fields: LiftFields,
  mask: EvaluationControl['targetMask'],
  sourceFieldSha256: string
): Promise<{ artifacts: ImageArtifact[]; runtime: RenderRuntime }> {
  const renderers = {
    step: createRasterizer(mask, undefined, undefined, 'step'),
    'linear-rgb': createRasterizer(mask, undefined, undefined, 'linear-rgb')
  } as const;
  const artifacts: ImageArtifact[] = [];
  const totals = {
    step: { rasterMs: 0, encodeMs: 0, bytes: 0 },
    smooth: { rasterMs: 0, encodeMs: 0, bytes: 0 }
  };
  const modeName = { step: 'step', 'linear-rgb': 'smooth' } as const;
  const views = mask.maxZoom > 0
    ? (['aragats-z8-159-96', 'aragats-z9-318-193', 'zone-overview'] as const)
    : (['aragats-z8-159-96', 'zone-overview'] as const);
  for (const layer of FIELD_LAYERS) for (const view of views) {
    const pairKey = `${frame.id}_${variant.id}_${layer}_${view}`;
    for (const style of ['step', 'linear-rgb'] as const) {
      const rasterStarted = performance.now();
      const rendered = view === 'aragats-z8-159-96'
        ? { ...renderers[style].renderTilePixels(fields[layer], layer, 8, 159, 96), width: 256, height: 256,
            z: 8, x0: 159, y0: 96, x1: 159, y1: 96 }
        : view === 'aragats-z9-318-193'
        ? { ...renderers[style].renderTilePixels(fields[layer], layer, 9, 318, 193), width: 256, height: 256,
            z: 9, x0: 318, y0: 193, x1: 318, y1: 193 }
        : await renderOverview(renderers[style], fields[layer], layer, mask);
      const rasterMs = performance.now() - rasterStarted;
      const encodeStarted = performance.now(), encoded = await encodeWebp(rendered.rgba, rendered.width, rendered.height);
      const encodeMs = performance.now() - encodeStarted;
      const suffix = view === 'aragats-z8-159-96' ? '' : view === 'aragats-z9-318-193' ? '-z9' : '-overview';
      const key = `${buildId}/images/${frame.id}_${variant.id}_${layer}${suffix}-${modeName[style]}.webp`;
      const artifact = await writeArtifact(out, key, encoded);
      const extent = view === 'aragats-z8-159-96'
        ? { kind: 'tile' as const, z: 8, x: 159, y: 96 }
        : view === 'aragats-z9-318-193'
        ? { kind: 'tile' as const, z: 9, x: 318, y: 193 }
        : { kind: 'overview' as const, z: rendered.z, x0: rendered.x0, y0: rendered.y0, x1: rendered.x1, y1: rendered.y1 };
      artifacts.push({
        ...artifact, pairKey, view, style, valueUnits: LAYERS[layer].units, fieldSha256: sourceFieldSha256,
        layer, width: rendered.width, height: rendered.height, extent
      });
      totals[modeName[style]].rasterMs += rasterMs;
      totals[modeName[style]].encodeMs += encodeMs;
      totals[modeName[style]].bytes += artifact.bytes;
    }
  }
  return { artifacts, runtime: { ...totals, bytesRatio: totals.step.bytes ? totals.smooth.bytes / totals.step.bytes : 0 } };
}

async function prepareKernel(control: EvaluationControl, provider: ForecastProvider): Promise<{
  preparations: Map<string, KernelPreparation>;
  definitions: VariantDefinition[];
}> {
  const definitions: VariantDefinition[] = [
    { id: 'stored-clearance', kind: 'stored' },
    { id: 'native', kind: 'native' },
    { id: 'candidate-neutral', kind: 'kernel', options: { bridgeMode: 'neutral', maximumBelowGroundExtrapolationM: 1000 } },
    { id: 'candidate-supported-clearance', kind: 'kernel', options: { bridgeMode: 'neutral', maximumBelowGroundExtrapolationM: 1000, clearanceFallback: 'unsupported' } }
  ];
  const active = coverageIndices(control.sourceMask).active, preparations = new Map<string, KernelPreparation>();
  for (const definition of definitions) {
    if (definition.kind !== 'kernel') continue;
    preparations.set(definition.id, prepareTerrainColumns(
      control.sourceMask, control.targetMask, active, provider.maxLevels, definition.options
    ));
  }
  return { preparations, definitions };
}

async function openAcquisition(
  control: EvaluationControl,
  frameIds: readonly string[],
  provider: ForecastProvider,
  cacheDir: string,
  signal?: AbortSignal
) {
  const product = getProduct(control.manifest.model);
  if (!product) throw new Error(`No product for control model ${control.manifest.model}`);
  const active = coverageIndices(control.sourceMask).active;
  const evidence = selectSourceFrames(control, frameIds);
  const session = await provider.open({ cycle: control.manifest.cycle, activeIndices: active, cacheDir, signal, readOnlyCache: true, offline: true });
  if (!sameInstant(session.cycle, control.manifest.cycle)) {
    await session.close();
    throw new Error('Provider cycle differs from control');
  }
  return { product, active, evidence, session };
}

async function acquireFrame(
  control: EvaluationControl,
  provider: ForecastProvider,
  session: ForecastSession,
  active: Uint32Array,
  product: NonNullable<ReturnType<typeof getProduct>>,
  selected: SourceFrameEvidence
): Promise<NormalizedFrame> {
  const frame = await session.acquire(selected.hour);
  validateNormalizedFrame(frame, active, control.sourceMask.grid, provider.maxLevels, product.layers, product.capabilities.verticalCoordinate);
  const descriptor = control.manifest.frames.find(candidate => candidate.id === selected.frameId)!;
  if (!sameInstant(frame.cycle, control.manifest.cycle) || frame.hour !== selected.hour || !sameInstant(frame.validAt, descriptor.validTime)) {
    throw new Error(`Acquired frame identity mismatch for ${selected.frameId}`);
  }
  if (!sameSourceEvidence(selected, { intervals: frame.intervals, receipt: frame.receipt })) {
    throw new Error(`Acquired raw source differs from control for ${selected.frameId}`);
  }
  return frame;
}


async function preparePublication(finalBuildDir: string): Promise<void> {
  try {
    await lstat(localPath(finalBuildDir, 'report.json'));
    throw new Error('Completed evaluation report already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await lstat(finalBuildDir);
    throw new Error(`Evaluation output collision at ${finalBuildDir}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function runEvaluation(options: RunEvaluationOptions): Promise<EvaluationRunResult> {
  const started = Date.now();
  options.signal?.throwIfAborted();
  const control = await loadEvaluationInput({ manifestPath: options.controlManifest, patchId: options.patchId, signal: options.signal });
  if (control.patch.method.id !== TERRAIN_CLEARANCE_METHOD.id) {
    throw new Error(`Wrong-method control: refinement patch method ${control.patch.method.id} is not ${TERRAIN_CLEARANCE_METHOD.id}`);
  }
  const product = getProduct(control.manifest.model);
  if (!product) throw new Error(`No product for ${control.manifest.model}`);
  const candidateIdentity = await buildIdentity(product, control.manifest.coverage.hash);
  const provider = options.provider ?? getForecastProvider(control.manifest.model);
  const frameIds = options.frames ?? control.manifest.frames.map(frame => frame.id);
  if (!frameIds.length) throw new Error('Evaluation requires at least one frame');
  const { preparations, definitions } = await prepareKernel(control, provider);
  const acquisition = await openAcquisition(control, frameIds, provider, options.cacheDir, options.signal);
  const finalBuildDir = localPath(options.out, control.manifest.buildId);
  const stageRoot = localPath(options.out, `.evaluation-work/${randomUUID()}`);
  try {
    await preparePublication(finalBuildDir);
    await mkdir(stageRoot, { recursive: true });
    const runOut = stageRoot;
    const storedBytes = await readLocalFile(
      localPath(control.outputRoot, control.patch.samples.key),
      control.patch.samples.bytes,
      control.patch.samples.bytes
    );
    const stored = decodeSamplePack(storedBytes, control.targetMask, control.manifest.frames.map(frame => frame.id), control.patch.layers, control.patch.samples.channelCount);
    const whole = selectEvaluationPopulation(control.targetMask, { kind: 'whole-zone', name: 'whole-zone' });
    const aragats = selectEvaluationPopulation(control.targetMask, {
      kind: 'spherical-radius', name: 'aragats-15km', ...ARAGATS
    });
    const populations = [['whole-zone', whole], ['aragats-15km', aragats]] as const;
    const probes = selectProbes(control, whole), probeIndices = probes.map(probe => probe.index);
    const layout = prepareSamplePackLayout(control.targetMask.grid, control.targetMask.output, control.targetMask.halo);
    const reportVariants: VariantFrameReport[] = [];
    const renderTotals = {
      step: { rasterMs: 0, encodeMs: 0, bytes: 0 },
      smooth: { rasterMs: 0, encodeMs: 0, bytes: 0 }
    };
    for (const selected of acquisition.evidence) {
      options.signal?.throwIfAborted();
      const frameId = selected.frameId;
      const frame = await acquireFrame(control, provider, acquisition.session, acquisition.active, acquisition.product, selected);
      const descriptor = control.manifest.frames.find(candidate => candidate.id === frameId)!;
      const storedFrame = stored.fields[frameId];
      if (!storedFrame) throw new Error(`Stored pack omitted frame ${frameId}`);
      const clearanceFields = {
        'usable-lift-msl': storedFrame['usable-lift-msl']!,
        'usable-lift-agl': storedFrame['usable-lift-agl']!
      };
      const perVariant = new Map<string, VariantFrame>();
      for (const definition of definitions) {
        let fields: LiftFields, metrics: Record<string, number> = {}, traces: readonly ProbeTrace[] = [];
        if (definition.kind === 'stored') {
          fields = clearanceFields;
        } else if (definition.kind === 'native') {
          fields = nativeFields(control, frame);
        } else {
          const preparation = preparations.get(definition.id);
          if (!preparation) throw new Error(`Missing kernel preparation for ${definition.id}`);
          const clearance = definition.options?.clearanceFallback === 'unsupported'
            ? { validTime: descriptor.validTime, grid: control.targetMask.grid, fields: clearanceFields, methodId: control.patch.method.id }
            : undefined;
          const derivation = preparation.derive(
            frame,
            { elevationM: control.terrain.elevationM, valid: control.terrain.valid },
            { intervalStart: descriptor.intervalStart, validTime: descriptor.validTime },
            { daylightOnly: true, probeIndices, ...(clearance ? { clearance } : {}) }
          );
          fields = derivation.fields;
          metrics = flatMetrics(derivation.metrics);
          traces = derivation.probes;
        }
        perVariant.set(definition.id, { frame: descriptor, fields, metrics, probes: traces });
      }
      for (const definition of definitions) {
        const variant = perVariant.get(definition.id)!;
        const builder = createSamplePackBuilder(layout, FIELD_LAYERS.length);
        const temporary = localPath(runOut, `${control.manifest.buildId}/.${randomUUID()}.pack.tmp`);
        const finalKey = `${control.manifest.buildId}/fields/${definition.id}/${frameId}.bin`;
        let packed: { sha256: string; bytes: number };
        try {
          for (let channel = 0; channel < FIELD_LAYERS.length; channel++) builder.writeChannel(channel, variant.fields[FIELD_LAYERS[channel]!]);
          packed = await builder.finish(temporary);
          const path = localPath(runOut, finalKey);
          await mkdir(dirname(path), { recursive: true });
          try { await link(temporary, path); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Evaluation field pack already exists: ${finalKey}`);
            throw error;
          }
        } finally {
          builder.close();
          await rm(temporary, { force: true });
        }
        const comparisons: PopulationComparison[] = [];
        for (const baseline of ['stored-clearance', 'native'] as const) {
          if (baseline === definition.id) continue;
          const base = perVariant.get(baseline)!;
          comparisons.push(comparison(baseline, variant.fields, base.fields, populations));
        }
        const fieldSha256Before = fieldSha256(variant.fields);
        const rendered = await renderVariantImages(runOut, control.manifest.buildId, definition, descriptor, variant.fields, control.targetMask, fieldSha256Before);
        const fieldSha256After = fieldSha256(variant.fields);
        if (fieldSha256Before !== fieldSha256After) throw new Error(`Rendered field mutation for ${definition.id}/${frameId}`);
        const packBytes = await readLocalFile(localPath(runOut, finalKey), packed.bytes, packed.bytes);
        const packSha256After = sha256(packBytes);
        if (packSha256After !== packed.sha256) throw new Error(`Rendered pack mutation for ${definition.id}/${frameId}`);
        for (const mode of ['step', 'smooth'] as const) {
          renderTotals[mode].rasterMs += rendered.runtime[mode].rasterMs;
          renderTotals[mode].encodeMs += rendered.runtime[mode].encodeMs;
          renderTotals[mode].bytes += rendered.runtime[mode].bytes;
        }
        reportVariants.push({
          variant: definition.id,
          frame: frameId,
          validTime: descriptor.validTime,
          parameters: definition.options ?? null,
          metrics: variant.metrics,
          fields: { key: finalKey, ...packed },
          comparisons,
          probes: probeReport(variant.probes, probes),
          renderInvariance: {
            fieldSha256Before, fieldSha256After, fieldSha256Identical: true,
            packSha256Before: packed.sha256, packSha256After, packSha256Identical: true
          },
          images: rendered.artifacts
        });
      }
    }
    const afterIdentity = await buildIdentity(product, control.manifest.coverage.hash);
    if (JSON.stringify(candidateIdentity) !== JSON.stringify(afterIdentity)) throw new Error('Candidate sources changed during evaluation');
    const manifestBytes = await readLocalFile(control.manifestPath, MAX_MANIFEST_BYTES);
    if (sha256(manifestBytes) !== control.manifestSha256) throw new Error('Control manifest changed during evaluation');
    const deterministic: EvaluationReportContent = {
      version: 1,
      candidate: {
        sourceRevision: candidateIdentity.recipe.sourceRevision,
        sourceDirty: candidateIdentity.recipe.sourceDirty,
        sourceHashes: {
          adapter: candidateIdentity.components.adapter,
          science: candidateIdentity.components.science,
          contracts: candidateIdentity.components.contracts
        }
      },
      control: {
        buildId: control.manifest.buildId,
        model: control.manifest.model,
        cycle: control.manifest.cycle,
        manifestSha256: control.manifestSha256,
        provenanceSha256: control.manifest.source.provenanceSha256,
        method: control.manifest.method,
        patch: { id: control.patch.id, method: control.patch.method, grid: control.patch.grid, terrain: control.patch.terrain },
        frames: control.manifest.frames.filter(frame => frameIds.includes(frame.id)),
        rawSourceReceiptsMatch: true
      },
      probeTargets: probes.map(({ index: _index, ...probe }) => probe),
      variants: reportVariants,
      scientificGate: {
        status: 'inconclusive',
        reason: 'Supported-anomaly hybrid parameters require the full multi-cycle observational gate.'
      }
    };
    const runtime = {
      elapsedMs: Date.now() - started,
      peakRssBytes: process.resourceUsage().maxRSS * 1024 + (acquisition.session.nativePeakRssBytes ?? 0),
      render: {
        ...renderTotals,
        bytesRatio: renderTotals.step.bytes ? renderTotals.smooth.bytes / renderTotals.step.bytes : 0
      }
    };
    const written = await writeCompletedEvaluationReport({
      out: runOut,
      buildId: control.manifest.buildId,
      deterministic,
      runtime
    });
    try { await rename(localPath(runOut, control.manifest.buildId), finalBuildDir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
        throw new Error('Completed evaluation report already exists');
      }
      throw error;
    }
    const report = { ...written, path: localPath(finalBuildDir, 'report.json') };
    return { report, deterministic, runtime };
  } finally {
    await acquisition.session.close();
    await rm(stageRoot, { recursive: true, force: true });
  }
}

export const EVALUATION_OPTIONS = {
  'control-manifest': { type: 'string' },
  'cache-dir': { type: 'string' },
  out: { type: 'string' },
  frames: { type: 'string' },
  patch: { type: 'string' }
} as const;

export async function runEvaluationCli(args: string[]): Promise<EvaluationRunResult> {
  const { values } = parseArgs({ args, options: EVALUATION_OPTIONS, strict: true, allowPositionals: false });
  if (!values['control-manifest'] || !values['cache-dir'] || !values.out) {
    throw new Error('refinement:evaluate requires --control-manifest, --cache-dir and --out');
  }
  return runEvaluation({
    controlManifest: values['control-manifest'],
    cacheDir: values['cache-dir'],
    out: values.out,
    frames: values.frames ? values.frames.split(',').map(value => value.trim()).filter(Boolean) : undefined,
    patchId: values.patch
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runEvaluationCli(process.argv.slice(2)).then(result => console.log(JSON.stringify(result.report)), error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
