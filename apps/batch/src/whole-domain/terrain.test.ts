import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalGridJson, GFS_PRODUCT, planWholeDomainGrid, setBit, sparseCoverageFromDense, type CoverageMask, type ProductDefinition, type RegularLatLonGrid } from '@av/contracts';
import { describeSparseCoverage } from '../coverage.js';
import { sha256 } from '../terrain/contract.js';
import { createTerrainReader } from '../terrain/reader.js';
import { seedTerrainCatalog, TerrainTestStorage } from '../terrain/test-fixtures.js';
import { prepareWholeDomain } from './prepare.js';
import { ensureWholeDomainTerrain, loadWholeDomainTerrain } from './terrain.js';

vi.mock('../terrain/source.js', async importOriginal => ({ ...await importOriginal<typeof import('../terrain/source.js')>(), verifyTerrainCatalogInventory: async () => {} }));
vi.mock('../terrain/reader.js', async importOriginal => ({
  ...await importOriginal<typeof import('../terrain/reader.js')>(),
  createTerrainReader: vi.fn(async () => ({
    sourceBlocks: () => '', close() {},
    sampleBatch: async (points: readonly { latitude: number; longitude: number }[]) =>
      points.map(({ latitude, longitude }) => ({ elevationM: 2 * longitude + 3 * latitude - 10, source: 'dem' as const })),
    stats: () => ({ requests: 1, bytesRead: 100, readBytesBound: 100, decodedPixels: 4, outputPixels: 15, cacheHits: 0 })
  }))
}));

const temporary: string[] = [];
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const out = await mkdtemp(join(tmpdir(), 'av-whole-domain-terrain-')); temporary.push(out);
  const native: RegularLatLonGrid = { kind: 'regular-latlon', width: 3, height: 2, earthRadiusM: 6371229,
    lon0: 0.25, lat0: 0.75, dx: 0.25, dy: -0.25, wrapLongitude: false };
  const product: ProductDefinition = { ...GFS_PRODUCT, grid: native, terrainSubdivisionFactor: 2,
    modelId: 'terrain-fixture', id: 'terrain-fixture', bounds: [0, 0, 1, 1], maxNativeZoom: 0 };
  const plan = planWholeDomainGrid(native, 2), grid = plan.fine;
  const dense = (cells: number) => {
    const output = new Uint8Array(Math.ceil(cells / 8));
    for (let index = 0; index < cells; index++) setBit(output, index);
    return { output, halo: new Uint8Array(output.length) };
  };
  const mask: CoverageMask = { grid: native, bounds: product.bounds, maxZoom: 0, tiles: Uint8Array.of(1), ...dense(6) };
  const fineMask = { grid, bounds: product.bounds, maxZoom: 0, tiles: Uint8Array.of(1),
    coverage: sparseCoverageFromDense({ ...grid, gridHash: sha256(canonicalGridJson(grid)), ...dense(grid.width * grid.height) }) };
  const fine = { mask: fineMask, ...describeSparseCoverage(fineMask, product) };
  const storage = new TerrainTestStorage(), catalogRef = seedTerrainCatalog(storage);
  return { out, product, mask, fine, storage, catalogRef, grid, coverage: fineMask.coverage, coverageDescriptor: fine.bytes };
}

describe('whole-domain terrain cache integration', () => {
  it('prewarms remote terrain once and stages the same verified bytes during cache-only planning', async () => {
    const input = await fixture();
    const prepare = () => prepareWholeDomain({ ...input, maxLevels: 3,
      wholeDomain: { catalogRef: input.catalogRef, storage: input.storage, fine: input.fine, cacheOnly: true } });
    await expect(prepare()).rejects.toThrow('Prepared terrain cache is missing');
    expect(createTerrainReader).not.toHaveBeenCalled();
    expect(input.storage.objects.size).toBe(1);

    const ref = await ensureWholeDomainTerrain(input);
    expect(createTerrainReader).toHaveBeenCalledTimes(2);
    await expect(readFile(join(input.out, ref.key))).rejects.toMatchObject({ code: 'ENOENT' });
    vi.mocked(createTerrainReader).mockClear();
    const writes = vi.spyOn(input.storage, 'put');
    const prepared = await prepare();
    expect(prepared.terrain).toEqual(ref);
    expect(createTerrainReader).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    for (const [key, bytes] of input.storage.objects) if (key.startsWith('terrain/prepared/')) {
      expect(await readFile(join(input.out, key))).toEqual(Buffer.from(bytes));
    }
    const loaded = await loadWholeDomainTerrain({ ...input, ref });
    expect([...loaded.valid]).toEqual(new Array(15).fill(1));
    expect([...loaded.elevationM]).toEqual(Array.from({ length: 15 }, (_, index) => {
      const column = index % input.grid.width, row = Math.floor(index / input.grid.width);
      return 2 * (input.grid.lon0 + column * input.grid.dx) + 3 * (input.grid.lat0 + row * input.grid.dy) - 10;
    }));
  });

  it.each(['missing', 'corrupt'] as const)('rejects a %s cached chunk before staging or resampling', async defect => {
    const input = await fixture(), ref = await ensureWholeDomainTerrain(input);
    const key = ref.key.replace('manifest.json', 'elevation-0.f32');
    if (defect === 'missing') input.storage.objects.delete(key);
    else input.storage.objects.get(key)![0] ^= 1;
    vi.mocked(createTerrainReader).mockClear();
    const writes = vi.spyOn(input.storage, 'put');
    await expect(prepareWholeDomain({ ...input, maxLevels: 3,
      wholeDomain: { catalogRef: input.catalogRef, storage: input.storage, fine: input.fine, cacheOnly: true }
    })).rejects.toThrow(defect === 'missing' ? 'Sparse terrain asset missing' : 'integrity mismatch');
    expect(createTerrainReader).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    await expect(readFile(join(input.out, ref.key))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
