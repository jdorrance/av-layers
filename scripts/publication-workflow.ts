import { execFile } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { forecastObjectsV5, getProduct, publishedManifestSchema, MAX_COVERAGE_BITSET_BYTES, MAX_COVERAGE_DESCRIPTOR_BYTES, MAX_MANIFEST_BYTES, MAX_SPARSE_COVERAGE_BYTES, decodeSparseCoverage, parseBoundedJson, validateArtifactRecordsV5, type ManifestV5, type PublishedManifest } from '@av/contracts';
import { buildIdentity } from '../apps/batch/src/identity.js';
import { readLocalFile } from '../apps/batch/src/local-file.js';
import { checkPerformance } from '../apps/batch/src/capacity.js';
import { workflowAuthority, workflowContext } from '../apps/batch/src/authority.js';
import { cleanup, publish, readPointer, type CleanupSummary } from '../apps/batch/src/publication.js';
import { getForecastProvider } from '../apps/batch/src/providers.js';
import { MAX_FORECAST_SHARDS, type BuildPlan } from '../apps/batch/src/parallel.js';
import { r2Storage, type ObjectStorage } from '../apps/batch/src/storage.js';
import { localPath, sha256, type ValidatedBuild } from '../apps/batch/src/validate.js';
import { validateApiBaseUrl, verifyPublishedForecast } from './smoke-api.js';
import { configuredRefinements } from '../apps/batch/src/refinement/config.js';
import { terrainCatalogInput, terrainInputForModel } from './terrain-inputs.js';

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

/** Build and artifact-resume use the same writer, cancellation and durable outcome protocol. */
export async function publicationWorkflow<T>(work: (run: {
  root: string; signal: AbortSignal; store: ObjectStorage; model: string;
  commit(manifest: PublishedManifest, path: string, resumedFromRun?: string, validated?: ValidatedBuild, options?: { deadlineAt?: string; receiptsOnly?: boolean; committedOnly?: boolean }): Promise<void>;
}) => Promise<T>, store?: ObjectStorage): Promise<T> {
  const { revision } = workflowContext();
  const authority = workflowAuthority(), root = 'output', controller = new AbortController(), storage = store ?? r2Storage();
  const abort = (): void => controller.abort(new Error('Publication interrupted'));
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  let publicationPath: string | undefined, committed = false, publicationAttempted = false;
  try {
    return await work({ root, signal: controller.signal, store: storage, model: authority.model, async commit(manifest, path, resumedFromRun, validated, options) {
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
      console.log(`Published ${manifest.buildId}`);
      // Record commit first; cancellation or maintenance failure must never masquerade as failed publication.
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
        await writeFile(join(dirname(path), 'maintenance.json'), JSON.stringify({ status: 'failed', publication: 'committed', maintenanceWallMs: Date.now() - maintenanceStarted, error: String(error), summary: summary ?? null, authority }, null, 2));
        throw new Error(`Publication committed; maintenance failed: ${String(error)}`);
      }
      const servingPath = join(dirname(path), 'serving.json');
      const smokeStarted = Date.now();
      try {
        signal.throwIfAborted();
        await verifyPublishedForecast({ baseUrl: apiUrl.origin, manifest, signal });
        await writeFile(servingPath, JSON.stringify({ status: 'verified', publication: 'committed', smokeVerifyWallMs: Date.now() - smokeStarted, model: manifest.model, buildId: manifest.buildId, frames: manifest.frames, layers: manifest.layers, apiBaseUrl: apiUrl.origin }, null, 2));
      } catch (error) {
        await writeFile(servingPath, JSON.stringify({ status: 'failed', publication: 'committed', smokeVerifyWallMs: Date.now() - smokeStarted, model: manifest.model, buildId: manifest.buildId, error: String(error) }, null, 2));
        throw new Error(`Publication committed; serving verification failed: ${String(error)}`);
      }
    } });
  } catch (error) {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'failure.json'), JSON.stringify({ at: new Date().toISOString(), revision, authority, publicationPath, publication: committed ? 'committed' : publicationAttempted ? 'unconfirmed' : 'not-attempted', cancelled: controller.signal.aborted, error: String(error) }, null, 2));
    throw error;
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
  }
}

export function configuredWholeDomain(model: string, env: NodeJS.ProcessEnv, store: ObjectStorage) {
  const product = getProduct(model);
  if (!product) throw new Error(`No forecast product for ${model}`);
  const factor = product.terrainSubdivisionFactor;
  if (factor === undefined) return undefined;
  if (!Number.isSafeInteger(factor) || factor < 1) throw new Error(`Invalid terrain subdivision factor for ${model}`);
  const catalog = env.TERRAIN_CATALOG_REF;
  if (!catalog) throw new Error(`TERRAIN_CATALOG_REF is required for configured whole-domain ${model} build`);
  return { catalogRef: terrainCatalogInput(catalog), storage: store };
}

/** Populate immutable terrain before the forecast build clock starts. */
export async function prepareForecastTerrain(store?: ObjectStorage): Promise<void> {
  await publicationWorkflow(async ({ signal, store, model }) => {
    const product = getProduct(model);
    if (!product) throw new Error(`No forecast product for ${model}`);
    const wholeDomain = configuredWholeDomain(model, process.env, store);
    if (!wholeDomain) return;
    const [{ wholeDomainPlan, loadBundledFineCoverage }, { ensureWholeDomainTerrain }] = await Promise.all([
      import('../apps/batch/src/whole-domain/coverage.js'), import('../apps/batch/src/whole-domain/terrain.js')
    ]);
    const plan = wholeDomainPlan(product);
    if (!plan) throw new Error(`No whole-domain terrain grid for ${model}`);
    const fine = await loadBundledFineCoverage(product, plan);
    const ref = await ensureWholeDomainTerrain({ ...wholeDomain, sourceCacheDir: join('.cache', 'terrain-source', model), grid: plan.fine,
      coverage: fine.mask.coverage, coverageDescriptor: fine.bytes, signal });
    console.log(JSON.stringify({ phase: 'terrain-ready', model, ...ref }));
  }, store);
}

/** Resolve the cycle once before independent workers receive the immutable plan. */
export async function planForecast(store?: ObjectStorage): Promise<BuildPlan | null> {
  return publicationWorkflow(async ({ root, signal, store, model }) => {
    const cacheDir = `.cache/${model}`;
    console.error(JSON.stringify({ phase: 'cycle-discovery', model, state: 'started' }));
    const cycle = await getForecastProvider(model).resolveCycle({ cycle: process.env.CYCLE || undefined, cacheDir, signal });
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
    const product = getProduct(model);
    if (!product) throw new Error(`No forecast product for ${model}`);
    const wholeDomain = configuredWholeDomain(model, process.env, store);
    const refinement = !wholeDomain && process.env.TERRAIN_CATALOG_REF && configuredRefinements(product).length
      ? { catalogRef: terrainCatalogInput(process.env.TERRAIN_CATALOG_REF), storage: store }
      : undefined;
    const terrain = process.env.TERRAIN_INPUTS ? terrainInputForModel(process.env.TERRAIN_INPUTS, model) : undefined;
    const options = { out: root, cycle, shards: MAX_FORECAST_SHARDS, signal, store, ...(terrain ? { terrain: { ref: terrain, storage: store } } : {}),
      ...(refinement ? { refinement } : {}), ...(wholeDomain ? { wholeDomain: { ...wholeDomain, cacheOnly: true } } : {}) };
    const plan = await createForecastPlan(model, options);
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
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    await assertPlannedModel(authority.model);
    const { buildForecastShard, readBuildPlan } = await import('../apps/batch/src/parallel.js');
    const plan = await readBuildPlan('output/plan.json');
    const prefix = `builds/${authority.model}/${plan.buildId}/`;
    const assertReadable = (key: string): void => {
      if (!key.startsWith(prefix) && !/^coverage\/[a-f0-9]{64}\/(manifest\.json|sparse\.bin|tiles\.bin)$/.test(key)
          && !/^terrain\/prepared\/[a-f0-9]{64}\/[a-z0-9.-]+$/.test(key)) throw new Error('Shard storage cannot read this key');
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
    await buildForecastShard('output/plan.json', shard, { out: 'output', cacheDir: `.cache/${authority.model}`, signal: controller.signal, store: scopedStore });
    await writeFile(join('output', 'shards', String(shard), 'workflow-metrics.json'), JSON.stringify({ shardSetupWallMs, rssBytes: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024 }));
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
  }
}

/** Only the complete, validated shard set can enter the existing publication protocol. */
export async function finalizeAndPublish(store?: ObjectStorage): Promise<void> {
  await publicationWorkflow(async ({ root, signal, store, model, commit }) => {
    await assertPlannedModel(model);
    const { finalizeForecastBuild, readBuildPlan } = await import('../apps/batch/src/parallel.js');
    const plan = await readBuildPlan(join(root, 'plan.json'));
    await finalizeForecastBuild(join(root, 'plan.json'), { out: root, signal, store, onValidated: (validated, path) => commit(validated.manifest, path, undefined, validated, { deadlineAt: plan.deadlineAt, receiptsOnly: Boolean(plan.wholeDomain) }) });
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
  const product = getProduct(manifest.model);
  if (!product) throw new Error('Resume product is not registered');
  const factor = product.terrainSubdivisionFactor;
  if (factor === undefined || frozen.k !== factor) throw new Error('Resume whole-domain subdivision factor differs');
  const native = manifest.surfaces.find(surface => surface.kind === 'native');
  if (native && native.coverage.hash !== frozen.nativeCoverageHash) throw new Error('Resume native coverage identity differs');
  const fine = manifest.surfaces.filter(surface => surface.kind === 'fine');
  if (fine.length !== 1) throw new Error('Resume v5 manifest requires one fine surface');
  const surface = fine[0]!, terrain = surface.terrain!;
  if (surface.coverage.id !== frozen.fineCoverage.id || surface.coverage.hash !== frozen.fineCoverage.hash
      || surface.coverage.maskKey !== frozen.fineCoverage.maskKey || surface.coverage.maxZoom !== frozen.fineCoverage.maxZoom
      || surface.gridHash !== frozen.fineCoverage.gridHash || terrain.key !== frozen.terrain.key || terrain.sha256 !== frozen.terrain.sha256) {
    throw new Error('Resume whole-domain coverage or terrain identity differs');
  }
  const identity = await buildIdentity(product, frozen.nativeCoverageHash, undefined, [], undefined,
    { k: frozen.k, nativeCoverageHash: frozen.nativeCoverageHash, fineCoverageHash: frozen.fineCoverage.hash, fineGridHash: frozen.fineCoverage.gridHash, terrain: frozen.terrain });
  if (identity.recipe.hash !== manifest.recipe.hash) throw new Error('Resume recipe differs from current code/configuration; build a fresh forecast');
  for (const current of manifest.surfaces) {
    signal?.throwIfAborted();
    const descriptorBytes = await readLocalFile(localPath(root, current.coverage.maskKey), MAX_COVERAGE_DESCRIPTOR_BYTES);
    if (sha256(descriptorBytes) !== current.coverage.hash) throw new Error('Resume coverage descriptor hash mismatch');
    const descriptor = record(parseBoundedJson(descriptorBytes), 'Resume coverage descriptor');
    if (descriptor.gridHash !== current.gridHash || descriptor.maxZoom !== current.coverage.maxZoom) throw new Error('Resume coverage descriptor binding mismatch');
    const files = record(descriptor.files, 'Resume coverage files'), sparseFile = record(files.sparse, 'Resume sparse coverage'), tilesFile = record(files.tiles, 'Resume tiles coverage');
    const prefix = dirname(current.coverage.maskKey);
    const sparse = await readLocalFile(localPath(root, `${prefix}/sparse.bin`), MAX_SPARSE_COVERAGE_BYTES, sparseFile.bytes as number);
    if (sha256(sparse) !== sparseFile.sha256) throw new Error('Resume sparse coverage hash mismatch');
    const coverage = decodeSparseCoverage(new Uint8Array(sparse.buffer, sparse.byteOffset, sparse.byteLength), current.gridHash);
    if (coverage.width !== current.grid.width || coverage.height !== current.grid.height || coverage.blockIds.length !== current.samples.blockCount) throw new Error('Resume sparse coverage layout mismatch');
    const tiles = await readLocalFile(localPath(root, `${prefix}/tiles.bin`), MAX_COVERAGE_BITSET_BYTES, tilesFile.bytes as number);
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
  await publicationWorkflow(async ({ root, signal, store, model, commit }) => {
    const runId = process.env.RESUME_RUN_ID;
    if (!/^\d+$/.test(runId ?? '')) throw new Error('Invalid resume workflow identity');
    const builds = await readdir(join(root, 'builds', model), { withFileTypes: true });
    if (builds.length !== 1 || !builds[0].isDirectory() || !/^\d{8}T\d{6}Z-[a-f0-9-]{36}$/.test(builds[0].name)) throw new Error('Resume artifact must contain exactly one build');
    const path = join(root, 'builds', model, builds[0].name, 'manifest.json');
    const bytes = await readLocalFile(path, MAX_MANIFEST_BYTES).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new Error(`Resume artifact is incomplete: missing manifest.json for ${model}/${builds[0].name}; start a fresh forecast without resume-run-id`, { cause: error });
      }
      throw error;
    });
    const manifest = publishedManifestSchema.parse(parseBoundedJson(bytes));
    if (manifest.model !== model || manifest.buildId !== builds[0].name) throw new Error('Resume manifest differs from its artifact path');
    if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? '') || manifest.recipe.sourceRevision !== sourceRevision || manifest.recipe.sourceDirty) throw new Error('Resume source does not match the verified workflow artifact');
    const product = getProduct(manifest.model), same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
    if (manifest.version === 5) {
      const { readBuildPlan } = await import('../apps/batch/src/parallel.js');
      const plan = await readBuildPlan(join(root, 'plan.json')).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
          throw new Error('Resume artifact is incomplete: missing plan.json for whole-domain build; start a fresh forecast without resume-run-id', { cause: error });
        }
        throw error;
      });
      if (plan.model !== manifest.model || plan.buildId !== manifest.buildId || plan.cycle !== manifest.cycle
          || plan.createdAt !== manifest.createdAt || !same(plan.recipe, manifest.recipe)) {
        throw new Error('Resume plan differs from the retained whole-domain manifest');
      }
      const committedOnly = Boolean(plan.deadlineAt && Date.now() >= Date.parse(plan.deadlineAt));
      if (committedOnly) {
        const pointer = (await readPointer(store, model, signal)).pointer;
        const retained = pointer?.retained.find(item => item.buildId === manifest.buildId);
        if (pointer?.latestBuildId !== manifest.buildId || retained?.manifestKey !== `builds/${model}/${manifest.buildId}/manifest.json` || retained.cycle !== manifest.cycle || retained.expiresAt !== manifest.expiresAt) throw new Error('Forecast publication deadline exceeded');
      }
      const deadlineAt = committedOnly ? new Date(Date.now() + 5 * 60_000).toISOString() : plan.deadlineAt;
      const deadlineSignal = deadlineAt ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Date.parse(deadlineAt) - Date.now()))]) : signal;
      const grouped = manifest.surfaces.some(surface => surface.samples.format === 'frame-group-block-shards-v1');
      let receiptsOnly = false;
      if (grouped) for (const object of forecastObjectsV5(manifest)) {
        try { if (!(await stat(localPath(root, object.key))).isFile()) receiptsOnly = true; }
        catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; receiptsOnly = true; }
        if (receiptsOnly) break;
      }
      await assertV5ResumeIdentity(manifest, plan, root, deadlineSignal, receiptsOnly);
      if (receiptsOnly) {
        const { verifyBuildReceipts } = await import('../apps/batch/src/parallel.js');
        await verifyBuildReceipts(root, manifest, store, deadlineSignal);
      }
      deadlineSignal.throwIfAborted();
      await commit(manifest, path, runId, undefined, { deadlineAt, receiptsOnly, committedOnly });
      return;
    }
    let terrain;
    if (manifest.source.terrain !== undefined) {
      const { preparedTerrainRefSchema } = await import('../apps/batch/src/terrain/prepare.js');
      terrain = preparedTerrainRefSchema.parse(manifest.source.terrain);
    }
    let refinements;
    if (manifest.version === 4) {
      const { readBuildPlan } = await import('../apps/batch/src/parallel.js');
      const plan = await readBuildPlan(join(root, 'plan.json')).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
          throw new Error('Resume artifact is incomplete: missing plan.json for refined build; start a fresh forecast without resume-run-id', { cause: error });
        }
        throw error;
      });
      if (plan.model !== manifest.model || plan.buildId !== manifest.buildId || plan.cycle !== manifest.cycle
          || plan.createdAt !== manifest.createdAt || plan.coverageHash !== manifest.coverage.hash
          || !same(plan.recipe, manifest.recipe) || !same(plan.terrain, terrain)
          || !same(plan.refinements?.map(input => ({ id: input.id, grid: input.grid, coverage: input.coverage,
            geometry: input.geometry, bounds: input.bounds, terrain: { key: input.terrain.key, sha256: input.terrain.sha256 } })),
          manifest.patches!.map(patch => ({ id: patch.id, grid: patch.grid, coverage: patch.coverage,
            geometry: patch.geometry, bounds: patch.descriptors.bounds, terrain: { key: patch.terrain.key, sha256: patch.terrain.sha256 } })))) {
        throw new Error('Resume plan differs from the retained refined manifest');
      }
      refinements = plan.refinements;
    }
    const identity = product && (refinements ? await buildIdentity(product, manifest.coverage.hash, terrain, refinements) : await buildIdentity(product, manifest.coverage.hash, terrain));
    if (!identity || manifest.recipe.hash !== identity.recipe.hash) throw new Error('Resume recipe differs from current code/configuration; build a fresh forecast');
    signal.throwIfAborted();
    await commit(manifest, path, runId);
  }, store);
}

/** Artifact names alone do not establish that a build came from the authorized publisher. */
export function forecastArtifactRevision(raw: unknown, repository: string, runId: string): string {
  const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const run = object(raw);
  if (!run || !Number.isSafeInteger(run.id) || String(run.id) !== runId || !/^[1-9]\d*$/.test(runId)
      || run.path !== '.github/workflows/forecast.yml' || run.head_branch !== 'main' || typeof run.head_sha !== 'string' || !/^[a-f0-9]{40}$/.test(run.head_sha)
      || (run.event !== 'schedule' && run.event !== 'workflow_dispatch') || run.status !== 'completed' || !Number.isSafeInteger(run.run_attempt) || (run.run_attempt as number) < 1
      || object(run.repository)?.full_name !== repository || object(run.head_repository)?.full_name !== repository) throw new Error('Source run is not a completed authorized main forecast');
  return run.head_sha;
}
