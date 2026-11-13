import { execFile } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { getProduct } from '@av/contracts/models';
import { manifestV5Schema, MAX_COVERAGE_BITSET_BYTES, MAX_COVERAGE_DESCRIPTOR_BYTES, MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS, MAX_SPARSE_COVERAGE_BYTES, decodeSparseCoverage, parseBoundedJson, sameGrid, sameJsonValue, sparseCoverageDescriptorSchema, validateArtifactRecordsV5, type ManifestV5 } from '@av/contracts';
import { buildIdentity } from '../apps/batch/src/identity.js';
import { readLocalFile } from '../apps/batch/src/local-file.js';
import { checkPerformance, forecastPlanDeadline } from '../apps/batch/src/capacity.js';
import { workflowAuthority, workflowContext, type PublicationAuthority } from '../apps/batch/src/authority.js';
import { failureReason } from '../apps/batch/src/failure.js';
import { cleanup, publish, readPointer, type CleanupSummary } from '../apps/batch/src/publication.js';
import { forecastObjects } from '../apps/batch/src/publication-objects.js';
import { getForecastProvider } from '../apps/batch/src/providers.js';
import { isPrivateUpstreamKey, pinnedSourcePrefix } from '../apps/batch/src/source.js';
import type { BuildPlan } from '../apps/batch/src/parallel.js';
import { isTransientStorageError, r2Storage, type ObjectStorage } from '../apps/batch/src/storage.js';
import { localPath, sha256, type ValidatedBuild } from '../apps/batch/src/validate.js';
import { validateApiBaseUrl, verifyPublishedForecast } from './smoke-api.js';
import { completeForecastControlShard, downloadForecastControlReceipts, forecastPlanSignal } from './forecast-control.js';
import { terrainCatalogInput } from './terrain-inputs.js';

const TERRAIN_ATTEMPTS = 3;

/** Check at entry and immediately before publishing a completed forecast. */
export async function assertCurrentMain(signal?: AbortSignal): Promise<void> {
  const { repository, revision } = workflowContext();
  const { stdout } = await promisify(execFile)('gh', ['api', `repos/${repository}/git/ref/heads/main`, '--jq', '.object.sha'], { timeout: 15_000, signal });
  if (stdout.trim() !== revision) throw new Error('This revision was superseded on main; rerun the latest revision');
}

export async function downloadForecastArtifact(runId: string, root = 'output'): Promise<string> {
  const { repository } = workflowContext();
  if (!/^[1-9]\d{0,19}$/.test(runId)) throw new Error('Invalid source artifact run ID');
  const { stdout } = await promisify(execFile)('gh', ['api', `repos/${repository}/actions/runs/${runId}`], { timeout: 15_000, maxBuffer: 1024 * 1024 });
  const run = JSON.parse(stdout) as { run_attempt?: unknown };
  const revision = forecastArtifactRevision(run, repository, runId);
  await promisify(execFile)('gh', ['run', 'download', runId, '--repo', repository, '--name', `forecast-${workflowAuthority().model}-${runId}`, '--dir', root], { timeout: 5 * 60_000, maxBuffer: 1024 * 1024 });
  const identity = record(parseBoundedJson(await readLocalFile(join(root, 'workflow.json'), 4096)), 'Source workflow identity');
  const authority = workflowAuthority();
  if (identity.runId !== runId || identity.attempt !== run.run_attempt || identity.model !== authority.model
      || identity.environment !== authority.environment || identity.revision !== revision) throw new Error('Resume artifact workflow identity differs from the authorized run attempt');
  return revision;
}

type ForecastPhase = 'terrain' | 'plan' | 'shard' | 'finalize' | 'resume' | 'publish' | 'maintenance' | 'serving';
type PublicationState = 'not-attempted' | 'unconfirmed' | 'committed';
type ForecastEvent = {
  phase: ForecastPhase;
  buildId?: string;
  shard?: number;
  publication?: PublicationState;
} & (
  { event: 'forecast-failure'; cancelled: boolean; error: ReturnType<typeof failureReason> }
  | { event: 'forecast-stage'; outcome: 'complete' | 'skipped' }
  | { event: 'forecast-published'; r2UploadWallMs?: number; casCommitWallMs?: number }
);

function logForecastEvent(authority: PublicationAuthority, started: number, detail: ForecastEvent): void {
  const attempt = process.env.GITHUB_RUN_ATTEMPT;
  const entry = JSON.stringify({ model: authority.model, environment: authority.environment,
    runId: authority.runId, attempt: /^\d+$/.test(attempt ?? '') ? attempt : undefined, ...detail,
    elapsedMs: Date.now() - started, peakRssBytes: process.resourceUsage().maxRSS * 1024 });
  if (detail.event === 'forecast-failure') console.error(entry);
  else console.log(entry);
}

/** Build and artifact-resume use the same writer, cancellation and durable outcome protocol. */
export async function publicationWorkflow<T>(operation: 'terrain' | 'plan' | 'finalize' | 'resume', work: (run: {
  root: string; signal: AbortSignal; store: ObjectStorage; model: string;
  identifyBuild(buildId: string): void;
  commit(manifest: ManifestV5, path: string, resumedFromRun?: string, validated?: ValidatedBuild, options?: { deadlineAt?: string; receiptsOnly?: boolean; committedOnly?: boolean }): Promise<void>;
}) => Promise<T>, store?: ObjectStorage): Promise<T> {
  const { revision } = workflowContext();
  const authority = workflowAuthority(), root = 'output', controller = new AbortController(), storage = store ?? r2Storage();
  const workflowStarted = Date.now();
  const abort = (): void => controller.abort(new Error('Publication interrupted'));
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  let publicationPath: string | undefined, committed = false, publicationAttempted = false;
  let phase: ForecastPhase = operation, buildId: string | undefined;
  try {
    const result = await work({ root, signal: controller.signal, store: storage, model: authority.model, identifyBuild(id) { buildId = id; }, async commit(manifest, path, resumedFromRun, validated, options) {
      buildId = manifest.buildId;
      phase = 'publish';
      if (options?.deadlineAt && Date.now() >= Date.parse(options.deadlineAt)) throw new Error('Forecast publication deadline exceeded');
      const signal = options?.deadlineAt ? AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, Date.parse(options.deadlineAt) - Date.now()))]) : controller.signal;
      signal.throwIfAborted();
      const apiUrl = validateApiBaseUrl(process.env.API_BASE_URL);
      const budget = checkPerformance(manifest);
      await writeFile(join(dirname(path), 'performance.json'), JSON.stringify(budget, null, 2));
      if (!budget.passed) throw new Error(`Performance budget failed: ${budget.failures.join('; ')}`);
      await assertCurrentMain(signal);
      const started = Date.now(), validationReused = validated !== undefined;
      publicationPath = join(dirname(path), 'publication.json');
      publicationAttempted = true;
      await writeFile(publicationPath, JSON.stringify({ version: 1, status: 'publishing', publication: 'unconfirmed', buildId: manifest.buildId, resumedFromRun, startedAt: new Date(started).toISOString() }, null, 2));
      const timings: { r2UploadWallMs?: number; casCommitWallMs?: number } = {};
      await publish(storage, root, manifest, { authority, signal, allowSameCycle: process.env.ALLOW_SAME_CYCLE === 'true', validated, ...options, timings });
      committed = true;
      await writeFile(publicationPath, JSON.stringify({ version: 1, status: 'committed', publication: 'committed', buildId: manifest.buildId, resumedFromRun, elapsedMs: Date.now() - started, publicationWallMs: Date.now() - started, ...timings, rssBytes: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024, validationReused }, null, 2));
      logForecastEvent(authority, started, { event: 'forecast-published', phase, buildId, publication: 'committed', ...timings });
      // Record commit first; cancellation or maintenance failure must never masquerade as failed publication.
      phase = 'maintenance';
      if (signal.aborted) {
        await writeFile(join(dirname(path), 'maintenance.json'), JSON.stringify({ status: 'deferred', publication: 'committed', reason: 'cancelled-after-commit', summary: null, authority }, null, 2));
        signal.throwIfAborted();
      }
      let summary: CleanupSummary | undefined;
      const maintenanceStarted = Date.now();
      try {
        await writeFile(join(dirname(path), 'maintenance.json'), JSON.stringify({ status: 'running', publication: 'committed', summary: null, authority }, null, 2));
        const deletedObjects = await cleanup(storage, manifest.model, authority, Date.now(), report => { summary = report; }, signal);
        await writeFile(join(dirname(path), 'maintenance.json'), JSON.stringify({ status: 'complete', publication: 'committed', maintenanceWallMs: Date.now() - maintenanceStarted, deletedObjects, summary: summary ?? null, authority }, null, 2));
      } catch (error) {
        await writeFile(join(dirname(path), 'maintenance.json'), JSON.stringify({ status: 'failed', publication: 'committed', maintenanceWallMs: Date.now() - maintenanceStarted, error: String(error), summary: summary ?? null, authority }, null, 2)).catch(() => {});
        throw new Error(`Publication committed; maintenance failed: ${String(error)}`, { cause: error });
      }
      phase = 'serving';
      const servingPath = join(dirname(path), 'serving.json');
      const smokeStarted = Date.now();
      try {
        signal.throwIfAborted();
        await verifyPublishedForecast({ baseUrl: apiUrl.origin, manifest, signal });
        await writeFile(servingPath, JSON.stringify({ status: 'verified', publication: 'committed', smokeVerifyWallMs: Date.now() - smokeStarted, model: manifest.model, buildId: manifest.buildId, frames: manifest.frames, layers: manifest.layers, apiBaseUrl: apiUrl.origin }, null, 2));
      } catch (error) {
        await writeFile(servingPath, JSON.stringify({ status: 'failed', publication: 'committed', smokeVerifyWallMs: Date.now() - smokeStarted, model: manifest.model, buildId: manifest.buildId, error: String(error) }, null, 2)).catch(() => {});
        throw new Error(`Publication committed; serving verification failed: ${String(error)}`, { cause: error });
      }
    } });
    logForecastEvent(authority, workflowStarted, { event: 'forecast-stage', phase: operation, buildId,
      publication: committed ? 'committed' : 'not-attempted', outcome: operation === 'plan' && result === null ? 'skipped' : 'complete' });
    return result;
  } catch (error) {
    const publication = committed ? 'committed' : publicationAttempted ? 'unconfirmed' : 'not-attempted';
    const cancelled = controller.signal.aborted;
    logForecastEvent(authority, workflowStarted, { event: 'forecast-failure', phase, buildId, publication, cancelled, error: failureReason(error) });
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'failure.json'), JSON.stringify({ at: new Date().toISOString(), revision, authority, publicationPath, publication, cancelled, error: String(error) }, null, 2));
    } catch {}
    throw error;
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
  }
}

function configuredWholeDomain(model: string, env: NodeJS.ProcessEnv, store: ObjectStorage) {
  const product = getProduct(model);
  if (!product) throw new Error(`No forecast product for ${model}`);
  const factor = product.terrainSubdivisionFactor;
  if (factor === undefined || !Number.isSafeInteger(factor) || factor < 1) throw new Error(`Invalid terrain subdivision factor for ${model}`);
  const catalog = env.TERRAIN_CATALOG_REF;
  if (!catalog) throw new Error(`TERRAIN_CATALOG_REF is required for configured whole-domain ${model} build`);
  return { catalogRef: terrainCatalogInput(catalog), storage: store };
}

async function publishedTerrainRef(store: ObjectStorage, model: string, signal?: AbortSignal) {
  const { pointer } = await readPointer(store, model, signal);
  if (!pointer) return;
  const latest = pointer.retained.find(item => item.buildId === pointer.latestBuildId);
  if (!latest) throw new Error('Published terrain pointer lacks its latest build');
  if (Date.parse(latest.expiresAt) <= Date.now()) return;
  const object = await store.get(latest.manifestKey, undefined, MAX_MANIFEST_BYTES, signal);
  signal?.throwIfAborted();
  if (!object) {
    if (Date.parse(latest.expiresAt) <= Date.now()) return;
    throw new Error('Published terrain manifest is missing');
  }
  const raw = record(parseBoundedJson(object.bytes, MAX_MANIFEST_JSON_TOKENS), 'Published terrain manifest');
  if (raw.model !== model || raw.buildId !== latest.buildId || raw.cycle !== latest.cycle || raw.expiresAt !== latest.expiresAt) throw new Error('Published terrain manifest identity mismatch');
  if (raw.version === 3 || raw.version === 4) return;
  const manifest = manifestV5Schema.parse(raw);
  const terrain = manifest.surfaces.find(surface => surface.id === 'fine')?.terrain;
  return terrain ? { key: terrain.key, sha256: terrain.sha256 } : undefined;
}

/** Populate immutable terrain before the forecast build clock starts. */
export async function prepareForecastTerrain(store?: ObjectStorage): Promise<void> {
  await publicationWorkflow('terrain', async ({ signal, store, model }) => {
    const product = getProduct(model);
    if (!product) throw new Error(`No forecast product for ${model}`);
    const wholeDomain = configuredWholeDomain(model, process.env, store);
    const [{ wholeDomainPlan, loadBundledFineCoverage }, { ensureWholeDomainTerrain }] = await Promise.all([
      import('../apps/batch/src/whole-domain/coverage.js'), import('../apps/batch/src/whole-domain/terrain.js')
    ]);
    const plan = wholeDomainPlan(product);
    if (!plan) throw new Error(`No whole-domain terrain grid for ${model}`);
    const fine = await loadBundledFineCoverage(product, plan);
    const reuseFrom = (reuseSignal?: AbortSignal) => publishedTerrainRef(store, model, reuseSignal);
    for (let attempt = 1; attempt <= TERRAIN_ATTEMPTS; attempt++) {
      signal.throwIfAborted();
      try {
        const ref = await ensureWholeDomainTerrain({ ...wholeDomain, sourceCacheDir: join('.cache', 'terrain-source', model), grid: plan.fine,
          coverage: fine.mask.coverage, coverageDescriptor: fine.bytes, signal, reuseFrom });
        console.log(JSON.stringify({ phase: 'terrain-ready', model, ...ref }));
        return;
      } catch (error) {
        signal.throwIfAborted();
        const deadline = error instanceof Error && error.message === 'Terrain preparation deadline exceeded';
        if (attempt === TERRAIN_ATTEMPTS || (!deadline && !isTransientStorageError(error))) throw error;
        console.error(JSON.stringify({ phase: 'terrain-retry', model, attempt, error: String(error) }));
      }
    }
  }, store);
}

/** Resolve the cycle once before independent workers receive the immutable plan. */
export async function planForecast(store?: ObjectStorage): Promise<BuildPlan | null> {
  return publicationWorkflow('plan', async ({ root, signal, store, model, identifyBuild }) => {
    const cacheDir = `.cache/${model}`;
    console.error(JSON.stringify({ phase: 'cycle-discovery', model, state: 'started' }));
    const provider = getForecastProvider(model), request = { cycle: process.env.CYCLE || undefined, cacheDir, signal };
    const pinned = provider.resolveRun ? await provider.resolveRun({ ...request, store }) : undefined;
    const cycle = pinned?.cycle ?? await provider.resolveCycle(request);
    console.error(JSON.stringify({ phase: 'cycle-discovery', model, state: 'complete', cycle }));
    const { pointer } = await readPointer(store, model, signal);
    signal.throwIfAborted();
    if (pointer) {
      // Use every retained cycle, just like publish(), including after rollback.
      const latestCycle = Math.max(...pointer.retained.map(item => Date.parse(item.cycle)));
      if (Date.parse(cycle) < latestCycle) throw new Error('Older cycle cannot be published');
      if (Date.parse(cycle) === latestCycle && process.env.ALLOW_SAME_CYCLE !== 'true') {
        console.log(`Skipped ${model} build: cycle ${cycle} was already published. No new build was produced. Set allow-same-cycle=true to rebuild it.`);
        return null;
      }
    }
    const { createForecastPlan } = await import('../apps/batch/src/parallel.js');
    const wholeDomain = configuredWholeDomain(model, process.env, store);
    const plan = await createForecastPlan(model, { out: root, cycle, signal, store,
      ...(pinned ? { sourcePin: pinned.sourcePin } : {}), wholeDomain: { ...wholeDomain, cacheOnly: true } });
    identifyBuild(plan.buildId);
    await writeFile(join(root, 'plan-metrics.json'), JSON.stringify({ planWallMs: Date.now() - Date.parse(plan.createdAt), rssBytes: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024 }));
    return plan;
  }, store);
}

async function assertPlannedModel(model: string): Promise<void> {
  const raw = parseBoundedJson(await readLocalFile('output/plan.json', MAX_MANIFEST_BYTES));
  if (!raw || typeof raw !== 'object' || !('model' in raw) || raw.model !== model) throw new Error('Forecast plan differs from the workflow model');
}

export async function runForecastShard(shard: number, store?: ObjectStorage): Promise<void> {
  const started = Date.now();
  const authority = workflowAuthority();
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error('Forecast shard interrupted'));
  let buildId: string | undefined;
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    await assertPlannedModel(authority.model);
    const { buildForecastShard, readBuildPlan } = await import('../apps/batch/src/parallel.js');
    const plan = await readBuildPlan('output/plan.json');
    buildId = plan.buildId;
    const prefix = `builds/${authority.model}/${plan.buildId}/`;
    const product = getProduct(authority.model);
    if (!product) throw new Error('Forecast shard requires a configured model');
    const sourcePrefix = plan.sourcePin ? pinnedSourcePrefix(product, plan.cycle, plan.sourcePin.key) : undefined;
    const assertReadable = (key: string): void => {
      if (!key.startsWith(prefix) && !/^coverage\/[a-f0-9]{64}\/(manifest\.json|sparse\.bin|tiles\.bin)$/.test(key)
          && !/^terrain\/prepared\/[a-f0-9]{64}\/[a-z0-9.-]+$/.test(key)
          && !(sourcePrefix && isPrivateUpstreamKey(key, sourcePrefix))) throw new Error('Shard storage cannot read this key');
    };
    const scopedStore: ObjectStorage | undefined = store && {
      get: (key, ...args) => { assertReadable(key); return store.get(key, ...args); },
      head: (key, ...args) => { assertReadable(key); return store.head(key, ...args); },
      put: async (key, bytes, condition, ...args) => {
        if (!key.startsWith(prefix) || condition.ifNoneMatch !== '*' || condition.ifMatch) throw new Error('Shard writes require an immutable build key');
        return store.put(key, bytes, condition, ...args);
      },
      list: async () => { throw new Error('Shard storage cannot list objects'); },
      delete: async () => { throw new Error('Shard storage cannot delete objects'); }
    };
    const shardSetupWallMs = Date.now() - started;
    const build = () => buildForecastShard('output/plan.json', shard, { out: 'output', cacheDir: `.cache/${authority.model}`, signal: controller.signal, store: scopedStore });
    if (scopedStore) await completeForecastControlShard(scopedStore, plan, shard, join('output', 'shards', String(shard), 'receipt.json'), build,
      forecastPlanSignal(plan, controller.signal), process.env.RETAIN_FULL_ARTIFACTS === 'true' ? 'output' : undefined);
    else await build();
    await writeFile(join('output', 'shards', String(shard), 'workflow-metrics.json'), JSON.stringify({ shardSetupWallMs, rssBytes: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024 }));
    logForecastEvent(authority, started, { event: 'forecast-stage', phase: 'shard', buildId, shard, outcome: 'complete' });
  } catch (error) {
    logForecastEvent(authority, started, { event: 'forecast-failure', phase: 'shard', buildId, shard,
      cancelled: controller.signal.aborted, error: failureReason(error) });
    throw error;
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
  }
}

/** Only the complete, validated shard set can enter the existing publication protocol. */
export async function finalizeAndPublish(store?: ObjectStorage): Promise<void> {
  await publicationWorkflow('finalize', async ({ root, signal, store, model, identifyBuild, commit }) => {
    await assertPlannedModel(model);
    const { finalizeForecastBuild, readBuildPlan } = await import('../apps/batch/src/parallel.js');
    const plan = await readBuildPlan(join(root, 'plan.json'));
    identifyBuild(plan.buildId);
    await downloadForecastControlReceipts(store, root, plan, forecastPlanSignal(plan, signal));
    await finalizeForecastBuild(join(root, 'plan.json'), { out: root, signal, store, onValidated: (validated, path) => commit(validated.manifest, path, undefined, validated, { deadlineAt: new Date(forecastPlanDeadline(plan)).toISOString(), receiptsOnly: true }) });
  }, store);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

export async function assertV5ResumeIdentity(manifest: ManifestV5, plan: BuildPlan, root: string, signal?: AbortSignal, receiptsOnly = false): Promise<void> {
  validateArtifactRecordsV5(manifest);
  const frozen = plan.wholeDomain;
  if (!frozen) throw new Error('Resume whole-domain plan lacks frozen inputs');
  const registered = getProduct(manifest.model);
  if (!registered) throw new Error('Resume product is not registered');
  const product = plan.execution ? { ...registered, maxNativeZoom: plan.execution.zoom,
    execution: { ...registered.execution, workers: plan.execution.workers } } : registered;
  if (plan.execution && manifest.surfaces.some(surface => surface.coverage.maxZoom !== plan.execution!.zoom)) throw new Error('Resume surface zoom differs from frozen execution');
  const factor = product.terrainSubdivisionFactor;
  if (factor === undefined || frozen.k !== factor) throw new Error('Resume whole-domain subdivision factor differs');
  const native = manifest.surfaces.find(surface => surface.kind === 'native');
  if (native && native.coverage.hash !== frozen.nativeCoverageHash) throw new Error('Resume native coverage identity differs');
  const fine = manifest.surfaces.filter(surface => surface.kind === 'fine');
  if (fine.length !== 1) throw new Error('Resume v5 manifest requires one fine surface');
  const surface = fine[0]!, terrain = surface.terrain!;
  if (surface.coverage.id !== frozen.fineCoverage.id || surface.coverage.hash !== frozen.fineCoverage.hash
      || surface.coverage.maskKey !== frozen.fineCoverage.maskKey
      || (plan.execution ? surface.coverage.maxZoom > frozen.fineCoverage.maxZoom : surface.coverage.maxZoom !== frozen.fineCoverage.maxZoom)
      || surface.gridHash !== frozen.fineCoverage.gridHash || terrain.key !== frozen.terrain.key || terrain.sha256 !== frozen.terrain.sha256) {
    throw new Error('Resume whole-domain coverage or terrain identity differs');
  }
  const identity = await buildIdentity(product, frozen.nativeCoverageHash, { wholeDomain:
    { k: frozen.k, nativeCoverageHash: frozen.nativeCoverageHash, fineCoverageHash: frozen.fineCoverage.hash, fineGridHash: frozen.fineCoverage.gridHash, terrain: frozen.terrain } });
  if (identity.recipe.hash !== manifest.recipe.hash) throw new Error('Resume recipe differs from current code/configuration; build a fresh forecast');
  for (const current of manifest.surfaces) {
    signal?.throwIfAborted();
    const descriptorBytes = await readLocalFile(localPath(root, current.coverage.maskKey), MAX_COVERAGE_DESCRIPTOR_BYTES);
    if (sha256(descriptorBytes) !== current.coverage.hash) throw new Error('Resume coverage descriptor hash mismatch');
    const descriptor = sparseCoverageDescriptorSchema.parse(parseBoundedJson(descriptorBytes));
    if (descriptor.id !== current.coverage.id || descriptor.gridHash !== current.gridHash || !sameGrid(descriptor.grid, current.grid)
        || !sameJsonValue(descriptor.bounds, manifest.descriptors.bounds)
        || (plan.execution ? descriptor.maxZoom < current.coverage.maxZoom : descriptor.maxZoom !== current.coverage.maxZoom)
        || (current.kind === 'fine' && descriptor.maxZoom !== frozen.fineCoverage.maxZoom)) throw new Error('Resume coverage descriptor binding mismatch');
    const { sparse: sparseFile, tiles: tilesFile } = descriptor.files;
    const prefix = dirname(current.coverage.maskKey);
    const sparse = await readLocalFile(localPath(root, `${prefix}/sparse.bin`), MAX_SPARSE_COVERAGE_BYTES, sparseFile.bytes);
    if (sha256(sparse) !== sparseFile.sha256) throw new Error('Resume sparse coverage hash mismatch');
    const coverage = decodeSparseCoverage(new Uint8Array(sparse.buffer, sparse.byteOffset, sparse.byteLength), current.gridHash);
    if (coverage.width !== current.grid.width || coverage.height !== current.grid.height || coverage.blockIds.length !== current.samples.blockCount) throw new Error('Resume sparse coverage layout mismatch');
    const tiles = await readLocalFile(localPath(root, `${prefix}/tiles.bin`), MAX_COVERAGE_BITSET_BYTES, tilesFile.bytes);
    if (sha256(tiles) !== tilesFile.sha256) throw new Error('Resume tile coverage hash mismatch');
    for (const shard of receiptsOnly ? [] : current.samples.shards) {
      signal?.throwIfAborted();
      const bytes = await readLocalFile(localPath(root, shard.key), shard.bytes, shard.bytes);
      if (sha256(bytes) !== shard.sha256) throw new Error(`Resume sample shard hash mismatch: ${shard.key}`);
    }
    if (current.terrain) {
      const terrainBytes = await readLocalFile(localPath(root, current.terrain.key), 16 * 1024);
      if (sha256(terrainBytes) !== current.terrain.sha256) throw new Error('Resume terrain descriptor hash mismatch');
      const descriptor = record(parseBoundedJson(terrainBytes), 'Resume terrain descriptor');
      if (descriptor.dataId !== current.terrain.dataId || descriptor.gridHash !== current.terrain.gridHash
          || descriptor.coverageHash !== current.terrain.coverageHash || descriptor.layoutVersion !== current.terrain.layoutVersion) throw new Error('Resume terrain binding mismatch');
    }
  }
}

/** Revalidate an existing artifact under the same authority, without repeating acquisition or science. */
export async function resumePublication(sourceRevision: string, store?: ObjectStorage): Promise<void> {
  await publicationWorkflow('resume', async ({ root, signal, store, model, identifyBuild, commit }) => {
    const runId = process.env.RESUME_RUN_ID;
    if (!/^\d+$/.test(runId ?? '')) throw new Error('Invalid resume workflow identity');
    const builds = await readdir(join(root, 'builds', model), { withFileTypes: true });
    if (builds.length !== 1 || !builds[0].isDirectory() || !/^\d{8}T\d{6}Z-[a-f0-9-]{36}$/.test(builds[0].name)) throw new Error('Resume artifact must contain exactly one build');
    identifyBuild(builds[0].name);
    const path = join(root, 'builds', model, builds[0].name, 'manifest.json');
    const bytes = await readLocalFile(path, MAX_MANIFEST_BYTES).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new Error(`Resume artifact is incomplete: missing manifest.json for ${model}/${builds[0].name}; start a fresh forecast without resume-run-id`, { cause: error });
      }
      throw error;
    });
    const raw = record(parseBoundedJson(bytes, MAX_MANIFEST_JSON_TOKENS), 'Resume manifest');
    if (raw.version === 3 || raw.version === 4) throw new Error('Resume requires a whole-domain v5 build; start a fresh forecast without resume-run-id');
    const manifest = manifestV5Schema.parse(raw);
    if (manifest.model !== model || manifest.buildId !== builds[0].name) throw new Error('Resume manifest differs from its artifact path');
    if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? '') || manifest.recipe.sourceRevision !== sourceRevision || manifest.recipe.sourceDirty) throw new Error('Resume source does not match the verified workflow artifact');
    const { readBuildPlan } = await import('../apps/batch/src/parallel.js');
    const plan = await readBuildPlan(join(root, 'plan.json')).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new Error('Resume artifact is incomplete: missing plan.json for whole-domain build; start a fresh forecast without resume-run-id', { cause: error });
      }
      throw error;
    });
    if (plan.model !== manifest.model || plan.buildId !== manifest.buildId || plan.cycle !== manifest.cycle
        || plan.createdAt !== manifest.createdAt || !sameJsonValue(plan.recipe, manifest.recipe)) {
      throw new Error('Resume plan differs from the retained whole-domain manifest');
    }
    const planDeadline = forecastPlanDeadline(plan);
    const committedOnly = Date.now() >= planDeadline;
    if (committedOnly) {
      const pointer = (await readPointer(store, model, signal)).pointer;
      const retained = pointer?.retained.find(item => item.buildId === manifest.buildId);
      if (pointer?.latestBuildId !== manifest.buildId || retained?.manifestKey !== `builds/${model}/${manifest.buildId}/manifest.json` || retained.cycle !== manifest.cycle || retained.expiresAt !== manifest.expiresAt) throw new Error('Forecast publication deadline exceeded');
    }
    const deadline = committedOnly ? Date.now() + 5 * 60_000 : planDeadline;
    const deadlineAt = new Date(deadline).toISOString();
    const deadlineSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
    const grouped = manifest.surfaces.some(surface => surface.samples.format === 'frame-group-block-shards-v1');
    let receiptsOnly = false;
    if (grouped) for (const object of forecastObjects(manifest)) {
      try { if (!(await stat(localPath(root, object.key))).isFile()) receiptsOnly = true; }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; receiptsOnly = true; }
      if (receiptsOnly) break;
    }
    await assertV5ResumeIdentity(manifest, plan, root, deadlineSignal, receiptsOnly);
    deadlineSignal.throwIfAborted();
    await commit(manifest, path, runId, undefined, { deadlineAt, receiptsOnly, committedOnly });
  }, store);
}

/** Artifact names alone do not establish that a build came from the authorized publisher. */
export function forecastArtifactRevision(raw: unknown, repository: string, runId: string): string {
  const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const run = object(raw);
  if (!run || !Number.isSafeInteger(run.id) || String(run.id) !== runId || !/^[1-9]\d*$/.test(runId)
      || run.path !== '.github/workflows/forecast.yml' || run.head_branch !== 'main' || typeof run.head_sha !== 'string' || !/^[a-f0-9]{40}$/.test(run.head_sha)
      || (run.event !== 'schedule' && run.event !== 'workflow_dispatch' && run.event !== 'repository_dispatch') || run.status !== 'completed' || !Number.isSafeInteger(run.run_attempt) || (run.run_attempt as number) < 1
      || object(run.repository)?.full_name !== repository || object(run.head_repository)?.full_name !== repository) throw new Error('Source run is not a completed authorized main forecast');
  return run.head_sha;
}
