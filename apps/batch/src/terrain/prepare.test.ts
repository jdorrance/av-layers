import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Grid } from '@av/contracts';
import { dataIdentity } from './contract.js';
import { prepareTerrain, readPreparedTerrain } from './prepare.js';
import { TerrainTestStorage, terrainCatalogFixture } from './test-fixtures.js';

const reader = vi.hoisted(() => ({ sample: vi.fn(), sampleBatch: vi.fn(), close: vi.fn(), open: vi.fn(), stats: () => ({ requests: 1, bytesRead: 100, decodedPixels: 4, outputPixels: 6, cacheHits: 5 }) }));
vi.mock('./reader.js', () => ({ createTerrainReader: async () => { reader.open(); return reader; } }));
const grid: Grid = { kind: 'regular-latlon', width: 3, height: 2, earthRadiusM: 6371229, lon0: 0.25, lat0: 0.75, dx: 0.25, dy: -0.25, wrapLongitude: false };
beforeEach(() => {
  vi.clearAllMocks();
  reader.sample.mockImplementation(async (lat: number, lon: number) => lat === 0.5 && lon === 0.75 ? null : { elevationM: 2 * lon + 3 * lat - 10, source: 'dem' });
  reader.sampleBatch.mockImplementation(async (points: Array<{ latitude: number; longitude: number }>) => {
    const samples = [];
    for (const point of points) samples.push(await reader.sample(point.latitude, point.longitude));
    return samples;
  });
});

async function loaded(storage: TerrainTestStorage, ref: Awaited<ReturnType<typeof prepareTerrain>>, target = grid) {
  return readPreparedTerrain(ref, async asset => (await storage.get(asset.key, undefined, asset.bytes))!.bytes, target);
}

describe('native terrain preparation', () => {
  it('samples explicit grid centres in row order and keeps negative elevations separate from absence', async () => {
    const storage = new TerrainTestStorage();
    const ref = await prepareTerrain({ catalog: terrainCatalogFixture(), storage, grid });
    const values = await loaded(storage, ref);
    expect(reader.sample.mock.calls).toEqual([[0.75, 0.25], [0.75, 0.5], [0.75, 0.75], [0.5, 0.25], [0.5, 0.5], [0.5, 0.75]]);
    expect([...values.elevationM]).toEqual([-7.25, -6.75, -6.25, -8, -7.5, 0]);
    expect([...values.valid]).toEqual([1, 1, 1, 1, 1, 0]);
    expect(ref.arrayBytes).toBe(30);
    expect(values.descriptor.method).toBe('bilinear-native-v1');
    expect(reader.close).toHaveBeenCalledOnce();
  });
  it('reuses numerical identity across COG repacking and JSON property order, without opening the reader', async () => {
    const storage = new TerrainTestStorage(), catalog = terrainCatalogFixture();
    const report = vi.fn();
    const first = await prepareTerrain({ catalog, storage, grid, onReport: report });
    const repacked = structuredClone(catalog);
    repacked.tiles[0].asset.sha256 = 'd'.repeat(64);
    const reordered = Object.fromEntries(Object.entries(grid).reverse()) as Grid;
    const second = await prepareTerrain({ catalog: repacked, storage, grid: reordered, onReport: report });
    expect(second).toEqual(first);
    expect(reader.open).toHaveBeenCalledOnce();
    expect(reader.sample).toHaveBeenCalledTimes(6);
    expect(report.mock.calls.map(([value]) => value.cacheHit)).toEqual([false, true]);
    expect(report.mock.calls[0][0].reader).toEqual(reader.stats());
    expect(report.mock.calls[1][0]).not.toHaveProperty('reader');
  });
  it('gives different origins and source elevations distinct preparations', async () => {
    const storage = new TerrainTestStorage(), catalog = terrainCatalogFixture();
    const first = await prepareTerrain({ catalog, storage, grid });
    const shifted = await prepareTerrain({ catalog, storage, grid: { ...grid, lon0: 0.125 } });
    const changed = structuredClone(catalog); changed.tiles[0].sourceSha256 = 'e'.repeat(64); changed.dataId = dataIdentity(changed);
    const third = await prepareTerrain({ catalog: changed, storage, grid });
    expect(new Set([first.key, shifted.key, third.key]).size).toBe(3);
  });
  it('rejects corrupt cache bytes and mismatching grids without recomputing immutable artifacts', async () => {
    const storage = new TerrainTestStorage(), catalog = terrainCatalogFixture();
    const ref = await prepareTerrain({ catalog, storage, grid });
    await expect(loaded(storage, ref, { ...grid, dx: 0.125 })).rejects.toThrow('grid mismatch');
    const key = ref.key.replace('manifest.json', 'elevation.f32');
    storage.objects.get(key)![0] ^= 1;
    await expect(prepareTerrain({ catalog, storage, grid })).rejects.toThrow('integrity mismatch');
    expect(reader.open).toHaveBeenCalledOnce();
  });
  it('admits cell counts before remote reads and stops cancellation before publishing a preparation', async () => {
    const storage = new TerrainTestStorage(), catalog = terrainCatalogFixture();
    await expect(prepareTerrain({ catalog, storage, grid, limits: { maxCells: 5 } })).rejects.toThrow('cell budget');
    expect(storage.gets).toEqual([]);
    const controller = new AbortController();
    reader.sample.mockImplementationOnce(async () => { controller.abort(new Error('cancel preparation')); return null; });
    await expect(prepareTerrain({ catalog, storage, grid, signal: controller.signal })).rejects.toThrow('cancel preparation');
    expect(reader.close).toHaveBeenCalledOnce();
    expect(storage.objects.size).toBe(0);
  });
  it('enforces the preparation deadline during cache lookup', async () => {
    const storage = new TerrainTestStorage();
    vi.spyOn(storage, 'get').mockImplementation(async (_key, _range, _max, signal) => {
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
      return null;
    });
    await expect(prepareTerrain({ catalog: terrainCatalogFixture(), storage, grid, limits: { maxDurationMs: 10 } })).rejects.toThrow();
    expect(reader.open).not.toHaveBeenCalled();
    expect(storage.objects.size).toBe(0);
  });
});
