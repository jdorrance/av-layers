import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CELL_BYTES, encodeBoundedJson, getProduct, MAX_MANIFEST_BYTES, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, manifestSchema, parseBoundedJson, type Manifest } from '@av/contracts';
import { BUILD_BUDGETS, MAX_BUILD_LIFETIME_MS, prepareBuild } from './capacity.js';
import { createBuildStamp, finishForecast } from './build.js';
import { describeCoverage, loadCoverage, writeCoverage } from './coverage.js';
import { buildFrames, forecastFrame, type BuildOptions, type ForecastInputs, type FrameBuildResult } from './frame-build.js';
import { buildIdentity } from './identity.js';
import { readLocalFile } from './local-file.js';
import { getForecastProvider } from './providers.js';
import { mergeSamplePacks } from './sample-pack.js';
import { localPath, sha256 } from './validate.js';
import { failureReason } from './failure.js';

export const MAX_FORECAST_SHARDS = 4;
export interface BuildPlan {
  version: 1;
  model: string;
  buildId: string;
  createdAt: string;
  cycle: string;
  coverageHash: string;
  providerId: string;
  recipe: Manifest['recipe'];
  groups: number[][];
}
interface PlanOptions { out: string; cycle?: string; shards?: number; signal?: AbortSignal }
interface ShardReceipt { version: 1; buildId: string; planHash: string; shard: number; result: FrameBuildResult }
const digest = /^[a-f0-9]{64}$/;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const planHash = (plan: BuildPlan) => sha256(encodeBoundedJson(plan, MAX_MANIFEST_BYTES));

function partition(hours: readonly number[], count: number): number[][] {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_FORECAST_SHARDS) throw new Error('Invalid forecast shard count');
  const n = Math.min(count, hours.length);
  return Array.from({ length: n }, (_, i) => hours.slice(Math.floor(i * hours.length / n), Math.floor((i + 1) * hours.length / n)));
}

/** Freeze discovery and complete-product admission once. No provider data is acquired here. */
export async function createBuildPlan(options: PlanOptions & ForecastInputs): Promise<BuildPlan> {
  options.signal?.throwIfAborted();
  const { product, provider, mask } = options, root = resolve(options.out);
  prepareBuild(mask, product, { maxLevels: provider.maxLevels });
  const groups = partition(product.frameHours, options.shards ?? MAX_FORECAST_SHARDS);
  const resolvedCycle = options.cycle ?? await provider.resolveCycle?.({ cacheDir: localPath(root, '.cache'), signal: options.signal });
  if (!resolvedCycle || !Number.isFinite(Date.parse(resolvedCycle))) throw new Error('A resolved forecast cycle is required');
  const stamp = createBuildStamp(), coverageHash = await writeCoverage(root, mask, product);
  const identity = await buildIdentity(product, coverageHash);
  const plan: BuildPlan = { version: 1, model: product.modelId, ...stamp, cycle: new Date(resolvedCycle).toISOString(), coverageHash, providerId: provider.id, recipe: identity.recipe, groups };
  options.signal?.throwIfAborted();
  await writeFile(localPath(root, 'plan.json'), encodeBoundedJson(plan, MAX_MANIFEST_BYTES), { flag: 'wx' });
  return plan;
}

/** Every process rechecks the plan against its checked-out code, product and coverage. */
async function admitPlan(plan: BuildPlan, inputs: ForecastInputs) {
  const { product, provider, mask } = inputs;
  if (!plan || !same(Object.keys(plan).sort(), ['version', 'model', 'buildId', 'createdAt', 'cycle', 'coverageHash', 'providerId', 'recipe', 'groups'].sort())
      || plan.version !== 1 || plan.model !== product.modelId || plan.providerId !== provider.id
      || typeof plan.buildId !== 'string' || !/^\d{8}T\d{6}Z-[a-f0-9-]{36}$/.test(plan.buildId)
      || typeof plan.createdAt !== 'string' || !Number.isFinite(Date.parse(plan.createdAt))
      || typeof plan.cycle !== 'string' || !Number.isFinite(Date.parse(plan.cycle))
      || new Date(plan.cycle).toISOString() !== plan.cycle || new Date(plan.createdAt).toISOString() !== plan.createdAt
      || !plan.buildId.startsWith(plan.createdAt.replace(/[-:]/g, '').slice(0, 15) + 'Z-')
      || !Array.isArray(plan.groups) || !plan.groups.length || !same(plan.groups, partition(product.frameHours, plan.groups.length))) {
    throw new Error('Invalid forecast plan identity or frame groups');
  }
  const age = Date.now() - Date.parse(plan.createdAt);
  if (age < -60_000 || age > MAX_BUILD_LIFETIME_MS) throw new Error('Forecast plan exceeds publisher lifetime');
  if (age > BUILD_BUDGETS.elapsedMs) throw new Error('Forecast plan exceeds elapsed-time budget; start a new build');
  const prepared = prepareBuild(mask, product, { maxLevels: provider.maxLevels });
  if (plan.coverageHash !== describeCoverage(mask, product).hash) throw new Error('Forecast plan coverage changed');
  const identity = await buildIdentity(product, plan.coverageHash);
  if (!same(plan.recipe, identity.recipe)) throw new Error('Forecast plan recipe or source revision changed');
  return { ...prepared, identity };
}

/** One job owns one group; completion is recorded only after its pack and archives finish. */
export async function buildShard(options: ForecastInputs & { plan: BuildPlan; shard: number; out: string; cacheDir?: string; signal?: AbortSignal }): Promise<string> {
  const { plan, shard } = options, root = resolve(options.out);
  options.signal?.throwIfAborted();
  await admitPlan(plan, options);
  if (!Number.isSafeInteger(shard) || shard < 0 || shard >= plan.groups.length) throw new Error('Invalid forecast shard');
  await mkdir(localPath(root, 'shards'), { recursive: true });
  const prefix = `shards/${shard}`;
  // A retry starts in a fresh worker directory; existing files never imply completion.
  await mkdir(localPath(root, prefix));
  try {
    const result = await buildFrames({ ...options, buildId: plan.buildId, createdAt: plan.createdAt, cycle: plan.cycle, hours: plan.groups[shard], samplesKey: `${prefix}/samples.bin`, journalPrefix: prefix });
    if (result.metrics.elapsedMs > BUILD_BUDGETS.elapsedMs || result.metrics.peakRssBytes > BUILD_BUDGETS.peakRssBytes) throw new Error('Forecast shard exceeded its runtime or memory budget');
    const receipt: ShardReceipt = { version: 1, buildId: plan.buildId, planHash: planHash(plan), shard, result };
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
  const receipt = raw as ShardReceipt;
  if (!receipt || receipt.version !== 1 || receipt.buildId !== plan.buildId || receipt.planHash !== planHash(plan) || receipt.shard !== shard || !receipt.result) throw new Error('Forecast shard receipt identity mismatch');
  const result = receipt.result, hours = plan.groups[shard], layers = options.product.layers;
  const expectedFrames = hours.map(hour => forecastFrame(plan.cycle, hour, options.product.intervalHours));
  const frames = manifestSchema.shape.frames.parse(result.frames), artifacts = manifestSchema.shape.artifacts.parse(result.artifacts);
  if (result.cycle !== plan.cycle || !same(frames, expectedFrames) || artifacts.length !== hours.length * layers.length) throw new Error('Forecast shard frames mismatch');
  for (let i = 0; i < artifacts.length; i++) {
    const artifact = artifacts[i], frame = expectedFrames[Math.floor(i / layers.length)].id, layer = layers[i % layers.length];
    if (artifact.layer !== layer || artifact.frame !== frame || artifact.tilesKey !== `builds/${plan.model}/${plan.buildId}/${layer}/${frame}.pmtiles`) throw new Error('Forecast shard artifact membership mismatch');
  }
  if (!Array.isArray(result.receipts) || result.receipts.length !== hours.length || result.receipts.some((entry, i) => !entry || entry.hour !== hours[i])) throw new Error('Forecast shard provenance mismatch');
  for (let i = 0; i < result.receipts.length; i++) {
    const intervals = result.receipts[i].intervals as { profileTime?: unknown; fluxWindow?: { start?: unknown; end?: unknown }; precipitationWindow?: { start?: unknown; end?: unknown } } | null;
    const frame = expectedFrames[i];
    const instant = (actual: unknown, expected: string) => typeof actual === 'string' && Date.parse(actual) === Date.parse(expected);
    if (!intervals || !instant(intervals.profileTime, frame.validTime)
        || !instant(intervals.fluxWindow?.start, frame.intervalStart) || !instant(intervals.fluxWindow?.end, frame.intervalEnd)
        || !instant(intervals.precipitationWindow?.start, frame.intervalStart) || !instant(intervals.precipitationWindow?.end, frame.intervalEnd)) throw new Error('Forecast shard provenance interval mismatch');
  }
  const samples = result.samples, channelCount = hours.length * layers.length;
  if (!samples || samples.key !== `shards/${shard}/samples.bin` || samples.channelCount !== channelCount || samples.bytes !== storedCells * channelCount * CELL_BYTES || typeof samples.sha256 !== 'string' || !digest.test(samples.sha256)) throw new Error('Forecast shard sample layout mismatch');
  const metrics = result.metrics;
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const object = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!metrics || !metrics.phasesMs || !['acquireMs', 'deriveMs', 'packMs', 'renderMs'].every(key => finite(metrics.phasesMs[key as keyof typeof metrics.phasesMs]))
      || !finite(metrics.elapsedMs) || !finite(metrics.peakRssBytes) || metrics.elapsedMs > BUILD_BUDGETS.elapsedMs || metrics.peakRssBytes > BUILD_BUDGETS.peakRssBytes
      || !object(metrics.renderer) || !object(metrics.acquisition)
      || !metrics.frames || !same(Object.keys(metrics.frames), expectedFrames.map(frame => frame.id))) throw new Error('Invalid forecast shard metrics');
  return { ...result, frames, artifacts };
}

/** Interleave only complete matching groups, then use the ordinary full-build validator/publisher. */
export async function finalizeBuild(options: ForecastInputs & { plan: BuildPlan } & Pick<BuildOptions, 'out' | 'signal' | 'onValidated'>): Promise<string> {
  const { plan } = options, root = resolve(options.out);
  options.signal?.throwIfAborted();
  const { layout, identity } = await admitPlan(plan, options);
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
  return finishForecast({ ...options, buildId: plan.buildId, createdAt: plan.createdAt, coverageHash: plan.coverageHash, identity, result: merged, execution: {
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
  return parseBoundedJson(await readLocalFile(path, MAX_MANIFEST_BYTES)) as BuildPlan;
}
export async function createForecastPlan(modelId: string, options: PlanOptions): Promise<{ planPath: string; shards: number[] }> {
  const plan = await createBuildPlan({ ...options, ...await inputsFor(modelId) });
  return { planPath: localPath(options.out, 'plan.json'), shards: plan.groups.map((_, i) => i) };
}
export async function buildForecastShard(planPath: string, shard: number, options: Pick<BuildOptions, 'out' | 'cacheDir' | 'signal'>): Promise<string> {
  const plan = await readPlan(planPath);
  return buildShard({ ...options, ...await inputsFor(plan.model), plan, shard });
}
export async function finalizeForecastBuild(planPath: string, options: Pick<BuildOptions, 'out' | 'signal' | 'onValidated'>): Promise<string> {
  const plan = await readPlan(planPath);
  return finalizeBuild({ ...options, ...await inputsFor(plan.model), plan });
}
