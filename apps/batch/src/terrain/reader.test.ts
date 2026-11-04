import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeSparseCoverage, gridSchema, sparseCoverageFromDense, sparseCoverageLookup, type SparseCoverage } from '@av/contracts';
import { createTerrainReadBudget, createTerrainReader, TERRAIN_READ_LIMITS } from './reader';
import * as terrainReader from './reader';
import { ASSET_MAX_BYTES, dataIdentity, encodeJson, sha256, TERRAIN_BATCH_POINTS, TERRAIN_PACKING, TERRAIN_SOURCE, type TerrainCatalog, type TerrainGeometry, type TerrainTile } from './contract';
import { TerrainTestStorage } from './test-fixtures';
import { PREPARED_TERRAIN_METHOD, prepareTerrain, readPreparedTerrain } from './prepare';
import { prepareSparseTerrain, readSparsePreparedTerrain, validateSparsePreparedTerrain } from './sparse';
import { loadSparsePreparedTerrain, stageSparsePreparedTerrain } from './staging';
import * as terrainSource from './source.js';
import { localTerrainStorage } from './local-store.js';

beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(terrainSource, 'verifyTerrainCatalogInventory').mockResolvedValue(undefined); });

type Fixture = { south?: number; west?: number; width?: number; height?: number; registration?: 1 | 2; nodata?: number | null; value?: (lat: number, lon: number, row: number, col: number) => number };
const ramp = (lat: number, lon: number) => -50 + lat * 100 + lon * 10;
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

/** Small geographic fixture in real 512-pixel TIFF blocks; values and expected geography are independent of the reader. */
function tiledFixture(input: Fixture = {}): { tile: TerrainTile; bytes: Uint8Array } {
  const south = input.south ?? 0, west = input.west ?? 0, width = input.width ?? 4, height = input.height ?? 4;
  const registration = input.registration ?? 2, nodata = input.nodata ?? null;
  const geometry: TerrainGeometry = { width, height, lon0: west, lat0: south + 1, dx: 1 / width, dy: -1 / height };
  const size = 512, blockBytes = size * size * 4, blocksAcross = Math.ceil(width / size), blocksDown = Math.ceil(height / size);
  const count = blocksAcross * blocksDown, pixelsAt = 2048;
  const tags: Array<[number, number, number[] | string]> = [
    [256, 4, [width]], [257, 4, [height]], [258, 3, [32]], [259, 3, [1]], [262, 3, [1]],
    [277, 3, [1]], [284, 3, [1]], [322, 4, [size]], [323, 4, [size]],
    [324, 4, Array.from({ length: count }, (_, i) => pixelsAt + i * blockBytes)],
    [325, 4, Array(count).fill(blockBytes)], [339, 3, [3]],
    [33550, 12, [geometry.dx, -geometry.dy, 0]],
    [33922, 12, [0, 0, 0, west - (registration === 1 ? geometry.dx / 2 : 0), south + 1 - (registration === 1 ? geometry.dy / 2 : 0), 0]],
    [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, registration, 2048, 0, 1, 4326]]
  ];
  if (nodata !== null) tags.push([42113, 2, `${nodata}\0`]);
  tags.sort((a, b) => a[0] - b[0]);
  const bytes = new Uint8Array(pixelsAt + count * blockBytes), view = new DataView(bytes.buffer);
  bytes.set([73, 73]); view.setUint16(2, 42, true); view.setUint32(4, 8, true); view.setUint16(8, tags.length, true);
  let extra = 8 + 2 + tags.length * 12 + 4;
  for (let i = 0; i < tags.length; i++) {
    const [tag, type, values] = tags[i], at = 10 + i * 12;
    const length = values.length, stride = type === 12 ? 8 : type === 4 ? 4 : type === 3 ? 2 : 1;
    view.setUint16(at, tag, true); view.setUint16(at + 2, type, true); view.setUint32(at + 4, length, true);
    let start = at + 8;
    if (length * stride > 4) { start = extra; view.setUint32(at + 8, extra, true); extra += length * stride; }
    for (let j = 0; j < length; j++) {
      const value = typeof values === 'string' ? values.charCodeAt(j) : values[j];
      if (type === 12) view.setFloat64(start + j * stride, value, true);
      else if (type === 4) view.setUint32(start + j * stride, value, true);
      else if (type === 3) view.setUint16(start + j * stride, value, true);
      else view.setUint8(start + j, value);
    }
  }
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    const block = Math.floor(row / size) * blocksAcross + Math.floor(col / size);
    const offset = pixelsAt + block * blockBytes + ((row % size) * size + col % size) * 4;
    view.setFloat32(offset, (input.value ?? ramp)(geometry.lat0 + row * geometry.dy, geometry.lon0 + col * geometry.dx, row, col), true);
  }
  const digest = sha256(bytes);
  return { bytes, tile: {
    id: `Copernicus_DSM_COG_30_${south < 0 ? 'S' : 'N'}${Math.abs(south).toString().padStart(2, '0')}_00_${west < 0 ? 'W' : 'E'}${Math.abs(west).toString().padStart(3, '0')}_00_DEM`,
    south, west, geometry, nodata: Number.isNaN(nodata) ? null : nodata, sourceSha256: digest,
    asset: { key: `terrain/assets/${digest}.tif`, sha256: digest, bytes: bytes.length }
  } };
}
function setup(...inputs: Fixture[]) {
  const storage = new TerrainTestStorage();
  const fixtures = (inputs.length ? inputs : [{}]).map(tiledFixture);
  for (const fixture of fixtures) storage.objects.set(fixture.tile.asset.key, fixture.bytes);
  const inventory = Buffer.from(fixtures.map(fixture => fixture.tile.id).sort().join('\n') + '\n'), inventorySha256 = sha256(inventory);
  storage.objects.set(`terrain/inventories/${inventorySha256}.txt`, inventory);
  const catalog: TerrainCatalog = { version: 1, source: TERRAIN_SOURCE, packing: TERRAIN_PACKING, inventorySha256, dataId: '', tiles: fixtures.map(fixture => fixture.tile).sort((a, b) => a.id.localeCompare(b.id)) };
  catalog.dataId = dataIdentity(catalog);
  return { storage, catalog };
}

describe('native terrain reader', () => {
  it.each([1, 2] as const)('normalizes pixel registration %s, retains negative heights and reuses decoded blocks', async registration => {
    const input = setup({ registration });
    const reader = await createTerrainReader(input);
    try {
      expect(await reader.sample(0.625, 0.375)).toEqual({ elevationM: ramp(0.625, 0.375), source: 'dem' });
      const before = reader.stats();
      expect(await reader.sample(0.25, 0)).toEqual({ elevationM: -25, source: 'dem' });
      expect(reader.stats().bytesRead).toBe(before.bytesRead);
      expect(reader.stats().decodedPixels).toBe(512 * 512);
      expect(reader.stats().cacheHits).toBeGreaterThan(0);
    } finally { reader.close(); }
  });

  it('requires only nonzero bilinear contributors and preserves nodata in native windows', async () => {
    const input = setup({ nodata: -9999, value: (lat, lon, row, col) => row === 2 && col === 2 ? -9999 : ramp(lat, lon) });
    const reader = await createTerrainReader(input);
    try {
      expect(await reader.sample(0.625, 0.375)).toBeNull();
      expect(await reader.sample(0.75, 0.25)).toEqual({ elevationM: 27.5, source: 'dem' });
      const windows = await collect(reader.readWindows([0, 0.5, 0.5, 1]));
      expect(windows).toHaveLength(1);
      expect(windows[0].geometry).toMatchObject({ width: 3, height: 3, lon0: 0, lat0: 1 });
      expect(Array.from(windows[0].missing)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1]);
      expect(windows[0].values[8]).toBe(-9999);
    } finally { reader.close(); }
  });

  it('interpolates across both geographic seams and a latitude-dependent width change', async () => {
    const input = setup({ south: 49 }, { south: 50, width: 2 }, { south: 49, west: 1 }, { south: 50, west: 1, width: 2 });
    const reader = await createTerrainReader(input);
    try {
      expect((await reader.sample(50.125, 0.375))?.elevationM).toBe(ramp(50.125, 0.375));
      expect((await reader.sample(49.625, 0.875))?.elevationM).toBe(ramp(49.625, 0.875));
      expect((await reader.sample(50, 0.25))?.elevationM).toBe(ramp(50, 0.25));
    } finally { reader.close(); }
  });

  it('keeps NaN nodata unavailable when the catalog has no finite sentinel', async () => {
    const reader = await createTerrainReader(setup({ nodata: NaN, value: (lat, lon, row, col) => row === 2 && col === 2 ? NaN : ramp(lat, lon) }));
    try {
      expect(await reader.sample(0.625, 0.375)).toBeNull();
      expect(await reader.sample(0.75, 0.25)).toEqual({ elevationM: 27.5, source: 'dem' });
    } finally { reader.close(); }
  });

  it('wraps native contributors at the dateline and streams bounded wrapped windows', async () => {
    const input = setup({ west: 179, value: () => 10 }, { west: -180, value: () => 30 });
    const reader = await createTerrainReader(input);
    try {
      expect(await reader.sample(0.75, 179.875)).toEqual({ elevationM: 20, source: 'dem' });
      expect(await reader.sample(0.75, 180)).toEqual({ elevationM: 30, source: 'dem' });
      const windows = await collect(reader.readWindows([179.75, 0.75, -179.75, 1]));
      expect(windows.reduce((count, window) => count + window.values.length, 0)).toBe(6);
      expect(windows.map(window => window.geometry.lon0)).toEqual([179.75, -180]);
    } finally { reader.close(); }
  });

  it('includes the shared dateline centre when a window ends at +180 degrees', async () => {
    const reader = await createTerrainReader(setup({ west: 179, value: () => 10 }, { west: -180, value: () => 30 }));
    try {
      const windows = await collect(reader.readWindows([179.75, 0.75, 180, 1]));
      expect(windows.map(window => window.geometry.lon0)).toEqual([179.75, -180]);
      expect(windows.flatMap(window => [...window.values])).toEqual([10, 10, 30, 30]);
    } finally { reader.close(); }
  });

  it('treats verified inventory absence as ocean and rejects missing assets', async () => {
    const input = setup();
    input.storage.objects.delete(input.catalog.tiles[0].asset.key);
    const reader = await createTerrainReader(input);
    try {
      expect(await reader.sample(5.5, 5.5)).toEqual({ elevationM: 0, source: 'ocean' });
      expect(reader.stats().requests).toBe(1);
      await expect(reader.sample(0.75, 0.25)).rejects.toThrow('Missing or changed terrain asset');
    } finally { reader.close(); }
  });

  it('fails closed when an inventory is missing, corrupt, or lists omitted land', async () => {
    const input = setup({}, { west: 1 }), partial = structuredClone(input.catalog);
    vi.mocked(terrainSource.verifyTerrainCatalogInventory).mockRejectedValue(new Error('Terrain catalog does not match trusted inventory'));
    partial.tiles.pop(); partial.dataId = dataIdentity(partial);
    const reader = await createTerrainReader({ ...input, catalog: partial });
    try { await expect(reader.sample(5.5, 5.5)).rejects.toThrow('catalog does not match trusted inventory'); }
    finally { reader.close(); }
    const key = `terrain/inventories/${input.catalog.inventorySha256}.txt`;
    vi.mocked(terrainSource.verifyTerrainCatalogInventory).mockRejectedValue(new Error('Trusted terrain inventory snapshot missing or corrupt'));
    input.storage.objects.delete(key);
    const missing = await createTerrainReader(input);
    try { await expect(missing.sample(5.5, 5.5)).rejects.toThrow('inventory snapshot missing or corrupt'); }
    finally { missing.close(); }
    input.storage.objects.set(key, Buffer.from('corrupt'));
    const corrupt = await createTerrainReader(input);
    try { await expect(corrupt.sample(5.5, 5.5)).rejects.toThrow('inventory snapshot missing or corrupt'); }
    finally { corrupt.close(); }
  });

  it('never substitutes an overview or fetches the other native block for a point', async () => {
    const input = setup({ width: 1024 });
    const get = vi.spyOn(input.storage, 'get');
    const reader = await createTerrainReader(input);
    try {
      expect((await reader.sample(0.75, 0.25))?.elevationM).toBe(ramp(0.75, 0.25));
      expect(reader.stats().decodedPixels).toBe(512 * 512);
      expect(reader.stats().bytesRead - input.catalog.tiles[0].asset.bytes).toBeLessThan(input.catalog.tiles[0].asset.bytes * 0.6);
      expect(get.mock.calls.every(call => call[1] && call[2] === call[1].length && call[3] instanceof AbortSignal)).toBe(true);
      const before = reader.stats().bytesRead;
      await Promise.all([reader.sample(0.75, 0.75), reader.sample(0.625, 0.75)]);
      expect(reader.stats().decodedPixels).toBe(2 * 512 * 512);
      expect(reader.stats().bytesRead - before).toBe(512 * 512 * 4);
    } finally { reader.close(); }
  });

  it('rejects a same-size COG replaced before the first read', async () => {
    const input = setup(), tile = input.catalog.tiles[0], changed = input.storage.objects.get(tile.asset.key)!.slice();
    new DataView(changed.buffer, changed.byteOffset, changed.byteLength).setFloat32(2048 + (512 + 1) * 4, 9999, true);
    input.storage.objects.set(tile.asset.key, changed);
    const head = input.storage.head.bind(input.storage);
    vi.spyOn(input.storage, 'head').mockImplementation(async (...args) => { const result = await head(...args); return result && { ...result, metadata: { sha256: tile.asset.sha256 } }; });
    const reader = await createTerrainReader(input);
    try { await expect(reader.sample(0.75, 0.25)).rejects.toThrow('terrain asset hash'); }
    finally { reader.close(); }
  });

  it('rejects a replacement during a bounded identity proof', async () => {
    const input = setup({ width: 1024 }), tile = input.catalog.tiles[0], original = input.storage.get.bind(input.storage);
    const changed = input.storage.objects.get(tile.asset.key)!.slice();
    changed[changed.length - 1] ^= 1;
    let reads = 0;
    vi.spyOn(input.storage, 'get').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (++reads === 1) input.storage.objects.set(tile.asset.key, changed);
      return result;
    });
    const reader = await createTerrainReader({ ...input, limits: { maxRangeBytes: 1024 * 1024 } });
    try {
      await expect(reader.sample(0.75, 0.25)).rejects.toThrow('changed terrain range');
      expect(reader.stats().bytesRead).toBe(2 * 1024 * 1024);
    } finally { reader.close(); }
  });

  it('reserves the requested range again before admitting a body retry', async () => {
    const input = setup(), tile = input.catalog.tiles[0];
    let retry = true, reads = 0;
    const storage = {
      head: input.storage.head.bind(input.storage),
      get: async (key: string, range?: { offset: number; length: number }, maxBytes?: number, signal?: AbortSignal, onRetry?: () => void) => {
        if (retry) { retry = false; onRetry?.(); }
        reads++;
        return input.storage.get(key, range, maxBytes, signal);
      }
    };
    const limited = await createTerrainReader({ catalog: input.catalog, storage, limits: { maxReadBytes: tile.asset.bytes } });
    try {
      await expect(limited.sample(0.75, 0.25)).rejects.toThrow('readBytesBound budget');
      expect(reads).toBe(0);
      expect(limited.stats()).toMatchObject({ bytesRead: 0, readBytesBound: tile.asset.bytes });
    } finally { limited.close(); }
    retry = true;
    const allowed = await createTerrainReader({ catalog: input.catalog, storage });
    try {
      expect(await allowed.sample(0.75, 0.25)).toEqual({ elevationM: 27.5, source: 'dem' });
      expect(allowed.stats().readBytesBound - allowed.stats().bytesRead).toBe(tile.asset.bytes);
    } finally { allowed.close(); }
  });

  it('reuses a verified asset identity across readers while checking the ETag', async () => {
    const input = setup(), tile = input.catalog.tiles[0];
    const budget = createTerrainReadBudget({ maxReadBytes: 16 * 1024 * 1024, maxDecodedPixels: 3 * 512 * 512, maxOutputPixels: 3 });
    const get = vi.spyOn(input.storage, 'get');
    const first = await createTerrainReader({ ...input, budget });
    try { expect(await first.sampleBatch!([{ latitude: 0.75, longitude: 0.25 }])).toEqual([{ elevationM: 27.5, source: 'dem' }]); }
    finally { first.close(); }
    expect(get.mock.calls.filter(call => call[1]?.offset === 0 && call[1].length === tile.asset.bytes)).toHaveLength(1);
    const second = await createTerrainReader({ ...input, budget });
    try { expect(await second.sampleBatch!([{ latitude: 0.75, longitude: 0.25 }])).toEqual([{ elevationM: 27.5, source: 'dem' }]); }
    finally { second.close(); }
    expect(get.mock.calls.filter(call => call[1]?.offset === 0 && call[1].length === tile.asset.bytes)).toHaveLength(1);
    const changed = input.storage.objects.get(tile.asset.key)!.slice(); changed[changed.length - 1] ^= 1;
    input.storage.objects.set(tile.asset.key, changed);
    const third = await createTerrainReader({ ...input, budget });
    try { await expect(third.sampleBatch!([{ latitude: 0.75, longitude: 0.25 }])).rejects.toThrow('changed terrain asset'); }
    finally { third.close(); }
  });

  it('verifies local COG bytes and rejects a same-size replacement', async () => {
    const input = setup(), tile = input.catalog.tiles[0], bytes = input.storage.objects.get(tile.asset.key)!;
    const directory = await mkdtemp(join(tmpdir(), 'terrain-identity-'));
    try {
      const storage = localTerrainStorage(directory);
      await storage.put(tile.asset.key, bytes, { ifNoneMatch: '*' });
      const get = vi.spyOn(storage, 'get');
      const first = await createTerrainReader({ catalog: input.catalog, storage });
      try { expect(await first.sample(0.75, 0.25)).toEqual({ elevationM: 27.5, source: 'dem' }); }
      finally { first.close(); }
      expect(get.mock.calls.some(call => call[1]?.offset === 0 && call[1]?.length === tile.asset.bytes)).toBe(false);
      const changed = bytes.slice(); changed[changed.length - 1] ^= 1;
      await writeFile(join(directory, tile.asset.key), changed);
      const second = await createTerrainReader({ catalog: input.catalog, storage });
      try { await expect(second.sample(0.75, 0.25)).rejects.toThrow('terrain asset hash'); }
      finally { second.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('evicts decoded blocks within the cache budget and accounts for later decoding again', async () => {
    const reader = await createTerrainReader({ ...setup({ width: 1024 }), limits: { maxCachedPixels: 512 * 512, maxOpenTiles: 1 } });
    try {
      await reader.sample(0.75, 0.25);
      await reader.sample(0.75, 0.75);
      await reader.sample(0.75, 0.25);
      expect(reader.stats().decodedPixels).toBe(3 * 512 * 512);
    } finally { reader.close(); }
  });

  it('groups alternating targets by source blocks within the cache budget', async () => {
    const reader = await createTerrainReader({ ...setup({ width: 1024 }), limits: { maxCachedPixels: 512 * 512 } });
    const points = [0.25, 0.75, 0.25, 0.75].map(longitude => ({ latitude: 0.75, longitude }));
    try {
      const values = await reader.sampleBatch!(points);
      expect(values.map(value => value?.elevationM)).toEqual(points.map(point => ramp(point.latitude, point.longitude)));
      expect(reader.stats().decodedPixels).toBe(2 * 512 * 512);
      expect(reader.stats().outputPixels).toBe(4);
    } finally { reader.close(); }
  });

  it('matches individual samples across seams, nodata and the dateline', async () => {
    const input = setup(
      { south: 49, nodata: -9999, value: (lat, lon, row, col) => row === 2 && col === 2 ? -9999 : ramp(lat, lon) },
      { south: 50, width: 2 }, { south: 49, west: 1 }, { south: 50, west: 1, width: 2 },
      { west: 179, value: () => 10 }, { west: -180, value: () => 30 }
    );
    const individual = await createTerrainReader(input), batch = await createTerrainReader(input);
    const points = [[50.125, 0.375], [49.625, 0.875], [50, 0.25], [49.625, 0.375], [0.75, 179.875], [0.75, 180]]
      .map(([latitude, longitude]) => ({ latitude, longitude }));
    try {
      const expected = [];
      for (const point of points) expected.push(await individual.sample(point.latitude, point.longitude));
      expect(await batch.sampleBatch!(points)).toEqual(expected);
      expect(expected).toContain(null);
    } finally { individual.close(); batch.close(); }
  });

  it('admits a complete bounded batch before source reads', async () => {
    const input = setup(), reader = await createTerrainReader({ ...input, limits: { maxOutputPixels: 1 } });
    const point = { latitude: 0.75, longitude: 0.25 };
    try {
      await expect(reader.sampleBatch!([point, point])).rejects.toThrow('outputPixels budget');
      await expect(reader.sampleBatch!(Array(TERRAIN_BATCH_POINTS + 1).fill(point))).rejects.toThrow('batch point budget');
      expect(input.storage.gets).toHaveLength(0);
      expect(reader.stats().outputPixels).toBe(0);
    } finally { reader.close(); }
  });

  it('prepares and reloads real seam samples in target-grid order', async () => {
    const input = setup({ west: 179, value: () => 10 }, { west: -180, value: () => 30 });
    const grid = { kind: 'regular-latlon' as const, width: 3, height: 2, earthRadiusM: 6371229, lon0: 179.75, lat0: 0.75, dx: 0.125, dy: -0.25, wrapLongitude: false };
    const report = vi.fn();
    const ref = await prepareTerrain({ ...input, grid, onReport: report });
    const prepared = await readPreparedTerrain(ref, async asset => (await input.storage.get(asset.key, undefined, asset.bytes))!.bytes, grid);
    expect([...prepared.elevationM]).toEqual([10, 20, 30, 10, 20, 30]);
    expect([...prepared.valid]).toEqual([1, 1, 1, 1, 1, 1]);
    expect(report.mock.calls[0][0].reader).toMatchObject({ outputPixels: 6, decodedPixels: 2 * 512 * 512 });
  });

  it('charges point budgets across multiple preparation batches', async () => {
    const input = setup();
    const grid = { kind: 'regular-latlon' as const, width: TERRAIN_BATCH_POINTS + 1, height: 1, earthRadiusM: 6371229, lon0: 0.25, lat0: 0.75, dx: 0.00001, dy: -0.25, wrapLongitude: false };
    await expect(prepareTerrain({ ...input, grid, limits: { reader: { maxOutputPixels: TERRAIN_BATCH_POINTS } } })).rejects.toThrow('outputPixels budget');
    expect([...input.storage.objects.keys()].filter(key => key.includes('/prepared/'))).toHaveLength(0);
  });

  it('prepares packed output and halo terrain, stages and reuses verified v2 assets', async () => {
    const input = setup({ west: 179, value: () => 10 }, { west: -180, value: () => 30 });
    const grid = { kind: 'regular-latlon' as const, width: 3, height: 2, earthRadiusM: 6371229, lon0: 179.75, lat0: 0.75, dx: 0.125, dy: -0.25, wrapLongitude: false };
    const coverage = sparseCoverageFromDense({ width: grid.width, height: grid.height, wrapLongitude: false, gridHash: sha256(JSON.stringify(gridSchema.parse(grid))), output: Uint8Array.of(0b010101), halo: Uint8Array.of(0b100010) });
    const descriptorFor = (value: SparseCoverage) => {
      const bytes = encodeSparseCoverage(value);
      return Buffer.from(JSON.stringify({ version: 2, id: 'fixture', grid, gridHash: value.gridHash, bounds: [179, 0, -179, 1], policy: 'fixture', maxZoom: 0, supportHaloCells: 1, sampleLayout: { format: 'cell-major-block-shards-v1', blockSize: 16 }, files: { sparse: { bytes: bytes.length, sha256: sha256(bytes) }, tiles: { bytes: 1, sha256: sha256(Uint8Array.of(1)) } } }));
    };
    const coverageDescriptor = descriptorFor(coverage);
    const report = vi.fn(), out = await mkdtemp(join(tmpdir(), 'av-sparse-terrain-'));
    try {
      const denseRef = await prepareTerrain({ ...input, grid });
      const dense = await readPreparedTerrain(denseRef, async asset => (await input.storage.get(asset.key, undefined, asset.bytes))!.bytes, grid);
      const ref = await prepareSparseTerrain({ ...input, grid, coverage, coverageDescriptor, onReport: report, limits: { reader: { maxOutputPixels: 2 } } });
      const packed = await readSparsePreparedTerrain(ref, async asset => (await input.storage.get(asset.key, undefined, asset.bytes))!.bytes, grid, coverage, coverageDescriptor);
      expect(packed.descriptor).toMatchObject({ version: 2, layoutVersion: 1, cells: 5 });
      for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
        const found = sparseCoverageLookup(coverage, x, y);
        if (found) { expect(packed.elevationM[found.offset]).toBe(dense.elevationM[y * grid.width + x]); expect(packed.valid[found.offset]).toBe(dense.valid[y * grid.width + x]); }
      }
      expect([...packed.elevationM]).toEqual([10, 20, 30, 20, 30]);
      expect(report.mock.calls[0][0]).toMatchObject({ cells: 5, sourceBlocks: 2, sourceAssets: 2, totalLimits: { maxOutputPixels: 5 }, reader: { outputPixels: 5, decodedPixels: 2 * 512 * 512 } });
      const oldPrefix = `terrain/prepared/${sha256(encodeJson({ dataId: input.catalog.dataId, gridHash: coverage.gridHash, method: PREPARED_TERRAIN_METHOD, coverageHash: sha256(coverageDescriptor), layoutVersion: 1, oceanCoverage: 'verified' }))}`;
      const { sourceIntegrity: _, ...oldDescriptor } = structuredClone(packed.descriptor);
      for (const asset of [...oldDescriptor.files.elevationM, ...oldDescriptor.files.valid]) {
        const oldKey = `${oldPrefix}/${asset.key.split('/').at(-1)}`;
        input.storage.objects.set(oldKey, input.storage.objects.get(asset.key)!);
        input.storage.objects.delete(asset.key);
        asset.key = oldKey;
      }
      const oldManifest = encodeJson(oldDescriptor), oldRef = { key: `${oldPrefix}/manifest.json`, bytes: oldManifest.length, sha256: sha256(oldManifest), arrayBytes: ref.arrayBytes };
      input.storage.objects.set(oldRef.key, oldManifest);
      input.storage.objects.delete(ref.key);
      await expect(readSparsePreparedTerrain(oldRef, async asset => (await input.storage.get(asset.key, undefined, asset.bytes))!.bytes, grid, coverage, coverageDescriptor)).rejects.toThrow();
      const head = vi.spyOn(input.storage, 'head');
      expect(await prepareSparseTerrain({ ...input, grid, coverage, coverageDescriptor, onReport: report })).toEqual(ref);
      expect(head).toHaveBeenCalled();
      head.mockClear();
      const tampered = encodeJson({ ...packed.descriptor, sourceIntegrity: 'unverified' });
      await expect(readSparsePreparedTerrain({ ...ref, bytes: tampered.length, sha256: sha256(tampered) }, async asset => asset.key === ref.key ? tampered : (await input.storage.get(asset.key, undefined, asset.bytes))!.bytes, grid, coverage, coverageDescriptor)).rejects.toThrow();
      await stageSparsePreparedTerrain({ ref, storage: input.storage, out, grid, coverage, coverageDescriptor });
      expect((await loadSparsePreparedTerrain({ ref, out, grid, coverage, coverageDescriptor })).elevationM).toEqual(packed.elevationM);
      expect(await prepareSparseTerrain({ ...input, grid, coverage, coverageDescriptor, onReport: report })).toEqual(ref);
      expect(head).not.toHaveBeenCalled();
      expect(report.mock.calls.map(([item]) => item.cacheHit)).toEqual([false, false, true]);
      const different = sparseCoverageFromDense({ width: grid.width, height: grid.height, wrapLongitude: false, gridHash: coverage.gridHash, output: Uint8Array.of(0b010101), halo: Uint8Array.of(0b001010) });
      const differentDescriptor = descriptorFor(different);
      await expect(readSparsePreparedTerrain(ref, async asset => (await input.storage.get(asset.key, undefined, asset.bytes))!.bytes, grid, different, differentDescriptor)).rejects.toThrow('identity or coverage mismatch');
      await expect(prepareSparseTerrain({ ...input, grid, coverage: different, coverageDescriptor })).rejects.toThrow('coverage grid mismatch');
      expect((await prepareSparseTerrain({ ...input, grid, coverage: different, coverageDescriptor: differentDescriptor })).key).not.toBe(ref.key);
      const otherPolicy = Buffer.from(JSON.stringify({ ...JSON.parse(coverageDescriptor.toString()), policy: 'other' }));
      expect((await prepareSparseTerrain({ ...input, grid, coverage, coverageDescriptor: otherPolicy })).key).not.toBe(ref.key);
      const corrupted = input.storage.objects.get(packed.descriptor.files.valid[0].key)!; corrupted[0] ^= 1;
      await expect(prepareSparseTerrain({ ...input, grid, coverage, coverageDescriptor })).rejects.toThrow('integrity mismatch');
      const rejectedOut = await mkdtemp(join(tmpdir(), 'av-sparse-rejected-'));
      try { await expect(stageSparsePreparedTerrain({ ref, storage: input.storage, out: rejectedOut, grid, coverage, coverageDescriptor })).rejects.toThrow('integrity mismatch'); }
      finally { await rm(rejectedOut, { recursive: true, force: true }); }
    } finally { await rm(out, { recursive: true, force: true }); }
  });

  it('budgets repeated source blocks across bounded scheduling windows', async () => {
    const input = setup({ width: 1024 }), grid = { kind: 'regular-latlon' as const, width: 1024, height: 192, earthRadiusM: 6371229, lon0: 0, lat0: 0.75, dx: 1 / 1024, dy: -1e-12, wrapLongitude: false };
    const cells = grid.width * grid.height, gridHash = sha256(JSON.stringify(gridSchema.parse(grid)));
    const coverage = sparseCoverageFromDense({ width: grid.width, height: grid.height, wrapLongitude: false, gridHash, output: new Uint8Array(cells / 8).fill(255), halo: new Uint8Array(cells / 8) });
    const encoded = encodeSparseCoverage(coverage), coverageDescriptor = Buffer.from(JSON.stringify({ version: 2, id: 'fixture', grid, gridHash, bounds: [0, 0, 1, 1], policy: 'fixture', maxZoom: 0, supportHaloCells: 1, sampleLayout: { format: 'cell-major-block-shards-v1', blockSize: 16 }, files: { sparse: { bytes: encoded.length, sha256: sha256(encoded) }, tiles: { bytes: 1, sha256: sha256(Uint8Array.of(1)) } } }));
    const report = vi.fn(), get = vi.spyOn(input.storage, 'get');
    const ref = await prepareSparseTerrain({ ...input, grid, coverage, coverageDescriptor, onReport: report, limits: { reader: { maxCachedPixels: 512 * 512 } } });
    const decoded = await readSparsePreparedTerrain(ref, async asset => (await input.storage.get(asset.key, undefined, asset.bytes))!.bytes, grid, coverage, coverageDescriptor);
    expect(decoded.valid.every(value => value === 1)).toBe(true);
    expect(decoded.elevationM[0]).toBeCloseTo(ramp(0.75, 0));
    expect(report.mock.calls[0][0]).toMatchObject({ sourceBlocks: 2, reader: { decodedPixels: 6 * 512 * 512, outputPixels: cells }, totalLimits: { maxDecodedPixels: 6 * 512 * 512 }, planning: { windowPoints: 65_536, windows: 3, maxWindowGroups: 2, decodedBlocks: 6, readBatches: 48 } });
    expect(report.mock.calls[0][0].planning).toMatchObject({ blockBitmapBytes: 1, sampledPeakRssBytes: expect.any(Number), sampledPeakHeapUsedBytes: expect.any(Number) });
    const ranges = get.mock.calls.map(call => call[1]?.offset).filter(offset => offset === 2048 || offset === 2048 + 512 * 512 * 4);
    expect(ranges).toEqual([2048, 2048 + 512 * 512 * 4, 2048, 2048 + 512 * 512 * 4, 2048, 2048 + 512 * 512 * 4]);
  }, 120_000);

  it.each([{ lat0: 0.75, dy: -1e-12, expected: 65_536 }, { lat0: -89, dy: -1, expected: 2048 }])('dispatches asynchronous abort during cold planning before source reads ($lat0)', async ({ lat0, dy, expected }) => {
    const input = setup({ width: 1024 }), grid = { kind: 'regular-latlon' as const, width: 1024, height: 192, earthRadiusM: 6371229, lon0: 0, lat0, dx: 1 / 1024, dy, wrapLongitude: false };
    const cells = grid.width * grid.height, gridHash = sha256(JSON.stringify(gridSchema.parse(grid)));
    const coverage = sparseCoverageFromDense({ width: grid.width, height: grid.height, wrapLongitude: false, gridHash, output: new Uint8Array(cells / 8).fill(255), halo: new Uint8Array(cells / 8) });
    const encoded = encodeSparseCoverage(coverage), coverageDescriptor = Buffer.from(JSON.stringify({ version: 2, id: 'fixture', grid, gridHash, bounds: [0, 0, 1, 1], policy: 'fixture', maxZoom: 0, supportHaloCells: 1, sampleLayout: { format: 'cell-major-block-shards-v1', blockSize: 16 }, files: { sparse: { bytes: encoded.length, sha256: sha256(encoded) }, tiles: { bytes: 1, sha256: sha256(Uint8Array.of(1)) } } }));
    const controller = new AbortController(), reason = new Error('planning cancelled'), original = terrainReader.createTerrainReader, head = vi.spyOn(input.storage, 'head');
    let points = 0, started = 0, elapsed = 0;
    vi.spyOn(terrainReader, 'createTerrainReader').mockImplementation(async options => {
      const reader = await original(options), sourceBlocks = reader.sourceBlocks;
      reader.sourceBlocks = (latitude, longitude) => {
        if (++points === 1) { started = performance.now(); setImmediate(() => { elapsed = performance.now() - started; controller.abort(reason); }); }
        return sourceBlocks(latitude, longitude);
      };
      return reader;
    });
    await expect(prepareSparseTerrain({ ...input, grid, coverage, coverageDescriptor, signal: controller.signal })).rejects.toBe(reason);
    expect(points).toBe(expected);
    expect(head).not.toHaveBeenCalled();
    expect([...input.storage.objects.keys()].filter(key => key.includes('/prepared/'))).toHaveLength(0);
    console.info(`cold terrain planning fixture: ${elapsed.toFixed(1)} ms for 65536 cells (${points} projectable)`);
  }, 120_000);

  it('stops cold planning when its deadline crosses during the scan', async () => {
    const input = setup({ width: 1024 }), grid = { kind: 'regular-latlon' as const, width: 1024, height: 192, earthRadiusM: 6371229, lon0: 0, lat0: 0.75, dx: 1 / 1024, dy: -1e-12, wrapLongitude: false };
    const cells = grid.width * grid.height, gridHash = sha256(JSON.stringify(gridSchema.parse(grid)));
    const coverage = sparseCoverageFromDense({ width: grid.width, height: grid.height, wrapLongitude: false, gridHash, output: new Uint8Array(cells / 8).fill(255), halo: new Uint8Array(cells / 8) });
    const encoded = encodeSparseCoverage(coverage), coverageDescriptor = Buffer.from(JSON.stringify({ version: 2, id: 'fixture', grid, gridHash, bounds: [0, 0, 1, 1], policy: 'fixture', maxZoom: 0, supportHaloCells: 1, sampleLayout: { format: 'cell-major-block-shards-v1', blockSize: 16 }, files: { sparse: { bytes: encoded.length, sha256: sha256(encoded) }, tiles: { bytes: 1, sha256: sha256(Uint8Array.of(1)) } } }));
    const original = terrainReader.createTerrainReader, head = vi.spyOn(input.storage, 'head'), now = Date.now();
    let points = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now + (points >= 10_000 ? 10_001 : 0));
    vi.spyOn(terrainReader, 'createTerrainReader').mockImplementation(async options => {
      const reader = await original(options), sourceBlocks = reader.sourceBlocks;
      reader.sourceBlocks = (latitude, longitude) => { points++; return sourceBlocks(latitude, longitude); };
      return reader;
    });
    await expect(prepareSparseTerrain({ ...input, grid, coverage, coverageDescriptor, limits: { maxDurationMs: 10_000 } })).rejects.toThrow('deadline exceeded');
    expect(points).toBeGreaterThanOrEqual(10_000);
    expect(points).toBeLessThan(65_536);
    expect(head).not.toHaveBeenCalled();
    expect([...input.storage.objects.keys()].filter(key => key.includes('/prepared/'))).toHaveLength(0);
  });

  it('preserves offsets for non-projectable cells in sparse preparation', async () => {
    const input = setup(), grid = { kind: 'regular-latlon' as const, width: 3, height: 3, earthRadiusM: 6371229, lon0: 0, lat0: -89.5, dx: 0.01, dy: -1, wrapLongitude: false };
    const gridHash = sha256(JSON.stringify(gridSchema.parse(grid)));
    const coverage = sparseCoverageFromDense({ width: 3, height: 3, wrapLongitude: false, gridHash, output: Uint8Array.of(255, 1), halo: Uint8Array.of(0, 0) });
    const encoded = encodeSparseCoverage(coverage), coverageDescriptor = Buffer.from(JSON.stringify({ version: 2, id: 'fixture', grid, gridHash, bounds: [0, -90, 1, -89], policy: 'fixture', maxZoom: 0, supportHaloCells: 1, sampleLayout: { format: 'cell-major-block-shards-v1', blockSize: 16 }, files: { sparse: { bytes: encoded.length, sha256: sha256(encoded) }, tiles: { bytes: 1, sha256: sha256(Uint8Array.of(1)) } } }));
    const ref = await prepareSparseTerrain({ ...input, grid, coverage, coverageDescriptor });
    const packed = await readSparsePreparedTerrain(ref, async asset => (await input.storage.get(asset.key, undefined, asset.bytes))!.bytes, grid, coverage, coverageDescriptor);
    expect([...packed.valid]).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0]);
    expect([...packed.elevationM]).toEqual(Array(9).fill(0));
  });

  it('bounds per-point redecodes when seam donors exceed cache and rejects a lower lifetime limit', async () => {
    const input = setup({ west: 179, value: () => 10 }, { west: -180, value: () => 30 });
    const grid = { kind: 'regular-latlon' as const, width: 8, height: 1, earthRadiusM: 6371229, lon0: 179.875, lat0: 0.75, dx: 1e-12, dy: -0.25, wrapLongitude: false };
    const gridHash = sha256(JSON.stringify(gridSchema.parse(grid)));
    const coverage = sparseCoverageFromDense({ width: 8, height: 1, wrapLongitude: false, gridHash, output: Uint8Array.of(255), halo: Uint8Array.of(0) });
    const encoded = encodeSparseCoverage(coverage), coverageDescriptor = Buffer.from(JSON.stringify({ version: 2, id: 'fixture', grid, gridHash, bounds: [179, 0, -179, 1], policy: 'fixture', maxZoom: 0, supportHaloCells: 1, sampleLayout: { format: 'cell-major-block-shards-v1', blockSize: 16 }, files: { sparse: { bytes: encoded.length, sha256: sha256(encoded) }, tiles: { bytes: 1, sha256: sha256(Uint8Array.of(1)) } } }));
    const reader = { maxCachedPixels: 512 * 512, maxDecodedPixels: 2 * 512 * 512 };
    const rejected = vi.fn();
    await expect(prepareSparseTerrain({ ...input, grid, coverage, coverageDescriptor, limits: { reader, total: { maxDecodedPixels: 15 * 512 * 512 } }, onReport: rejected })).rejects.toThrow('decodedPixels budget');
    expect(rejected.mock.calls[0][0]).toMatchObject({ reader: { decodedPixels: 15 * 512 * 512 }, totalLimits: { maxDecodedPixels: 15 * 512 * 512 } });
    const report = vi.fn();
    const ref = await prepareSparseTerrain({ ...input, grid, coverage, coverageDescriptor, limits: { reader }, onReport: report });
    const values = await readSparsePreparedTerrain(ref, async asset => (await input.storage.get(asset.key, undefined, asset.bytes))!.bytes, grid, coverage, coverageDescriptor);
    expect([...values.elevationM]).toEqual(Array(8).fill(20));
    expect(report.mock.calls[0][0]).toMatchObject({ sourceBlocks: 2, reader: { decodedPixels: 16 * 512 * 512, outputPixels: 8 }, totalLimits: { maxDecodedPixels: 32 * 512 * 512, maxReadBytes: 8 * TERRAIN_READ_LIMITS.maxReadBytes }, planning: { decodedBlocks: 32, readBatches: 8 } });
  });

  it('streams multiple chunks through cache validation and staging with load parity', async () => {
    const input = setup(), grid = { kind: 'regular-latlon' as const, width: 4096, height: 2049, earthRadiusM: 6371229, lon0: 0, lat0: 1, dx: 0.0001, dy: -0.0001, wrapLongitude: false };
    const cells = grid.width * grid.height, gridHash = sha256(JSON.stringify(gridSchema.parse(grid)));
    const coverage = sparseCoverageFromDense({ width: grid.width, height: grid.height, wrapLongitude: false, gridHash, output: new Uint8Array(cells / 8).fill(255), halo: new Uint8Array(cells / 8) });
    const encoded = encodeSparseCoverage(coverage), coverageDescriptor = Buffer.from(JSON.stringify({ version: 2, id: 'fixture', grid, gridHash, bounds: [0, 0, 1, 1], policy: 'fixture', maxZoom: 0, supportHaloCells: 1, sampleLayout: { format: 'cell-major-block-shards-v1', blockSize: 16 }, files: { sparse: { bytes: encoded.length, sha256: sha256(encoded) }, tiles: { bytes: 1, sha256: sha256(Uint8Array.of(1)) } } }));
    const coverageHash = sha256(coverageDescriptor), prefix = `terrain/prepared/${sha256(encodeJson({ dataId: input.catalog.dataId, gridHash, method: PREPARED_TERRAIN_METHOD, coverageHash, layoutVersion: 1, oceanCoverage: 'verified', sourceIntegrity: 'sha256-before-sampling-v1' }))}`;
    const files: { elevationM: Array<{ key: string; bytes: number; sha256: string }>; valid: Array<{ key: string; bytes: number; sha256: string }> } = { elevationM: [], valid: [] };
    const chunkCells = ASSET_MAX_BYTES / 4;
    for (let start = 0, i = 0; start < cells; start += chunkCells, i++) {
      const count = Math.min(chunkCells, cells - start);
      for (const [name, bytes, list] of [[`elevation-${i}.f32`, new Uint8Array(count * 4), files.elevationM], [`valid-${i}.u8`, new Uint8Array(count), files.valid]] as const) {
        if (name.startsWith('elevation-')) new DataView(bytes.buffer).setFloat32(0, i + 42.5, true);
        else bytes[0] = 1;
        const key = `${prefix}/${name}`;
        input.storage.objects.set(key, bytes);
        list.push({ key, bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
    const manifest = encodeJson({ version: 2, dataId: input.catalog.dataId, method: PREPARED_TERRAIN_METHOD, grid, gridHash, coverageHash, layoutVersion: 1, oceanCoverage: 'verified', sourceIntegrity: 'sha256-before-sampling-v1', cells, source: input.catalog.source, files });
    const ref = { key: `${prefix}/manifest.json`, bytes: manifest.length, sha256: sha256(manifest), arrayBytes: cells * 5 };
    input.storage.objects.set(ref.key, manifest);
    const read = async (asset: { key: string; bytes: number }) => (await input.storage.get(asset.key, undefined, asset.bytes))!.bytes;
    const out = await mkdtemp(join(tmpdir(), 'av-sparse-chunks-'));
    try {
      const checked = await validateSparsePreparedTerrain(ref, read, grid, coverage, coverageDescriptor);
      expect(checked.elevationM).toBeUndefined();
      expect(checked.valid).toBeUndefined();
      expect(checked.descriptor.files.elevationM).toHaveLength(2);
      expect(await prepareSparseTerrain({ ...input, grid, coverage, coverageDescriptor })).toEqual(ref);
      await stageSparsePreparedTerrain({ ref, storage: input.storage, out, grid, coverage, coverageDescriptor });
      const loaded = await loadSparsePreparedTerrain({ ref, out, grid, coverage, coverageDescriptor });
      expect(loaded.valid.length).toBe(cells);
      expect(loaded.elevationM[0]).toBe(42.5);
      expect(loaded.elevationM[chunkCells]).toBe(43.5);
      expect(loaded.elevationM[cells - 1]).toBe(0);
    } finally { await rm(out, { recursive: true, force: true }); }
  }, 120_000);

  it('enforces batch and lifetime work limits separately', async () => {
    const input = setup(), budget = createTerrainReadBudget({ maxReadBytes: TERRAIN_READ_LIMITS.maxReadBytes, maxDecodedPixels: TERRAIN_READ_LIMITS.maxDecodedPixels, maxOutputPixels: 3 });
    const reader = await createTerrainReader({ ...input, limits: { maxOutputPixels: 2 }, budget });
    const point = { latitude: 0.75, longitude: 0.25 };
    try {
      await reader.sampleBatch!([point, point]);
      reader.close();
      const next = await createTerrainReader({ ...input, limits: { maxOutputPixels: 2 }, budget });
      try {
        await next.sampleBatch!([point]);
        await expect(next.sampleBatch!([point])).rejects.toThrow('outputPixels budget');
        expect(next.stats().outputPixels).toBe(3);
      } finally { next.close(); }
    } finally { reader.close(); }
  });

  it('bounds decoder work within a batch without resetting lifetime totals', async () => {
    const input = setup({ width: 1024 });
    const budget = createTerrainReadBudget({ maxReadBytes: TERRAIN_READ_LIMITS.maxReadBytes, maxDecodedPixels: 2 * 512 * 512, maxOutputPixels: 3 });
    const reader = await createTerrainReader({ ...input, budget, limits: { maxDecodedPixels: 512 * 512, maxCachedPixels: 512 * 512 } });
    try {
      const points = [0.25, 0.75].map(longitude => ({ latitude: 0.75, longitude }));
      await expect(reader.sampleBatch!(points)).rejects.toThrow('decodedPixels budget');
      expect(reader.stats().decodedPixels).toBe(512 * 512);
      expect(await reader.sampleBatch!([points[1]])).toEqual([{ elevationM: ramp(points[1].latitude, points[1].longitude), source: 'dem' }]);
      expect(reader.stats().decodedPixels).toBe(2 * 512 * 512);
    } finally { reader.close(); }
  });

  it('retains source identity and deadline across reader lifetimes', async () => {
    const input = setup();
    const budget = createTerrainReadBudget({ maxReadBytes: TERRAIN_READ_LIMITS.maxReadBytes, maxDecodedPixels: TERRAIN_READ_LIMITS.maxDecodedPixels, maxOutputPixels: 10 });
    const reader = await createTerrainReader({ ...input, budget });
    await reader.sampleBatch!([{ latitude: 0.75, longitude: 0.25 }]);
    reader.close();
    const bytes = input.storage.objects.get(input.catalog.tiles[0].asset.key)!;
    bytes[bytes.length - 1] ^= 1;
    const next = await createTerrainReader({ ...input, budget });
    try { await expect(next.sampleBatch!([{ latitude: 0.75, longitude: 0.25 }])).rejects.toThrow('Missing or changed terrain asset'); }
    finally { next.close(); }
    const expired = createTerrainReadBudget({ maxReadBytes: 1, maxDecodedPixels: 1, maxOutputPixels: 1 }, { deadlineAt: Date.now() - 1 });
    await expect(createTerrainReader({ ...input, budget: expired })).rejects.toThrow('deadline exceeded');
  });

  it.each([
    { limits: { maxDecodedPixels: 1 }, message: 'decodedPixels budget' },
    { limits: { maxReadBytes: 1 }, message: 'readBytesBound budget' },
    { limits: { maxRangeBytes: 1 }, message: 'byte range exceeds' },
    { limits: { maxCachedPixels: 1 }, message: 'block exceeds cache' }
  ])('enforces source work limits before the expensive read: $message', async ({ limits, message }) => {
    const input = setup();
    const reader = await createTerrainReader({ ...input, limits });
    try { await expect(reader.sample(0.75, 0.25)).rejects.toThrow(message); expect(input.storage.gets).toHaveLength(0); }
    finally { reader.close(); }
  });

  it('admits output work before global window allocation or reads', async () => {
    const input = setup();
    const reader = await createTerrainReader({ ...input, limits: { maxOutputPixels: 1 } });
    try {
      await expect(collect(reader.readWindows([-180, -90, 180, 90]))).rejects.toThrow('outputPixels budget');
      expect(input.storage.gets).toHaveLength(0);
      await reader.sample(0.75, 0.25);
      await expect(reader.sample(0.75, 0.25)).rejects.toThrow('outputPixels budget');
    } finally { reader.close(); }
  });

  it.each(['geometry', 'nodata'] as const)('rejects catalog/file %s disagreements', async defect => {
    const input = setup();
    if (defect === 'geometry') input.catalog.tiles[0].geometry.lon0 = 0.125;
    else input.catalog.tiles[0].nodata = -9999;
    input.catalog.dataId = dataIdentity(input.catalog);
    const reader = await createTerrainReader(input);
    try { await expect(reader.sample(0.75, 0.25)).rejects.toThrow(`catalog ${defect}`); }
    finally { reader.close(); }
  });

  it('refuses changed ETags and removes failed in-flight cache entries', async () => {
    const input = setup(), original = input.storage.get.bind(input.storage);
    const get = vi.spyOn(input.storage, 'get').mockImplementationOnce(async (...args) => {
      const result = await original(...args); return result && { ...result, etag: 'changed' };
    });
    const reader = await createTerrainReader(input);
    try {
      await expect(reader.sample(0.75, 0.25)).rejects.toThrow('changed terrain range');
      expect(reader.stats().bytesRead).toBe(input.catalog.tiles[0].asset.bytes);
      get.mockRestore();
      expect(await reader.sample(0.75, 0.25)).toEqual({ elevationM: 27.5, source: 'dem' });
      expect(reader.stats().bytesRead).toBeGreaterThan(2 * input.catalog.tiles[0].asset.bytes);
    } finally { reader.close(); }
  });

  it('decodes exact range bytes when storage returns a Buffer view with an offset', async () => {
    const input = setup(), original = input.storage.get.bind(input.storage);
    vi.spyOn(input.storage, 'get').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (!result) return null;
      const backing = Buffer.concat([Buffer.alloc(13, 0xde), result.bytes, Buffer.alloc(7, 0xad)]);
      return { ...result, bytes: backing.subarray(13, 13 + result.bytes.length) };
    });
    const reader = await createTerrainReader(input);
    try { expect(await reader.sample(0.75, 0.25)).toEqual({ elevationM: 27.5, source: 'dem' }); }
    finally { reader.close(); }
  });

  it('pins an asset ETag even after both image metadata and decoded blocks are evicted', async () => {
    const input = setup({}, { south: 1 });
    const reader = await createTerrainReader({ ...input, limits: { maxCachedPixels: 512 * 512, maxOpenTiles: 1 } });
    try {
      await reader.sample(0.75, 0.25);
      await reader.sample(1.75, 0.25);
      const key = input.catalog.tiles.find(tile => tile.south === 0)!.asset.key;
      const changed = input.storage.objects.get(key)!.slice();
      changed[changed.length - 1] ^= 1;
      input.storage.objects.set(key, changed);
      await expect(reader.sample(0.75, 0.25)).rejects.toThrow('changed terrain asset');
    } finally { reader.close(); }
  });

  it('checks cancellation after storage work and closes even cached/ocean access', async () => {
    const input = setup(), controller = new AbortController(), original = input.storage.get.bind(input.storage);
    vi.spyOn(input.storage, 'get').mockImplementation(async (...args) => {
      const result = await original(...args); controller.abort(new Error('cancel terrain')); return result;
    });
    const reader = await createTerrainReader({ ...input, signal: controller.signal });
    await expect(reader.sample(0.75, 0.25)).rejects.toThrow('cancel terrain');
    reader.close();
    const closed = await createTerrainReader(setup());
    closed.close();
    await expect(closed.sample(5.5, 5.5)).rejects.toThrow('Terrain reader closed');
  });

  it('rejects invalid limits, coordinates and immutable catalog identity', async () => {
    await expect(createTerrainReader({ ...setup(), limits: { maxReadBytes: NaN } })).rejects.toThrow('Invalid terrain read limit');
    await expect(createTerrainReader({ ...setup(), limits: { maxReadBytes: 257 * 1024 * 1024 } })).rejects.toThrow('Invalid terrain read limit');
    await expect(createTerrainReader({ ...setup(), limits: { extra: 1 } as never })).rejects.toThrow('Invalid terrain read limit');
    const corrupt = setup(); corrupt.catalog.dataId = 'b'.repeat(64);
    await expect(createTerrainReader(corrupt)).rejects.toThrow('data identity');
    const reader = await createTerrainReader(setup());
    try {
      await expect(reader.sample(0, 181)).rejects.toThrow('Invalid terrain point');
      await expect(collect(reader.readWindows([0, -91, 1, 2]))).rejects.toThrow('Invalid terrain window');
    } finally { reader.close(); }
  });
});
