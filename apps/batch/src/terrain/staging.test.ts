import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { type Grid } from '@av/contracts';
import { prepareTerrain } from './prepare.js';
import { loadPreparedTerrain, loadTerrainCatalog, stagePreparedTerrain } from './staging.js';
import { seedTerrainCatalog, TerrainTestStorage, terrainCatalogFixture } from './test-fixtures.js';
import { CATALOG_MAX_BYTES } from './contract.js';

vi.mock('./reader.js', () => ({ createTerrainReader: async () => ({ sample: async () => ({ elevationM: 12.5, source: 'dem' }), close: async () => {}, stats: () => ({ requests: 0, bytesRead: 0, decodedPixels: 0, outputPixels: 4, cacheHits: 0 }) }) }));
const grid: Grid = { kind: 'regular-latlon', width: 2, height: 2, earthRadiusM: 6371229, lon0: 0, lat0: 1, dx: 1, dy: -1, wrapLongitude: false };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const out = await mkdtemp(join(tmpdir(), 'av-terrain-stage-')); roots.push(out);
  const storage = new TerrainTestStorage(), ref = await prepareTerrain({ catalog: terrainCatalogFixture(), storage, grid });
  return { storage, ref, out, grid };
}

it('stages immutable arrays for a network-free shard load', async () => {
  const options = await fixture();
  await stagePreparedTerrain(options);
  const requests = options.storage.gets.length;
  const ready = await loadPreparedTerrain(options);
  expect([...ready.elevationM]).toEqual([12.5, 12.5, 12.5, 12.5]);
  expect([...ready.valid]).toEqual([1, 1, 1, 1]);
  expect(options.storage.gets.length).toBe(requests);
  expect(await readFile(join(options.out, options.ref.key))).toEqual(Buffer.from(options.storage.objects.get(options.ref.key)!));
});
it('does not publish a staged descriptor when an asset is missing or the grid differs', async () => {
  const options = await fixture();
  await expect(stagePreparedTerrain({ ...options, grid: { ...grid, width: 3 } })).rejects.toThrow('grid mismatch');
  options.storage.objects.delete(options.ref.key.replace('manifest.json', 'valid.u8'));
  await expect(stagePreparedTerrain(options)).rejects.toThrow('asset missing');
  await expect(readFile(join(options.out, options.ref.key))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects local corruption and wrong pinned descriptors before exposing arrays', async () => {
  const options = await fixture(); await stagePreparedTerrain(options);
  await expect(loadPreparedTerrain({ ...options, ref: { ...options.ref, sha256: 'f'.repeat(64) } })).rejects.toThrow('integrity mismatch');
  await writeFile(join(options.out, options.ref.key.replace('manifest.json', 'valid.u8')), Uint8Array.of(1, 1, 1, 0));
  await expect(loadPreparedTerrain(options)).rejects.toThrow('integrity mismatch');
});

it('loads only the checksum-pinned catalog and validates its data identity', async () => {
  const storage = new TerrainTestStorage(), catalog = terrainCatalogFixture(), ref = seedTerrainCatalog(storage, catalog);
  expect(await loadTerrainCatalog(ref, storage)).toEqual(catalog);
  const corrupted = new Uint8Array(storage.objects.get(ref.key)!); corrupted[corrupted.length - 1] ^= 1;
  storage.objects.set(ref.key, corrupted);
  await expect(loadTerrainCatalog(ref, storage)).rejects.toThrow('missing or corrupt');
  storage.objects.delete(ref.key);
  await expect(loadTerrainCatalog(ref, storage)).rejects.toThrow('missing or corrupt');
  const invalid = seedTerrainCatalog(storage, { ...catalog, dataId: 'f'.repeat(64) });
  await expect(loadTerrainCatalog(invalid, storage)).rejects.toThrow('data identity');
});

it('rejects oversized or cancelled catalog reads before touching storage', async () => {
  const storage = new TerrainTestStorage(), ref = seedTerrainCatalog(storage);
  await expect(loadTerrainCatalog({ ...ref, bytes: CATALOG_MAX_BYTES + 1 }, storage)).rejects.toThrow('catalog reference');
  await expect(loadTerrainCatalog({ ...ref, key: 'terrain/catalogs/other.json' }, storage)).rejects.toThrow('catalog reference');
  const controller = new AbortController(); controller.abort(new Error('stopped'));
  await expect(loadTerrainCatalog(ref, storage, controller.signal)).rejects.toThrow('stopped');
  expect(storage.gets).toEqual([]);
});
