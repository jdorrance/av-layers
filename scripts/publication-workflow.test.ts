import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalGridJson, createRefinementDescriptors, createSparseCoverage, encodeSparseCoverage, getProduct, manifestV5Schema, MODEL_IDS, TERRAIN_COLUMN_METHODS_BY_VERTICAL_COORDINATE, validateArtifactRecords, type Manifest, type ManifestV5, type ModelPointer } from '@av/contracts';
import * as refinementConfiguration from '../apps/batch/src/refinement/config.js';
import { fixturePatch } from '../tests/forecast-fixture.js';
import type { BuildPlan } from '../apps/batch/src/parallel.js';
import { refinementInputSchema } from '../apps/batch/src/refinement/prepare.js';
import { localPath } from '../apps/batch/src/validate.js';
const fake = vi.hoisted(() => ({ discover: vi.fn(), pointer: vi.fn(), publish: vi.fn(), cleanup: vi.fn(), mkdir: vi.fn(), gh: vi.fn(), write: vi.fn(), directories: vi.fn(), readLocal: vi.fn(), identity: vi.fn(), plan: vi.fn(), readPlan: vi.fn(), shard: vi.fn(), finalize: vi.fn(), storage: vi.fn(), verifyServing: vi.fn() }));
vi.mock('./smoke-api.js', async importOriginal => ({ ...await importOriginal<typeof import('./smoke-api.js')>(), verifyPublishedForecast: fake.verifyServing }));
vi.mock('../apps/batch/src/parallel.js', () => ({ MAX_FORECAST_SHARDS: 4, createForecastPlan: fake.plan, readBuildPlan: fake.readPlan, buildForecastShard: fake.shard, finalizeForecastBuild: fake.finalize }));
vi.mock('../apps/batch/src/providers.js', async () => {
  const { validateCycle } = await import('../apps/batch/src/gfs/fields.js');
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
import { resumePublication, assertV5ResumeIdentity, forecastArtifactRevision, downloadForecastArtifact, planForecast, runForecastShard, finalizeAndPublish } from './publication-workflow.js';
const revision = 'a'.repeat(40);
const catalogRef = { key: `terrain/catalogs/${'c'.repeat(64)}.json`, sha256: 'c'.repeat(64), bytes: 100 };
let manifest: Manifest;
beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/forecast.yml@refs/heads/main', GITHUB_RUN_ID: '123', TARGET_ENV: 'staging', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: revision, MODEL: 'gfs', API_BASE_URL: 'https://api.example', CYCLE: '', RESUME_RUN_ID: '100', ALLOW_SAME_CYCLE: 'false', TERRAIN_INPUTS: '', TERRAIN_CATALOG_REF: JSON.stringify(catalogRef) })) vi.stubEnv(key, value);
  manifest = JSON.parse(readFileSync(new URL('./fixtures/manifest.contract.json', import.meta.url), 'utf8'));
  manifest.metrics = { elapsedMs: 1000, peakRssBytes: 100_000_000, tiles: [1, 4, 8, 30, 92, 267, 847, 2794] };
  manifest.recipe.sourceRevision = revision; manifest.recipe.sourceDirty = false;
  fake.storage.mockReturnValue({});
  fake.plan.mockResolvedValue({ model: 'gfs', cycle: manifest.cycle, groups: [[1, 2], [3, 4], [5, 6], [7, 8]] });
  fake.verifyServing.mockResolvedValue(undefined);
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

const retainedPointer = (cycles: string[], model = 'gfs'): ModelPointer => ({
  version: 1, model, latestBuildId: 'build-0',
  retained: cycles.map((cycle, i) => ({ buildId: `build-${i}`, manifestKey: `builds/${model}/build-${i}/manifest.json`, cycle, expiresAt: '2020-01-01T00:00:00Z' }))
});

it.each(MODEL_IDS.flatMap(model => ['schedule', 'workflow_dispatch'].map(event => ({ model, event }))))(
  'skips an already-published $model cycle for $event before building or writing anything', async ({ model, event }) => {
    vi.stubEnv('MODEL', model); vi.stubEnv('GITHUB_EVENT_NAME', event);
    fake.pointer.mockResolvedValue({ pointer: retainedPointer([manifest.cycle], model) });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(planForecast()).resolves.toBeNull();
    expect(fake.pointer).toHaveBeenCalledWith({}, model, expect.any(AbortSignal));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('No new build was produced'));
    for (const call of [fake.plan, fake.publish, fake.cleanup, fake.verifyServing, fake.write]) expect(call).not.toHaveBeenCalled();
  }
);
it('skips an explicitly selected published cycle without discovering or rebuilding it', async () => {
  vi.stubEnv('CYCLE', manifest.cycle);
  fake.pointer.mockResolvedValue({ pointer: retainedPointer([manifest.cycle]) });
  await expect(planForecast()).resolves.toBeNull();
  for (const call of [fake.discover, fake.plan, fake.publish, fake.cleanup, fake.write]) expect(call).not.toHaveBeenCalled();
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
  await expect(planForecast()).resolves.toEqual({ model: 'gfs', cycle: manifest.cycle, groups: [[1, 2], [3, 4], [5, 6], [7, 8]] });
  expect(fake.discover).toHaveBeenCalledOnce();
  expect(fake.discover).toHaveBeenCalledWith({ cacheDir: '.cache/gfs', signal: expect.any(AbortSignal) });
  expect(fake.pointer).toHaveBeenCalledWith({}, 'gfs', expect.any(AbortSignal));
  expect(fake.plan).toHaveBeenCalledWith('gfs', { out: 'output', cycle: manifest.cycle.replace('.000Z', 'Z'), shards: 4, signal: expect.any(AbortSignal), wholeDomain: { catalogRef, storage: {} } });
});

it.each(MODEL_IDS)('passes the same global catalog pin for configured %s zones', async model => {
  vi.stubEnv('MODEL', model);
  await planForecast();
  expect(fake.plan).toHaveBeenCalledWith(model, expect.objectContaining({ wholeDomain: { catalogRef, storage: {} } }));
});
it.each(MODEL_IDS)('requires a pinned catalog for configured %s scheduled and manual builds', async model => {
  vi.stubEnv('MODEL', model);
  for (const event of ['schedule', 'workflow_dispatch']) {
    vi.stubEnv('GITHUB_EVENT_NAME', event);
    vi.stubEnv('TERRAIN_CATALOG_REF', '');
    await expect(planForecast()).rejects.toThrow('TERRAIN_CATALOG_REF is required');
    expect(fake.plan).not.toHaveBeenCalled();
  }
});
it('rejects a malformed catalog pin before preparing a whole-domain build', async () => {
  vi.stubEnv('TERRAIN_CATALOG_REF', 'not JSON');
  await expect(planForecast()).rejects.toThrow();
  expect(fake.plan).not.toHaveBeenCalled();
});
it('rejects an unpinned catalog before preparing a whole-domain build', async () => {
  vi.stubEnv('TERRAIN_CATALOG_REF', '{}');
  await expect(planForecast()).rejects.toThrow();
  expect(fake.plan).not.toHaveBeenCalled();
});
it('preserves the optional native-grid terrain reference alongside whole-domain preparation', async () => {
  const ref = { key: `terrain/prepared/${'a'.repeat(64)}/manifest.json`, sha256: 'b'.repeat(64), bytes: 100, arrayBytes: 20 };
  vi.stubEnv('TERRAIN_INPUTS', JSON.stringify({ gfs: ref }));
  await planForecast();
  expect(fake.plan).toHaveBeenCalledWith('gfs', expect.objectContaining({ terrain: { ref, storage: {} }, wholeDomain: { catalogRef, storage: {} } }));
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
  expect(fake.readPlan).not.toHaveBeenCalled();
});

function refinedResumePlan(): BuildPlan {
  const patch = fixturePatch(manifest), product = getProduct(manifest.model)!;
  patch.descriptors = createRefinementDescriptors(product, patch.descriptors.bounds);
  patch.method.id = TERRAIN_COLUMN_METHODS_BY_VERTICAL_COORDINATE[product.capabilities.verticalCoordinate].id;
  manifest.version = 4; manifest.patches = [patch];
  validateArtifactRecords(manifest);
  const input = refinementInputSchema.parse({ id: patch.id, grid: patch.grid, geometry: patch.geometry,
    bounds: patch.descriptors.bounds, coverage: patch.coverage,
    terrain: { key: patch.terrain.key, sha256: patch.terrain.sha256, bytes: 100, arrayBytes: patch.grid.width * patch.grid.height * 5 } });
  const plan: BuildPlan = { version: 1, model: manifest.model, buildId: manifest.buildId, cycle: manifest.cycle,
    createdAt: manifest.createdAt, coverageHash: manifest.coverage.hash, providerId: 'fixture-provider', recipe: structuredClone(manifest.recipe),
    groups: [manifest.frames.map(frame => Number(frame.id.slice(1)))], refinements: [input] };
  fake.readPlan.mockResolvedValue(plan);
  return plan;
}

function digest(data: Uint8Array | string): string { return createHash('sha256').update(data).digest('hex'); }

function v5ResumeFixture(metrics: Record<string, unknown> = { elapsedMs: 1000, peakRssBytes: 100_000_000, tiles: [1, 1, 1, 1, 1, 1, 1, 1] }): { manifest: ManifestV5; plan: BuildPlan; files: Map<string, Buffer> } {
  const base = JSON.parse(readFileSync(new URL('./fixtures/manifest.contract.json', import.meta.url), 'utf8')) as Manifest;
  const grid = { kind: 'regular-latlon' as const, width: 34, height: 17, earthRadiusM: 6371229, lon0: -10, lat0: 10, dx: 0.1, dy: -0.1, wrapLongitude: false };
  const gridHash = digest(canonicalGridJson(grid)), blockCount = 3;
  const output = new Uint8Array(blockCount * 32);
  for (let block = 0; block < blockCount; block++) output[block * 32] = 1;
  const coverage = createSparseCoverage({ width: grid.width, height: grid.height, wrapLongitude: grid.wrapLongitude, gridHash,
    blockIds: Uint32Array.of(0, 2, 3), offsets: Uint32Array.of(0, 1, 2, 3), output, halo: new Uint8Array(output.length) });
  const sparse = encodeSparseCoverage(coverage), tiles = Uint8Array.of(1, 2, 3);
  const descriptor = Buffer.from(JSON.stringify({ version: 2, id: 'fine', grid, gridHash, bounds: base.descriptors.bounds,
    policy: 'fixture', maxZoom: 7, supportHaloCells: 1, sampleLayout: { format: 'cell-major-block-shards-v1', blockSize: 16 },
    files: { sparse: { bytes: sparse.length, sha256: digest(sparse) }, tiles: { bytes: tiles.length, sha256: digest(tiles) } } }));
  const coverageHash = digest(descriptor), maskKey = `coverage/${coverageHash}/manifest.json`, prefix = `coverage/${coverageHash}`;
  const terrainDataId = 'd'.repeat(64);
  const terrainBytes = Buffer.from(JSON.stringify({ version: 2, dataId: terrainDataId, grid, gridHash, coverageHash, layoutVersion: 1, cells: 3 }));
  const terrainSha = digest(terrainBytes), terrainKey = `terrain/prepared/${terrainSha}/manifest.json`;
  const surface = (id: 'native' | 'fine', layers: ManifestV5['layers']) => {
    const channelCount = base.frames.length * layers.length, storedCells = 3;
    const bytes = Buffer.alloc(storedCells * channelCount * 5, 1);
    const shard = { firstBlock: 0, blockCount, storedCells, bytes: bytes.byteLength, sha256: digest(bytes), key: `builds/${base.model}/${base.buildId}/surfaces/${id}/samples/0.bin` };
    return { id, kind: id, grid, gridHash, coverage: { id: 'fine', hash: coverageHash, maskKey, maxZoom: 7, gridHash }, layers,
      samples: { format: 'cell-major-block-shards-v1' as const, blockSize: 16 as const, channelOrder: 'frame-then-layer' as const, channelCount,
        coverageHash, blockCount, storedCells, shards: [shard] },
      ...(id === 'fine' ? { terrain: { dataId: terrainDataId, key: terrainKey, sha256: terrainSha, verticalDatum: 'EGM2008', surface: 'DSM', gridHash, coverageHash, layoutVersion: 1 as const } } : {}),
      file: bytes };
  };
  const native = surface('native', ['precip-rate']), fine = surface('fine', ['usable-lift-msl', 'usable-lift-agl']);
  const { file: nativeFile, ...nativeSurface } = native, { file: fineFile, ...fineSurface } = fine;
  const manifest = manifestV5Schema.parse({ version: 5, descriptors: base.descriptors, recipe: { ...base.recipe, sourceRevision: revision, sourceDirty: false }, model: base.model,
    buildId: base.buildId, cycle: base.cycle, createdAt: base.createdAt, expiresAt: base.expiresAt, method: base.method,
    frames: base.frames, layers: base.layers, artifacts: base.artifacts, source: base.source, tool: base.tool,
    palettes: base.palettes, metrics, surfaces: [nativeSurface, fineSurface] });
  const plan: BuildPlan = { version: 2, model: manifest.model, buildId: manifest.buildId, cycle: manifest.cycle,
    createdAt: manifest.createdAt, coverageHash, providerId: 'fixture-provider', recipe: structuredClone(manifest.recipe),
    groups: [manifest.frames.map(frame => Number(frame.id.slice(1)))],
    wholeDomain: { k: 10, nativeCoverageHash: coverageHash, fineCoverage: { id: 'fine', hash: coverageHash, maskKey, maxZoom: 7, gridHash },
      terrain: { key: terrainKey, sha256: terrainSha, bytes: terrainBytes.length, arrayBytes: 15 } } };
  const files = new Map<string, Buffer>([
    [localPath('output', maskKey), descriptor], [localPath('output', `${prefix}/sparse.bin`), Buffer.from(sparse)],
    [localPath('output', `${prefix}/tiles.bin`), Buffer.from(tiles)], [localPath('output', nativeSurface.samples.shards[0]!.key), nativeFile],
    [localPath('output', fineSurface.samples.shards[0]!.key), fineFile], [localPath('output', terrainKey), terrainBytes],
    [localPath('output', `builds/${manifest.model}/${manifest.buildId}/manifest.json`), Buffer.from(JSON.stringify(manifest))],
    [resolve('output/plan.json'), Buffer.from(JSON.stringify(plan))]
  ]);
  return { manifest, plan, files };
}

it('validates matching v5 frozen plan, coverage, terrain and shard bytes', async () => {
  const { manifest, plan, files } = v5ResumeFixture();
  fake.readLocal.mockImplementation(async (path: string) => files.get(path) ?? files.get(resolve(path)) ?? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })));
  await expect(assertV5ResumeIdentity(manifest, plan, 'output')).resolves.toBeUndefined();
  expect(fake.identity).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'gfs' }), plan.wholeDomain!.nativeCoverageHash,
    undefined, [], undefined, expect.objectContaining({ k: 10, fineCoverageHash: plan.wholeDomain!.fineCoverage.hash }));
});

it('resumes matching v5 artifacts with measured metrics within budget', async () => {
  const { manifest, plan, files } = v5ResumeFixture();
  fake.readPlan.mockResolvedValue(plan);
  fake.directories.mockResolvedValue([{ name: manifest.buildId, isDirectory: () => true }]);
  fake.readLocal.mockImplementation(async (path: string) => files.get(path) ?? files.get(resolve(path)) ?? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })));
  await resumePublication(revision);
  expect(fake.publish).toHaveBeenCalledOnce();
  expect(fake.write).toHaveBeenCalledWith(`output/builds/gfs/${manifest.buildId}/publication.json`, expect.stringContaining('"resumedFromRun": "100"'));
});

it.each([
  { defect: 'elapsed', metrics: { elapsedMs: 51 * 60_000, peakRssBytes: 100_000_000, tiles: [1, 1, 1, 1, 1, 1, 1, 1] }, message: 'elapsedMs' },
  { defect: 'rss', metrics: { elapsedMs: 1000, peakRssBytes: 3 * 1024 ** 3, tiles: [1, 1, 1, 1, 1, 1, 1, 1] }, message: 'peakRssBytes' },
  { defect: 'invalid', metrics: { elapsedMs: -1, peakRssBytes: 0 }, message: 'missing or invalid' }
] as const)('rejects v5 publication with $defect budget metrics', async ({ metrics, message }) => {
  const { manifest, plan, files } = v5ResumeFixture(metrics);
  fake.readPlan.mockResolvedValue(plan);
  fake.directories.mockResolvedValue([{ name: manifest.buildId, isDirectory: () => true }]);
  fake.readLocal.mockImplementation(async (path: string) => files.get(path) ?? files.get(resolve(path)) ?? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })));
  await expect(resumePublication(revision)).rejects.toThrow(message);
  expect(fake.publish).not.toHaveBeenCalled();
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining(message));
});

it.each(['factor', 'native-coverage', 'fine-coverage', 'fine-grid', 'fine-mask', 'terrain-ref', 'recipe'] as const)('rejects altered v5 frozen %s identity before publication', async defect => {
  const { manifest, plan, files } = v5ResumeFixture();
  const frozen = plan.wholeDomain!;
  if (defect === 'factor') frozen.k = 5;
  else if (defect === 'native-coverage') frozen.nativeCoverageHash = 'e'.repeat(64);
  else if (defect === 'fine-coverage') frozen.fineCoverage.hash = 'e'.repeat(64);
  else if (defect === 'fine-grid') frozen.fineCoverage.gridHash = 'e'.repeat(64);
  else if (defect === 'fine-mask') frozen.fineCoverage.maskKey = `coverage/${'e'.repeat(64)}/manifest.json`;
  else if (defect === 'terrain-ref') frozen.terrain.sha256 = 'e'.repeat(64);
  else fake.identity.mockResolvedValueOnce({ recipe: { hash: 'e'.repeat(64) } });
  fake.readLocal.mockImplementation(async (path: string) => files.get(path) ?? files.get(resolve(path)) ?? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })));
  await expect(assertV5ResumeIdentity(manifest, plan, 'output')).rejects.toThrow(/differs|identity/);
  expect(fake.publish).not.toHaveBeenCalled();
});

it.each(['coverage-descriptor', 'sparse', 'tiles', 'shard', 'terrain-file'] as const)('rejects corrupted v5 local %s bytes before publication', async defect => {
  const { manifest, plan, files } = v5ResumeFixture();
  const surface = manifest.surfaces[1]!, prefix = `coverage/${surface.coverage.hash}`;
  if (defect === 'coverage-descriptor') files.set(localPath('output', surface.coverage.maskKey), Buffer.from('corrupt'));
  else if (defect === 'sparse') files.set(localPath('output', `${prefix}/sparse.bin`), Buffer.from([9]));
  else if (defect === 'tiles') files.set(localPath('output', `${prefix}/tiles.bin`), Buffer.from([9]));
  else if (defect === 'shard') files.set(localPath('output', surface.samples.shards[0]!.key), Buffer.alloc(surface.samples.shards[0]!.bytes, 2));
  else files.set(localPath('output', surface.terrain!.key), Buffer.from('{"dataId":"other"}'));
  fake.readLocal.mockImplementation(async (path: string) => files.get(path) ?? files.get(resolve(path)) ?? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })));
  await expect(assertV5ResumeIdentity(manifest, plan, 'output')).rejects.toThrow(/hash|binding/);
  expect(fake.publish).not.toHaveBeenCalled();
});


it('resumes a valid v4 build using frozen inputs without consulting current catalog or zones', async () => {
  const plan = refinedResumePlan();
  vi.stubEnv('TERRAIN_CATALOG_REF', 'invalid new default');
  vi.spyOn(refinementConfiguration, 'configuredRefinements').mockImplementation(() => { throw new Error('Mutable configuration must not be consulted'); });
  fake.identity.mockImplementation(async (_product, _coverage, _terrain, inputs) => ({ recipe: {
    hash: JSON.stringify(inputs) === JSON.stringify(plan.refinements) ? manifest.recipe.hash : 'd'.repeat(64)
  } }));
  await resumePublication(revision);
  expect(fake.readPlan).toHaveBeenCalledWith('output/plan.json');
  expect(fake.identity).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'gfs' }), manifest.coverage.hash, undefined, plan.refinements);
  expect(fake.publish).toHaveBeenCalledOnce();
  expect(fake.plan).not.toHaveBeenCalled(); expect(fake.shard).not.toHaveBeenCalled();
});

it.each(['model', 'build', 'cycle', 'created', 'base-coverage', 'recipe', 'missing-input', 'grid', 'geometry', 'bounds', 'coverage', 'terrain-key', 'terrain-sha'])('rejects altered v4 resume %s binding before identity or publication', async kind => {
  const plan = refinedResumePlan(), input = plan.refinements![0];
  if (kind === 'model') plan.model = 'icon-eu';
  else if (kind === 'build') plan.buildId = '20261030T000000Z-00000000-0000-4000-8000-000000000001';
  else if (kind === 'cycle') plan.cycle = '2026-10-30T06:00:00.000Z';
  else if (kind === 'created') plan.createdAt = '2026-10-30T00:00:02.000Z';
  else if (kind === 'base-coverage') plan.coverageHash = 'd'.repeat(64);
  else if (kind === 'recipe') plan.recipe.hash = 'd'.repeat(64);
  else if (kind === 'missing-input') delete plan.refinements;
  else if (kind === 'grid' && input.grid.kind === 'lambert-conformal') input.grid.x0M += 100;
  else if (kind === 'geometry' && input.geometry.type === 'Polygon') {
    input.geometry.coordinates[0][0][0] += 0.0001;
    input.geometry.coordinates[0].at(-1)![0] += 0.0001;
  }
  else if (kind === 'bounds') input.bounds[0] += 0.001;
  else if (kind === 'coverage') input.coverage.id = 'other-coverage';
  else if (kind === 'terrain-key') input.terrain.key = `terrain/prepared/${'d'.repeat(64)}/manifest.json`;
  else input.terrain.sha256 = 'd'.repeat(64);
  await expect(resumePublication(revision)).rejects.toThrow('Resume plan differs');
  expect(fake.identity).not.toHaveBeenCalled(); expect(fake.publish).not.toHaveBeenCalled();
});

it('rechecks the full frozen reference in the recipe, including metadata absent from the public patch', async () => {
  const plan = refinedResumePlan(), original = JSON.stringify(plan.refinements);
  plan.refinements![0].terrain.bytes++;
  fake.identity.mockImplementation(async (_product, _coverage, _terrain, inputs) => ({ recipe: {
    hash: JSON.stringify(inputs) === original ? manifest.recipe.hash : 'd'.repeat(64)
  } }));
  await expect(resumePublication(revision)).rejects.toThrow('Resume recipe differs');
  expect(fake.publish).not.toHaveBeenCalled();
});

it('reports a missing retained v4 plan without fetching or preparing terrain', async () => {
  refinedResumePlan();
  fake.readPlan.mockRejectedValueOnce(Object.assign(new Error('missing plan'), { code: 'ENOENT' }));
  await expect(resumePublication(revision)).rejects.toThrow('missing plan.json for refined build');
  expect(fake.identity).not.toHaveBeenCalled(); expect(fake.publish).not.toHaveBeenCalled();
});
it('reports incomplete retained shard output without rebuilding or publishing it', async () => {
  fake.readLocal.mockRejectedValueOnce(Object.assign(new Error('missing manifest'), { code: 'ENOENT' }));
  await expect(resumePublication(revision)).rejects.toThrow('Resume artifact is incomplete: missing manifest.json');
  for (const call of [fake.identity, fake.plan, fake.shard, fake.finalize, fake.publish, fake.cleanup]) expect(call).not.toHaveBeenCalled();
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('start a fresh forecast without resume-run-id'));
});
it('preserves unrelated retained manifest read failures', async () => {
  const error = Object.assign(new Error('manifest read denied'), { code: 'EACCES' });
  fake.readLocal.mockRejectedValueOnce(error);
  await expect(resumePublication(revision)).rejects.toBe(error);
  expect(fake.publish).not.toHaveBeenCalled();
});
it('refuses resume after recipe changes and preserves a failure receipt', async () => {
  fake.identity.mockResolvedValueOnce({ recipe: { hash: 'b'.repeat(64) } });
  await expect(resumePublication(revision)).rejects.toThrow('recipe differs');
  expect(fake.publish).not.toHaveBeenCalled();
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('recipe differs'));
});
it('resumes with the retained terrain identity instead of new workflow input', async () => {
  const terrain = { key: `terrain/prepared/${'a'.repeat(64)}/manifest.json`, bytes: 100, sha256: 'b'.repeat(64), arrayBytes: 20 };
  manifest.source.terrain = terrain;
  vi.stubEnv('TERRAIN_INPUTS', JSON.stringify({ gfs: { ...terrain, sha256: 'c'.repeat(64) } }));
  fake.identity.mockImplementation(async (_product, _coverage, actual) => ({ recipe: { hash: actual?.sha256 === terrain.sha256 ? manifest.recipe.hash : 'd'.repeat(64) } }));
  await resumePublication(revision);
  expect(fake.identity).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'gfs' }), manifest.coverage.hash, terrain);
  expect(fake.publish).toHaveBeenCalledTimes(1);
});
it('refuses malformed retained terrain before resuming publication', async () => {
  manifest.source.terrain = { key: 'other/path' };
  await expect(resumePublication(revision)).rejects.toThrow();
  expect(fake.identity).not.toHaveBeenCalled();
  expect(fake.publish).not.toHaveBeenCalled();
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
  vi.stubEnv('TERRAIN_CATALOG_REF', 'not JSON');
  vi.stubEnv('TERRAIN_INPUTS', 'not JSON');
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

it('verifies the committed build and hour listing through the live API after cleanup', async () => {
  await finalizeAndPublish();
  expect(fake.verifyServing).toHaveBeenCalledWith({ baseUrl: 'https://api.example', manifest, signal: expect.any(AbortSignal) });
  expect(fake.verifyServing.mock.invocationCallOrder[0]).toBeGreaterThan(fake.cleanup.mock.invocationCallOrder[0]);
  const record = JSON.parse(fake.write.mock.calls.find(([path]) => String(path).endsWith('/serving.json'))![1]);
  expect(record).toMatchObject({ status: 'verified', model: manifest.model, buildId: manifest.buildId, frames: manifest.frames, layers: manifest.layers });
});

it('preserves committed publication when the API cannot serve the new build', async () => {
  fake.verifyServing.mockRejectedValueOnce(new Error('API still shows previous build'));
  await expect(finalizeAndPublish()).rejects.toThrow('Publication committed; serving verification failed');
  expect(fake.write).toHaveBeenCalledWith('output/builds/gfs/build/serving.json', expect.stringContaining('"publication": "committed"'));
  expect(fake.write).toHaveBeenCalledWith('output/failure.json', expect.stringContaining('"publication": "committed"'));
});

it('rejects missing or invalid serving destinations before publishing', async () => {
  for (const url of ['', 'http://api.example', 'https://api.example/path']) {
    vi.stubEnv('API_BASE_URL', url);
    await expect(finalizeAndPublish()).rejects.toThrow('API_BASE_URL');
  }
  expect(fake.publish).not.toHaveBeenCalled();
});
