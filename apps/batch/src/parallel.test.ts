import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PMTiles } from 'pmtiles';
import { GFS_PRODUCT, manifestSchema, setBit, type CoverageMask, type Manifest, type ProductDefinition } from '@av/contracts';
import { normalizedFixtureFrame } from '../../../scripts/fixtures/normalized-provider.js';
import { buildForecast } from './build.js';
import { BUILD_BUDGETS } from './capacity.js';
import { buildShard, createBuildPlan, finalizeBuild, type BuildPlan } from './parallel.js';
import type { ForecastProvider } from './providers.js';
import { assertValidatedBuild, localPath, validateBuild } from './validate.js';
import { decodeWebp } from './webp.js';

// Keep real rasterization, encoding and archive validation, without starting workers for one tile.
vi.mock('./raster-pool.js', async importOriginal => ({
  ...await importOriginal<typeof import('./raster-pool.js')>(),
  rasterWorkerCount: () => 0
}));

const CYCLE = '2026-06-21T00:00:00.000Z';
const product: ProductDefinition = {
  ...GFS_PRODUCT,
  modelId: 'parallel-fixture', id: 'parallel-fixture-recipe',
  source: { modelFamily: 'fixture-model', configurationId: 'parallel-fixture-provider', domainId: 'synthetic' },
  label: 'Parallel build fixture', attribution: 'Synthetic test data',
  coverageDescription: 'Synthetic grid spanning block and longitude-wrap boundaries',
  bounds: [-180, 70, 180, 72],
  grid: { kind: 'regular-latlon', width: 18, height: 3, earthRadiusM: 6371229, lon0: -180, lat0: 72, dx: 20, dy: -1, wrapLongitude: true },
  coverageId: 'parallel-fixture-coverage', maxNativeZoom: 0,
  frameHours: [2, 4, 6, 8], intervalHours: 2
};
const cellCount = product.grid.width * product.grid.height;
const mask: CoverageMask = {
  grid: product.grid, bounds: product.bounds, maxZoom: 0,
  output: new Uint8Array(Math.ceil(cellCount / 8)),
  halo: new Uint8Array(Math.ceil(cellCount / 8)), tiles: Uint8Array.of(1)
};
for (let index = 0; index < cellCount - 1; index++) setBit(mask.output, index);
setBit(mask.halo, cellCount - 1);

function fixtureProvider(options: { failHour?: number; abort?: AbortController; returnedCycle?: string; beforeAcquire?: (hour: number) => Promise<void> } = {}) {
  const observed = { cycles: [] as (string | undefined)[], closed: 0, sessions: 0, peakSessions: 0 };
  const close = vi.fn(async () => { observed.closed++; observed.sessions--; });
  const acquire = vi.fn();
  const open = vi.fn<ForecastProvider['open']>(async ({ cycle, activeIndices }) => {
    observed.cycles.push(cycle);
    observed.sessions++;
    observed.peakSessions = Math.max(observed.peakSessions, observed.sessions);
    return {
    cycle: options.returnedCycle ?? cycle ?? CYCLE,
    stats: { fixture: true, networkRequests: 0 },
    async acquire(hour) {
      acquire(hour);
      await options.beforeAcquire?.(hour);
      if (hour === options.failHour) {
        options.abort?.abort(new Error('Fixture cancellation'));
        throw new Error('Fixture acquisition failure');
      }
      const frame = normalizedFixtureFrame(product.grid, activeIndices, cycle ?? CYCLE, hour, product.intervalHours);
      for (let index = 0; index < activeIndices.length; index++) {
        const elevation = activeIndices[index] * 2;
        frame.terrainM[index] += elevation;
        frame.temp2mK[index] += hour * 0.25;
        for (const heights of frame.hgtM) heights[index] += elevation;
      }
      frame.missing.temp[0][5] = 1;
      return frame;
    },
    close
  };
  });
  const provider: ForecastProvider = {
    id: product.source.configurationId, provider: 'Synthetic fixture', maxLevels: 3,
    open
  };
  return { provider, open, close, acquire, observed };
}

async function readManifest(path: string): Promise<Manifest> {
  return manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

async function tilePixels(root: string, artifact: Manifest['artifacts'][number]): Promise<Uint8Array> {
  const bytes = await readFile(localPath(root, artifact.tilesKey));
  const archive = new PMTiles({
    getKey: () => artifact.tilesKey,
    async getBytes(offset, length) {
      const selected = bytes.subarray(offset, offset + length);
      return { data: selected.buffer.slice(selected.byteOffset, selected.byteOffset + selected.byteLength) };
    }
  });
  const tile = await archive.getZxy(0, 0, 0);
  expect(tile).toBeDefined();
  return (await decodeWebp(new Uint8Array(tile!.data))).data;
}

const temporary: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'av-parallel-test-'));
  temporary.push(root);
  return root;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

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
    const runs = await Promise.allSettled([0, 1].map(async shard => {
      try {
        receipts[shard] = await buildShard({ plan, shard, out: shardRoot, product, mask, provider: source.provider });
        completionOrder.push(shard);
      } finally { if (shard === 1) releaseEarlier(); }
    }));
    holdEarlier = false;
    for (const result of runs) if (result.status === 'rejected') throw result.reason;
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

  it('reproduces serial sample bytes and tile pixels for a non-GFS, non-hourly product', async () => {
    const out = await copyCompleted(), onValidated = vi.fn();
    const path = await finalize(out, onValidated), manifest = await readManifest(path);
    expect(plan.groups).toEqual([[2, 4], [6, 8]]);
    expect(manifest.model).toBe('parallel-fixture');
    expect(manifest.frames).toEqual(serial.frames);
    expect(manifest.layers).toEqual(serial.layers);
    expect(manifest.descriptors).toEqual(serial.descriptors);
    expect(manifest.method).toEqual(serial.method);
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
    const changed = { ...plan, createdAt, buildId: `${createdAt.replace(/[-:]/g, '').slice(0, 15)}Z-${plan.buildId.split('Z-')[1]}` };
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

  it.each([0, -1, 1.5, 5])('rejects an unbounded or invalid shard count %s before acquisition', async shards => {
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
