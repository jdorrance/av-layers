import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Manifest, ModelPointer } from '@av/contracts';
const fake = vi.hoisted(() => ({ discover: vi.fn(), pointer: vi.fn(), publish: vi.fn(), cleanup: vi.fn(), mkdir: vi.fn(), gh: vi.fn(), write: vi.fn(), directories: vi.fn(), readLocal: vi.fn(), identity: vi.fn(), plan: vi.fn(), shard: vi.fn(), finalize: vi.fn(), storage: vi.fn() }));
vi.mock('../apps/batch/src/parallel.js', () => ({ MAX_FORECAST_SHARDS: 4, createForecastPlan: fake.plan, buildForecastShard: fake.shard, finalizeForecastBuild: fake.finalize }));
vi.mock('../apps/batch/src/providers.js', async () => {
  const { validateCycle } = await import('../apps/batch/src/noaa/acquire.js');
  return { getForecastProvider: () => ({ async resolveCycle({ cycle, ...options }: { cycle?: string }) { return validateCycle(cycle || (await fake.discover(options)).cycle); } }) };
});
vi.mock('../apps/batch/src/publication.js', () => ({ publish: fake.publish, cleanup: fake.cleanup, readPointer: fake.pointer }));
vi.mock('../apps/batch/src/local-file.js', () => ({ readLocalFile: fake.readLocal }));
vi.mock('../apps/batch/src/identity.js', () => ({ buildIdentity: fake.identity }));
vi.mock('../apps/batch/src/storage.js', () => ({ r2Storage: fake.storage }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: fake.gh }) };
});
vi.mock('node:fs/promises', () => ({ writeFile: fake.write, mkdir: fake.mkdir, readdir: fake.directories }));
import { resumePublication, forecastArtifactRevision, downloadForecastArtifact, planForecast, runForecastShard, finalizeAndPublish } from './publication-workflow.js';
const revision = 'a'.repeat(40);
let manifest: Manifest;
beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/forecast.yml@refs/heads/main', GITHUB_RUN_ID: '123', TARGET_ENV: 'staging', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: revision, MODEL: 'gfs', CYCLE: '', RESUME_RUN_ID: '100', ALLOW_SAME_CYCLE: 'false' })) vi.stubEnv(key, value);
  manifest = JSON.parse(readFileSync(new URL('./fixtures/manifest.contract.json', import.meta.url), 'utf8'));
  manifest.metrics = { elapsedMs: 1000, peakRssBytes: 100_000_000, tiles: [1, 4, 8, 30, 92, 267, 847, 2794] };
  manifest.recipe.sourceRevision = revision; manifest.recipe.sourceDirty = false;
  fake.storage.mockReturnValue({});
  fake.plan.mockResolvedValue([0, 1, 2, 3]);
  fake.shard.mockResolvedValue('output/shards/0/receipt.json');
  fake.finalize.mockImplementation(async (_plan, { onValidated }) => { await onValidated({ root: 'output', manifest, hash: 'a'.repeat(64) }, 'output/builds/gfs/build/manifest.json'); return 'manifest.json'; });
  fake.discover.mockResolvedValue({ cycle: manifest.cycle });
  fake.pointer.mockResolvedValue({ pointer: null });
  fake.gh.mockResolvedValue({ stdout: revision + '\n' });
  fake.publish.mockResolvedValue(undefined);
  fake.cleanup.mockResolvedValue(3);
  fake.directories.mockResolvedValue([{ name: manifest.buildId, isDirectory: () => true }]);
  fake.readLocal.mockImplementation(async () => Buffer.from(JSON.stringify(manifest)));
  fake.identity.mockImplementation(async () => ({ recipe: { hash: manifest.recipe.hash } }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const retainedPointer = (cycles: string[]): ModelPointer => ({
  version: 1, model: 'gfs', latestBuildId: 'build-0',
  retained: cycles.map((cycle, i) => ({ buildId: `build-${i}`, manifestKey: `builds/gfs/build-${i}/manifest.json`, cycle, expiresAt: '2020-01-01T00:00:00Z' }))
});

it('skips an already-published scheduled cycle before building or writing anything', async () => {
  vi.stubEnv('GITHUB_EVENT_NAME', 'schedule');
  fake.pointer.mockResolvedValue({ pointer: retainedPointer([manifest.cycle]) });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await expect(planForecast()).resolves.toBeNull();
  expect(log).toHaveBeenCalledWith(expect.stringContaining('No new build was produced'));
  for (const call of [fake.plan, fake.publish, fake.cleanup, fake.write]) expect(call).not.toHaveBeenCalled();
});
it('rejects manual equality early with explicit replacement guidance', async () => {
  fake.pointer.mockResolvedValue({ pointer: retainedPointer([manifest.cycle]) });
  await expect(planForecast()).rejects.toThrow('allow-same-cycle=true');
  expect(fake.plan).not.toHaveBeenCalled();
  expect(fake.publish).not.toHaveBeenCalled();
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('"publication": "not-attempted"'));
});
it.each(['schedule', 'workflow_dispatch'])('permits an intentional same-cycle replacement for %s', async event => {
  vi.stubEnv('GITHUB_EVENT_NAME', event); vi.stubEnv('ALLOW_SAME_CYCLE', 'true'); vi.stubEnv('CYCLE', manifest.cycle);
  fake.pointer.mockResolvedValue({ pointer: retainedPointer([manifest.cycle]) });
  await planForecast();
  expect(fake.discover).not.toHaveBeenCalled();
  expect(fake.plan).toHaveBeenCalledWith('gfs', expect.objectContaining({ cycle: manifest.cycle.replace('.000Z', 'Z') }));
  await finalizeAndPublish();
  expect(fake.publish).toHaveBeenCalledWith({}, 'output', manifest, expect.objectContaining({ allowSameCycle: true }));
});
it.each([null, retainedPointer(['2026-10-29T18:00:00Z'])])('plans a discovered new cycle once using the inventory cache', async pointer => {
  fake.pointer.mockResolvedValue({ pointer });
  await expect(planForecast()).resolves.toEqual([0, 1, 2, 3]);
  expect(fake.discover).toHaveBeenCalledOnce();
  expect(fake.discover).toHaveBeenCalledWith({ cacheDir: '.cache/gfs', signal: expect.any(AbortSignal) });
  expect(fake.pointer).toHaveBeenCalledWith({}, 'gfs', expect.any(AbortSignal));
  expect(fake.plan).toHaveBeenCalledWith('gfs', { out: 'output', cycle: manifest.cycle.replace('.000Z', 'Z'), shards: 4, signal: expect.any(AbortSignal) });
});
it('uses all retained cycles after rollback, including expired entries', async () => {
  fake.pointer.mockResolvedValue({ pointer: retainedPointer(['2026-10-29T18:00:00Z', manifest.cycle]) });
  vi.stubEnv('GITHUB_EVENT_NAME', 'schedule');
  await planForecast();
  expect(fake.plan).not.toHaveBeenCalled();
  vi.stubEnv('CYCLE', '2026-10-29T18:00:00Z'); vi.stubEnv('ALLOW_SAME_CYCLE', 'true');
  await expect(planForecast()).rejects.toThrow('Older cycle cannot be published');
  expect(fake.plan).not.toHaveBeenCalled();
  expect(fake.publish).not.toHaveBeenCalled();
});
it.each(['discover', 'pointer'] as const)('does not plan or publish when %s fails', async stage => {
  fake[stage].mockRejectedValueOnce(new Error(`${stage} unavailable`));
  await expect(planForecast()).rejects.toThrow(`${stage} unavailable`);
  expect(fake.plan).not.toHaveBeenCalled();
  expect(fake.publish).not.toHaveBeenCalled();
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('"publication": "not-attempted"'));
});
it('rejects malformed explicit cycles before comparison instead of silently skipping them', async () => {
  vi.stubEnv('CYCLE', '2026-10-30'); vi.stubEnv('GITHUB_EVENT_NAME', 'schedule');
  await expect(planForecast()).rejects.toThrow('GFS cycle must be an exact ISO UTC');
  expect(fake.discover).not.toHaveBeenCalled(); expect(fake.pointer).not.toHaveBeenCalled(); expect(fake.plan).not.toHaveBeenCalled();
});
it('does not report a successful skip after cancellation during the pointer read', async () => {
  vi.stubEnv('GITHUB_EVENT_NAME', 'schedule');
  fake.pointer.mockImplementationOnce(async () => { process.emit('SIGTERM'); return { pointer: retainedPointer([manifest.cycle]) }; });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await expect(planForecast()).rejects.toThrow('interrupted');
  expect(log).not.toHaveBeenCalled(); expect(fake.plan).not.toHaveBeenCalled();
});
it('keeps a main-revision check between the completed build and publication', async () => {
  await finalizeAndPublish();
  expect(fake.finalize).toHaveBeenCalledWith('output/plan.json', expect.objectContaining({ out: 'output', signal: expect.any(AbortSignal), onValidated: expect.any(Function) }));
  expect(fake.discover).not.toHaveBeenCalled();
  expect(fake.gh).toHaveBeenCalledWith('gh', ['api', 'repos/owner/repo/git/ref/heads/main', '--jq', '.object.sha'], { timeout: 15_000, signal: expect.any(AbortSignal) });
  expect(fake.finalize.mock.invocationCallOrder[0]).toBeLessThan(fake.gh.mock.invocationCallOrder[0]);
  expect(fake.gh.mock.invocationCallOrder[0]).toBeLessThan(fake.publish.mock.invocationCallOrder[0]);
  expect(fake.publish).toHaveBeenCalledWith({}, 'output', manifest, expect.objectContaining({ authority: expect.objectContaining({ group: 'forecast-staging-gfs' }), signal: expect.any(AbortSignal) }));
  expect(fake.cleanup.mock.invocationCallOrder[0]).toBeGreaterThan(fake.publish.mock.invocationCallOrder[0]);
  expect(fake.write).toHaveBeenCalledWith('output/builds/gfs/build/publication.json', expect.stringContaining('"validationReused": true'));
});
it('refuses local or non-main invocation before building or publishing', async () => {
  vi.stubEnv('GITHUB_ACTIONS', 'false');
  await expect(finalizeAndPublish()).rejects.toThrow('workflow on main');
  expect(fake.finalize).not.toHaveBeenCalled();
  expect(fake.publish).not.toHaveBeenCalled();
});
it('refuses a superseded revision before publishing', async () => {
  fake.gh.mockResolvedValue({ stdout: 'b'.repeat(40) });
  await expect(finalizeAndPublish()).rejects.toThrow('superseded');
  expect(fake.publish).not.toHaveBeenCalled();
});
it('refuses a build that exceeds resource budgets before publication', async () => {
  manifest.metrics.peakRssBytes = 10 * 1024 ** 3;
  await expect(finalizeAndPublish()).rejects.toThrow('Performance budget failed');
  expect(fake.gh).not.toHaveBeenCalled();
  expect(fake.publish).not.toHaveBeenCalled();
});

it('reports committed publication separately when serialized cleanup fails', async () => {
  fake.cleanup.mockRejectedValueOnce(new Error('cleanup unavailable'));
  await expect(finalizeAndPublish()).rejects.toThrow('Publication committed; maintenance failed');
  expect(fake.write).toHaveBeenCalledWith('output/builds/gfs/build/maintenance.json', expect.stringContaining('"publication": "committed"'));
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('cleanup unavailable'));
});
it('never starts cleanup after publication fails', async () => {
  fake.publish.mockRejectedValueOnce(new Error('CAS failed'));
  await expect(finalizeAndPublish()).rejects.toThrow('CAS failed');
  expect(fake.cleanup).not.toHaveBeenCalled();
});

it('records cancellation before commit without publishing or leaking signal handlers', async () => {
  const before = process.listenerCount('SIGTERM');
  fake.finalize.mockImplementationOnce(async (_model, { signal }) => { process.emit('SIGTERM'); signal.throwIfAborted(); });
  await expect(finalizeAndPublish()).rejects.toThrow('interrupted');
  expect(fake.publish).not.toHaveBeenCalled();
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('"cancelled": true'));
  expect(process.listenerCount('SIGTERM')).toBe(before);
});
it('records an ambiguous commit reconciled by publish before deferring cleanup after cancellation', async () => {
  fake.publish.mockImplementationOnce(async () => { process.emit('SIGTERM'); });
  await expect(finalizeAndPublish()).rejects.toThrow('interrupted');
  expect(fake.write).toHaveBeenCalledWith('output/builds/gfs/build/publication.json', expect.stringContaining('"status": "committed"'));
  expect(fake.write).toHaveBeenCalledWith('output/builds/gfs/build/maintenance.json', expect.stringContaining('cancelled-after-commit'));
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('"publication": "committed"'));
  expect(fake.cleanup).not.toHaveBeenCalled();
});
it('resumes matching artifacts through the same admission/journal without rebuilding science', async () => {
  await resumePublication(revision);
  expect(fake.finalize).not.toHaveBeenCalled();
  expect(fake.publish).toHaveBeenCalledTimes(1);
  expect(fake.write).toHaveBeenCalledWith(`output/builds/gfs/${manifest.buildId}/publication.json`, expect.stringContaining('"resumedFromRun": "100"'));
  expect(fake.write).toHaveBeenCalledWith(`output/builds/gfs/${manifest.buildId}/publication.json`, expect.stringContaining('"validationReused": false'));
});
it('refuses resume after recipe changes and preserves a failure receipt', async () => {
  fake.identity.mockResolvedValueOnce({ recipe: { hash: 'b'.repeat(64) } });
  await expect(resumePublication(revision)).rejects.toThrow('recipe differs');
  expect(fake.publish).not.toHaveBeenCalled();
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('recipe differs'));
});
it('refuses ambiguous downloaded build sets before any publication', async () => {
  fake.directories.mockResolvedValueOnce([{ name: manifest.buildId, isDirectory: () => true }, { name: 'another', isDirectory: () => true }]);
  await expect(resumePublication(revision)).rejects.toThrow('exactly one');
  expect(fake.publish).not.toHaveBeenCalled();
});

it('keeps an ambiguous publication rejection unconfirmed until authoritative reconciliation succeeds', async () => {
  fake.publish.mockRejectedValueOnce(new Error('CAS outcome cannot be read'));
  await expect(finalizeAndPublish()).rejects.toThrow('cannot be read');
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('"publication": "unconfirmed"'));
});
it('reports cancellation during cleanup after retaining the completed maintenance receipt', async () => {
  fake.cleanup.mockImplementationOnce(async () => { process.emit('SIGTERM'); return 3; });
  await expect(finalizeAndPublish()).rejects.toThrow('interrupted');
  expect(fake.write).toHaveBeenCalledWith('output/builds/gfs/build/maintenance.json', expect.stringContaining('"status": "complete"'));
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('"publication": "committed"'));
});

it('persists cleanup cost observations and preserves unknown deletion progress on maintenance failure', async () => {
  const summary = { version: 1, prefix: 'builds/gfs/', observedAt: '2026-11-01T00:00:00Z', status: 'failed', listed: { objects: 30, knownBytes: 1000, unknownSizeObjects: 1 }, protected: null, unreferenced: null, eligible: null, deleted: null };
  fake.cleanup.mockImplementationOnce(async (_store, _model, _authority, _now, report) => { report(summary); throw new Error('delete status unknown'); });
  await expect(finalizeAndPublish()).rejects.toThrow('maintenance failed');
  const maintenance = fake.write.mock.calls.filter(([path]) => path.endsWith('/maintenance.json')).at(-1);
  expect(JSON.parse(maintenance![1])).toMatchObject({ status: 'failed', publication: 'committed', summary });
});

const repository = 'owner/repo';
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
it('verifies the completed source workflow before downloading a retained forecast', async () => {
  fake.gh.mockResolvedValueOnce({ stdout: JSON.stringify(run) });
  await expect(downloadForecastArtifact('123')).resolves.toBe(revision);
  expect(fake.gh).toHaveBeenNthCalledWith(1, 'gh', ['api', 'repos/owner/repo/actions/runs/123'], { timeout: 15_000, maxBuffer: 1024 * 1024 });
  expect(fake.gh).toHaveBeenNthCalledWith(2, 'gh', ['run', 'download', '123', '--repo', 'owner/repo', '--name', 'forecast-gfs-123', '--dir', 'output'], { timeout: 300_000, maxBuffer: 1024 * 1024 });
  fake.gh.mockClear();
  fake.gh.mockResolvedValueOnce({ stdout: JSON.stringify({ ...run, head_branch: 'feature' }) });
  await expect(downloadForecastArtifact('123')).rejects.toThrow('authorized main forecast');
  expect(fake.gh).toHaveBeenCalledTimes(1);
});

it('records planning failure without claiming publication', async () => {
  fake.plan.mockRejectedValueOnce(new Error('Plan does not fit budget'));
  await expect(planForecast()).rejects.toThrow('Plan does not fit budget');
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('"publication": "not-attempted"'));
  expect(fake.publish).not.toHaveBeenCalled();
});
it('runs a worker without constructing publication storage or resolving another cycle', async () => {
  await runForecastShard(2);
  expect(fake.shard).toHaveBeenCalledWith('output/plan.json', 2, { out: 'output', cacheDir: '.cache/gfs', signal: expect.any(AbortSignal) });
  expect(fake.storage).not.toHaveBeenCalled(); expect(fake.discover).not.toHaveBeenCalled(); expect(fake.publish).not.toHaveBeenCalled();
});
it('cancels the shard and removes its signal handlers', async () => {
  const before = process.listenerCount('SIGTERM');
  fake.shard.mockImplementationOnce(async (_plan, _shard, { signal }) => { process.emit('SIGTERM'); signal.throwIfAborted(); });
  await expect(runForecastShard(0)).rejects.toThrow('Forecast shard interrupted');
  expect(process.listenerCount('SIGTERM')).toBe(before);
  expect(fake.storage).not.toHaveBeenCalled();
});
it('never publishes or cleans up an incomplete shard set', async () => {
  fake.finalize.mockRejectedValueOnce(new Error('Missing forecast shard'));
  await expect(finalizeAndPublish()).rejects.toThrow('Missing forecast shard');
  expect(fake.publish).not.toHaveBeenCalled(); expect(fake.cleanup).not.toHaveBeenCalled();
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('"publication": "not-attempted"'));
});
it('rejects a plan for another workflow model before worker computation or finalization', async () => {
  fake.readLocal.mockResolvedValue(Buffer.from(JSON.stringify({ model: 'other-model' })));
  await expect(runForecastShard(0)).rejects.toThrow('workflow model');
  await expect(finalizeAndPublish()).rejects.toThrow('workflow model');
  expect(fake.shard).not.toHaveBeenCalled(); expect(fake.finalize).not.toHaveBeenCalled(); expect(fake.publish).not.toHaveBeenCalled();
});
