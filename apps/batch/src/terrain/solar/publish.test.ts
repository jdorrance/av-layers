import { beforeEach, expect, it, vi } from 'vitest';
import { SOLAR_TERRAIN_FORMAT, type SolarSite, type SolarTerrainIndex, type TerrainSources } from '@av/contracts';
import { sha256 } from '../contract.js';
import { seedTerrainCatalog, terrainCatalogFixture, TerrainTestStorage } from '../test-fixtures.js';
import { publishSolarTerrain } from './publish.js';

const fake = vi.hoisted(() => ({ start: vi.fn(), grid: vi.fn(), close: vi.fn() }));
vi.mock('./index.js', async original => ({ ...await original<typeof import('./index.js')>(), startSolarTerrain: fake.start }));
vi.mock('./glo90.js', () => ({ readSolarElevationGrid: fake.grid }));
vi.mock('../reader.js', () => ({ createTerrainReader: async () => ({ close: fake.close, stats: () => ({ outputPixels: 4 }) }) }));

const site = { slug: 'launch', latitude: 0.5, longitude: 0.5 }, generation = '123456789abc', prefix = 'terrain/solar/launch';
const tile = Uint8Array.of(1, 2, 3), relief = Uint8Array.of(4, 5), generatedAt = '2026-11-05T00:00:00Z';
let addBlock: ReturnType<typeof vi.fn>, finish: ReturnType<typeof vi.fn>;

class CasStorage extends TerrainTestStorage {
  metadata = new Map<string, Record<string, string>>();
  override async head(key: string) { const value = await super.head(key); return value ? { ...value, metadata: this.metadata.get(key) } : null; }
  override async put(key: string, bytes: Uint8Array, condition: { ifMatch?: string; ifNoneMatch?: '*' }, _type?: string, _md5?: string, metadata?: Record<string, string>) {
    if (condition.ifMatch && (await this.head(key))?.etag !== condition.ifMatch) throw new Error('Precondition failed');
    await super.put(key, bytes, condition);
    if (metadata) this.metadata.set(key, metadata);
  }
}

function indexFor(site: SolarSite, sources: TerrainSources): SolarTerrainIndex {
  return {
    schemaVersion: 1, slug: site.slug, generatedAt, generation,
    inputs: { latitude: site.latitude, longitude: site.longitude, radiusKm: 15, maxDistanceKm: 20, algorithmVersion: 1,
      sources: { surface: sources.surface.id, horizon: sources.horizon.id } }, sources,
    bounds: { south: 0, west: 0, north: 1, east: 1 }, referenceElevationM: 10,
    tiles: { path: `${generation}/{z}/{x}/{y}.bin.gz`, size: 256, minZoom: 11, maxZoom: 14, ranges: { 11: [1, 1, 1, 1] },
      count: 1, bytes: tile.length, objects: [{ z: 11, columns: [{ x: 1, rows: [[1, tile.length, sha256(tile)]] }] }] },
    encoding: { planes: ['nx', 'ny', 'nz', 'svf'], normal: 'signed normal', horizonCells: 64, horizonBorder: 1,
      azimuthsDeg: [...SOLAR_TERRAIN_FORMAT.azimuthsDeg], horizonStepDeg: 0.3, delta: 'row', compression: 'gzip' }, launch: null,
    relief: { version: 1, path: `${generation}/relief-v1.bin.gz`, zoom: 11, x0: 0, y0: 0, width: 1, height: 1,
      offsetM: 500, scale: 10, minM: 10, maxM: 10, encoding: 'uint16-le', bytes: relief.length, sha256: sha256(relief) }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.grid.mockResolvedValue({ values: new Float32Array(4), width: 2, height: 2, west: 0, north: 1, dLon: 0.5, dLat: 0.5 });
  fake.start.mockImplementation((site: SolarSite, { sources }: { sources: TerrainSources }) => {
    const index = indexFor(site, sources), block = { x0: 0, y0: 0, x1: 1, y1: 1, bounds: index.bounds };
    addBlock = vi.fn(() => [{ z: 11, x: 1, y: 1, body: tile }]);
    finish = vi.fn(() => ({ index, relief: { body: relief, meta: index.relief } }));
    return { generation, domain: block, blocks: [block], addBlock, finish };
  });
});

function input(storage = new CasStorage()) {
  const catalog = terrainCatalogFixture(), catalogRef = seedTerrainCatalog(storage, catalog);
  return { storage, catalog, catalogRef, site };
}

it('publishes complete immutable assets and preserves an existing generation index byte for byte', async () => {
  const options = input(), first = await publishSolarTerrain(options), original = options.storage.objects.get(first.generationKey)!.slice();
  expect(first.reused).toBe(false);
  expect(options.storage.objects.get(first.key)).toEqual(original);
  expect(options.storage.metadata.get(first.key)).toEqual({ sha256: sha256(original) });
  expect(addBlock).toHaveBeenCalledOnce(); expect(finish).toHaveBeenCalledOnce();
  const second = await publishSolarTerrain(options);
  expect(second.reused).toBe(true);
  expect(second.index.generatedAt).toBe(generatedAt);
  expect(options.storage.objects.get(first.generationKey)).toEqual(original);
  expect(options.storage.objects.get(first.key)).toEqual(original);
  expect(addBlock).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
  expect(fake.close).toHaveBeenCalledTimes(2);
});

it('keeps both indexes unpublished when a completed asset fails its full digest check', async () => {
  const options = input(), get = options.storage.get.bind(options.storage);
  vi.spyOn(options.storage, 'get').mockImplementation(async (key, range, limit, signal) => {
    const value = await get(key, range, limit, signal);
    return value && !range && key.endsWith('/11/1/1.bin.gz') ? { ...value, bytes: Uint8Array.of(9, 2, 3) } : value;
  });
  await expect(publishSolarTerrain(options)).rejects.toThrow('asset verification failed');
  expect(options.storage.objects.has(`${prefix}/index.json`)).toBe(false);
  expect(options.storage.objects.has(`${prefix}/${generation}/index.json`)).toBe(false);
  expect(fake.close).toHaveBeenCalledOnce();
});

it('refuses a mutable-index race while retaining the completed immutable generation', async () => {
  const options = input(), put = options.storage.put.bind(options.storage), concurrent = Uint8Array.of(99);
  vi.spyOn(options.storage, 'put').mockImplementation(async (key, bytes, condition, type, md5, metadata) => {
    if (key === `${prefix}/index.json`) options.storage.objects.set(key, concurrent);
    return put(key, bytes, condition, type, md5, metadata);
  });
  await expect(publishSolarTerrain(options)).rejects.toThrow('Precondition failed');
  expect(options.storage.objects.get(`${prefix}/index.json`)).toEqual(concurrent);
  expect(options.storage.objects.has(`${prefix}/${generation}/index.json`)).toBe(true);
  expect(fake.close).toHaveBeenCalledOnce();
});
