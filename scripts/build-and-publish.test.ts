import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Manifest } from '@av/contracts';
const fake = vi.hoisted(() => ({ build: vi.fn(), publish: vi.fn(), cleanup: vi.fn(), mkdir: vi.fn(), gh: vi.fn(), write: vi.fn(), append: vi.fn(), validated: vi.fn(), directories: vi.fn(), readLocal: vi.fn(), identity: vi.fn() }));
vi.mock('../apps/batch/src/build.js', () => ({ buildSample: fake.build }));
vi.mock('../apps/batch/src/publication.js', () => ({ publish: fake.publish, cleanup: fake.cleanup }));
vi.mock('../apps/batch/src/validate.js', () => ({ wasValidatedInProcess: fake.validated }));
vi.mock('../apps/batch/src/local-file.js', () => ({ readLocalFile: fake.readLocal }));
vi.mock('../apps/batch/src/identity.js', () => ({ buildIdentity: fake.identity }));
vi.mock('../apps/batch/src/storage.js', () => ({ r2Storage: () => ({}) }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: fake.gh }) };
});
vi.mock('node:fs/promises', () => ({ appendFile: fake.append, writeFile: fake.write, mkdir: fake.mkdir, readdir: fake.directories }));
import { buildAndPublish } from './build-and-publish.js';
import { resumePublication } from './resume-publication.js';
const revision = 'a'.repeat(40);
let manifest: Manifest;
beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW: 'Forecast sample', GITHUB_RUN_ID: '123', TARGET_ENV: 'staging', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: revision, MODEL: 'gfs', GITHUB_ENV: '/tmp/ci-env', CYCLE: '', RESUME_RUN_ID: '100' })) vi.stubEnv(key, value);
  manifest = JSON.parse(readFileSync(new URL('./fixtures/manifest.contract.json', import.meta.url), 'utf8'));
  manifest.metrics = { elapsedMs: 1000, peakRssBytes: 100_000_000, tiles: [1, 4, 8, 30, 92, 267, 847, 2794] };
  manifest.recipe.sourceRevision = revision; manifest.recipe.sourceDirty = false;
  vi.stubEnv('SOURCE_BUILD_REVISION', revision);
  fake.build.mockImplementation(async ({ onValidated }) => { await onValidated(manifest, 'output/builds/gfs/build/manifest.json'); return 'manifest.json'; });
  fake.gh.mockResolvedValue({ stdout: revision + '\n' });
  fake.publish.mockResolvedValue(undefined);
  fake.cleanup.mockResolvedValue(3);
  fake.validated.mockReturnValue(true);
  fake.directories.mockResolvedValue([{ name: manifest.buildId, isDirectory: () => true }]);
  fake.readLocal.mockImplementation(async () => Buffer.from(JSON.stringify(manifest)));
  fake.identity.mockImplementation(async () => ({ recipe: { hash: manifest.recipe.hash } }));
});
afterEach(() => vi.unstubAllEnvs());
it('keeps a main-revision check between the completed build and publication', async () => {
  await buildAndPublish();
  expect(fake.gh).toHaveBeenCalledWith('gh', ['api', 'repos/owner/repo/git/ref/heads/main', '--jq', '.object.sha'], { timeout: 15_000, signal: expect.any(AbortSignal) });
  expect(fake.build.mock.invocationCallOrder[0]).toBeLessThan(fake.gh.mock.invocationCallOrder[0]);
  expect(fake.gh.mock.invocationCallOrder[0]).toBeLessThan(fake.publish.mock.invocationCallOrder[0]);
  expect(fake.publish).toHaveBeenCalledWith({}, 'output', manifest, expect.objectContaining({ authority: expect.objectContaining({ group: 'forecast-staging-gfs' }), signal: expect.any(AbortSignal) }));
  expect(fake.cleanup.mock.invocationCallOrder[0]).toBeGreaterThan(fake.publish.mock.invocationCallOrder[0]);
  expect(fake.write).toHaveBeenCalledWith('output/builds/gfs/build/publication.json', expect.stringContaining('"validationReused": true'));
});
it('refuses local or non-main invocation before building or publishing', async () => {
  vi.stubEnv('GITHUB_ACTIONS', 'false');
  await expect(buildAndPublish()).rejects.toThrow('forecast workflow');
  expect(fake.build).not.toHaveBeenCalled();
  expect(fake.publish).not.toHaveBeenCalled();
});
it('refuses a superseded revision before publishing', async () => {
  fake.gh.mockResolvedValue({ stdout: 'b'.repeat(40) });
  await expect(buildAndPublish()).rejects.toThrow('superseded');
  expect(fake.publish).not.toHaveBeenCalled();
});
it('refuses a build that exceeds resource budgets before publication', async () => {
  manifest.metrics.peakRssBytes = 10 * 1024 ** 3;
  await expect(buildAndPublish()).rejects.toThrow('Performance budget failed');
  expect(fake.gh).not.toHaveBeenCalled();
  expect(fake.publish).not.toHaveBeenCalled();
});

it('reports committed publication separately when serialized cleanup fails', async () => {
  fake.cleanup.mockRejectedValueOnce(new Error('cleanup unavailable'));
  await expect(buildAndPublish()).rejects.toThrow('Publication committed; maintenance failed');
  expect(fake.write).toHaveBeenCalledWith('output/builds/gfs/build/maintenance.json', expect.stringContaining('"publication": "committed"'));
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('cleanup unavailable'));
});
it('never starts cleanup after publication fails', async () => {
  fake.publish.mockRejectedValueOnce(new Error('CAS failed'));
  await expect(buildAndPublish()).rejects.toThrow('CAS failed');
  expect(fake.cleanup).not.toHaveBeenCalled();
});

it('records cancellation before commit without publishing or leaking signal handlers', async () => {
  const before = process.listenerCount('SIGTERM');
  fake.build.mockImplementationOnce(async ({ signal }) => { process.emit('SIGTERM'); signal.throwIfAborted(); });
  await expect(buildAndPublish()).rejects.toThrow('interrupted');
  expect(fake.publish).not.toHaveBeenCalled();
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('"cancelled": true'));
  expect(process.listenerCount('SIGTERM')).toBe(before);
});
it('records an ambiguous commit reconciled by publish before deferring cleanup after cancellation', async () => {
  fake.publish.mockImplementationOnce(async () => { process.emit('SIGTERM'); });
  await expect(buildAndPublish()).rejects.toThrow('interrupted');
  expect(fake.write).toHaveBeenCalledWith('output/builds/gfs/build/publication.json', expect.stringContaining('"status": "committed"'));
  expect(fake.write).toHaveBeenCalledWith('output/builds/gfs/build/maintenance.json', expect.stringContaining('cancelled-after-commit'));
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('"publication": "committed"'));
  expect(fake.cleanup).not.toHaveBeenCalled();
});
it('resumes matching artifacts through the same admission/journal without rebuilding science', async () => {
  fake.validated.mockReturnValue(false);
  await resumePublication();
  expect(fake.build).not.toHaveBeenCalled();
  expect(fake.publish).toHaveBeenCalledTimes(1);
  expect(fake.write).toHaveBeenCalledWith(`output/builds/gfs/${manifest.buildId}/publication.json`, expect.stringContaining('"resumedFromRun": "100"'));
  expect(fake.write).toHaveBeenCalledWith(`output/builds/gfs/${manifest.buildId}/publication.json`, expect.stringContaining('"validationReused": false'));
});
it('refuses resume after recipe changes and preserves a failure receipt', async () => {
  fake.identity.mockResolvedValueOnce({ recipe: { hash: 'b'.repeat(64) } });
  await expect(resumePublication()).rejects.toThrow('recipe differs');
  expect(fake.publish).not.toHaveBeenCalled();
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('recipe differs'));
});
it('refuses ambiguous downloaded build sets before any publication', async () => {
  fake.directories.mockResolvedValueOnce([{ name: manifest.buildId, isDirectory: () => true }, { name: 'another', isDirectory: () => true }]);
  await expect(resumePublication()).rejects.toThrow('exactly one');
  expect(fake.publish).not.toHaveBeenCalled();
});

it('keeps an ambiguous publication rejection unconfirmed until authoritative reconciliation succeeds', async () => {
  fake.publish.mockRejectedValueOnce(new Error('CAS outcome cannot be read'));
  await expect(buildAndPublish()).rejects.toThrow('cannot be read');
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('"publication": "unconfirmed"'));
});
it('reports cancellation during cleanup after retaining the completed maintenance receipt', async () => {
  fake.cleanup.mockImplementationOnce(async () => { process.emit('SIGTERM'); return 3; });
  await expect(buildAndPublish()).rejects.toThrow('interrupted');
  expect(fake.write).toHaveBeenCalledWith('output/builds/gfs/build/maintenance.json', expect.stringContaining('"status": "complete"'));
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('"publication": "committed"'));
});


it('persists cleanup cost observations and preserves unknown deletion progress on maintenance failure', async () => {
  const summary = { version: 1, prefix: 'builds/gfs/', observedAt: '2026-11-01T00:00:00Z', status: 'failed', listed: { objects: 30, knownBytes: 1000, unknownSizeObjects: 1 }, protected: null, unreferenced: null, eligible: null, deleted: null };
  fake.cleanup.mockImplementationOnce(async (_store, _model, _authority, _now, report) => { report(summary); throw new Error('delete status unknown'); });
  await expect(buildAndPublish()).rejects.toThrow('maintenance failed');
  const maintenance = fake.write.mock.calls.filter(([path]) => path.endsWith('/maintenance.json')).at(-1);
  expect(JSON.parse(maintenance![1])).toMatchObject({ status: 'failed', publication: 'committed', summary });
});
