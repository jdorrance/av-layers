import { INDEXED_PRODUCT } from '../../../../tests/model-fixtures.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBit, isCovered, MAX_GRID_CELLS, prepareGridGeometry, setBit, type CoverageMask, type ProductDefinition } from '@av/contracts';
import { containsRefinement } from '@av/contracts/refinement';
import { sha256 } from '../terrain/contract.js';
import { seedTerrainCatalog, TerrainTestStorage } from '../terrain/test-fixtures.js';
import { loadRefinements, prepareRefinements } from './prepare.js';

const reader = vi.hoisted(() => ({ open: vi.fn(), sample: vi.fn(), close: vi.fn(), stats: () => ({ requests: 1, bytesRead: 16, decodedPixels: 4, outputPixels: 4, cacheHits: 0 }) }));
vi.mock('../terrain/reader.js', () => ({ createTerrainReader: async () => { reader.open(); return reader; } }));
const roots: string[] = [];
const ring = (west: number, south: number, east: number, north: number) => [[west, south], [east, south], [east, north], [west, north], [west, south]];
const zones = (holes = true) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 'zone-001', properties: {}, geometry: { type: 'Polygon', coordinates: [ring(0.48, 0.48, 0.52, 0.52), ...(holes ? [ring(0.497, 0.497, 0.503, 0.503)] : [])] } }] });
beforeEach(() => {
  vi.clearAllMocks();
  reader.sample.mockImplementation(async (lat: number, lon: number) => lat > 0.51 && lon > 0.51 ? null : { elevationM: -12.5, source: 'dem' });
});
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const out = await mkdtemp(join(tmpdir(), 'av-refinement-')); roots.push(out);
  const storage = new TerrainTestStorage(), catalogRef = seedTerrainCatalog(storage);
  const product: ProductDefinition = { ...INDEXED_PRODUCT, grid: { kind: 'regular-latlon', width: 7, height: 7, earthRadiusM: 6371229, lon0: 0.47, lat0: 0.53, dx: 0.01, dy: -0.01, wrapLongitude: false }, bounds: [0.47, 0.47, 0.53, 0.53], maxNativeZoom: 2 };
  const mask: CoverageMask = { grid: product.grid, bounds: product.bounds, output: new Uint8Array(7), halo: new Uint8Array(7), tiles: new Uint8Array(3), maxZoom: 2 };
  for (let i = 0; i < 49; i++) setBit(mask.output, i);
  setBit(mask.output, 3 * 7 + 4, false);
  for (let i = 0; i < 21; i++) setBit(mask.tiles, i);
  return { out, storage, catalogRef, product, mask, zones: zones() };
}

describe('frozen refinement preparation', () => {
  it('stages polygon-and-base interiors with a one-cell halo and loads them without remote I/O', async () => {
    const options = await fixture(), inputs = await prepareRefinements(options);
    expect(inputs).toHaveLength(1);
    const remoteReads = options.storage.gets.length;
    const [ready] = await loadRefinements({ inputs: JSON.parse(JSON.stringify(inputs)), out: options.out, baseMask: options.mask });
    expect(options.storage.gets.length).toBe(remoteReads);
    expect(ready.terrain.valid.some(value => value === 0)).toBe(true);
    expect(ready.terrain.elevationM.some(value => value === -12.5)).toBe(true);
    const geometry = prepareGridGeometry(ready.mask.grid), { width, height } = ready.mask.grid;
    let outputCells = 0, haloCells = 0;
    for (let i = 0; i < width * height; i++) {
      const x = i % width, y = Math.floor(i / width), point = geometry.gridToGeographic(x, y)!;
      const owned = containsRefinement(ready.input, point.lat, point.lon) && isCovered(options.mask, point.lat, point.lon);
      expect(getBit(ready.mask.output, i)).toBe(owned);
      if (owned) {
        outputCells++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) expect(getBit(ready.mask.output, (y + dy) * width + x + dx) || getBit(ready.mask.halo, (y + dy) * width + x + dx)).toBe(true);
      }
      if (getBit(ready.mask.halo, i)) {
        haloCells++;
        expect(owned).toBe(false);
        expect([-1, 0, 1].some(dy => [-1, 0, 1].some(dx => x + dx >= 0 && y + dy >= 0 && x + dx < width && y + dy < height && getBit(ready.mask.output, (y + dy) * width + x + dx)))).toBe(true);
      }
    }
    expect(outputCells).toBeGreaterThan(0); expect(haloCells).toBeGreaterThan(0);
    expect(ready.mask.tiles.some(byte => byte !== 0)).toBe(true);
    expect(ready.mask.tiles.every((byte, i) => (byte & ~options.mask.tiles[i]) === 0)).toBe(true);
  });

  it('reuses the same DEM preparation when only polygon ownership changes on the same grid', async () => {
    const options = await fixture(), initial = await prepareRefinements(options);
    expect(await prepareRefinements(options)).toEqual(initial);
    const changed = await prepareRefinements({ ...options, zones: zones(false) });
    expect(changed[0].terrain).toEqual(initial[0].terrain);
    expect(changed[0].coverage.hash).not.toBe(initial[0].coverage.hash);
    expect(reader.open).toHaveBeenCalledTimes(1);
  });

  it('does no terrain work for a truly empty selection or zones excluded by base coverage', async () => {
    const options = await fixture();
    expect(await prepareRefinements({ ...options, zones: { type: 'FeatureCollection', features: [] } })).toEqual([]);
    options.mask.output.fill(0);
    expect(await prepareRefinements(options)).toEqual([]);
    expect(options.storage.gets).toEqual([]); expect(reader.open).not.toHaveBeenCalled();
  });

  it('rejects aggregate base-plus-patch growth and cancellation before terrain reads', async () => {
    const options = await fixture();
    const grid = { ...options.product.grid, kind: 'regular-latlon' as const, width: 2000, height: 2000, lon0: 0.4, lat0: 0.6, dx: 0.0001, dy: -0.0001, wrapLongitude: false };
    expect(grid.width * grid.height).toBe(MAX_GRID_CELLS);
    await expect(prepareRefinements({ ...options, product: { ...options.product, grid }, mask: { ...options.mask, grid } })).rejects.toThrow('Aggregate');
    const controller = new AbortController(); controller.abort(new Error('stopped'));
    await expect(prepareRefinements({ ...options, signal: controller.signal })).rejects.toThrow('stopped');
    expect(options.storage.gets).toEqual([]);
  });

  it('rejects mismatched frozen geometry, coverage, ordering and base ownership', async () => {
    const options = await fixture(), inputs = await prepareRefinements(options);
    const load = (candidate = inputs, baseMask = options.mask) => loadRefinements({ inputs: candidate, out: options.out, baseMask });
    await expect(load([inputs[0], inputs[0]])).rejects.toThrow('sorted and unique');
    await expect(load([{ ...inputs[0], bounds: [0.49, 0.49, 0.51, 0.51] }])).rejects.toThrow('binding');
    await expect(load([{ ...inputs[0], grid: { ...inputs[0].grid, width: inputs[0].grid.width + 1 } }])).rejects.toThrow('layout');
    await expect(load(inputs, { ...options.mask, output: new Uint8Array(options.mask.output.length) })).rejects.toThrow('base coverage');
    const controller = new AbortController(); controller.abort(new Error('stopped'));
    await expect(loadRefinements({ inputs, out: options.out, baseMask: options.mask, signal: controller.signal })).rejects.toThrow('stopped');
  });

  it('rejects a substituted terrain data identity even when the supplied descriptor checksum is updated', async () => {
    const options = await fixture(), inputs = await prepareRefinements(options), input = inputs[0];
    const path = join(options.out, input.terrain.key), descriptor = JSON.parse(await readFile(path, 'utf8'));
    descriptor.dataId = 'd'.repeat(64);
    const bytes = Buffer.from(JSON.stringify(descriptor)); await writeFile(path, bytes);
    const forged = { ...input, terrain: { ...input.terrain, sha256: sha256(bytes), bytes: bytes.length } };
    await expect(loadRefinements({ inputs: [forged], out: options.out, baseMask: options.mask })).rejects.toThrow(/layout|identity/);
  });
});
