import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import z from 'zod';
import { profileRecordBytes, prepareShardedSamplePackLayout, resolveProductFrameHours } from '@av/forecast';
import { assertSampleLayoutBindingV5, CELL_BYTES, coverageAtZoom, createWholeDomainDescriptors, encodeBoundedJson, getProduct, getProvenanceReference, provenanceFrameReferenceSchema, layerSurface, renderedLayers, mapFrameCount, sourceIntervalHours, MAX_FORECAST_SHARDS, MAX_MANIFEST_BYTES, MAX_MODEL_WORKERS, MAX_NATIVE_ZOOM, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, MAX_SAMPLE_VALUES, manifestSchema, parseBoundedJson, parseProvenance, SAMPLE_BLOCK_SIZE, TERRAIN_CLEARANCE_METHOD, type ForecastSurfaceV5, type ManifestV5 } from '@av/contracts';
import { MAX_REFINEMENT_ZONES } from '@av/contracts/refinement';
import { BUILD_BUDGETS, MAX_BUILD_LIFETIME_MS, MAX_V5_SHARD_BYTES, prepareBuild, type PreparedBuild } from './capacity.js';
import { createBuildStamp, finishForecast, type BuildOptions } from './build.js';
import { describeCoverage, loadCoverage, writeCoverage } from './coverage.js';
import { buildFrames, forecastFrame, matchesFrameIntervals, type ForecastInputs, type FrameBuildResult } from './frame-build.js';
import { buildIdentity } from './identity.js';
import { createLocalFileReader, readLocalFile } from './local-file.js';
import { getForecastProvider } from './providers.js';
import { mergeSamplePacks } from './sample-pack.js';
import { localPath, sha256, validateArchive, validateSampleGroup } from './validate.js';
import { failureReason } from './failure.js';
import { preparedTerrainRefSchema, type PreparedTerrainRef } from './terrain/prepare.js';
import { sparseTerrainRefSchema, validateSparsePreparedTerrain } from './terrain/sparse.js';
import { stagePreparedTerrain, stageSparsePreparedTerrain } from './terrain/staging.js';
import { loadRefinements, prepareRefinements, refinementInputSchema } from './refinement/prepare.js';
import type { ObjectStorage } from './storage.js';
import { admitWholeDomain, wholeDomainSampleGroupLayouts } from './whole-domain/capacity.js';
import { buildWholeDomainFrames, type WholeDomainSurfaceResult } from './whole-domain/frames.js';
import { finishWholeDomain, type FinishWholeDomainOptions } from './whole-domain/finish.js';
import { frozenWholeDomain, loadFrozenWholeDomain, loadWholeDomainTerrain, prepareWholeDomain, wholeDomainSurfaceLayers, type WholeDomainOptions, type WholeDomainPrepared } from './whole-domain/prepare.js';
import { readFrameProvenance } from './frame-provenance.js';
import { sampleShardKey } from './sample-pack-v5.js';
import { servingSampleShards, writeServingGroups, type HourSamplePart } from './serving-groups.js';
import { putImmutableReceipt, verifyObjectReceipts, type ObjectReceipt } from './immutable-upload.js';

export { MAX_FORECAST_SHARDS } from '@av/contracts';
const digestSchema = manifestSchema.shape.samples.shape.sha256;
const objectReceiptSchema = z.strictObject({ key: z.string().min(1), bytes: z.number().int().positive().max(BUILD_BUDGETS.samplePackBytes), sha256: digestSchema, etag: z.string().min(1) });
const timestampSchema = manifestSchema.shape.createdAt.refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const preparationSchema = z.strictObject({ elapsedMs: z.number().nonnegative().max(BUILD_BUDGETS.elapsedMs), peakRssBytes: z.number().nonnegative().max(BUILD_BUDGETS.peakRssBytes) });
const wholeDomainPlanSchema = z.strictObject({
  k: z.number().int().positive().max(64), nativeCoverageHash: digestSchema,
  fineCoverage: z.strictObject({ id: z.string().min(1).max(128), hash: digestSchema,
    maskKey: z.string().regex(/^coverage\/[a-f0-9]{64}\/manifest\.json$/), maxZoom: z.number().int().nonnegative(), gridHash: digestSchema }),
  terrain: sparseTerrainRefSchema
});
const planSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]), model: manifestSchema.shape.model,
  buildId: z.string().regex(/^\d{8}T\d{6}Z-[a-f0-9-]{36}$/),
  createdAt: timestampSchema, deadlineAt: timestampSchema.optional(), cycle: timestampSchema, coverageHash: digestSchema,
  providerId: z.string().min(1), terrain: preparedTerrainRefSchema.optional(),
  refinements: z.array(refinementInputSchema).min(1).max(MAX_REFINEMENT_ZONES).optional(),
  wholeDomain: wholeDomainPlanSchema.optional(),
  dependencies: z.array(objectReceiptSchema).min(1).optional(),
  preparation: preparationSchema.optional(),
  recipe: manifestSchema.shape.recipe.strict().extend({ source: manifestSchema.shape.recipe.shape.source.strict() }),
  execution: z.strictObject({ zoom: z.number().int().min(0).max(MAX_NATIVE_ZOOM), workers: z.number().int().min(0).max(MAX_MODEL_WORKERS) }).optional(),
  groups: z.array(z.array(z.number().int().positive()).min(1).max(MAX_SAMPLE_VALUES)).min(1).max(MAX_FORECAST_SHARDS)
}).superRefine((plan, ctx) => {
  if ((plan.version === 2) !== (plan.wholeDomain !== undefined)) ctx.addIssue({ code: 'custom', message: 'Only version 2 plans carry whole-domain inputs' });
  if ((plan.version === 2) !== (plan.preparation !== undefined)) ctx.addIssue({ code: 'custom', message: 'Only version 2 plans carry preparation metrics' });
  if (plan.deadlineAt !== undefined && Date.parse(plan.deadlineAt) !== Date.parse(plan.createdAt) + BUILD_BUDGETS.elapsedMs) ctx.addIssue({ code: 'custom', message: 'Invalid forecast plan deadline' });
});
export type BuildPlan = z.infer<typeof planSchema>;
interface PlanOptions {
  out: string; cycle: string; shards?: number; signal?: AbortSignal;
  store?: ObjectStorage;
  terrain?: { ref: PreparedTerrainRef; storage: Pick<ObjectStorage, 'get'> };
  refinement?: BuildOptions['refinement'];
  wholeDomain?: WholeDomainOptions;
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
const receiptSchema = z.strictObject({
  version: z.literal(1), planHash: digestSchema, shard: z.number().int().min(0).max(MAX_FORECAST_SHARDS - 1),
  sampleSha256: digestSchema, tileSha256: z.array(digestSchema).min(1).max(MAX_SAMPLE_VALUES),
  refinements: z.array(z.strictObject({ id: refinementInputSchema.shape.id, sampleSha256: digestSchema })).min(1).max(MAX_REFINEMENT_ZONES).optional(),
  provenance: z.array(z.strictObject({ hour: z.number().int().positive(), intervals: z.unknown(), receipt: z.unknown() })).min(1).max(MAX_SAMPLE_VALUES),
  metrics: metricsSchema
});
const sampleShardSchema = z.strictObject({ firstBlock: z.number().int().nonnegative(), blockCount: z.number().int().positive(), storedCells: z.number().int().positive(), bytes: z.number().int().positive(), key: z.string().min(1), sha256: digestSchema });
const wholeDomainReceiptSchema = z.strictObject({
  version: z.literal(2), planHash: digestSchema, shard: z.number().int().min(0).max(MAX_FORECAST_SHARDS - 1),
  artifacts: z.array(manifestSchema.shape.artifacts.element).max(MAX_SAMPLE_VALUES),
  provenance: z.array(provenanceFrameReferenceSchema).min(1).max(MAX_SAMPLE_VALUES),
  surfaces: z.array(z.strictObject({ id: z.enum(['native', 'fine']), channelCount: z.number().int().positive(), shards: z.array(sampleShardSchema).min(1),
    profiles: z.strictObject({ levelCount: z.number().int().positive().max(256), recordBytes: z.number().int().positive(), shards: z.array(sampleShardSchema).min(1) }).optional() })).min(1).max(2),
  objects: z.array(objectReceiptSchema).min(1).optional(),
  metrics: metricsSchema
});
type WholeDomainReceipt = z.infer<typeof wholeDomainReceiptSchema>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const planHash = (plan: BuildPlan) => sha256(encodeBoundedJson(plan, MAX_MANIFEST_BYTES));
function assertReceiptFrames(receipt: Pick<z.infer<typeof receiptSchema>, 'provenance' | 'metrics'>, plan: BuildPlan, shard: number, product: ForecastInputs['product']) {
  const hours = plan.groups[shard]!, frames = hours.map(hour => forecastFrame(plan.cycle, hour, sourceIntervalHours(product, hour)));
  if (receipt.provenance.length !== hours.length || receipt.provenance.some((entry, index) => entry.hour !== hours[index] || !matchesFrameIntervals(entry.intervals, frames[index]!, product.layers.includes('precip-rate')))) throw new Error('Forecast shard provenance interval mismatch');
  if (!same(Object.keys(receipt.metrics.frames), frames.map(frame => frame.id))) throw new Error('Forecast shard metric frames mismatch');
  return frames;
}
function assertWholeDomainReceipt(receipt: WholeDomainReceipt, plan: BuildPlan, shard: number, product: ForecastInputs['product'], whole: WholeDomainPrepared, maxLevels: number) {
  if (receipt.planHash !== planHash(plan) || receipt.shard !== shard) throw new Error('Forecast shard receipt identity mismatch');
  const hours = plan.groups[shard]!, frames = hours.map(hour => forecastFrame(plan.cycle, hour, sourceIntervalHours(product, hour))), layers = wholeDomainSurfaceLayers(product);
  if (receipt.provenance.length !== frames.length || receipt.provenance.some((entry, index) => entry.hour !== hours[index] || entry.frame !== frames[index]!.id
    || entry.key !== `builds/${plan.model}/${plan.buildId}/provenance/${entry.frame}.json`)) throw new Error('Forecast shard provenance frame mismatch');
  if (!same(Object.keys(receipt.metrics.frames), frames.map(frame => frame.id))) throw new Error('Forecast shard metric frames mismatch');
  const prefix = `builds/${plan.model}/${plan.buildId}`;
  const mapped = mapFrameCount({ ...product, frameHours: plan.groups[shard]! });
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
    if (surface.shards.some((item, index) => item.key !== sampleShardKey(plan.model, plan.buildId, id, index, shard, 'samples', 'hour'))) throw new Error('Forecast shard surface key mismatch');
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


function partition(hours: readonly number[], count: number): number[][] {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_FORECAST_SHARDS) throw new Error('Invalid forecast shard count');
  const n = Math.min(count, hours.length);
  return Array.from({ length: n }, (_, i) => hours.slice(Math.ceil(i * hours.length / n), Math.ceil((i + 1) * hours.length / n)));
}

/** Freeze the resolved cycle and complete-product admission. No provider data is acquired here. */
export async function createBuildPlan(options: PlanOptions & ForecastInputs): Promise<BuildPlan> {
  options.signal?.throwIfAborted();
  const stamp = createBuildStamp();
  const deadlineAt = new Date(Date.parse(stamp.createdAt) + BUILD_BUDGETS.elapsedMs).toISOString();
  const deadlineSignal = AbortSignal.timeout(Math.max(1, Date.parse(deadlineAt) - Date.now()));
  options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, deadlineSignal]) : deadlineSignal };
  const { product, provider, mask } = options, root = resolve(options.out);
  if (typeof options.cycle !== 'string' || !Number.isFinite(Date.parse(options.cycle))) throw new Error('A resolved forecast cycle is required');
  const groups = partition(resolveProductFrameHours(product, mask, options.cycle), options.shards ?? product.execution.shards);
  const execution = { zoom: product.maxNativeZoom, workers: product.execution.workers };
  if (product.terrainSubdivisionFactor !== undefined) {
    const prepared = await prepareWholeDomain({ product, mask, out: root, maxLevels: provider.maxLevels, wholeDomain: options.wholeDomain, signal: options.signal });
    const capacity = admitWholeDomain({ product, plan: prepared.plan, nativeBlocks: prepared.native.mask.coverage.blockIds,
      nativeActive: prepared.acquisitionActive.length, nativeMask: prepared.native.mask, fine: prepared.fine.mask,
      maxLevels: provider.maxLevels, retainedGeometryFields: provider.retainedGeometryFields ?? 0,
      auxiliarySurfaceFields: provider.auxiliarySurfaceFields ?? 0, auxiliaryLevelFields: provider.auxiliaryLevelFields ?? 0,
      nativeMaskBytes: prepared.nativeMask.output.byteLength + prepared.nativeMask.halo.byteLength + prepared.nativeMask.tiles.byteLength,
      frames: groups.flat().length, mapFrames: mapFrameCount({ ...product, frameHours: groups.flat() }), groupFrames: Math.max(...groups.map(group => group.length)), nativeLayers: prepared.nativeSurfaceLayers.length, fineLayers: prepared.fineSurfaceLayers.length,
      columns: prepared.columns, terrainBytes: prepared.terrain.arrayBytes });
    if (capacity.violations.length) throw new Error(`Whole-domain build exceeds capacity: ${capacity.violations.join('; ')}`);
    const frozen = frozenWholeDomain(prepared);
    const identity = await buildIdentity(product, prepared.native.hash, undefined, [], undefined,
      { k: prepared.plan.k, nativeCoverageHash: prepared.native.hash, fineCoverageHash: prepared.fine.hash, fineGridHash: prepared.fine.descriptor.gridHash, terrain: prepared.terrain });
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
      coverageHash: prepared.native.hash, providerId: provider.id, recipe: identity.recipe, execution, groups, wholeDomain: frozen, preparation, ...(dependencies.length ? { dependencies } : {}) });
    options.signal?.throwIfAborted();
    await writeFile(localPath(root, 'plan.json'), encodeBoundedJson(plan, MAX_MANIFEST_BYTES), { flag: 'wx' });
    return plan;
  }
  const terrain = options.terrain ? preparedTerrainRefSchema.parse(options.terrain.ref) : undefined;
  prepareBuild(mask, product, { ...provider, terrainBytes: terrain?.arrayBytes });
  const coverageHash = await writeCoverage(root, mask, product);
  if (terrain) await stagePreparedTerrain({ ref: terrain, storage: options.terrain!.storage, out: root, grid: product.grid, signal: options.signal });
  const refinements = options.refinement
    ? await prepareRefinements({ ...options.refinement, product, mask, out: root, signal: options.signal }) : [];
  if (refinements.length) {
    const loaded = await loadRefinements({ inputs: refinements, out: root, baseMask: mask, signal: options.signal });
    prepareBuild(mask, product, { ...provider, terrainBytes: terrain?.arrayBytes, refinements: loaded });
  }
  const identity = await buildIdentity(product, coverageHash, terrain, refinements);
  const plan = planSchema.parse({ version: 1, model: product.modelId, ...stamp, deadlineAt, cycle: new Date(options.cycle).toISOString(), coverageHash, providerId: provider.id, recipe: identity.recipe, execution, groups,
    ...(terrain ? { terrain } : {}), ...(refinements.length ? { refinements } : {}) });
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
  if (plan.execution) product = { ...product, maxNativeZoom: plan.execution.zoom,
    execution: { ...product.execution, workers: plan.execution.workers } };
  if (plan.model !== product.modelId || plan.providerId !== provider.id
      || !plan.buildId.startsWith(plan.createdAt.replace(/[-:]/g, '').slice(0, 15) + 'Z-')
      || !same(plan.groups, partition(resolveProductFrameHours(product, mask, plan.cycle), plan.groups.length))) {
    throw new Error('Invalid forecast plan identity or frame groups');
  }
  const age = Date.now() - Date.parse(plan.createdAt);
  if (age < -60_000 || (!resume && age > MAX_BUILD_LIFETIME_MS)) throw new Error('Forecast plan exceeds publisher lifetime');
  if (!resume && age > BUILD_BUDGETS.elapsedMs) throw new Error('Forecast plan exceeds elapsed-time budget; start a new build');
  if (plan.wholeDomain) {
    if (!product.terrainSubdivisionFactor) throw new Error('Frozen plan requires a configured whole-domain product');
    const prepared = await loadFrozenWholeDomain({ product, frozen: plan.wholeDomain, out: resolve(inputs.out), maxLevels: provider.maxLevels, signal: inputs.signal });
    if (plan.coverageHash !== prepared.native.hash) throw new Error('Forecast plan coverage changed');
    const identity = await buildIdentity(product, plan.coverageHash, undefined, [], undefined,
      { k: prepared.plan.k, nativeCoverageHash: prepared.native.hash, fineCoverageHash: prepared.fine.hash, fineGridHash: prepared.fine.descriptor.gridHash, terrain: prepared.terrain });
    if (!same(plan.recipe, identity.recipe)) throw new Error('Forecast plan recipe or source revision changed');
    return { plan, prepared, identity, product };
  }
  if (plan.coverageHash !== describeCoverage(mask, product).hash) throw new Error('Forecast plan coverage changed');
  const identity = await buildIdentity(product, plan.coverageHash, plan.terrain, plan.refinements);
  if (!same(plan.recipe, identity.recipe)) throw new Error('Forecast plan recipe or source revision changed');
  const refinements = plan.refinements ? await loadRefinements({ inputs: plan.refinements, out: resolve(inputs.out), baseMask: mask, signal: inputs.signal }) : [];
  const prepared = prepareBuild(mask, product, { ...provider, terrainBytes: plan.terrain?.arrayBytes, refinements });
  return { plan, prepared, identity, product };
}

/** One job owns one group; completion is recorded only after its pack and archives finish. */
export async function buildShard(options: ForecastInputs & { plan: BuildPlan; shard: number; out: string; cacheDir?: string; signal?: AbortSignal; store?: ObjectStorage }): Promise<string> {
  const deadline = options.plan.deadlineAt ?? new Date(Date.parse(options.plan.createdAt) + BUILD_BUDGETS.elapsedMs).toISOString();
  const deadlineSignal = AbortSignal.timeout(Math.max(1, Date.parse(deadline) - Date.now()));
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
    if (plan.wholeDomain) {
      const whole = prepared as WholeDomainPrepared;
      if (options.store) await stagePlanTerrain(root, plan, whole, options.store, options.signal);
      const result = await buildWholeDomainFrames({ ...options, prepared: whole, buildId: plan.buildId, createdAt: plan.createdAt, cycle: plan.cycle,
        hours: plan.groups[shard], journalPrefix: prefix, sampleGroup: shard });
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
      const receipt: WholeDomainReceipt = wholeDomainReceiptSchema.parse({ version: 2, planHash: planHash(plan), shard,
        artifacts: result.artifacts, provenance: result.receipts,
        surfaces: result.surfaces.map(surface => ({ id: surface.id, channelCount: surface.layout.channelCount,
          shards: surface.shards!.map(item => ({ ...item, key: item.key })),
          ...(surface.profiles ? { profiles: { levelCount: surface.profiles.levelCount, recordBytes: surface.profiles.recordBytes, shards: surface.profiles.shards } } : {}) })), metrics: withProcessPeakRss(result.metrics), ...(objects.length ? { objects } : {}) });
      options.signal?.throwIfAborted();
      const path = localPath(root, `${prefix}/receipt.json`);
      await writeFile(path + '.tmp', encodeBoundedJson(receipt, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS), { flag: 'wx' });
      await rename(path + '.tmp', path);
      return path;
    }
    const result = await buildFrames({ ...options, terrain: plan.terrain, prepared: prepared as PreparedBuild, buildId: plan.buildId, createdAt: plan.createdAt, cycle: plan.cycle,
      hours: plan.groups[shard], samplesKey: `${prefix}/samples.bin`, journalPrefix: prefix, refinementPrefix: `${prefix}/refinements` });
    const receipt = receiptSchema.parse({ version: 1, planHash: planHash(plan), shard,
      sampleSha256: result.samples.sha256, tileSha256: result.artifacts.map(artifact => artifact.tilesSha256),
      provenance: result.receipts, metrics: withProcessPeakRss(result.metrics),
      ...(result.refinements?.length ? { refinements: result.refinements.map(({ id, samples }) => ({ id, sampleSha256: samples.sha256 })) } : {}) });
    options.signal?.throwIfAborted();
    const path = localPath(root, `${prefix}/receipt.json`);
    await writeFile(path + '.tmp', encodeBoundedJson(receipt, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS), { flag: 'wx' });
    await rename(path + '.tmp', path);
    return path;
  } catch (error) {
    await writeFile(localPath(root, `${prefix}/worker-failure.json`), JSON.stringify({ buildId: plan.buildId, shard, cancelled: options.signal?.aborted ?? false, error: failureReason(error) }));
    throw error;
  }
}

function readResult(raw: unknown, plan: BuildPlan, shard: number, options: ForecastInputs, prepared: PreparedBuild): FrameBuildResult {
  const receipt = receiptSchema.parse(raw), hours = plan.groups[shard], layers = options.product.layers;
  if (receipt.planHash !== planHash(plan) || receipt.shard !== shard) throw new Error('Forecast shard receipt identity mismatch');
  const frames = assertReceiptFrames(receipt, plan, shard, options.product), channelCount = hours.length * layers.length;
  if (receipt.tileSha256.length !== channelCount) throw new Error('Forecast shard artifact count mismatch');
  if (!same(receipt.refinements?.map(({ id }) => id) ?? [], plan.refinements?.map(({ id }) => id) ?? [])) throw new Error('Forecast shard refinement set mismatch');
  const artifacts = frames.flatMap((frame, i) => layers.map((layer, j) => ({ layer, frame: frame.id, tilesKey: `builds/${plan.model}/${plan.buildId}/${layer}/${frame.id}.pmtiles`, tilesSha256: receipt.tileSha256[i * layers.length + j] })));
  const fineChannels = hours.length * TERRAIN_CLEARANCE_METHOD.outputs.length;
  const refinements = prepared.refinements.map(({ input, layout }, index) => ({ id: input.id, samples: { key: `shards/${shard}/refinements/${input.id}/samples.bin`, channelCount: fineChannels,
    bytes: layout.storedCells * fineChannels * CELL_BYTES, sha256: receipt.refinements![index].sampleSha256 } }));
  return { cycle: plan.cycle, frames, artifacts, receipts: receipt.provenance, metrics: receipt.metrics,
    samples: { key: `shards/${shard}/samples.bin`, channelCount, bytes: prepared.layout.storedCells * channelCount * CELL_BYTES, sha256: receipt.sampleSha256 },
    ...(refinements.length ? { refinements } : {}) };
}

function hourSampleParts(receipts: readonly WholeDomainReceipt[], plan: BuildPlan, product: ForecastInputs['product'], id: 'native' | 'fine'): HourSamplePart[] {
  const parts: HourSamplePart[] = [];
  let firstFrame = 0;
  for (const receipt of receipts) {
    const frameCount = id === 'native' ? plan.groups[receipt.shard]!.length : mapFrameCount({ ...product, frameHours: plan.groups[receipt.shard]! });
    if (!frameCount) continue;
    const surface = receipt.surfaces.find(item => item.id === id);
    if (!surface) throw new Error(`Forecast shard is missing ${id} samples`);
    parts.push({ firstFrame, frameCount, shards: surface.shards });
    firstFrame += frameCount;
  }
  return parts;
}

/** Repack hour packs into serving groups, then use the ordinary full-build validator/publisher. */
export async function finalizeBuild(options: ForecastInputs & { plan: BuildPlan; store?: ObjectStorage } & Pick<BuildOptions, 'out' | 'signal' | 'onValidated'>): Promise<string> {
  const deadline = options.plan.deadlineAt ?? new Date(Date.parse(options.plan.createdAt) + BUILD_BUDGETS.elapsedMs).toISOString();
  const deadlineSignal = AbortSignal.timeout(Math.max(1, Date.parse(deadline) - Date.now()));
  options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, deadlineSignal]) : deadlineSignal };
  const assemblyStartedAt = Date.now();
  const root = resolve(options.out);
  options.signal?.throwIfAborted();
  const admitted = await admitPlan(options.plan, options), { plan, prepared, identity } = admitted;
  options = { ...options, product: admitted.product };
  const entries = await readdir(localPath(root, 'shards'), { withFileTypes: true });
  const expected = plan.groups.map((_, i) => String(i));
  if (entries.some(entry => !entry.isDirectory()) || !same(entries.map(entry => entry.name).sort(), expected.sort())) throw new Error('Missing or extra forecast shard directories');
  if (plan.wholeDomain) {
    const whole = prepared as WholeDomainPrepared, totalFrames = plan.groups.flat().length;
    if (options.store) await stagePlanTerrain(root, plan, whole, options.store, options.signal);
    const receipts: WholeDomainReceipt[] = [];
    for (let shard = 0; shard < plan.groups.length; shard++) {
      const bytes = await readLocalFile(localPath(root, `shards/${shard}/receipt.json`), MAX_PROVENANCE_BYTES);
      const receipt = wholeDomainReceiptSchema.parse(parseBoundedJson(bytes, MAX_PROVENANCE_JSON_TOKENS));
      assertWholeDomainReceipt(receipt, plan, shard, options.product, whole, options.provider.maxLevels);
      receipts.push(receipt);
    }
    const capacity = admitWholeDomain({ product: options.product, plan: whole.plan, nativeBlocks: whole.native.mask.coverage.blockIds,
      nativeActive: whole.acquisitionActive.length, nativeMask: whole.native.mask, fine: whole.fine.mask, maxLevels: options.provider.maxLevels, retainedGeometryFields: options.provider.retainedGeometryFields ?? 0,
      auxiliarySurfaceFields: options.provider.auxiliarySurfaceFields ?? 0, auxiliaryLevelFields: options.provider.auxiliaryLevelFields ?? 0,
      nativeMaskBytes: whole.nativeMask.output.byteLength + whole.nativeMask.halo.byteLength + whole.nativeMask.tiles.byteLength,
      frames: totalFrames, mapFrames: mapFrameCount({ ...options.product, frameHours: plan.groups.flat() }), groupFrames: Math.max(...plan.groups.map(group => group.length)), nativeLayers: whole.nativeSurfaceLayers.length, fineLayers: whole.fineSurfaceLayers.length,
      columns: whole.columns, terrainBytes: whole.terrain.arrayBytes });
    if (capacity.violations.length) throw new Error(`Whole-domain build exceeds capacity: ${capacity.violations.join('; ')}`);
    const layouts = wholeDomainSampleGroupLayouts({ product: options.product, plan: whole.plan, nativeBlocks: whole.native.mask.coverage.blockIds,
      nativeActive: whole.acquisitionActive.length, fine: whole.fine.mask, nativeMaskBytes: 0, frames: totalFrames, mapFrames: mapFrameCount({ ...options.product, frameHours: plan.groups.flat() }), groupFrames: Math.max(...plan.groups.map(group => group.length)), maxLevels: options.provider.maxLevels, retainedGeometryFields: options.provider.retainedGeometryFields ?? 0,
      auxiliarySurfaceFields: options.provider.auxiliarySurfaceFields ?? 0, auxiliaryLevelFields: options.provider.auxiliaryLevelFields ?? 0,
      nativeLayers: whole.nativeSurfaceLayers.length, fineLayers: whole.fineSurfaceLayers.length, columns: whole.columns, terrainBytes: whole.terrain.arrayBytes });
    const terrainData = await loadWholeDomainTerrain({ ref: whole.terrain, out: root, grid: whole.plan.fine,
      coverage: whole.fine.mask.coverage, coverageDescriptor: whole.fine.bytes, signal: options.signal, collect: false });
    const surfaces: WholeDomainSurfaceResult[] = [];
    const sampleGroups: Partial<Record<'native' | 'fine', Extract<ManifestV5['surfaces'][number]['samples'], { format: 'frame-group-block-shards-v1' }>['shards']>> = {};
    const servingObjects: ObjectReceipt[] = [];
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
      const shards = written.shards;
      let profiles: WholeDomainSurfaceResult['profiles'];
      if (id === 'native' && renderedLayers(options.product.layers).length !== options.product.layers.length) {
        const recordBytes = profileRecordBytes(options.provider.maxLevels), groups: NonNullable<typeof profileGroups> = [];
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
          layout: prepareShardedSamplePackLayout(whole.plan.native, whole.native.mask.coverage.blockIds,
            Math.max(...plan.groups.map(group => group.length)), MAX_V5_SHARD_BYTES, recordBytes) };
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
      metrics: { phasesMs, renderer: { shards: receipts.map(receipt => receipt.metrics.renderer) },
        peakRssBytes: Math.max(plan.preparation!.peakRssBytes, process.resourceUsage().maxRSS * 1024, ...receipts.map(receipt => receipt.metrics.peakRssBytes)) } };
    const hourObjects = options.store ? receipts.flatMap(receipt => {
      if (!receipt.objects) throw new Error('Forecast shard lacks remote object receipts');
      return receipt.objects;
    }) : undefined;
    const hourSampleKeys = new Set(receipts.flatMap(receipt => receipt.surfaces.flatMap(surface => surface.shards.map(shard => shard.key))));
    const objects = hourObjects ? [...hourObjects.filter(object => !hourSampleKeys.has(object.key)), ...servingObjects] : undefined;
    return finishWholeDomain({ ...options, prepared: whole, result, identity, buildId: plan.buildId, createdAt: plan.createdAt, preparation: plan.preparation, assemblyStartedAt, sampleGroups, profileGroups,
      ...(objects ? { remote: { store: options.store!, objects, signal: options.signal } } : {}) });
  }
  const results: FrameBuildResult[] = [];
  for (let shard = 0; shard < plan.groups.length; shard++) {
    options.signal?.throwIfAborted();
    const bytes = await readLocalFile(localPath(root, `shards/${shard}/receipt.json`), MAX_PROVENANCE_BYTES);
    results.push(readResult(parseBoundedJson(bytes, MAX_PROVENANCE_JSON_TOKENS), plan, shard, options, prepared as PreparedBuild));
  }
  const packStarted = Date.now(), samplesKey = `builds/${plan.model}/${plan.buildId}/samples.bin`;
  const legacy = prepared as PreparedBuild;
  const packed = await mergeSamplePacks(legacy.layout, results.map(result => ({ path: localPath(root, result.samples.key), channelCount: result.samples.channelCount, sha256: result.samples.sha256 })), localPath(root, samplesKey), BUILD_BUDGETS.samplePackBytes, options.signal);
  const refinements: NonNullable<FrameBuildResult['refinements']> = [];
  for (const [index, { input, layout }] of legacy.refinements.entries()) {
    const key = `builds/${plan.model}/${plan.buildId}/refinements/${input.id}/samples.bin`;
    const packs = results.map(result => result.refinements![index].samples);
    const merged = await mergeSamplePacks(layout, packs.map(pack => ({ path: localPath(root, pack.key), channelCount: pack.channelCount, sha256: pack.sha256 })), localPath(root, key), BUILD_BUDGETS.samplePackBytes, options.signal);
    refinements.push({ id: input.id, samples: { ...merged, key, channelCount: plan.groups.flat().length * TERRAIN_CLEARANCE_METHOD.outputs.length } });
  }
  const phasesMs = { acquireMs: 0, deriveMs: 0, packMs: Date.now() - packStarted, renderMs: 0 };
  for (const result of results) for (const key of Object.keys(phasesMs) as (keyof typeof phasesMs)[]) phasesMs[key] += result.metrics.phasesMs[key];
  const totalWorkerElapsedMs = results.reduce((sum, result) => sum + result.metrics.elapsedMs, 0);
  const merged: FrameBuildResult = {
    cycle: plan.cycle, frames: results.flatMap(result => result.frames), artifacts: results.flatMap(result => result.artifacts), receipts: results.flatMap(result => result.receipts),
    samples: { ...packed, key: samplesKey, channelCount: plan.groups.flat().length * options.product.layers.length },
    ...(refinements.length ? { refinements } : {}),
    metrics: {
      frames: Object.assign({}, ...results.map(result => result.metrics.frames)), phasesMs,
      renderer: { shards: results.map(result => result.metrics.renderer) }, acquisition: { shards: results.map(result => result.metrics.acquisition) },
      elapsedMs: Date.now() - Date.parse(plan.createdAt), peakRssBytes: Math.max(...results.map(result => result.metrics.peakRssBytes))
    }
  };
  options.signal?.throwIfAborted();
  return finishForecast({ ...options, terrain: plan.terrain, prepared: legacy, buildId: plan.buildId, createdAt: plan.createdAt, coverageHash: plan.coverageHash, identity, result: merged, execution: {
    mode: 'parallel', shardCount: plan.groups.length, totalWorkerElapsedMs,
    workers: results.map((result, shard) => ({ shard, hours: plan.groups[shard], elapsedMs: result.metrics.elapsedMs, peakRssBytes: result.metrics.peakRssBytes }))
  } });
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

export async function verifyBuildReceipts(root: string, manifest: ManifestV5, store: ObjectStorage, signal?: AbortSignal, trustedInputs?: ForecastInputs): Promise<ObjectReceipt[]> {
  const plan = await readBuildPlan(localPath(root, 'plan.json'));
  const inputs = trustedInputs ?? await inputsFor(plan.model), admitted = await admitPlan(plan, { ...inputs, out: root, signal }, true);
  if (!plan.wholeDomain || manifest.model !== plan.model || manifest.buildId !== plan.buildId || manifest.cycle !== plan.cycle
      || manifest.createdAt !== plan.createdAt || !same(manifest.recipe, plan.recipe)) throw new Error('Manifest forecast plan identity mismatch');
  const whole = admitted.prepared as WholeDomainPrepared;
  await stagePlanTerrain(root, plan, whole, store, signal);
  const receipts: WholeDomainReceipt[] = [];
  for (let shard = 0; shard < plan.groups.length; shard++) {
    const receipt = wholeDomainReceiptSchema.parse(parseBoundedJson(await readLocalFile(localPath(root, `shards/${shard}/receipt.json`), MAX_PROVENANCE_BYTES), MAX_PROVENANCE_JSON_TOKENS));
    assertWholeDomainReceipt(receipt, plan, shard, admitted.product, whole, inputs.provider.maxLevels);
    if (!receipt.objects) throw new Error('Forecast shard lacks remote object receipts');
    receipts.push(receipt);
  }
  if (!same(manifest.frames, plan.groups.flat().map(hour => forecastFrame(plan.cycle, hour, sourceIntervalHours(admitted.product, hour))))
      || !same(manifest.artifacts, receipts.flatMap(receipt => receipt.artifacts))) throw new Error('Manifest forecast receipt mismatch');
  const provenance = getProvenanceReference(manifest), provenanceBytes = await readLocalFile(localPath(root, provenance.key), MAX_PROVENANCE_BYTES);
  if (sha256(provenanceBytes) !== provenance.sha256 || !same(parseProvenance(parseBoundedJson(provenanceBytes, MAX_PROVENANCE_JSON_TOKENS), manifest).frames, receipts.flatMap(receipt => receipt.provenance))) throw new Error('Manifest provenance receipt mismatch');
  if (!same(manifest.surfaces.map(surface => surface.id), receipts[0].surfaces.map(surface => surface.id))
      || manifest.surfaces.some(surface => surface.coverage.maxZoom !== admitted.product.maxNativeZoom)) throw new Error('Manifest surface receipt mismatch');
  for (const surface of manifest.surfaces) {
    if (surface.samples.format !== 'frame-group-block-shards-v1') throw new Error('Receipt build requires grouped samples');
    const info = surface.kind === 'native' ? whole.native : whole.fine;
    const expected = servingSampleShards({ model: plan.model, buildId: plan.buildId, surfaceId: surface.id,
      grid: surface.kind === 'native' ? whole.plan.native : whole.plan.fine, blockIds: info.mask.coverage.blockIds, layers: surface.layers.length,
      parts: hourSampleParts(receipts, plan, admitted.product, surface.kind) });
    if (surface.samples.shards.length !== expected.length || surface.samples.shards.some((shard, index) => {
      const item = expected[index]!;
      return shard.group !== item.group || shard.firstFrame !== item.firstFrame || shard.frameCount !== item.frameCount
        || shard.blockShard !== item.blockShard || shard.firstBlock !== item.firstBlock || shard.blockCount !== item.blockCount
        || shard.storedCells !== item.storedCells || shard.bytes !== item.bytes || shard.key !== item.key;
    })) throw new Error('Manifest sample receipt mismatch');
    const profileBasis = receipts[0]!.surfaces.find(part => part.id === surface.id)?.profiles;
    if (!!surface.profiles !== !!profileBasis) throw new Error('Manifest profile receipt mismatch');
    if (surface.profiles && profileBasis) {
      let firstFrame = 0;
      const expectedProfiles = receipts.map(receipt => {
        const part = receipt.surfaces.find(item => item.id === surface.id)?.profiles;
        if (!part || part.levelCount !== profileBasis.levelCount || part.recordBytes !== profileBasis.recordBytes) throw new Error('Missing or inconsistent receipt profiles');
        const frameCount = plan.groups[receipt.shard]!.length;
        const group = { firstFrame, frameCount, shards: part.shards };
        firstFrame += frameCount;
        return group;
      });
      if (surface.profiles.levelCount !== profileBasis.levelCount || surface.profiles.recordBytes !== profileBasis.recordBytes
        || !same(surface.profiles.groups, expectedProfiles)) throw new Error('Manifest profile receipt mismatch');
    }
  }
  const objects = receipts.flatMap(receipt => receipt.objects!);
  const hourSamples = receipts.flatMap(receipt => receipt.surfaces.flatMap(surface => surface.shards.map(shard => ({ key: shard.key, sha256: shard.sha256, bytes: shard.bytes }))));
  const hourExpected = [...hourSamples,
    ...manifest.surfaces.flatMap(surface => (surface.profiles?.groups.flatMap(group => group.shards) ?? []).map(shard => ({ key: shard.key, sha256: shard.sha256, bytes: shard.bytes }))),
    ...manifest.artifacts.map(artifact => ({ key: artifact.tilesKey, sha256: artifact.tilesSha256 })),
    ...receipts.flatMap(receipt => receipt.provenance.map(item => ({ key: item.key, sha256: item.sha256, bytes: item.bytes })))];
  const byKey = new Map(objects.map(object => [object.key, object]));
  if (byKey.size !== objects.length || byKey.size !== hourExpected.length || hourExpected.some(item => {
    const object = byKey.get(item.key);
    return !object || object.sha256 !== item.sha256 || ('bytes' in item && object.bytes !== item.bytes);
  })) throw new Error('Forecast object receipt set mismatch');
  // Source receipt identities remain bound to the plan; only advertised data survives compaction cleanup.
  const hourSampleKeys = new Set(hourSamples.map(item => item.key));
  const published: ObjectReceipt[] = [];
  for (const surface of manifest.surfaces) for (const shard of surface.samples.shards) {
    const head = await store.head(shard.key, signal);
    if (!head || head.size !== shard.bytes || !head.etag || head.metadata?.sha256 !== shard.sha256) throw new Error(`Remote object receipt mismatch: ${shard.key}`);
    published.push({ key: shard.key, bytes: shard.bytes, sha256: shard.sha256, etag: head.etag });
  }
  for (const item of hourExpected) {
    if (hourSampleKeys.has(item.key)) continue;
    const object = byKey.get(item.key);
    if (!object) throw new Error('Forecast object receipt set mismatch');
    published.push(object);
  }
  await verifyObjectReceipts(store, published, signal);
  return published;
}

export { type WholeDomainReceipt };
