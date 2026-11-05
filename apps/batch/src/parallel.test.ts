import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeBoundedJson, LIFT_STEP_RENDER_STYLE, liftRenderStyle, MAX_MANIFEST_BYTES, PALETTES, type CoverageMask, type Manifest, type ProductDefinition } from '@av/contracts';
import { normalizedFixtureFrame } from '../../../scripts/fixtures/normalized-provider.js';
import { buildForecast } from './build.js';
import { BUILD_BUDGETS } from './capacity.js';
import { buildShard, createBuildPlan, finalizeBuild, MAX_FORECAST_SHARDS, readBuildPlan, type BuildPlan } from './parallel.js';
import type { ForecastProvider } from './provider.js';
import { assertValidatedBuild, localPath, sha256, validateBuild } from './validate.js';
import { CYCLE, cleanupTemporaryRoots, fixtureProvider, mask, product, readManifest, temporaryRoot, tilePixels } from '../parallel-fixtures.js';

// Keep real rasterization, encoding and archive validation, without starting workers for one tile.
vi.mock('./raster-pool.js', async importOriginal => ({
  ...await importOriginal<typeof import('./raster-pool.js')>(),
  rasterWorkerCount: () => 0
}));
vi.mock('./terrain/reader.js', () => ({ createTerrainReader: async () => ({
  close() {},
  async sample(lat: number, lon: number) { return { elevationM: 200 + lat + 50 * lon, source: 'dem' as const }; },
  stats: () => ({ requests: 1, bytesRead: 100, decodedPixels: 4, outputPixels: 100, cacheHits: 0 })
}) }));

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTemporaryRoots();
});

describe('forecast hour-group builds', () => {
  let fixtureRoot: string, serialRoot: string, shardRoot: string;
  let plan: BuildPlan, serial: Manifest;
  let receipts: string[];
  let holdEarlier = false, releaseEarlier = () => {};
  let laterFinished = Promise.resolve();
  const completionOrder: number[] = [];
  const source = fixtureProvider({ beforeAcquire: async hour => { if (holdEarlier && hour === 2) await laterFinished; } });

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'av-parallel-complete-'));
    serialRoot = join(fixtureRoot, 'serial');
    shardRoot = join(fixtureRoot, 'shards');
    serial = await readManifest(await buildForecast({ out: serialRoot, cycle: CYCLE, product, mask, provider: source.provider }));
    plan = await createBuildPlan({ out: shardRoot, cycle: CYCLE, product, mask, provider: source.provider, shards: 2 });
    receipts = [];
    // Both sessions overlap; deliberately finish later hours before releasing the earlier group.
    holdEarlier = true;
    laterFinished = new Promise(resolve => { releaseEarlier = resolve; });
    const workerRoots = plan.groups.map((_, shard) => join(fixtureRoot, `worker-${shard}`));
    const runs = await Promise.allSettled(workerRoots.map(async (out, shard) => {
      try {
        await cp(shardRoot, out, { recursive: true });
        const downloadedPlan = JSON.parse(await readFile(join(out, 'plan.json'), 'utf8')) as BuildPlan;
        const receipt = await buildShard({ plan: downloadedPlan, shard, out, product, mask, provider: source.provider });
        receipts[shard] = join(shardRoot, relative(out, receipt));
        completionOrder.push(shard);
      } finally { if (shard === 1) releaseEarlier(); }
    }));
    holdEarlier = false;
    for (const result of runs) if (result.status === 'rejected') throw result.reason;
    // Match the workflow's artifact handoff: only completed packs, receipts and archives merge.
    for (const out of workerRoots) for (const directory of ['builds', 'shards']) {
      await cp(join(out, directory), join(shardRoot, directory), { recursive: true });
    }
  }, 60_000);
  afterAll(async () => { if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

  async function copyCompleted(): Promise<string> {
    const out = await temporaryRoot();
    await cp(shardRoot, out, { recursive: true });
    return out;
  }
  const manifestPath = (out: string) => join(out, 'builds', product.modelId, plan.buildId, 'manifest.json');
  const receiptPath = (out: string, shard: number) => join(out, relative(shardRoot, receipts[shard]));
  async function mutateReceipt(out: string, shard: number, change: (receipt: Record<string, unknown>) => void) {
    const path = receiptPath(out, shard), receipt = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    change(receipt);
    await writeFile(path, JSON.stringify(receipt));
  }
  const finalize = (out: string, onValidated?: Parameters<typeof finalizeBuild>[0]['onValidated']) =>
    finalizeBuild({ plan, out, product, mask, provider: source.provider, onValidated });

  it('reproduces serial sample bytes and tile pixels after isolated workers transfer their artifacts', async () => {
    vi.stubEnv('PMTILES_BIN', '/unused/finalizer-must-not-run-the-archive-builder');
    const out = await copyCompleted(), onValidated = vi.fn();
    const path = await finalize(out, onValidated), manifest = await readManifest(path);
    expect(plan.groups).toEqual([[2, 4], [6, 8]]);
    expect(manifest.model).toBe('parallel-fixture');
    expect(manifest.frames).toEqual(serial.frames);
    expect(manifest.layers).toEqual(serial.layers);
    expect(manifest.descriptors).toEqual(serial.descriptors);
    expect(manifest.method).toEqual(serial.method);
    expect(manifest.tool.liftRenderStyle).toBe(serial.tool.liftRenderStyle);
    expect(manifest.tool.liftRenderStyle).toBe(liftRenderStyle(PALETTES.lift.interpolation));
    expect(manifest.tool.liftRenderStyle).toBe(LIFT_STEP_RENDER_STYLE);
    expect(manifest.samples.channelCount).toBe(12);
    expect(await readFile(localPath(out, manifest.samples.key))).toEqual(await readFile(localPath(serialRoot, serial.samples.key)));
    expect(manifest.artifacts.map(({ layer, frame }) => ({ layer, frame }))).toEqual(serial.artifacts.map(({ layer, frame }) => ({ layer, frame })));
    for (let index = 0; index < manifest.artifacts.length; index++) {
      expect(await tilePixels(out, manifest.artifacts[index])).toEqual(await tilePixels(serialRoot, serial.artifacts[index]));
    }
    const provenance = JSON.parse(await readFile(localPath(out, manifest.source.provenanceKey), 'utf8'));
    expect(provenance.frames.map((frame: { hour: number }) => frame.hour)).toEqual(product.frameHours);
    const validated = await validateBuild(out, manifest, mask, plan.coverageHash, product);
    expect(() => assertValidatedBuild(out, manifest, validated)).not.toThrow();
    expect(onValidated).toHaveBeenCalledExactlyOnceWith(expect.any(Object), path);
    expect(() => assertValidatedBuild(out, manifest, onValidated.mock.calls[0][0])).not.toThrow();
    expect(source.observed.cycles).toEqual([CYCLE, CYCLE, CYCLE]);
    expect(source.observed.closed).toBe(3);
    expect(source.observed.peakSessions).toBe(2);
    expect(source.observed.sessions).toBe(0);
    expect(completionOrder).toEqual([1, 0]);
  }, 60_000);

  it('records summed worker effort separately from elapsed time and peak memory', async () => {
    const out = await copyCompleted();
    for (const shard of [0, 1]) await mutateReceipt(out, shard, receipt => {
      const metrics = receipt.metrics as { peakRssBytes: number };
      metrics.peakRssBytes = (shard === 0 ? 1 : 1.5) * 1024 ** 3;
    });
    const workerMetrics = await Promise.all(receipts.map(path => readFile(path, 'utf8').then(bytes => JSON.parse(bytes).metrics as { elapsedMs: number; phasesMs: Record<string, number> })));
    const manifest = await readManifest(await finalize(out));
    expect(manifest.metrics.execution).toMatchObject({ mode: 'parallel', shardCount: 2, totalWorkerElapsedMs: workerMetrics.reduce((sum, worker) => sum + worker.elapsedMs, 0) });
    expect(manifest.metrics.peakRssBytes).toBe(1.5 * 1024 ** 3);
    const elapsedMs = manifest.metrics.elapsedMs as number;
    expect(elapsedMs).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThanOrEqual(Date.now() - Date.parse(plan.createdAt));
    const phases = manifest.metrics.phasesMs as Record<string, number>;
    expect(phases.validateMs).toBeGreaterThanOrEqual(0);
    for (const phase of ['acquireMs', 'deriveMs', 'renderMs']) expect(phases[phase]).toBe(workerMetrics.reduce((sum, worker) => sum + worker.phasesMs[phase], 0));
    expect(phases.packMs).toBeGreaterThanOrEqual(workerMetrics.reduce((sum, worker) => sum + worker.phasesMs.packMs, 0));
  });

  it('keeps regional model-level lift builds identical while omitting dark-hour acquisition', async () => {
    const regional: ProductDefinition = {
      ...product,
      modelId: 'regional-fixture', id: 'regional-fixture-recipe',
      coverageId: 'regional-fixture-coverage', bounds: [-2, -2, 2, 2],
      grid: { kind: 'regular-latlon', width: 3, height: 3, earthRadiusM: 6371229, lon0: -2, lat0: 2, dx: 2, dy: -2, wrapLongitude: false },
      frameHours: [2, 8, 14, 22], layers: ['usable-lift-msl', 'usable-lift-agl'],
      capabilities: { verticalCoordinate: 'model-levels', maxVerticalLevels: 3, daylightFrames: 'regional-daylight' }
    };
    const regionalMask: CoverageMask = {
      grid: regional.grid, bounds: regional.bounds, maxZoom: 0,
      output: Uint8Array.of(255, 1), halo: new Uint8Array(2), tiles: Uint8Array.of(1)
    };
    const acquire = vi.fn();
    const provider: ForecastProvider = {
      id: regional.source.configurationId, provider: 'Synthetic model-level fixture', maxLevels: 3,
      async open({ cycle = CYCLE, activeIndices }) {
        return {
          cycle, stats: {},
          async acquire(hour) {
            acquire(hour);
            const frame = normalizedFixtureFrame(regional.grid, activeIndices, cycle, hour, regional.intervalHours);
            for (let index = 0; index < activeIndices.length; index++) frame.temp2mK[index] += hour * 0.25 + activeIndices[index] * 0.05;
            const pressurePa = frame.pressureLevelsHpa.map(pressure => new Float32Array(activeIndices.length).fill(pressure * 100));
            delete frame.precipitationMmPerHour;
            delete frame.missing.precipitation;
            delete frame.intervals.precipitationWindow;
            delete frame.intervals.precipitationSourceWindow;
            return { ...frame, pressureLevelsHpa: undefined, pressurePa, missing: { ...frame.missing, pressure: pressurePa.map(() => new Uint8Array(activeIndices.length)) } };
          },
          async close() {}
        };
      }
    };
    const root = await temporaryRoot(), localOut = join(root, 'local'), parallelOut = join(root, 'parallel');
    const inputs = { cycle: CYCLE, product: regional, mask: regionalMask, provider };
    const local = await readManifest(await buildForecast({ ...inputs, out: localOut }));
    expect(acquire.mock.calls.map(([hour]) => hour)).toEqual([8, 14]);
    acquire.mockClear();
    const regionalPlan = await createBuildPlan({ ...inputs, out: parallelOut, shards: 2 });
    expect(regionalPlan.groups).toEqual([[8], [14]]);
    expect(acquire).not.toHaveBeenCalled();
    await Promise.all(regionalPlan.groups.map((_, shard) => buildShard({ ...inputs, plan: regionalPlan, shard, out: parallelOut })));
    const parallel = await readManifest(await finalizeBuild({ ...inputs, plan: regionalPlan, out: parallelOut }));
    expect(acquire.mock.calls.map(([hour]) => hour).sort((a, b) => a - b)).toEqual([8, 14]);
    expect(local.frames.map(frame => frame.id)).toEqual(['f008', 'f014']);
    expect(parallel.frames).toEqual(local.frames);
    expect(parallel.layers).toEqual(regional.layers);
    expect(parallel.descriptors).toEqual(local.descriptors);
    expect(parallel.method).toEqual(local.method);
    expect(parallel.samples.channelCount).toBe(4);
    expect(parallel.samples.sha256).toBe(local.samples.sha256);
    expect(await readFile(localPath(parallelOut, parallel.samples.key))).toEqual(await readFile(localPath(localOut, local.samples.key)));
    expect(parallel.artifacts.map(({ layer, frame }) => ({ layer, frame }))).toEqual(local.artifacts.map(({ layer, frame }) => ({ layer, frame })));
    expect(parallel.metrics.frames).toEqual(local.metrics.frames);
    for (const frame of Object.values(local.metrics.frames as Record<string, Record<string, { valid: number }>>)) {
      for (const layer of regional.layers) expect(frame[layer].valid).toBe(9);
    }
  }, 60_000);

  it('refuses to finalize when an expected group receipt is missing', async () => {
    const out = await copyCompleted(), onValidated = vi.fn();
    await rm(receiptPath(out, 1));
    await expect(finalize(out, onValidated)).rejects.toThrow();
    expect(onValidated).not.toHaveBeenCalled();
    await expect(readFile(manifestPath(out))).rejects.toThrow();
  });

  it('rejects a completed receipt from another build', async () => {
    const out = await copyCompleted();
    await mutateReceipt(out, 0, receipt => { receipt.planHash = '0'.repeat(64); });
    await expect(finalize(out)).rejects.toThrow();
    await expect(readFile(manifestPath(out))).rejects.toThrow();
  });

  it.each(['missing', 'extra'])('rejects %s artifact hashes instead of changing channel membership', async count => {
    const out = await copyCompleted();
    await mutateReceipt(out, 0, receipt => {
      const hashes = receipt.tileSha256 as string[];
      if (count === 'missing') hashes.pop();
      else hashes.push(hashes[0]);
    });
    await expect(finalize(out)).rejects.toThrow(/artifact count/);
    await expect(readFile(manifestPath(out))).rejects.toThrow();
  });

  it.each(['samples', 'tiles'])('verifies the compact receipt %s hash against the actual bytes', async kind => {
    const out = await copyCompleted();
    await mutateReceipt(out, 0, receipt => {
      if (kind === 'samples') receipt.sampleSha256 = '0'.repeat(64);
      else (receipt.tileSha256 as string[])[0] = '0'.repeat(64);
    });
    await expect(finalize(out)).rejects.toThrow(/hash/i);
    await expect(readFile(manifestPath(out))).rejects.toThrow();
  });

  it('rejects a repeated receipt instead of accepting duplicate hours as completion', async () => {
    const out = await copyCompleted();
    await writeFile(receiptPath(out, 1), await readFile(receiptPath(out, 0)));
    await expect(finalize(out)).rejects.toThrow();
    await expect(readFile(manifestPath(out))).rejects.toThrow();
  });

  it('rejects a shard provenance window that differs from its forecast frame', async () => {
    const out = await copyCompleted();
    await mutateReceipt(out, 0, receipt => {
      const provenance = receipt.provenance as { intervals: { fluxWindow: { end: string } } }[];
      provenance[0].intervals.fluxWindow.end = CYCLE;
    });
    await expect(finalize(out)).rejects.toThrow();
    await expect(readFile(manifestPath(out))).rejects.toThrow();
  });

  it('rejects an extra downloaded shard instead of silently mixing attempts', async () => {
    const out = await copyCompleted();
    await cp(dirname(receiptPath(out, 0)), join(out, 'shards', '2'), { recursive: true });
    await expect(finalize(out)).rejects.toThrow();
    await expect(readFile(manifestPath(out))).rejects.toThrow();
  });

  it('rejects altered archive bytes before handing a build to publication', async () => {
    const out = await copyCompleted(), onValidated = vi.fn();
    const path = join(out, 'builds', product.modelId, plan.buildId, product.layers[0], 'f002.pmtiles');
    const bytes = await readFile(path);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(path, bytes);
    await expect(finalize(out, onValidated)).rejects.toThrow();
    expect(onValidated).not.toHaveBeenCalled();
    await expect(readFile(manifestPath(out))).rejects.toThrow();
  });

  it('rejects a truncated partial sample pack instead of filling missing channels with zero', async () => {
    const out = await copyCompleted(), directory = dirname(receiptPath(out, 0));
    const binaryFiles = (await readdir(directory)).filter(name => name.endsWith('.bin'));
    expect(binaryFiles).toHaveLength(1);
    const path = join(directory, binaryFiles[0]), bytes = await readFile(path);
    await writeFile(path, bytes.subarray(0, bytes.length - 5));
    await expect(finalize(out)).rejects.toThrow();
    await expect(readFile(manifestPath(out))).rejects.toThrow();
  });

  it('binds the plan to the current recipe and coverage before opening a provider', async () => {
    const out = await temporaryRoot(), provider = fixtureProvider();
    const changed = { ...plan, recipe: { ...plan.recipe, hash: '0'.repeat(64) } };
    await expect(buildShard({ plan: changed, shard: 0, out, product, mask, provider: provider.provider })).rejects.toThrow();
    const changedMask = { ...mask, output: new Uint8Array(mask.output) };
    changedMask.output[0] ^= 1;
    await expect(buildShard({ plan, shard: 0, out, product, mask: changedMask, provider: provider.provider })).rejects.toThrow();
    expect(provider.open).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'output path', extra: { out: '/untrusted-plan-output' } },
    { name: 'science options', extra: { deriveOptions: { daylightOnly: false, sinkRateMps: 0 } } }
  ])('rejects a serialized plan that tries to override $name', async ({ extra }) => {
    const out = await temporaryRoot(), provider = fixtureProvider();
    const changed = { ...plan, ...extra };
    await expect(buildShard({ plan: changed, shard: 0, out, product, mask, provider: provider.provider })).rejects.toThrow(/plan/);
    expect(provider.open).not.toHaveBeenCalled();
    expect(await readdir(out)).toEqual([]);
  });

  it('rejects an otherwise consistent plan older than the measured build budget', async () => {
    const out = await temporaryRoot(), provider = fixtureProvider();
    const createdAt = new Date(Date.now() - BUILD_BUDGETS.elapsedMs - 1000).toISOString();
    const changed = { ...plan, createdAt, deadlineAt: new Date(Date.parse(createdAt) + BUILD_BUDGETS.elapsedMs).toISOString(), buildId: `${createdAt.replace(/[-:]/g, '').slice(0, 15)}Z-${plan.buildId.split('Z-')[1]}` };
    await expect(buildShard({ plan: changed, shard: 0, out, product, mask, provider: provider.provider })).rejects.toThrow(/elapsed-time budget/);
    expect(provider.open).not.toHaveBeenCalled();
    expect(await readdir(out)).toEqual([]);
  });

  it.each([false, true])('does not complete a failed shard (cancelled=%s)', async cancelled => {
    const out = await temporaryRoot(), abort = cancelled ? new AbortController() : undefined;
    const provider = fixtureProvider({ failHour: 2, abort });
    await expect(buildShard({ plan, shard: 0, out, product, mask, provider: provider.provider, signal: abort?.signal })).rejects.toThrow();
    expect(provider.close).toHaveBeenCalledOnce();
    await expect(readFile(receiptPath(out, 0))).rejects.toThrow();
    await expect(finalize(out)).rejects.toThrow();
    await expect(readFile(manifestPath(out))).rejects.toThrow();
  });

  it('rejects provider cycle drift rather than mixing model runs', async () => {
    const out = await temporaryRoot(), provider = fixtureProvider({ returnedCycle: '2026-06-21T06:00:00.000Z' });
    await expect(buildShard({ plan, shard: 0, out, product, mask, provider: provider.provider })).rejects.toThrow();
    expect(provider.acquire).not.toHaveBeenCalled();
    expect(provider.close).toHaveBeenCalledOnce();
    await expect(readFile(receiptPath(out, 0))).rejects.toThrow();
  });

  it('does not overwrite a complete shard on an accidental retry', async () => {
    const out = await copyCompleted(), before = await readFile(receiptPath(out, 0));
    const provider = fixtureProvider();
    await expect(buildShard({ plan, shard: 0, out, product, mask, provider: provider.provider })).rejects.toThrow();
    expect(await readFile(receiptPath(out, 0))).toEqual(before);
    expect(provider.open).not.toHaveBeenCalled();
  });

  it('rejects groups outside the planned product before acquisition', async () => {
    const out = await temporaryRoot(), provider = fixtureProvider();
    for (const groups of [[[2, 4], [4, 8]], [[2, 4], [6]], [[2, 4], [6, 10]]]) {
      await expect(buildShard({ plan: { ...plan, groups }, shard: 0, out, product, mask, provider: provider.provider })).rejects.toThrow();
    }
    expect(provider.open).not.toHaveBeenCalled();
  });

  it('assigns the extra hour to the early group and preserves forecast order', async () => {
    const hours = [1, 2, 3, 4, 5, 6, 7, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
    const configured = { ...product, frameHours: hours, intervalHours: 1 };
    const out = await temporaryRoot(), source = fixtureProvider();
    const planned = await createBuildPlan({ out, cycle: CYCLE, product: configured, mask, provider: source.provider, shards: 4 });
    expect(planned.groups).toEqual([[1, 2, 3, 4, 5], [6, 7, 15, 16], [17, 18, 19, 20], [21, 22, 23, 24]]);
    expect(planned.groups.flat()).toEqual(hours);
    expect(source.open).not.toHaveBeenCalled();
  });

  it.each([
    { hours: [1, 2, 3, 4, 5, 6], shards: 3 },
    { hours: [1, 9, 10, 11, 12, 17, 18], shards: 4 },
    { hours: [1, 2, 3, 4], shards: 8 }
  ])('partitions the configured timeline with shard target $shards', async ({ hours, shards }) => {
    const configured = { ...product, frameHours: hours, intervalHours: 1, execution: { ...product.execution, shards } };
    const out = await temporaryRoot(), source = fixtureProvider();
    const planned = await createBuildPlan({ out, cycle: CYCLE, product: configured, mask, provider: source.provider });
    expect(planned.groups).toHaveLength(Math.min(shards, hours.length));
    expect(planned.groups.flat()).toEqual(hours);
    const sizes = planned.groups.map(group => group.length);
    expect(Math.min(...sizes)).toBeGreaterThan(0);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(source.open).not.toHaveBeenCalled();
  });

  it('preserves receipt hashes for plans that omit execution settings', async () => {
    const out = await temporaryRoot(), source = fixtureProvider();
    const old = await createBuildPlan({ out, cycle: CYCLE, product, mask, provider: source.provider });
    delete old.execution;
    await writeFile(join(out, 'plan.json'), encodeBoundedJson(old, MAX_MANIFEST_BYTES));
    const parsed = await readBuildPlan(join(out, 'plan.json'));
    expect(Object.hasOwn(parsed, 'execution')).toBe(false);
    const path = await buildShard({ out, plan: parsed, shard: 0, product, mask, provider: source.provider });
    const receipt = JSON.parse(await readFile(path, 'utf8'));
    expect(receipt.planHash).toBe(sha256(encodeBoundedJson(old, MAX_MANIFEST_BYTES)));
  });

  it.each([0, -1, 1.5, MAX_FORECAST_SHARDS + 1])('rejects an unbounded or invalid shard count %s before acquisition', async shards => {
    const out = await temporaryRoot(), provider = fixtureProvider();
    await expect(createBuildPlan({ out, cycle: CYCLE, product, mask, provider: provider.provider, shards })).rejects.toThrow();
    expect(provider.open).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'invalid-cycle'])('requires an explicit resolved cycle (%s)', async cycle => {
    const out = await temporaryRoot(), provider = fixtureProvider();
    await expect(createBuildPlan({ out, cycle: cycle as string, product, mask, provider: provider.provider })).rejects.toThrow(/resolved forecast cycle/);
    expect(provider.open).not.toHaveBeenCalled();
    expect(await readdir(out)).toEqual([]);
  });

});
