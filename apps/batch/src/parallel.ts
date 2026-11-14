import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import z from 'zod';
import { profileRecordBytes, prepareShardedSamplePackLayout, resolveProductFrameHours } from '@av/forecast';
import { getProduct } from '@av/contracts/models';
import { artifactSchema, assertSampleLayoutBindingV5, coverageAtZoom, createWholeDomainDescriptors, encodeBoundedJson, matchesFrameIntervals, provenanceFrameReferenceSchema, layerSurface, renderedLayers, mapFrameCount, sameJsonValue, sourceIntervalHours, MAX_FORECAST_SHARDS, MAX_MANIFEST_BYTES, MAX_MODEL_WORKERS, MAX_NATIVE_ZOOM, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, MAX_SAMPLE_VALUES, manifestV5Schema, parseBoundedJson, SAMPLE_BLOCK_SIZE, type ForecastSurfaceV5, type ManifestV5 } from '@av/contracts';
import { assertForecastInputs, BUILD_BUDGETS, forecastPlanDeadline, isForecastPlanDeadline, MAX_BUILD_LIFETIME_MS, MAX_V5_SHARD_BYTES, MAX_FORECAST_RECEIPT_ENTRIES } from './capacity.js';
import { createBuildStamp, type BuildOptions } from './build.js';
import { loadCoverage } from './coverage.js';
import { forecastFrame, type ForecastInputs } from './frame-build.js';
import { buildIdentity } from './identity.js';
import { createLocalFileReader, readLocalFile } from './local-file.js';
import { getForecastProvider } from './providers.js';
import { forecastSourcePinSchema, type ForecastSourcePin } from './provider.js';
import { pinnedSourcePrefix } from './source.js';
import { localPath, sha256, validateArchive, validateSampleGroup } from './validate.js';
import { failureReason } from './failure.js';
import { sparseTerrainRefSchema, validateSparsePreparedTerrain } from './terrain/sparse.js';
import { stageSparsePreparedTerrain } from './terrain/staging.js';
import type { ObjectStorage } from './storage.js';
import { admitWholeDomain, partitionForecastHours, planWholeDomainCapacity, wholeDomainCapacityInput, wholeDomainSurfaceLayers } from './whole-domain/capacity.js';
import { buildWholeDomainFrames, type WholeDomainSurfaceResult } from './whole-domain/frames.js';
import { finishWholeDomain, type FinishWholeDomainOptions } from './whole-domain/finish.js';
import { frozenWholeDomain, loadFrozenWholeDomain, loadWholeDomainTerrain, prepareWholeDomain, type WholeDomainOptions, type WholeDomainPrepared } from './whole-domain/prepare.js';
import { readFrameProvenance } from './frame-provenance.js';
import { sampleShardKey } from './sample-pack-v5.js';
import { writeServingGroups } from './serving-groups.js';
import { putImmutableReceipt, verifyObjectReceipts, type ObjectReceipt } from './immutable-upload.js';
import { hourSampleParts, verifyPublicationReceipts } from './build-receipts.js';
import { createWindDataWriter, localWindData } from './wind-data.js';
import { WIND_FRAME_LIMIT, WIND_ROOT_LIMIT, assertWindFrameLayout, windFrameParts, windDataSchema, parseWindFrame } from '@av/contracts/wind-data';

const windSparsity = (whole: WholeDomainPrepared) => ({ activeIndices: whole.acquisitionActive, fineCoverage: whole.fine.mask.coverage });

export { MAX_FORECAST_SHARDS } from '@av/contracts';
const digestSchema = artifactSchema.shape.tilesSha256;
const objectReceiptSchema = z.strictObject({ key: z.string().min(1), bytes: z.number().int().positive().max(BUILD_BUDGETS.samplePackBytes), sha256: digestSchema, etag: z.string().min(1) });
const timestampSchema = manifestV5Schema.shape.createdAt.refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const preparationSchema = z.strictObject({ elapsedMs: z.number().nonnegative().max(BUILD_BUDGETS.elapsedMs), peakRssBytes: z.number().nonnegative().max(BUILD_BUDGETS.peakRssBytes) });
const wholeDomainPlanSchema = z.strictObject({
  k: z.number().int().positive().max(64), nativeCoverageHash: digestSchema,
  fineCoverage: z.strictObject({ id: z.string().min(1).max(128), hash: digestSchema,
    maskKey: z.string().regex(/^coverage\/[a-f0-9]{64}\/manifest\.json$/), maxZoom: z.number().int().nonnegative(), gridHash: digestSchema }),
  terrain: sparseTerrainRefSchema
});
const buildPlanBase = z.strictObject({
  version: z.literal(2), model: manifestV5Schema.shape.model,
  buildId: z.string().regex(/^\d{8}T\d{6}Z-[a-f0-9-]{36}$/),
  createdAt: timestampSchema, deadlineAt: timestampSchema.optional(), cycle: timestampSchema, coverageHash: digestSchema,
  providerId: z.string().min(1), wholeDomain: wholeDomainPlanSchema, sourcePin: forecastSourcePinSchema.optional(),
  dependencies: z.array(objectReceiptSchema).min(1).optional(),
  preparation: preparationSchema,
  recipe: manifestV5Schema.shape.recipe.strict().extend({ source: manifestV5Schema.shape.recipe.shape.source.strict() }),
  execution: z.strictObject({ zoom: z.number().int().min(0).max(MAX_NATIVE_ZOOM), workers: z.number().int().min(0).max(MAX_MODEL_WORKERS) }).optional(),
  numericWind: z.literal(true).optional(),
  groups: z.array(z.array(z.number().int().positive()).min(1).max(MAX_SAMPLE_VALUES)).min(1).max(MAX_FORECAST_SHARDS)
});
const planSchema = buildPlanBase.superRefine((plan, ctx) => {
  if (!isForecastPlanDeadline(plan.createdAt, forecastPlanDeadline(plan))) ctx.addIssue({ code: 'custom', message: 'Invalid forecast plan deadline' });
});
export type BuildPlan = z.infer<typeof planSchema>;

interface PlanOptions {
  out: string; cycle: string; shards?: number; signal?: AbortSignal;
  store?: ObjectStorage;
  sourcePin?: ForecastSourcePin;
  wholeDomain?: WholeDomainOptions;
  numericWind?: boolean;
}
const nonnegativeNumber = z.number().nonnegative();
const metricsSchema = z.strictObject({
  frames: z.record(z.string(), z.record(z.string(), z.unknown())),
  phasesMs: z.strictObject({ acquireMs: nonnegativeNumber, deriveMs: nonnegativeNumber, packMs: nonnegativeNumber, renderMs: nonnegativeNumber }),
  renderer: z.record(z.string(), z.unknown()), acquisition: z.record(z.string(), z.unknown()),
  elapsedMs: nonnegativeNumber.max(BUILD_BUDGETS.elapsedMs), peakRssBytes: nonnegativeNumber.max(BUILD_BUDGETS.peakRssBytes)
});
function withProcessPeakRss(metrics: z.infer<typeof metricsSchema>) {
  const peakRssBytes = Math.max(metrics.peakRssBytes, process.resourceUsage().maxRSS * 1024);
  const parsed = metricsSchema.safeParse({ ...metrics, peakRssBytes });
  if (!parsed.success) throw new Error(`Invalid forecast shard metrics (peakRssBytes=${peakRssBytes}): ${parsed.error.message}`);
  return parsed.data;
}
const sampleShardSchema = z.strictObject({ firstBlock: z.number().int().nonnegative(), blockCount: z.number().int().positive(), storedCells: z.number().int().positive(), bytes: z.number().int().positive(), key: z.string().min(1), sha256: digestSchema });
const wholeDomainReceiptSchema = z.strictObject({
  version: z.literal(2), planHash: digestSchema, shard: z.number().int().min(0).max(MAX_FORECAST_SHARDS - 1),
  artifacts: z.array(manifestV5Schema.shape.artifacts.element).max(MAX_SAMPLE_VALUES),
  provenance: z.array(provenanceFrameReferenceSchema).min(1).max(MAX_SAMPLE_VALUES),
  surfaces: z.array(z.strictObject({ id: z.enum(['native', 'fine']), channelCount: z.number().int().positive(), shards: z.array(sampleShardSchema).min(1),
    profiles: z.strictObject({ levelCount: z.number().int().positive().max(256), recordBytes: z.number().int().positive(), shards: z.array(sampleShardSchema).min(1) }).optional() })).min(1).max(2),
  objects: z.array(objectReceiptSchema).min(1).optional(),
  numeric: z.strictObject({ frames: z.array(z.strictObject({ id: z.string(), bytes: z.number().int().positive().max(WIND_FRAME_LIMIT), sha256: digestSchema })).max(MAX_SAMPLE_VALUES),
    objects: z.array(objectReceiptSchema.extend({ bytes: z.number().int().positive().max(MAX_V5_SHARD_BYTES), etag: z.string().min(1).optional() })).max(MAX_FORECAST_RECEIPT_ENTRIES) }).optional(),
  metrics: metricsSchema
});
type WholeDomainReceipt = z.infer<typeof wholeDomainReceiptSchema>;
const same = sameJsonValue;
const planHash = (plan: BuildPlan) => sha256(encodeBoundedJson(plan, MAX_MANIFEST_BYTES));
export function parseForecastShardReceipt(bytes: Uint8Array, plan: BuildPlan, shard: number): WholeDomainReceipt {
  const receipt = wholeDomainReceiptSchema.parse(parseBoundedJson(bytes, MAX_PROVENANCE_JSON_TOKENS, MAX_FORECAST_RECEIPT_ENTRIES));
  if (receipt.planHash !== planHash(plan) || receipt.shard !== shard) throw new Error('Forecast shard receipt identity mismatch');
  return receipt;
}

function assertWholeDomainReceipt(receipt: WholeDomainReceipt, plan: BuildPlan, shard: number, product: ForecastInputs['product'], whole: WholeDomainPrepared, maxLevels: number) {
  const hours = plan.groups[shard]!, frames = hours.map(hour => forecastFrame(plan.cycle, hour, sourceIntervalHours(product, hour))), layers = wholeDomainSurfaceLayers(product);
  if (receipt.provenance.length !== frames.length || receipt.provenance.some((entry, index) => entry.hour !== hours[index] || entry.frame !== frames[index]!.id
    || entry.key !== `builds/${plan.model}/${plan.buildId}/provenance/${entry.frame}.json`)) throw new Error('Forecast shard provenance frame mismatch');
  if (!same(Object.keys(receipt.metrics.frames), frames.map(frame => frame.id))) throw new Error('Forecast shard metric frames mismatch');
  const prefix = `builds/${plan.model}/${plan.buildId}`;
  const mapped = mapFrameCount({ ...product, frameHours: plan.groups[shard]! });
  const numericFrames = frames.slice(0, mapped).map(frame => frame.id);
  if (plan.numericWind ? (mapped > 0 && !receipt.numeric) || !same(receipt.numeric?.frames.map(frame => frame.id) ?? [], numericFrames) : Boolean(receipt.numeric)) {
    throw new Error('Forecast shard numeric frame mismatch');
  }
  if (receipt.numeric) {
    const keys = new Set<string>(), base = `${prefix}/map-data/`;
    for (const object of receipt.numeric.objects) {
      const path = object.key.slice(base.length), [frame, file, extra] = path.split('/');
      const valid = numericFrames.includes(frame.replace(/\.json$/, '')) && (file === undefined ? frame.endsWith('.json') : extra === undefined && /^(wind|fine|overview-[1-9][0-9]{0,4})-(0|[1-9][0-9]*)\.(bin|idx)$/.test(file));
      if (!object.key.startsWith(base) || !valid || keys.has(object.key)) throw new Error('Forecast shard numeric object mismatch');
      keys.add(object.key);
    }
    for (const frame of receipt.numeric.frames) {
      const object = receipt.numeric.objects.find(item => item.key === `${base}${frame.id}.json`);
      if (!object || object.bytes !== frame.bytes || object.sha256 !== frame.sha256) throw new Error('Forecast shard numeric frame digest mismatch');
    }
  }
  const artifacts = frames.slice(0, mapped).flatMap(frame => renderedLayers([...layers.native, ...layers.fine]).map(layer => ({ layer, frame: frame.id, key: `${prefix}/${layer}/${frame.id}.pmtiles` })));
  if (receipt.artifacts.length !== artifacts.length) throw new Error('Forecast shard artifact count mismatch');
  if (receipt.artifacts.some((artifact, index) => artifact.layer !== artifacts[index]!.layer || artifact.frame !== artifacts[index]!.frame || artifact.tilesKey !== artifacts[index]!.key)) throw new Error('Forecast shard artifact record mismatch');
  const expectedSurfaces = (['native', 'fine'] as const).filter(id => layers[id].length && (id === 'native' || mapped));
  if (!same(receipt.surfaces.map(surface => surface.id), expectedSurfaces)) throw new Error('Forecast shard surface set mismatch');
  for (const surface of receipt.surfaces) {
    const id = surface.id, info = id === 'native' ? whole.native : whole.fine;
    const binding = { grid: id === 'native' ? whole.plan.native : whole.plan.fine, gridHash: info.descriptor.gridHash,
      coverageHash: info.hash, blockIds: info.mask.coverage.blockIds };
    if (surface.channelCount !== (id === 'native' ? frames.length : mapped) * layers[id].length) throw new Error('Forecast shard surface channel count mismatch');
    if (surface.shards.some((item, index) => item.key !== sampleShardKey(plan.model, plan.buildId, id, index, shard, 'samples', 'hour'))) {
      if (surface.shards.every((item, index) => item.key === sampleShardKey(plan.model, plan.buildId, id, index, shard))) {
        throw new Error('Legacy forecast sample receipts require their original producer; start a fresh forecast');
      }
      throw new Error('Forecast shard surface key mismatch');
    }
    const candidate: ForecastSurfaceV5 = { id, kind: id, grid: binding.grid, gridHash: binding.gridHash,
      coverage: { id: info.descriptor.id, hash: info.hash, maskKey: `coverage/${info.hash}/manifest.json`, maxZoom: product.maxNativeZoom, gridHash: info.descriptor.gridHash },
      layers: layers[id],
      samples: { format: 'cell-major-block-shards-v1', blockSize: SAMPLE_BLOCK_SIZE, channelOrder: 'frame-then-layer',
        channelCount: surface.channelCount, coverageHash: info.hash, blockCount: binding.blockIds.length,
        storedCells: surface.shards.reduce((sum, item) => sum + item.storedCells, 0), shards: surface.shards } };
    assertSampleLayoutBindingV5(candidate, binding);
    const requiresProfiles = id === 'native' && renderedLayers(product.layers).length !== product.layers.length;
    if (requiresProfiles !== !!surface.profiles) throw new Error('Forecast shard profile set mismatch');
    if (surface.profiles) {
      const profiles = surface.profiles;
      if (profiles.levelCount !== maxLevels || profiles.recordBytes !== profileRecordBytes(maxLevels)) throw new Error('Forecast shard profile width mismatch');
      const layout = prepareShardedSamplePackLayout(binding.grid, binding.blockIds, frames.length, MAX_V5_SHARD_BYTES, profiles.recordBytes);
      if (layout.shards.length !== profiles.shards.length || profiles.shards.some((item, index) => {
        const expected = layout.shards[index]!;
        return item.key !== sampleShardKey(plan.model, plan.buildId, id, index, shard, 'profiles')
          || item.firstBlock !== expected.firstBlock || item.blockCount !== expected.blockCount || item.bytes !== expected.byteLength
          || item.storedCells !== expected.byteLength / (frames.length * profiles.recordBytes);
      })) throw new Error('Forecast shard profile layout mismatch');
    }
  }
}

async function assertWholeDomainProvenance(root: string, plan: BuildPlan, shard: number, product: ForecastInputs['product'], references: WholeDomainReceipt['provenance']) {
  const hours = plan.groups[shard]!, frames = hours.map(hour => forecastFrame(plan.cycle, hour, sourceIntervalHours(product, hour)));
  if (references.length !== hours.length) throw new Error('Forecast shard provenance frame mismatch');
  for (const [index, reference] of references.entries()) {
    if (reference.hour !== hours[index] || reference.frame !== frames[index]!.id) throw new Error('Forecast shard provenance frame mismatch');
    const value = await readFrameProvenance(root, plan, frames[index]!, reference);
    if (!matchesFrameIntervals(value.intervals, frames[index]!, product.layers.includes('precip-rate'))) throw new Error('Forecast shard provenance interval mismatch');
    if (plan.sourcePin && (!value.receipt || typeof value.receipt !== 'object' || !('sourcePin' in value.receipt)
        || !same(value.receipt.sourcePin, plan.sourcePin))) throw new Error('Forecast shard provenance differs from its pinned upstream receipt');
  }
  return frames;
}

const terrainStaging = new Map<string, Promise<void>>();

async function stagePlanTerrain(root: string, plan: BuildPlan, whole: WholeDomainPrepared, store: ObjectStorage, signal?: AbortSignal): Promise<void> {
  const key = `${root}\0${plan.buildId}`;
  const current = terrainStaging.get(key);
  if (current) return current;
  const pending = stagePlanTerrainOnce(root, plan, whole, store, signal).finally(() => {
    if (terrainStaging.get(key) === pending) terrainStaging.delete(key);
  });
  terrainStaging.set(key, pending);
  return pending;
}

async function stagePlanTerrainOnce(root: string, plan: BuildPlan, whole: WholeDomainPrepared, store: ObjectStorage, signal?: AbortSignal): Promise<void> {
  if (!plan.dependencies) throw new Error('Forecast plan lacks dependency receipts');
  await verifyObjectReceipts(store, plan.dependencies, signal);
  await stageSparsePreparedTerrain({ ref: whole.terrain, storage: store, out: root, grid: whole.plan.fine,
    coverage: whole.fine.mask.coverage, coverageDescriptor: whole.fine.bytes, signal });
  const expected = new Map<string, { bytes: number; sha256: string }>();
  for (const coverage of [whole.native, whole.fine]) {
    expected.set(`coverage/${coverage.hash}/manifest.json`, { bytes: coverage.bytes.length, sha256: coverage.hash });
    for (const name of ['sparse', 'tiles'] as const) expected.set(`coverage/${coverage.hash}/${name}.bin`, coverage.descriptor.files[name]);
  }
  await validateSparsePreparedTerrain(whole.terrain, async asset => {
    expected.set(asset.key, asset);
    return readLocalFile(localPath(root, asset.key), asset.bytes, asset.bytes);
  }, whole.plan.fine, whole.fine.mask.coverage, whole.fine.bytes, signal);
  if (plan.dependencies.length !== expected.size || plan.dependencies.some(item => {
    const asset = expected.get(item.key);
    return !asset || asset.bytes !== item.bytes || asset.sha256 !== item.sha256;
  })) throw new Error('Forecast dependency receipt set mismatch');
}


/** Freeze the resolved cycle and complete-product admission. No provider data is acquired here. */
export async function createBuildPlan(options: PlanOptions & ForecastInputs): Promise<BuildPlan> {
  options.signal?.throwIfAborted();
  const stamp = createBuildStamp();
  const deadlineAt = new Date(Date.parse(stamp.createdAt) + BUILD_BUDGETS.elapsedMs).toISOString();
  const deadlineSignal = AbortSignal.timeout(Math.max(1, Date.parse(deadlineAt) - Date.now()));
  options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, deadlineSignal]) : deadlineSignal };
  const { product, provider, mask } = options, root = resolve(options.out);
  assertForecastInputs(mask, product);
  if (typeof options.cycle !== 'string' || !Number.isFinite(Date.parse(options.cycle))) throw new Error('A resolved forecast cycle is required');
  const groups = partitionForecastHours(resolveProductFrameHours(product, mask, options.cycle), options.shards ?? product.execution.shards);
  const execution = { zoom: product.maxNativeZoom, workers: product.execution.workers };
  const prepared = await prepareWholeDomain({ product, mask, out: root, maxLevels: provider.maxLevels, wholeDomain: options.wholeDomain, signal: options.signal });
  const capacity = admitWholeDomain(wholeDomainCapacityInput(product, provider, prepared, groups));
  if (capacity.violations.length) throw new Error(`Whole-domain build exceeds capacity: ${capacity.violations.join('; ')}`);
  const numericWind = Boolean(options.numericWind && capacity.mapFrames);
  if (numericWind) createWindDataWriter(root, product.modelId, stamp.buildId, provider.maxLevels, prepared.plan, capacity, options.signal, windSparsity(prepared));
  const source = !options.sourcePin && provider.resolveRun ? await provider.resolveRun({ cycle: options.cycle,
    cacheDir: localPath(root, '.cache/source'), store: options.store, signal: options.signal }) : undefined;
  if (source && Date.parse(source.cycle) !== Date.parse(options.cycle)) throw new Error('Pinned upstream cycle differs from the planned cycle');
  const sourcePin = options.sourcePin ?? source?.sourcePin;
  if (!!provider.resolveRun !== !!sourcePin) throw new Error('Forecast plan must pin its private source');
  if (sourcePin) pinnedSourcePrefix(product, options.cycle, sourcePin.key);
  const frozen = frozenWholeDomain(prepared);
  const identity = await buildIdentity(product, prepared.native.hash, { wholeDomain:
    { k: prepared.plan.k, nativeCoverageHash: prepared.native.hash, fineCoverageHash: prepared.fine.hash, fineGridHash: prepared.fine.descriptor.gridHash, terrain: prepared.terrain } });
  const preparation = preparationSchema.parse({ elapsedMs: Date.now() - Date.parse(stamp.createdAt), peakRssBytes: process.resourceUsage().maxRSS * 1024 });
  const dependencies: ObjectReceipt[] = [];
  if (options.store) {
    for (const coverage of [prepared.native, prepared.fine]) {
      for (const key of [`coverage/${coverage.hash}/manifest.json`, `coverage/${coverage.hash}/sparse.bin`, `coverage/${coverage.hash}/tiles.bin`]) {
        if (dependencies.some(item => item.key === key)) continue;
        const bytes = await readLocalFile(localPath(root, key), BUILD_BUDGETS.samplePackBytes);
        dependencies.push(await putImmutableReceipt(options.store, key, bytes, key.endsWith('.json') ? 'application/json' : 'application/octet-stream', options.signal));
      }
    }
    await validateSparsePreparedTerrain(prepared.terrain, async asset => {
      const bytes = await readLocalFile(localPath(root, asset.key), asset.bytes, asset.bytes);
      dependencies.push(await putImmutableReceipt(options.store!, asset.key, bytes, asset.key.endsWith('.json') ? 'application/json' : 'application/octet-stream', options.signal));
      return bytes;
    }, prepared.plan.fine, prepared.fine.mask.coverage, prepared.fine.bytes, options.signal);
  }
  const plan = planSchema.parse({ version: 2, model: product.modelId, ...stamp, deadlineAt, cycle: new Date(options.cycle).toISOString(),
    coverageHash: prepared.native.hash, providerId: provider.id, recipe: identity.recipe, execution, groups, wholeDomain: frozen, preparation,
    ...(sourcePin ? { sourcePin } : {}), ...(dependencies.length ? { dependencies } : {}), ...(numericWind ? { numericWind: true } : {}) });
  options.signal?.throwIfAborted();
  await writeFile(localPath(root, 'plan.json'), encodeBoundedJson(plan, MAX_MANIFEST_BYTES), { flag: 'wx' });
  return plan;
}

async function admitPlan(plan: BuildPlan, inputs: ForecastInputs & Pick<BuildOptions, 'out' | 'signal'>, resume = false) {
  const { provider, mask } = inputs;
  let { product } = inputs;
  const parsed = planSchema.safeParse(plan);
  if (!parsed.success) throw new Error('Invalid forecast plan', { cause: parsed.error });
  plan = parsed.data;
  if (!!provider.resolveRun !== !!plan.sourcePin) throw new Error('Forecast plan must pin its private source');
  if (plan.sourcePin) pinnedSourcePrefix(product, plan.cycle, plan.sourcePin.key);
  if (plan.execution) product = { ...product, maxNativeZoom: plan.execution.zoom,
    execution: { ...product.execution, workers: plan.execution.workers } };
  assertForecastInputs(mask, product);
  if (plan.model !== product.modelId || plan.providerId !== provider.id
      || !plan.buildId.startsWith(plan.createdAt.replace(/[-:]/g, '').slice(0, 15) + 'Z-')
      || !same(plan.groups, partitionForecastHours(resolveProductFrameHours(product, mask, plan.cycle), plan.groups.length))) {
    throw new Error('Invalid forecast plan identity or frame groups');
  }
  const now = Date.now(), age = now - Date.parse(plan.createdAt);
  if (age < -60_000 || (!resume && age > MAX_BUILD_LIFETIME_MS)) throw new Error('Forecast plan exceeds publisher lifetime');
  if (!resume && now >= forecastPlanDeadline(plan)) throw new Error('Forecast plan exceeds elapsed-time budget; start a new build');
  const prepared = await loadFrozenWholeDomain({ product, frozen: plan.wholeDomain, out: resolve(inputs.out), maxLevels: provider.maxLevels, signal: inputs.signal });
  if (plan.coverageHash !== prepared.native.hash || mask.maxZoom !== prepared.nativeMask.maxZoom
      || (['output', 'halo', 'tiles'] as const).some(name => {
        const bytes = mask[name];
        return !Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).equals(prepared.nativeMask[name]);
      })) throw new Error('Forecast plan coverage changed');
  const identity = await buildIdentity(product, plan.coverageHash, { wholeDomain:
    { k: prepared.plan.k, nativeCoverageHash: prepared.native.hash, fineCoverageHash: prepared.fine.hash, fineGridHash: prepared.fine.descriptor.gridHash, terrain: prepared.terrain } });
  // Receipt-only resume can cross unrelated commits; producer content and dirty state stay pinned.
  const recipe = resume ? { ...identity.recipe, sourceRevision: plan.recipe.sourceRevision } : identity.recipe;
  if (!same(plan.recipe, recipe)) throw new Error('Forecast plan recipe or source revision changed; start a fresh forecast');
  if (plan.numericWind) createWindDataWriter(resolve(inputs.out), plan.model, plan.buildId, provider.maxLevels, prepared.plan, admitWholeDomain(wholeDomainCapacityInput(product, provider, prepared, plan.groups)), inputs.signal, windSparsity(prepared));
  return { plan, prepared, identity, product };
}

async function writeReceipt(path: string, receipt: unknown): Promise<string> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, encodeBoundedJson(receipt, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, MAX_FORECAST_RECEIPT_ENTRIES), { flag: 'wx' });
    await rename(tmp, path);
    return path;
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** One job owns one group; completion is recorded only after its pack and archives finish. */
export async function buildShard(options: ForecastInputs & { plan: BuildPlan; shard: number; out: string; cacheDir?: string; signal?: AbortSignal; store?: ObjectStorage }): Promise<string> {
  const deadline = forecastPlanDeadline(options.plan);
  const deadlineSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, deadlineSignal]) : deadlineSignal };
  const { shard } = options, root = resolve(options.out);
  options.signal?.throwIfAborted();
  const admitted = await admitPlan(options.plan, options), { plan, prepared } = admitted;
  options = { ...options, product: admitted.product };
  if (!Number.isSafeInteger(shard) || shard < 0 || shard >= plan.groups.length) throw new Error('Invalid forecast shard');
  await mkdir(localPath(root, 'shards'), { recursive: true });
  const prefix = `shards/${shard}`;
  await mkdir(localPath(root, prefix));
  try {
    const whole = prepared;
    if (options.store) await stagePlanTerrain(root, plan, whole, options.store, options.signal);
    const capacity = admitWholeDomain(wholeDomainCapacityInput(options.product, options.provider, whole, [plan.groups[shard]]));
    const numericWriter = plan.numericWind && capacity.mapFrames ? createWindDataWriter(root, plan.model, plan.buildId, options.provider.maxLevels, whole.plan, capacity, options.signal, windSparsity(whole)) : undefined;
    const result = await buildWholeDomainFrames({ ...options, prepared: whole, buildId: plan.buildId, createdAt: plan.createdAt, cycle: plan.cycle,
      sourceStore: options.store, sourcePin: plan.sourcePin, hours: plan.groups[shard], deadlineAt: deadline, journalPrefix: prefix, sampleGroup: shard,
      ...(numericWriter ? { onNumericFrame: numericWriter.writeFrame } : {}) });
    const numericResult = numericWriter?.finishShard() ?? { frames: [], objects: [] };
    const numericReader = createLocalFileReader(MAX_V5_SHARD_BYTES), validation = { reader: numericReader, signal: options.signal };
    for (const surface of result.surfaces) {
      const coverage = surface.id === 'native' ? whole.native : whole.fine;
      await validateSampleGroup(root, surface, coverage.mask.coverage, createWholeDomainDescriptors(options.product), { channels: surface.layout.channelCount, shards: surface.shards! }, validation);
      if (surface.profiles) await validateSampleGroup(root, surface, coverage.mask.coverage, createWholeDomainDescriptors(options.product), {
        channels: surface.profiles.layout.channelCount, recordBytes: surface.profiles.recordBytes, shards: surface.profiles.shards
      }, validation);
    }
    for (const artifact of result.artifacts) {
      const coverage = layerSurface(artifact.layer) === 'native' ? whole.native : whole.fine;
      await validateArchive(localPath(root, artifact.tilesKey), coverageAtZoom(coverage.mask, options.product.maxNativeZoom));
    }
    await assertWholeDomainProvenance(root, plan, shard, options.product, result.receipts);
    const objects: ObjectReceipt[] = [], store = options.store;
    if (store) {
      const files = [...result.surfaces.flatMap(surface => [...surface.shards!, ...(surface.profiles?.shards ?? [])].map(item => ({ key: item.key, hash: item.sha256, type: 'application/octet-stream' }))),
        ...result.artifacts.map(item => ({ key: item.tilesKey, hash: item.tilesSha256, type: 'application/vnd.pmtiles' })),
        ...result.receipts.map(item => ({ key: item.key, hash: item.sha256, type: 'application/json' }))];
      for (const file of files) {
        const upload = async (bytes: Buffer): Promise<void> => {
          if (sha256(bytes) !== file.hash) throw new Error(`Local hash mismatch: ${file.key}`);
          objects.push(await putImmutableReceipt(store, file.key, bytes, file.type, options.signal));
        };
        if (file.type === 'application/octet-stream') await numericReader(localPath(root, file.key), undefined, upload, options.signal);
        else await upload(await readLocalFile(localPath(root, file.key), BUILD_BUDGETS.samplePackBytes));
      }
    }
    const numericObjects = [];
    for (const file of numericResult.objects) {
      if (store) {
        const bytes = await readLocalFile(localPath(root, file.key), BUILD_BUDGETS.samplePackBytes, file.bytes);
        if (sha256(bytes) !== file.sha256) throw new Error(`Local wind hash mismatch: ${file.key}`);
        numericObjects.push(await putImmutableReceipt(store, file.key, bytes, file.contentType, options.signal));
      } else numericObjects.push({ key: file.key, bytes: file.bytes, sha256: file.sha256 });
    }
    const receipt: WholeDomainReceipt = wholeDomainReceiptSchema.parse({ version: 2, planHash: planHash(plan), shard,
      artifacts: result.artifacts, provenance: result.receipts,
      surfaces: result.surfaces.map(surface => ({ id: surface.id, channelCount: surface.layout.channelCount,
        shards: surface.shards!.map(item => ({ ...item, key: item.key })),
        ...(surface.profiles ? { profiles: { levelCount: surface.profiles.levelCount, recordBytes: surface.profiles.recordBytes, shards: surface.profiles.shards } } : {}) })), metrics: withProcessPeakRss(result.metrics), ...(objects.length ? { objects } : {}), ...(plan.numericWind ? { numeric: { frames: numericResult.frames, objects: numericObjects } } : {}) });
    options.signal?.throwIfAborted();
    return await writeReceipt(localPath(root, `${prefix}/receipt.json`), receipt);
  } catch (error) {
    await writeFile(localPath(root, `${prefix}/worker-failure.json`), JSON.stringify({ buildId: plan.buildId, shard, cancelled: options.signal?.aborted ?? false, error: failureReason(error) })).catch(() => {});
    throw error;
  }
}

async function assembleWindData(root: string, plan: BuildPlan, whole: WholeDomainPrepared, receipts: WholeDomainReceipt[], store?: ObjectStorage, signal?: AbortSignal, checkOnly = false) {
  if (!plan.numericWind) return;
  const prefix = `builds/${plan.model}/${plan.buildId}`, frames = receipts.flatMap(receipt => receipt.numeric?.frames ?? []);
  const rootBytes = encodeBoundedJson(windDataSchema.parse({ version: 1, model: plan.model, buildId: plan.buildId, frames }), WIND_ROOT_LIMIT);
  for (const receipt of receipts) {
    const numeric = receipt.numeric ?? { frames: [], objects: [] }, objects = new Map(numeric.objects.map(object => [object.key, object]));
    if (objects.size !== numeric.objects.length) throw new Error('Duplicate numeric wind receipt');
    const expected = new Map<string, { bytes: number; sha256: string }>();
    for (const frame of numeric.frames) {
      const key = `${prefix}/map-data/${frame.id}.json`, recorded = objects.get(key);
      if (!recorded) throw new Error('Numeric wind frame receipt missing');
      const bytes = store ? (await store.get(key, undefined, frame.bytes, signal, undefined, recorded.etag ? { ...recorded, etag: recorded.etag } : undefined))?.bytes : await readLocalFile(localPath(root, key), WIND_FRAME_LIMIT, frame.bytes);
      if (!bytes || bytes.length !== frame.bytes || sha256(bytes) !== frame.sha256) throw new Error('Numeric wind frame receipt digest mismatch');
      const descriptor = parseWindFrame(bytes);
      if (descriptor.frame !== frame.id) throw new Error('Numeric wind frame identity mismatch');
      assertWindFrameLayout(descriptor, whole.plan);
      expected.set(key, frame);
      for (const { kind, shards } of windFrameParts(descriptor)) {
        for (const [page, shard] of shards.entries()) {
          const base = `${prefix}/map-data/${frame.id}/${kind}-${page}`;
          expected.set(`${base}.idx`, { bytes: shard.count * 32, sha256: shard.indexSha256 });
          expected.set(`${base}.bin`, { bytes: shard.bytes, sha256: shard.sha256 });
        }
      }
    }
    if (objects.size !== expected.size || [...expected].some(([key, value]) => { const object = objects.get(key); return !object || object.bytes !== value.bytes || object.sha256 !== value.sha256 || (store && !object.etag); })) throw new Error('Numeric wind object receipt set mismatch');
    if (store) await verifyObjectReceipts(store, numeric.objects.map(object => ({ ...object, etag: object.etag! })), signal);
  }
  const key = `${prefix}/map-data.json`, reference = { bytes: rootBytes.length, sha256: sha256(rootBytes) };
  let rootReceipt: ObjectReceipt | undefined;
  if (checkOnly) {
    const localBytes = await readLocalFile(localPath(root, key), WIND_ROOT_LIMIT, reference.bytes).catch((error: NodeJS.ErrnoException) => {
      if (error?.code === 'ENOENT' && store) return null;
      throw error;
    });
    const bytes = localBytes ?? (await store!.get(key, undefined, reference.bytes, signal))?.bytes;
    if (!bytes || !Buffer.from(bytes).equals(rootBytes)) throw new Error('Numeric wind root differs from shard receipts');
    if (store) {
      const head = await store.head(key, signal);
      if (!head || head.size !== reference.bytes || !head.etag) throw new Error('Numeric wind root receipt missing in remote store');
      rootReceipt = { key, bytes: reference.bytes, sha256: reference.sha256, etag: head.etag };
    }
  } else {
    await mkdir(localPath(root, prefix), { recursive: true });
    await writeFile(localPath(root, key), rootBytes);
    if (store) rootReceipt = await putImmutableReceipt(store, key, rootBytes, 'application/json', signal, reference.sha256);
  }
  if (!store) {
    const manifest = { model: plan.model, buildId: plan.buildId, frames: frames.map(frame => ({ id: frame.id })), mapFrameCount: frames.length,
      surfaces: [{ kind: 'native', grid: whole.plan.native }, { kind: 'fine', grid: whole.plan.fine }] } as ManifestV5;
    await localWindData(root, manifest, signal);
  }
  const windReceipts: ObjectReceipt[] = store ? [...receipts.flatMap(receipt => (receipt.numeric?.objects ?? []).map(object => ({ ...object, etag: object.etag! }))), rootReceipt!] : [];
  return { reference, objects: windReceipts };
}

/** Repack hour packs into serving groups, then use the ordinary full-build validator/publisher. */
export async function finalizeBuild(options: ForecastInputs & { plan: BuildPlan; store?: ObjectStorage } & Pick<BuildOptions, 'out' | 'signal' | 'onValidated'>): Promise<string> {
  const deadline = forecastPlanDeadline(options.plan);
  const deadlineSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, deadlineSignal]) : deadlineSignal };
  const assemblyStartedAt = Date.now();
  const root = resolve(options.out);
  options.signal?.throwIfAborted();
  const admitted = await admitPlan(options.plan, options), { plan, prepared, identity } = admitted;
  options = { ...options, product: admitted.product };
  const entries = await readdir(localPath(root, 'shards'), { withFileTypes: true });
  const expected = plan.groups.map((_, i) => String(i));
  if (entries.some(entry => !entry.isDirectory()) || !same(entries.map(entry => entry.name).sort(), expected.sort())) throw new Error('Missing or extra forecast shard directories');
  const whole = prepared;
  if (options.store) await stagePlanTerrain(root, plan, whole, options.store, options.signal);
  const receipts: WholeDomainReceipt[] = [];
  for (let shard = 0; shard < plan.groups.length; shard++) {
    const bytes = await readLocalFile(localPath(root, `shards/${shard}/receipt.json`), MAX_PROVENANCE_BYTES);
    const receipt = parseForecastShardReceipt(bytes, plan, shard);
    assertWholeDomainReceipt(receipt, plan, shard, options.product, whole, options.provider.maxLevels);
    receipts.push(receipt);
  }
  const assembledWind = await assembleWindData(root, plan, prepared, receipts, options.store, options.signal);
  const mapData = assembledWind?.reference;
  const { capacity, layouts, profileLayout } = planWholeDomainCapacity(wholeDomainCapacityInput(options.product, options.provider, whole, plan.groups));
  if (capacity.violations.length) throw new Error(`Whole-domain build exceeds capacity: ${capacity.violations.join('; ')}`);
  const terrainData = await loadWholeDomainTerrain({ ref: whole.terrain, out: root, grid: whole.plan.fine,
    coverage: whole.fine.mask.coverage, coverageDescriptor: whole.fine.bytes, signal: options.signal, collect: false });
  const surfaces: WholeDomainSurfaceResult[] = [];
  const sampleGroups: Partial<Record<'native' | 'fine', Extract<ManifestV5['surfaces'][number]['samples'], { format: 'frame-group-block-shards-v1' }>['shards']>> = {};
  const servingObjects: ObjectReceipt[] = [];
  const scalarPhasesMs = { scalarStageMs: 0, scalarMergeMs: 0, scalarUploadMs: 0 };
  let profileGroups: NonNullable<ManifestV5['surfaces'][number]['profiles']>['groups'] | undefined;
  for (const id of ['native', 'fine'] as const) {
    const layout = id === 'native' ? layouts.native : layouts.fine, info = id === 'native' ? whole.native : whole.fine;
    const layers = id === 'native' ? whole.nativeSurfaceLayers : whole.fineSurfaceLayers;
    if (!layout || !layers.length) continue;
    const written = await writeServingGroups({ root, model: plan.model, buildId: plan.buildId, surfaceId: id,
      grid: id === 'native' ? whole.plan.native : whole.plan.fine, blockIds: info.mask.coverage.blockIds, layers: layers.length,
      parts: hourSampleParts(receipts, plan, options.product, id), store: options.store, signal: options.signal });
    sampleGroups[id] = written.shards;
    servingObjects.push(...written.objects);
    scalarPhasesMs.scalarStageMs += written.phasesMs.stageMs;
    scalarPhasesMs.scalarMergeMs += written.phasesMs.mergeMs;
    scalarPhasesMs.scalarUploadMs += written.phasesMs.uploadMs;
    const shards = written.shards;
    let profiles: WholeDomainSurfaceResult['profiles'];
    if (id === 'native' && profileLayout) {
      const recordBytes = profileLayout.recordBytes, groups: NonNullable<typeof profileGroups> = [];
      let profileFirstFrame = 0;
      for (const receipt of receipts) {
        const part = receipt.surfaces.find(surface => surface.id === 'native')?.profiles;
        if (!part) throw new Error('Forecast shard is missing native profiles');
        const frameCount = plan.groups[receipt.shard]!.length;
        groups.push({ firstFrame: profileFirstFrame, frameCount, shards: part.shards });
        profileFirstFrame += frameCount;
      }
      profileGroups = groups;
      profiles = { levelCount: options.provider.maxLevels, recordBytes, shards: groups.flatMap(group => group.shards),
        layout: profileLayout };
    }
    surfaces.push({ id, kind: id, grid: id === 'native' ? whole.plan.native : whole.plan.fine, gridHash: info.descriptor.gridHash,
      coverage: { id: info.descriptor.id, hash: info.hash, maskKey: `coverage/${info.hash}/manifest.json`, maxZoom: options.product.maxNativeZoom, gridHash: info.descriptor.gridHash },
      layers: [...layers], layout, shards, ...(profiles ? { profiles } : {}), ...(id === 'fine' ? { terrain: { dataId: terrainData.descriptor.dataId, verticalDatum: terrainData.descriptor.source.verticalDatum,
      surface: terrainData.descriptor.source.surface, ref: whole.terrain, layoutVersion: 1 as const } } : {}) });
  }
  const phasesMs = { acquireMs: 0, deriveMs: 0, packMs: 0, renderMs: 0 };
  for (const receipt of receipts) for (const key of Object.keys(phasesMs) as (keyof typeof phasesMs)[]) phasesMs[key] += receipt.metrics.phasesMs[key];
  const frames = plan.groups.flat().map(hour => forecastFrame(plan.cycle, hour, sourceIntervalHours(options.product, hour)));
  const result: FinishWholeDomainOptions['result'] = { cycle: plan.cycle, frames, artifacts: receipts.flatMap(receipt => receipt.artifacts),
    receipts: receipts.flatMap(receipt => receipt.provenance), surfaces, capacity,
    metrics: { phasesMs: { ...phasesMs, ...scalarPhasesMs }, renderer: { shards: receipts.map(receipt => receipt.metrics.renderer) },
      peakRssBytes: Math.max(plan.preparation!.peakRssBytes, process.resourceUsage().maxRSS * 1024, ...receipts.map(receipt => receipt.metrics.peakRssBytes)) } };
  const hourObjects = options.store ? receipts.flatMap(receipt => {
    if (!receipt.objects) throw new Error('Forecast shard lacks remote object receipts');
    return receipt.objects;
  }) : undefined;
  const hourSampleKeys = new Set(receipts.flatMap(receipt => receipt.surfaces.flatMap(surface => surface.shards.map(shard => shard.key))));
  const objects = hourObjects ? [...hourObjects.filter(object => !hourSampleKeys.has(object.key)), ...servingObjects, ...(assembledWind?.objects ?? [])] : undefined;
  options.signal?.throwIfAborted();
  if (objects) await writeReceipt(localPath(root, `builds/${plan.model}/${plan.buildId}/serving-receipts.json`), { version: 1, planHash: planHash(plan), objects: servingObjects });
  return finishWholeDomain({ ...options, prepared: whole, result, identity, buildId: plan.buildId, createdAt: plan.createdAt, preparation: plan.preparation, assemblyStartedAt, sampleGroups, profileGroups, mapData,
    ...(objects ? { remote: { store: options.store!, objects, signal: options.signal } } : {}) });
}

async function inputsFor(modelId: string): Promise<ForecastInputs> {
  const product = getProduct(modelId);
  if (!product) throw new Error(`No forecast product for ${modelId}`);
  return { product, provider: getForecastProvider(modelId), mask: await loadCoverage(product) };
}
export async function readBuildPlan(path: string): Promise<BuildPlan> {
  return planSchema.parse(parseBoundedJson(await readLocalFile(path, MAX_MANIFEST_BYTES)));
}
export async function createForecastPlan(modelId: string, options: PlanOptions): Promise<BuildPlan> {
  const inputs = await inputsFor(modelId);
  return createBuildPlan({ ...options, ...inputs });
}
export async function buildForecastShard(planPath: string, shard: number, options: Pick<BuildOptions, 'out' | 'cacheDir' | 'signal'> & { store?: ObjectStorage }): Promise<string> {
  const plan = await readBuildPlan(planPath);
  return buildShard({ ...options, ...await inputsFor(plan.model), plan, shard });
}
export async function finalizeForecastBuild(planPath: string, options: Pick<BuildOptions, 'out' | 'signal' | 'onValidated'> & { store?: ObjectStorage }): Promise<string> {
  const plan = await readBuildPlan(planPath);
  return finalizeBuild({ ...options, ...await inputsFor(plan.model), plan });
}

export async function verifyBuildReceipts(root: string, manifest: ManifestV5, store: ObjectStorage, signal?: AbortSignal, trustedInputs?: ForecastInputs, onNumericReceipts?: (receipts: ObjectReceipt[]) => void): Promise<ObjectReceipt[]> {
  const plan = await readBuildPlan(localPath(root, 'plan.json'));
  const inputs = trustedInputs ?? await inputsFor(plan.model), admitted = await admitPlan(plan, { ...inputs, out: root, signal }, true);
  if (manifest.model !== plan.model || manifest.buildId !== plan.buildId || manifest.cycle !== plan.cycle
      || manifest.createdAt !== plan.createdAt || !same(manifest.recipe, plan.recipe)) throw new Error('Manifest forecast plan identity mismatch');
  const whole = admitted.prepared;
  await stagePlanTerrain(root, plan, whole, store, signal);
  const receipts: WholeDomainReceipt[] = [];
  for (let shard = 0; shard < plan.groups.length; shard++) {
    const receipt = parseForecastShardReceipt(await readLocalFile(localPath(root, `shards/${shard}/receipt.json`), MAX_PROVENANCE_BYTES), plan, shard);
    assertWholeDomainReceipt(receipt, plan, shard, admitted.product, whole, inputs.provider.maxLevels);
    if (!receipt.objects) throw new Error('Forecast shard lacks remote object receipts');
    receipts.push(receipt);
  }
  const assembledWind = await assembleWindData(root, plan, whole, receipts, store, signal, true);
  const mapData = assembledWind?.reference;
  if (manifest.mapData && (!mapData || manifest.mapData.sha256 !== mapData.sha256 || manifest.mapData.bytes !== mapData.bytes)) throw new Error('Manifest numeric wind identity mismatch');
  if (plan.numericWind && assembledWind) onNumericReceipts?.(assembledWind.objects);
  const baseReceipts = await verifyPublicationReceipts({ root, manifest, store, plan, receipts, product: admitted.product, whole, signal });
  return [...baseReceipts, ...(assembledWind?.objects ?? [])];
}

export { type WholeDomainReceipt };
