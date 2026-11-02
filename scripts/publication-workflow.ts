import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { getProduct, manifestSchema, MAX_MANIFEST_BYTES, parseBoundedJson, type Manifest } from '@av/contracts';
import { buildIdentity } from '../apps/batch/src/identity.js';
import { readLocalFile } from '../apps/batch/src/local-file.js';
import { checkPerformance } from '../apps/batch/src/capacity.js';
import { workflowAuthority, workflowContext } from '../apps/batch/src/authority.js';
import { cleanup, publish, readPointer, type CleanupSummary } from '../apps/batch/src/publication.js';
import { getForecastProvider } from '../apps/batch/src/providers.js';
import { MAX_FORECAST_SHARDS } from '../apps/batch/src/parallel.js';
import { r2Storage, type ObjectStorage } from '../apps/batch/src/storage.js';
import type { ValidatedBuild } from '../apps/batch/src/validate.js';

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
  const revision = forecastArtifactRevision(JSON.parse(stdout), repository, runId);
  await promisify(execFile)('gh', ['run', 'download', runId, '--repo', repository, '--name', `forecast-${workflowAuthority().model}-${runId}`, '--dir', root], { timeout: 5 * 60_000, maxBuffer: 1024 * 1024 });
  return revision;
}

/** Build and artifact-resume use the same writer, cancellation and durable outcome protocol. */
export async function publicationWorkflow<T>(work: (run: {
  root: string; signal: AbortSignal; store: ObjectStorage; model: string;
  commit(manifest: Manifest, path: string, resumedFromRun?: string, validated?: ValidatedBuild): Promise<void>;
}) => Promise<T>, store?: ObjectStorage): Promise<T> {
  const { revision } = workflowContext();
  const authority = workflowAuthority(), root = 'output', controller = new AbortController(), storage = store ?? r2Storage();
  const abort = (): void => controller.abort(new Error('Publication interrupted'));
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  let publicationPath: string | undefined, committed = false, publicationAttempted = false;
  try {
    return await work({ root, signal: controller.signal, store: storage, model: authority.model, async commit(manifest, path, resumedFromRun, validated) {
      controller.signal.throwIfAborted();
      const budget = checkPerformance(manifest);
      await writeFile(join(dirname(path), 'performance.json'), JSON.stringify(budget, null, 2));
      if (!budget.passed) throw new Error(`Performance budget failed: ${budget.failures.join('; ')}`);
      await assertCurrentMain(controller.signal);
      const started = Date.now(), validationReused = validated !== undefined;
      publicationPath = join(dirname(path), 'publication.json');
      publicationAttempted = true;
      await publish(storage, root, manifest, { authority, signal: controller.signal, allowSameCycle: process.env.ALLOW_SAME_CYCLE === 'true', validated });
      committed = true;
      await writeFile(publicationPath, JSON.stringify({ version: 1, status: 'committed', buildId: manifest.buildId, resumedFromRun, elapsedMs: Date.now() - started, peakRssBytes: process.resourceUsage().maxRSS * 1024, validationReused }, null, 2));
      console.log(`Published ${manifest.buildId}`);
      // Record commit first; cancellation or maintenance failure must never masquerade as failed publication.
      if (controller.signal.aborted) {
        await writeFile(join(dirname(path), 'maintenance.json'), JSON.stringify({ status: 'deferred', publication: 'committed', reason: 'cancelled-after-commit', summary: null, authority }, null, 2));
        controller.signal.throwIfAborted();
      }
      let summary: CleanupSummary | undefined;
      try {
        await writeFile(join(dirname(path), 'maintenance.json'), JSON.stringify({ status: 'running', publication: 'committed', summary: null, authority }, null, 2));
        const deletedObjects = await cleanup(storage, manifest.model, authority, Date.now(), report => { summary = report; }, controller.signal);
        await writeFile(join(dirname(path), 'maintenance.json'), JSON.stringify({ status: 'complete', deletedObjects, summary: summary ?? null, authority }, null, 2));
      } catch (error) {
        await writeFile(join(dirname(path), 'maintenance.json'), JSON.stringify({ status: 'failed', publication: 'committed', error: String(error), summary: summary ?? null, authority }, null, 2));
        throw new Error(`Publication committed; maintenance failed: ${String(error)}`);
      }
      controller.signal.throwIfAborted();
    } });
  } catch (error) {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'failure.json'), JSON.stringify({ at: new Date().toISOString(), revision, authority, publicationPath, publication: committed ? 'committed' : publicationAttempted ? 'unconfirmed' : 'not-attempted', cancelled: controller.signal.aborted, error: String(error) }, null, 2));
    throw error;
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
  }
}

/** Resolve the cycle once before independent workers receive the immutable plan. */
export async function planForecast(store?: ObjectStorage): Promise<{ planPath: string; shards: number[] } | null> {
  return publicationWorkflow(async ({ root, signal, store, model }) => {
    const cacheDir = `.cache/${model}`;
    const cycle = await getForecastProvider(model).resolveCycle({ cycle: process.env.CYCLE || undefined, cacheDir, signal });
    const { pointer } = await readPointer(store, model, signal);
    signal.throwIfAborted();
    if (pointer) {
      // Use every retained cycle, just like publish(), including after rollback.
      const latestCycle = Math.max(...pointer.retained.map(item => Date.parse(item.cycle)));
      if (Date.parse(cycle) < latestCycle) throw new Error('Older cycle cannot be published');
      if (Date.parse(cycle) === latestCycle && process.env.ALLOW_SAME_CYCLE !== 'true') {
        if (process.env.GITHUB_EVENT_NAME === 'schedule') {
          console.log(`Skipped scheduled ${model} build: cycle ${cycle} was already published. No new build was produced.`);
          return null;
        }
        throw new Error('This cycle was already published; set allow-same-cycle=true for an intentional replacement');
      }
    }
    const { createForecastPlan } = await import('../apps/batch/src/parallel.js');
    return createForecastPlan(model, { out: root, cycle, shards: MAX_FORECAST_SHARDS, signal });
  }, store);
}

async function assertPlannedModel(model: string): Promise<void> {
  const raw = parseBoundedJson(await readLocalFile('output/plan.json', MAX_MANIFEST_BYTES));
  if (!raw || typeof raw !== 'object' || !('model' in raw) || raw.model !== model) throw new Error('Forecast plan differs from the workflow model');
}

/** Shard workers have no publication storage or credentials. */
export async function runForecastShard(shard: number): Promise<void> {
  const authority = workflowAuthority();
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error('Forecast shard interrupted'));
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    await assertPlannedModel(authority.model);
    const { buildForecastShard } = await import('../apps/batch/src/parallel.js');
    await buildForecastShard('output/plan.json', shard, { out: 'output', cacheDir: `.cache/${authority.model}`, signal: controller.signal });
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
  }
}

/** Only the complete, validated shard set can enter the existing publication protocol. */
export async function finalizeAndPublish(store?: ObjectStorage): Promise<void> {
  await publicationWorkflow(async ({ root, signal, model, commit }) => {
    await assertPlannedModel(model);
    const { finalizeForecastBuild } = await import('../apps/batch/src/parallel.js');
    await finalizeForecastBuild(join(root, 'plan.json'), { out: root, signal, onValidated: (validated, path) => commit(validated.manifest, path, undefined, validated) });
  }, store);
}

/** Revalidate an existing artifact under the same authority, without repeating acquisition or science. */
export async function resumePublication(sourceRevision: string, store?: ObjectStorage): Promise<void> {
  await publicationWorkflow(async ({ root, signal, model, commit }) => {
    const runId = process.env.RESUME_RUN_ID;
    if (!/^\d+$/.test(runId ?? '')) throw new Error('Invalid resume workflow identity');
    const builds = await readdir(join(root, 'builds', model), { withFileTypes: true });
    if (builds.length !== 1 || !builds[0].isDirectory() || !/^\d{8}T\d{6}Z-[a-f0-9-]{36}$/.test(builds[0].name)) throw new Error('Resume artifact must contain exactly one build');
    const path = join(root, 'builds', model, builds[0].name, 'manifest.json');
    const manifest = manifestSchema.parse(parseBoundedJson(await readLocalFile(path, MAX_MANIFEST_BYTES)));
    if (manifest.model !== model || manifest.buildId !== builds[0].name) throw new Error('Resume manifest differs from its artifact path');
    if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? '') || manifest.recipe.sourceRevision !== sourceRevision || manifest.recipe.sourceDirty) throw new Error('Resume source does not match the verified workflow artifact');
    const product = getProduct(manifest.model);
    if (!product || manifest.recipe.hash !== (await buildIdentity(product, manifest.coverage.hash)).recipe.hash) throw new Error('Resume recipe differs from current code/configuration; build a fresh forecast');
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
      || (run.event !== 'schedule' && run.event !== 'workflow_dispatch') || run.status !== 'completed'
      || object(run.repository)?.full_name !== repository || object(run.head_repository)?.full_name !== repository) throw new Error('Source run is not a completed authorized main forecast');
  return run.head_sha;
}
