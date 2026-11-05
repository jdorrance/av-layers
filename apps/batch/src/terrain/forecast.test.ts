import { INDEXED_PRODUCT } from '../../../../tests/model-fixtures.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { type CoverageMask, type ProductDefinition } from '@av/contracts';
import { buildShard, createBuildPlan, type BuildPlan } from '../parallel.js';
import type { ForecastProvider } from '../provider.js';
import * as localFiles from '../local-file.js';
import { prepareTerrain } from './prepare.js';
import { TerrainTestStorage, terrainCatalogFixture } from './test-fixtures.js';

vi.mock('./reader.js', () => ({ createTerrainReader: async () => ({ sample: async () => ({ elevationM: 42, source: 'dem' }), close: async () => {}, stats: () => ({ requests: 0, bytesRead: 0, decodedPixels: 0, outputPixels: 4, cacheHits: 0 }) }) }));
const product: ProductDefinition = { ...INDEXED_PRODUCT, modelId: 'terrain-fixture', id: 'terrain-fixture', bounds: [0, 0, 1, 1],
  grid: { kind: 'regular-latlon', width: 2, height: 2, earthRadiusM: 6371229, lon0: 0, lat0: 1, dx: 1, dy: -1, wrapLongitude: false },
  coverageId: 'terrain-fixture', coverageDescription: 'Synthetic terrain staging test', maxNativeZoom: 0, frameHours: [1], terrainSubdivisionFactor: undefined };
const mask: CoverageMask = { grid: product.grid, bounds: product.bounds, maxZoom: 0, output: Uint8Array.of(15), halo: Uint8Array.of(0), tiles: Uint8Array.of(1) };
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const out = await mkdtemp(join(tmpdir(), 'av-terrain-plan-')); roots.push(out);
  const open = vi.fn<ForecastProvider['open']>(async () => { throw new Error('fixture acquisition reached'); });
  const provider: ForecastProvider = { id: product.source.configurationId, provider: 'Synthetic', maxLevels: 1, open };
  return { out, open, provider, product, mask, cycle: '2026-06-21T00:00:00.000Z' };
}

it('leaves ordinary plans terrain-free and admits the provider without a terrain read', async () => {
  const options = await fixture(), plan = await createBuildPlan(options);
  expect(plan).not.toHaveProperty('terrain');
  const read = vi.spyOn(localFiles, 'readLocalFile');
  await expect(buildShard({ ...options, plan, shard: 0 })).rejects.toThrow('fixture acquisition reached');
  expect(options.open).toHaveBeenCalledOnce();
  expect(read.mock.calls.some(([path]) => path.includes('/terrain/'))).toBe(false);
});
it('pins the serialized terrain ref and validates exactly three staged files before acquisition', async () => {
  const options = await fixture(), storage = new TerrainTestStorage();
  const ref = await prepareTerrain({ catalog: terrainCatalogFixture(), storage, grid: product.grid });
  await createBuildPlan({ ...options, terrain: { ref, storage } });
  const plan = JSON.parse(await readFile(join(options.out, 'plan.json'), 'utf8')) as BuildPlan;
  expect(plan.terrain).toEqual(ref);
  const read = vi.spyOn(localFiles, 'readLocalFile');
  await expect(buildShard({ ...options, plan, shard: 0 })).rejects.toThrow('fixture acquisition reached');
  expect(options.open).toHaveBeenCalledOnce();
  expect(read.mock.calls.filter(([path]) => path.includes('/terrain/prepared/'))).toHaveLength(3);
});
it('fails a corrupted staged sidecar before opening weather acquisition', async () => {
  const options = await fixture(), storage = new TerrainTestStorage();
  const ref = await prepareTerrain({ catalog: terrainCatalogFixture(), storage, grid: product.grid });
  const plan = await createBuildPlan({ ...options, terrain: { ref, storage } });
  await writeFile(join(options.out, ref.key.replace('manifest.json', 'valid.u8')), Uint8Array.of(1, 0, 0, 0));
  await expect(buildShard({ ...options, plan, shard: 0 })).rejects.toThrow('integrity mismatch');
  expect(options.open).not.toHaveBeenCalled();
});
it('rejects a changed pinned reference before opening weather acquisition', async () => {
  const options = await fixture(), storage = new TerrainTestStorage();
  const ref = await prepareTerrain({ catalog: terrainCatalogFixture(), storage, grid: product.grid });
  const plan = await createBuildPlan({ ...options, terrain: { ref, storage } });
  plan.terrain!.sha256 = 'f'.repeat(64);
  await expect(buildShard({ ...options, plan, shard: 0 })).rejects.toThrow('recipe or source revision changed');
  expect(options.open).not.toHaveBeenCalled();
});
