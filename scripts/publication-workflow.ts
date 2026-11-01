import { execFile } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Manifest } from '@av/contracts';
import { checkPerformance } from '../apps/batch/src/capacity.js';
import { workflowAuthority } from '../apps/batch/src/authority.js';
import { cleanup, publish, type CleanupSummary } from '../apps/batch/src/publication.js';
import { r2Storage } from '../apps/batch/src/storage.js';
import { wasValidatedInProcess } from '../apps/batch/src/validate.js';

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
      if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `MANIFEST=${path}\n`);
      const budget = checkPerformance(manifest);
      await writeFile(join(dirname(path), 'performance.json'), JSON.stringify(budget, null, 2));
      if (!budget.passed) throw new Error(`Performance budget failed: ${budget.failures.join('; ')}`);
      const { stdout } = await promisify(execFile)('gh', ['api', `repos/${repository}/git/ref/heads/main`, '--jq', '.object.sha'], { timeout: 15_000, signal: controller.signal });
      if (stdout.trim() !== revision) throw new Error('This revision was superseded during the build; rerun the latest revision before publishing');
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
