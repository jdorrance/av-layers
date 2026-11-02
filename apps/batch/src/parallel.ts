import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import z from 'zod';
import { CELL_BYTES, encodeBoundedJson, getProduct, MAX_MANIFEST_BYTES, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, MAX_SAMPLE_VALUES, manifestSchema, parseBoundedJson } from '@av/contracts';
import { BUILD_BUDGETS, MAX_BUILD_LIFETIME_MS, prepareBuild } from './capacity.js';
import { createBuildStamp, finishForecast, type BuildOptions } from './build.js';
import { describeCoverage, loadCoverage, writeCoverage } from './coverage.js';
import { buildFrames, forecastFrame, matchesFrameIntervals, type ForecastInputs, type FrameBuildResult } from './frame-build.js';
import { buildIdentity } from './identity.js';
import { readLocalFile } from './local-file.js';
import { getForecastProvider } from './providers.js';
import { mergeSamplePacks } from './sample-pack.js';
import { localPath, sha256 } from './validate.js';
import { failureReason } from './failure.js';

export const MAX_FORECAST_SHARDS = 4;
const digestSchema = manifestSchema.shape.samples.shape.sha256;
const timestampSchema = manifestSchema.shape.createdAt.refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const planSchema = z.strictObject({
  version: z.literal(1), model: manifestSchema.shape.model,
  buildId: z.string().regex(/^\d{8}T\d{6}Z-[a-f0-9-]{36}$/),
  createdAt: timestampSchema, cycle: timestampSchema, coverageHash: digestSchema,
  providerId: z.string().min(1),
  recipe: manifestSchema.shape.recipe.strict().extend({ source: manifestSchema.shape.recipe.shape.source.strict() }),
  groups: z.array(z.array(z.number().int().positive()).min(1).max(MAX_SAMPLE_VALUES)).min(1).max(MAX_FORECAST_SHARDS)
});
export type BuildPlan = z.infer<typeof planSchema>;
interface PlanOptions { out: string; cycle: string; shards?: number; signal?: AbortSignal }
const nonnegativeNumber = z.number().nonnegative();
const receiptSchema = z.strictObject({
  version: z.literal(1), planHash: digestSchema, shard: z.number().int().min(0).max(MAX_FORECAST_SHARDS - 1),
  sampleSha256: digestSchema, tileSha256: z.array(digestSchema).min(1).max(MAX_SAMPLE_VALUES),
  provenance: z.array(z.strictObject({ hour: z.number().int().positive(), intervals: z.unknown(), receipt: z.unknown() })).min(1).max(MAX_SAMPLE_VALUES),
  metrics: z.strictObject({
    frames: z.record(z.string(), z.record(z.string(), z.unknown())),
    phasesMs: z.strictObject({ acquireMs: nonnegativeNumber, deriveMs: nonnegativeNumber, packMs: nonnegativeNumber, renderMs: nonnegativeNumber }),
    renderer: z.record(z.string(), z.unknown()), acquisition: z.record(z.string(), z.unknown()),
    elapsedMs: nonnegativeNumber.max(BUILD_BUDGETS.elapsedMs), peakRssBytes: nonnegativeNumber.max(BUILD_BUDGETS.peakRssBytes)
  })
});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const planHash = (plan: BuildPlan) => sha256(encodeBoundedJson(plan, MAX_MANIFEST_BYTES));

function partition(hours: readonly number[], count: number): number[][] {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_FORECAST_SHARDS) throw new Error('Invalid forecast shard count');
  const n = Math.min(count, hours.length);
  return Array.from({ length: n }, (_, i) => hours.slice(Math.floor(i * hours.length / n), Math.floor((i + 1) * hours.length / n)));
}

/** Freeze the resolved cycle and complete-product admission. No provider data is acquired here. */
export async function createBuildPlan(options: PlanOptions & ForecastInputs): Promise<BuildPlan> {
  options.signal?.throwIfAborted();
  const { product, provider, mask } = options, root = resolve(options.out);
  prepareBuild(mask, product, { maxLevels: provider.maxLevels });
  const groups = partition(product.frameHours, options.shards ?? MAX_FORECAST_SHARDS);
  if (typeof options.cycle !== 'string' || !Number.isFinite(Date.parse(options.cycle))) throw new Error('A resolved forecast cycle is required');
  const stamp = createBuildStamp(), coverageHash = await writeCoverage(root, mask, product);
  const identity = await buildIdentity(product, coverageHash);
  const plan = planSchema.parse({ version: 1, model: product.modelId, ...stamp, cycle: new Date(options.cycle).toISOString(), coverageHash, providerId: provider.id, recipe: identity.recipe, groups });
  options.signal?.throwIfAborted();
  await writeFile(localPath(root, 'plan.json'), encodeBoundedJson(plan, MAX_MANIFEST_BYTES), { flag: 'wx' });
  return plan;
}

/** Every process rechecks the plan against its checked-out code, product and coverage. */
async function admitPlan(plan: BuildPlan, inputs: ForecastInputs) {
  const { product, provider, mask } = inputs;
  const parsed = planSchema.safeParse(plan);
  if (!parsed.success) throw new Error('Invalid forecast plan', { cause: parsed.error });
  plan = parsed.data;
  if (plan.model !== product.modelId || plan.providerId !== provider.id
      || !plan.buildId.startsWith(plan.createdAt.replace(/[-:]/g, '').slice(0, 15) + 'Z-')
      || !same(plan.groups, partition(product.frameHours, plan.groups.length))) {
    throw new Error('Invalid forecast plan identity or frame groups');
  }
  const age = Date.now() - Date.parse(plan.createdAt);
  if (age < -60_000 || age > MAX_BUILD_LIFETIME_MS) throw new Error('Forecast plan exceeds publisher lifetime');
  if (age > BUILD_BUDGETS.elapsedMs) throw new Error('Forecast plan exceeds elapsed-time budget; start a new build');
  const prepared = prepareBuild(mask, product, { maxLevels: provider.maxLevels });
  if (plan.coverageHash !== describeCoverage(mask, product).hash) throw new Error('Forecast plan coverage changed');
  const identity = await buildIdentity(product, plan.coverageHash);
  if (!same(plan.recipe, identity.recipe)) throw new Error('Forecast plan recipe or source revision changed');
  return { plan, prepared, identity };
}

/** One job owns one group; completion is recorded only after its pack and archives finish. */
export async function buildShard(options: ForecastInputs & { plan: BuildPlan; shard: number; out: string; cacheDir?: string; signal?: AbortSignal }): Promise<string> {
  const { shard } = options, root = resolve(options.out);
  options.signal?.throwIfAborted();
  const { plan, prepared } = await admitPlan(options.plan, options);
  if (!Number.isSafeInteger(shard) || shard < 0 || shard >= plan.groups.length) throw new Error('Invalid forecast shard');
  await mkdir(localPath(root, 'shards'), { recursive: true });
  const prefix = `shards/${shard}`;
  // A retry starts in a fresh worker directory; existing files never imply completion.
  await mkdir(localPath(root, prefix));
  try {
    const result = await buildFrames({ ...options, prepared, buildId: plan.buildId, createdAt: plan.createdAt, cycle: plan.cycle, hours: plan.groups[shard], samplesKey: `${prefix}/samples.bin`, journalPrefix: prefix });
    const receipt = receiptSchema.parse({ version: 1, planHash: planHash(plan), shard,
      sampleSha256: result.samples.sha256, tileSha256: result.artifacts.map(artifact => artifact.tilesSha256),
      provenance: result.receipts, metrics: result.metrics });
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

function readResult(raw: unknown, plan: BuildPlan, shard: number, options: ForecastInputs, storedCells: number): FrameBuildResult {
  const receipt = receiptSchema.parse(raw), hours = plan.groups[shard], layers = options.product.layers;
  if (receipt.planHash !== planHash(plan) || receipt.shard !== shard) throw new Error('Forecast shard receipt identity mismatch');
  const frames = hours.map(hour => forecastFrame(plan.cycle, hour, options.product.intervalHours)), channelCount = hours.length * layers.length;
  if (receipt.tileSha256.length !== channelCount) throw new Error('Forecast shard artifact count mismatch');
  if (receipt.provenance.length !== hours.length || receipt.provenance.some((entry, i) => entry.hour !== hours[i] || !matchesFrameIntervals(entry.intervals, frames[i]))) throw new Error('Forecast shard provenance interval mismatch');
  if (!same(Object.keys(receipt.metrics.frames), frames.map(frame => frame.id))) throw new Error('Forecast shard metric frames mismatch');
  const artifacts = frames.flatMap((frame, i) => layers.map((layer, j) => ({
    layer, frame: frame.id, tilesKey: `builds/${plan.model}/${plan.buildId}/${layer}/${frame.id}.pmtiles`,
    tilesSha256: receipt.tileSha256[i * layers.length + j]
  })));
  return { cycle: plan.cycle, frames, artifacts, receipts: receipt.provenance, metrics: receipt.metrics,
    samples: { key: `shards/${shard}/samples.bin`, channelCount, bytes: storedCells * channelCount * CELL_BYTES, sha256: receipt.sampleSha256 } };
}

/** Interleave only complete matching groups, then use the ordinary full-build validator/publisher. */
export async function finalizeBuild(options: ForecastInputs & { plan: BuildPlan } & Pick<BuildOptions, 'out' | 'signal' | 'onValidated'>): Promise<string> {
  const root = resolve(options.out);
  options.signal?.throwIfAborted();
  const { plan, prepared, identity } = await admitPlan(options.plan, options), { layout } = prepared;
  const entries = await readdir(localPath(root, 'shards'), { withFileTypes: true });
  const expected = plan.groups.map((_, i) => String(i));
  if (entries.some(entry => !entry.isDirectory()) || !same(entries.map(entry => entry.name).sort(), expected.sort())) throw new Error('Missing or extra forecast shard directories');
  const results: FrameBuildResult[] = [];
  for (let shard = 0; shard < plan.groups.length; shard++) {
    options.signal?.throwIfAborted();
    const bytes = await readLocalFile(localPath(root, `shards/${shard}/receipt.json`), MAX_PROVENANCE_BYTES);
    results.push(readResult(parseBoundedJson(bytes, MAX_PROVENANCE_JSON_TOKENS), plan, shard, options, layout.storedCells));
  }
  const packStarted = Date.now(), samplesKey = `builds/${plan.model}/${plan.buildId}/samples.bin`;
  const packed = await mergeSamplePacks(layout, results.map(result => ({ path: localPath(root, result.samples.key), channelCount: result.samples.channelCount, sha256: result.samples.sha256 })), localPath(root, samplesKey), BUILD_BUDGETS.samplePackBytes, options.signal);
  const phasesMs = { acquireMs: 0, deriveMs: 0, packMs: Date.now() - packStarted, renderMs: 0 };
  for (const result of results) for (const key of Object.keys(phasesMs) as (keyof typeof phasesMs)[]) phasesMs[key] += result.metrics.phasesMs[key];
  const totalWorkerElapsedMs = results.reduce((sum, result) => sum + result.metrics.elapsedMs, 0);
  const merged: FrameBuildResult = {
    cycle: plan.cycle, frames: results.flatMap(result => result.frames), artifacts: results.flatMap(result => result.artifacts), receipts: results.flatMap(result => result.receipts),
    samples: { ...packed, key: samplesKey, channelCount: options.product.frameHours.length * options.product.layers.length },
    metrics: {
      frames: Object.assign({}, ...results.map(result => result.metrics.frames)), phasesMs,
      renderer: { shards: results.map(result => result.metrics.renderer) }, acquisition: { shards: results.map(result => result.metrics.acquisition) },
      elapsedMs: Date.now() - Date.parse(plan.createdAt), peakRssBytes: Math.max(...results.map(result => result.metrics.peakRssBytes))
    }
  };
  options.signal?.throwIfAborted();
  return finishForecast({ ...options, prepared, buildId: plan.buildId, createdAt: plan.createdAt, coverageHash: plan.coverageHash, identity, result: merged, execution: {
    mode: 'parallel', shardCount: plan.groups.length, totalWorkerElapsedMs,
    // Phase sums describe work; elapsedMs measures plan-to-validation latency including job handoffs.
    workers: results.map((result, shard) => ({ shard, hours: plan.groups[shard], elapsedMs: result.metrics.elapsedMs, peakRssBytes: result.metrics.peakRssBytes }))
  } });
}

async function inputsFor(modelId: string): Promise<ForecastInputs> {
  const product = getProduct(modelId);
  if (!product) throw new Error(`No forecast product for ${modelId}`);
  return { product, provider: getForecastProvider(modelId), mask: await loadCoverage(product) };
}
async function readPlan(path: string): Promise<BuildPlan> {
  return planSchema.parse(parseBoundedJson(await readLocalFile(path, MAX_MANIFEST_BYTES)));
}
export async function createForecastPlan(modelId: string, options: PlanOptions): Promise<number[]> {
  const plan = await createBuildPlan({ ...options, ...await inputsFor(modelId) });
  return plan.groups.map((_, i) => i);
}
export async function buildForecastShard(planPath: string, shard: number, options: Pick<BuildOptions, 'out' | 'cacheDir' | 'signal'>): Promise<string> {
  const plan = await readPlan(planPath);
  return buildShard({ ...options, ...await inputsFor(plan.model), plan, shard });
}
export async function finalizeForecastBuild(planPath: string, options: Pick<BuildOptions, 'out' | 'signal' | 'onValidated'>): Promise<string> {
  const plan = await readPlan(planPath);
  return finalizeBuild({ ...options, ...await inputsFor(plan.model), plan });
}
