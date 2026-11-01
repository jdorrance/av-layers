import { expect, it } from 'vitest';
import { forecastArtifactRevision } from './check-forecast-artifact.js';
const repository = 'owner/repo', revision = 'a'.repeat(40);
const run = { id: 123, path: '.github/workflows/forecast.yml', head_branch: 'main', head_sha: revision, event: 'schedule', status: 'completed', repository: { full_name: repository }, head_repository: { full_name: repository } };
it('accepts completed main publisher runs and returns their immutable source revision', () => {
  expect(forecastArtifactRevision(run, repository, '123')).toBe(revision);
  expect(forecastArtifactRevision({ ...run, event: 'workflow_dispatch' }, repository, '123')).toBe(revision);
});
it('rejects lookalike artifacts from forks, other workflows, refs or uncompleted runs', () => {
  for (const patch of [{ event: 'pull_request' }, { head_branch: 'feature' }, { head_repository: { full_name: 'fork/repo' } }, { path: '.github/workflows/ci.yml' }, { status: 'in_progress' }, { id: 124 }]) {
    expect(() => forecastArtifactRevision({ ...run, ...patch }, repository, '123')).toThrow();
  }
});
