import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

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

export async function checkForecastArtifact(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY, runId = process.env.SOURCE_RUN_ID;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !runId || !/^\d+$/.test(runId) || !process.env.GITHUB_ENV) throw new Error('Invalid source artifact workflow context');
  const { stdout } = await promisify(execFile)('gh', ['api', `repos/${repository}/actions/runs/${runId}`], { timeout: 15_000, maxBuffer: 1024 * 1024 });
  const revision = forecastArtifactRevision(JSON.parse(stdout), repository, runId);
  await appendFile(process.env.GITHUB_ENV, `SOURCE_BUILD_REVISION=${revision}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkForecastArtifact().catch(error => { console.error(error); process.exitCode = 1; });
}
