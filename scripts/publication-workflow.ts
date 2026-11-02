import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { getProduct, manifestSchema, MAX_MANIFEST_BYTES, parseBoundedJson, type Manifest } from '@av/contracts';
import { buildIdentity } from '../apps/batch/src/identity.js';
import { readLocalFile } from '../apps/batch/src/local-file.js';
import { checkPerformance } from '../apps/batch/src/capacity.js';
import { workflowAuthority } from '../apps/batch/src/authority.js';
import { cleanup, publish, readPointer, type CleanupSummary } from '../apps/batch/src/publication.js';
import { discoverGfsRun } from '../apps/batch/src/noaa/discover.js';
import { validateCycle } from '../apps/batch/src/noaa/acquire.js';
import { r2Storage } from '../apps/batch/src/storage.js';
import { wasValidatedInProcess } from '../apps/batch/src/validate.js';

function workflowContext(): { repository: string; revision: string } {
  const repository = process.env.GITHUB_REPOSITORY, revision = process.env.GITHUB_SHA;
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main' || !repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !revision || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Operations require the GitHub workflow on main');
  return { repository, revision };
}

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
  await promisify(execFile)('gh', ['run', 'download', runId, '--repo', repository, '--name', `forecast-gfs-${runId}`, '--dir', root], { timeout: 5 * 60_000, maxBuffer: 1024 * 1024 });
  return revision;
}

/** Build and artifact-resume use the same writer, cancellation and durable outcome protocol. */
export async function publicationWorkflow(work: (run: {
  root: string; signal: AbortSignal;
  commit(manifest: Manifest, path: string, resumedFromRun?: string): Promise<void>;
}) => Promise<void>): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY, revision = process.env.GITHUB_SHA;
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main' || !repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !revision || !/^[a-f0-9]{40}$/.test(revision) || process.env.MODEL !== 'gfs') {
    throw new Error('This entry point requires the forecast workflow on main');
  }
  const authority = workflowAuthority(), root = 'output', controller = new AbortController();
  const abort = (): void => controller.abort(new Error('Publication interrupted'));
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  let publicationPath: string | undefined, committed = false, publicationAttempted = false;
  try {
    await work({ root, signal: controller.signal, async commit(manifest, path, resumedFromRun) {
      controller.signal.throwIfAborted();
      const budget = checkPerformance(manifest);
      await writeFile(join(dirname(path), 'performance.json'), JSON.stringify(budget, null, 2));
      if (!budget.passed) throw new Error(`Performance budget failed: ${budget.failures.join('; ')}`);
      await assertCurrentMain(controller.signal);
      const started = Date.now(), store = r2Storage(), validationReused = wasValidatedInProcess(root, manifest);
      publicationPath = join(dirname(path), 'publication.json');
      publicationAttempted = true;
      await publish(store, root, manifest, { authority, signal: controller.signal, allowSameCycle: process.env.ALLOW_SAME_CYCLE === 'true' });
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
        const deletedObjects = await cleanup(store, manifest.model, authority, Date.now(), report => { summary = report; }, controller.signal);
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

/** The one writer workflow retains validation and owns exclusion through publication and cleanup. */
export async function buildAndPublish(): Promise<void> {
  await publicationWorkflow(async ({ root, signal, commit }) => {
    const cacheDir = '.cache/gfs';
    const cycle = validateCycle(process.env.CYCLE || (await discoverGfsRun({ cacheDir, signal })).cycle);
    const { pointer } = await readPointer(r2Storage(), 'gfs', signal);
    signal.throwIfAborted();
    if (pointer) {
      // Use every retained cycle, just like publish(), including after rollback.
      const latestCycle = Math.max(...pointer.retained.map(item => Date.parse(item.cycle)));
      if (Date.parse(cycle) < latestCycle) throw new Error('Older cycle cannot be published');
      if (Date.parse(cycle) === latestCycle && process.env.ALLOW_SAME_CYCLE !== 'true') {
        if (process.env.GITHUB_EVENT_NAME === 'schedule') {
          console.log(`Skipped scheduled GFS build: cycle ${cycle} was already published. No new build was produced.`);
          return;
        }
        throw new Error('This cycle was already published; set allow-same-cycle=true for an intentional replacement');
      }
    }
    const { buildSample } = await import('../apps/batch/src/build.js');
    await buildSample({ out: root, signal, cycle, cacheDir, onValidated: commit });
  });
}


/** Revalidate an existing artifact under the same authority, without repeating acquisition or science. */
export async function resumePublication(sourceRevision: string): Promise<void> {
  await publicationWorkflow(async ({ root, signal, commit }) => {
    const runId = process.env.RESUME_RUN_ID;
    if (!/^\d+$/.test(runId ?? '')) throw new Error('Invalid resume workflow identity');
    const builds = await readdir(join(root, 'builds', 'gfs'), { withFileTypes: true });
    if (builds.length !== 1 || !builds[0].isDirectory() || !/^\d{8}T\d{6}Z-[a-f0-9-]{36}$/.test(builds[0].name)) throw new Error('Resume artifact must contain exactly one build');
    const path = join(root, 'builds', 'gfs', builds[0].name, 'manifest.json');
    const manifest = manifestSchema.parse(parseBoundedJson(await readLocalFile(path, MAX_MANIFEST_BYTES)));
    if (manifest.model !== 'gfs' || manifest.buildId !== builds[0].name) throw new Error('Resume manifest differs from its artifact path');
    if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? '') || manifest.recipe.sourceRevision !== sourceRevision || manifest.recipe.sourceDirty) throw new Error('Resume source does not match the verified workflow artifact');
    const product = getProduct(manifest.model);
    if (!product || manifest.recipe.hash !== (await buildIdentity(product, manifest.coverage.hash)).recipe.hash) throw new Error('Resume recipe differs from current code/configuration; build a fresh forecast');
    signal.throwIfAborted();
    await commit(manifest, path, runId);
  });
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
