import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Manifest } from '@av/contracts';
const fake = vi.hoisted(() => ({ build: vi.fn(), publish: vi.fn(), gh: vi.fn(), write: vi.fn(), append: vi.fn() }));
vi.mock('../apps/batch/src/build.js', () => ({ buildSample: fake.build }));
vi.mock('../apps/batch/src/publication.js', () => ({ publish: fake.publish }));
vi.mock('../apps/batch/src/storage.js', () => ({ r2Storage: () => ({}) }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: fake.gh }) };
});
vi.mock('node:fs/promises', () => ({ appendFile: fake.append, writeFile: fake.write }));
import { buildAndPublish } from './build-and-publish.js';
const revision = 'a'.repeat(40);
let manifest: Manifest;
beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: revision, MODEL: 'gfs', GITHUB_ENV: '/tmp/ci-env', CYCLE: '' })) vi.stubEnv(key, value);
  manifest = JSON.parse(readFileSync(new URL('./fixtures/manifest.contract.json', import.meta.url), 'utf8'));
  manifest.metrics = { elapsedMs: 1000, peakRssBytes: 100_000_000, tiles: [1, 4, 8, 30, 92, 267] };
  fake.build.mockImplementation(async ({ onValidated }) => { await onValidated(manifest, 'output/builds/gfs/build/manifest.json'); return 'manifest.json'; });
  fake.gh.mockResolvedValue({ stdout: revision + '\n' });
  fake.publish.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());
it('keeps a main-revision check between the completed build and publication', async () => {
  await buildAndPublish();
  expect(fake.gh).toHaveBeenCalledWith('gh', ['api', 'repos/owner/repo/git/ref/heads/main', '--jq', '.object.sha']);
  expect(fake.build.mock.invocationCallOrder[0]).toBeLessThan(fake.gh.mock.invocationCallOrder[0]);
  expect(fake.gh.mock.invocationCallOrder[0]).toBeLessThan(fake.publish.mock.invocationCallOrder[0]);
  expect(fake.publish).toHaveBeenCalledWith({}, 'output', manifest);
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
