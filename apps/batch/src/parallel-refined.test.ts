import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TERRAIN_CLEARANCE_METHOD, type Manifest } from '@av/contracts';
import { buildForecast } from './build.js';
import { buildShard, createBuildPlan, finalizeBuild, type BuildPlan } from './parallel.js';
import { assertValidatedBuild, localPath } from './validate.js';
import * as refinementConfig from './refinement/config.js';
import { seedTerrainCatalog, TerrainTestStorage } from './terrain/test-fixtures.js';
import { CYCLE, cleanupTemporaryRoots, fixtureProvider, mask, product, readManifest, temporaryRoot, tilePixels } from '../parallel-fixtures.js';

vi.mock('./raster-pool.js', async importOriginal => ({
  ...await importOriginal<typeof import('./raster-pool.js')>(),
  rasterWorkerCount: () => 0
}));
const terrainReader = vi.hoisted(() => ({
  opened: 0, close() {},
  async sample(lat: number, lon: number) { return { elevationM: 200 + lat + 50 * lon, source: 'dem' as const }; },
  stats: () => ({ requests: 1, bytesRead: 100, decodedPixels: 4, outputPixels: 100, cacheHits: 0 })
}));
vi.mock('./terrain/reader.js', () => ({ createTerrainReader: async () => { terrainReader.opened++; return terrainReader; } }));

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTemporaryRoots();
});

describe('refined hour-group builds', () => {
  let fixtureRoot: string, serialRoot: string, shardRoot: string;
  let plan: BuildPlan, serial: Manifest;
  let restoreConfig: () => void;
  const source = fixtureProvider();
  const zones = { type: 'FeatureCollection', features: [
    { type: 'Feature', id: 'east', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0.3, 71.2], [0.34, 71.2], [0.34, 71.24], [0.3, 71.24], [0.3, 71.2]]] } },
    { type: 'Feature', id: 'west', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0.1, 71.1], [0.14, 71.1], [0.14, 71.14], [0.1, 71.14], [0.1, 71.1]]] } }
  ] };

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'av-refined-parallel-'));
    serialRoot = join(fixtureRoot, 'serial'); shardRoot = join(fixtureRoot, 'parallel');
    const configured = refinementConfig.configuredRefinements;
    const resolveConfig = vi.spyOn(refinementConfig, 'configuredRefinements').mockImplementation(product => configured(product, zones));
    restoreConfig = () => resolveConfig.mockRestore();
    const storage = new TerrainTestStorage(), refinement = { storage, catalogRef: seedTerrainCatalog(storage) };
    serial = await readManifest(await buildForecast({ out: serialRoot, cycle: CYCLE, product, mask, provider: source.provider, refinement }));
    plan = await createBuildPlan({ out: shardRoot, cycle: CYCLE, product, mask, provider: source.provider, refinement, shards: 2 });
    expect(source.acquire.mock.calls.map(([hour]) => hour)).toEqual(product.frameHours);
    expect(resolveConfig).toHaveBeenCalledTimes(2);
    expect(plan.refinements?.map(input => input.id)).toEqual(['east', 'west']);
    resolveConfig.mockImplementation(() => { throw new Error('Workers must use the frozen regions'); });
    storage.objects.clear();
    const workerRoots = plan.groups.map((_, shard) => join(fixtureRoot, `worker-${shard}`));
    await Promise.all(workerRoots.map(async (out, shard) => {
      await cp(shardRoot, out, { recursive: true });
      const downloadedPlan = JSON.parse(await readFile(join(out, 'plan.json'), 'utf8')) as BuildPlan;
      await buildShard({ plan: downloadedPlan, shard, out, product, mask, provider: source.provider });
    }));
    for (const out of workerRoots) for (const directory of ['builds', 'shards']) {
      await cp(join(out, directory), join(shardRoot, directory), { recursive: true });
    }
  }, 60_000);
  afterAll(async () => {
    restoreConfig?.();
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  });

  async function copyCompleted(): Promise<string> {
    const out = await temporaryRoot();
    await cp(shardRoot, out, { recursive: true });
    return out;
  }
  const manifestPath = (out: string) => join(out, 'builds', product.modelId, plan.buildId, 'manifest.json');
  const finalize = (out: string, onValidated?: Parameters<typeof finalizeBuild>[0]['onValidated']) =>
    finalizeBuild({ plan, out, product, mask, provider: source.provider, onValidated });

  it('merges byte-identical fine AGL packs without acquiring extra forecast hours or rereading terrain', async () => {
    const out = await copyCompleted(), onValidated = vi.fn();
    const manifest = await readManifest(await finalize(out, onValidated));
    expect(manifest.version).toBe(4);
    expect(manifest.frames).toEqual(serial.frames);
    expect(manifest.patches?.map(patch => patch.id)).toEqual(['east', 'west']);
    expect(await readFile(localPath(out, manifest.samples.key))).toEqual(await readFile(localPath(serialRoot, serial.samples.key)));
    for (const [index, patch] of manifest.patches!.entries()) {
      const expected = serial.patches![index], input = plan.refinements![index];
      expect(patch.layers).toEqual([...TERRAIN_CLEARANCE_METHOD.outputs]);
      expect(patch.samples.channelCount).toBe(product.frameHours.length * TERRAIN_CLEARANCE_METHOD.outputs.length);
      expect(patch.grid).toEqual(input.grid);
      expect(patch.coverage).toEqual(input.coverage);
      expect(patch.terrain).toEqual(expected.terrain);
      expect(patch.terrain).toMatchObject({ key: input.terrain.key, sha256: input.terrain.sha256 });
      expect(patch.descriptors).toEqual(expected.descriptors);
      const bytes = await readFile(localPath(out, patch.samples.key));
      expect(bytes).toEqual(await readFile(localPath(serialRoot, expected.samples.key)));
      expect(Array.from({ length: bytes.length / 5 }, (_, i) => bytes.readFloatLE(i * 5)).some(value => value > 0)).toBe(true);
    }
    for (let index = 0; index < manifest.artifacts.length; index++) {
      expect(await tilePixels(out, manifest.artifacts[index])).toEqual(await tilePixels(serialRoot, serial.artifacts[index]));
    }
    expect([...source.observed.hours].sort((a, b) => a - b)).toEqual([2, 2, 4, 4, 6, 6, 8, 8]);
    expect(terrainReader.opened).toBe(2);
    expect(onValidated).toHaveBeenCalledOnce();
    expect(() => assertValidatedBuild(out, manifest, onValidated.mock.calls[0][0])).not.toThrow();
  }, 60_000);

  it.each(['omitted', 'missing', 'extra', 'reordered'])('rejects %s refinement receipts before publishing', async kind => {
    const out = await copyCompleted(), path = join(out, 'shards/0/receipt.json'), onValidated = vi.fn();
    const receipt = JSON.parse(await readFile(path, 'utf8'));
    if (kind === 'omitted') delete receipt.refinements;
    else if (kind === 'missing') receipt.refinements.pop();
    else if (kind === 'extra') receipt.refinements.push({ id: 'unexpected', sampleSha256: '0'.repeat(64) });
    else receipt.refinements.reverse();
    await writeFile(path, JSON.stringify(receipt));
    await expect(finalize(out, onValidated)).rejects.toThrow(/refinement set mismatch/);
    expect(onValidated).not.toHaveBeenCalled();
    await expect(readFile(manifestPath(out))).rejects.toThrow();
  });

  it.each(['missing', 'truncated', 'wrong-hash'])('rejects a %s fine shard pack instead of filling or ignoring it', async kind => {
    const out = await copyCompleted(), path = join(out, 'shards/0/refinements/east/samples.bin'), onValidated = vi.fn();
    if (kind === 'missing') await rm(path);
    else {
      const bytes = await readFile(path);
      if (kind === 'wrong-hash') { bytes[0] ^= 1; await writeFile(path, bytes); }
      else await writeFile(path, bytes.subarray(0, bytes.length - 5));
    }
    await expect(finalize(out, onValidated)).rejects.toThrow();
    expect(onValidated).not.toHaveBeenCalled();
    await expect(readFile(manifestPath(out))).rejects.toThrow();
  });

  it.each(['geometry', 'terrain-reference'])('binds frozen %s to the recipe before opening a provider', async kind => {
    const out = await temporaryRoot(), provider = fixtureProvider(), changed = structuredClone(plan);
    if (kind === 'terrain-reference') changed.refinements![0].terrain.sha256 = '0'.repeat(64);
    else changed.refinements![0].bounds[0] += 0.001;
    await expect(buildShard({ plan: changed, shard: 0, out, product, mask, provider: provider.provider })).rejects.toThrow(/recipe or source revision/);
    expect(provider.open).not.toHaveBeenCalled();
    expect(await readdir(out)).toEqual([]);
  });

  it('rejects missing staged terrain before any acquisition', async () => {
    const out = await copyCompleted(), provider = fixtureProvider();
    await rm(join(out, 'shards'), { recursive: true });
    await rm(localPath(out, plan.refinements![0].terrain.key));
    await expect(buildShard({ plan, shard: 0, out, product, mask, provider: provider.provider })).rejects.toThrow();
    expect(provider.open).not.toHaveBeenCalled();
  });
});
