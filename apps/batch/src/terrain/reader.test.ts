import { describe, expect, it, vi } from 'vitest';
import { createTerrainReader } from './reader';
import { dataIdentity, sha256, TERRAIN_PACKING, TERRAIN_SOURCE, type TerrainCatalog, type TerrainGeometry, type TerrainTile } from './contract';
import { TerrainTestStorage } from './test-fixtures';

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
  const catalog: TerrainCatalog = { version: 1, source: TERRAIN_SOURCE, packing: TERRAIN_PACKING, inventorySha256: 'a'.repeat(64), dataId: '', tiles: fixtures.map(fixture => fixture.tile).sort((a, b) => a.id.localeCompare(b.id)) };
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

  it('treats inventory absence as ocean but never treats a missing expected asset as ocean', async () => {
    const input = setup();
    input.storage.objects.clear();
    const reader = await createTerrainReader(input);
    try {
      expect(await reader.sample(5.5, 5.5)).toEqual({ elevationM: 0, source: 'ocean' });
      expect(reader.stats().requests).toBe(0);
      await expect(reader.sample(0.75, 0.25)).rejects.toThrow('Missing or changed terrain asset');
    } finally { reader.close(); }
  });

  it('never substitutes an overview or fetches the other native block for a point', async () => {
    const input = setup({ width: 1024 });
    const get = vi.spyOn(input.storage, 'get');
    const reader = await createTerrainReader(input);
    try {
      expect((await reader.sample(0.75, 0.25))?.elevationM).toBe(ramp(0.75, 0.25));
      expect(reader.stats().decodedPixels).toBe(512 * 512);
      expect(reader.stats().bytesRead).toBeLessThan(input.catalog.tiles[0].asset.bytes * 0.6);
      expect(get.mock.calls.every(call => call[1] && call[2] === call[1].length && call[3] instanceof AbortSignal)).toBe(true);
      const before = reader.stats().bytesRead;
      await Promise.all([reader.sample(0.75, 0.75), reader.sample(0.625, 0.75)]);
      expect(reader.stats().decodedPixels).toBe(2 * 512 * 512);
      expect(reader.stats().bytesRead - before).toBe(512 * 512 * 4);
    } finally { reader.close(); }
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

  it.each([
    { limits: { maxDecodedPixels: 1 }, message: 'decodedPixels budget' },
    { limits: { maxReadBytes: 1 }, message: 'bytesRead budget' },
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
      await reader.sample(5.5, 5.5);
      await expect(reader.sample(5.5, 5.5)).rejects.toThrow('outputPixels budget');
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
      get.mockRestore();
      expect(await reader.sample(0.75, 0.25)).toEqual({ elevationM: 27.5, source: 'dem' });
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
