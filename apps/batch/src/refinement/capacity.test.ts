import { INDEXED_PRODUCT } from '../../../../tests/model-fixtures.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBit, STATUS_VALID, TERRAIN_COLUMN_METHOD, type CoverageMask, type ProductDefinition } from '@av/contracts';
import type { GridField } from '@av/forecast';
import { prepareTerrainClearance, prepareTerrainColumns } from '@av/forecast/refinement';
import * as refinement from '@av/forecast/refinement';
import { buildForecast } from '../build.js';
import { BUILD_BUDGETS, estimateCapacity, prepareBuild } from '../capacity.js';
import type { ForecastProvider } from '../provider.js';
import { createSamplePackBuilder } from '../sample-pack.js';
import { seedTerrainCatalog, TerrainTestStorage } from '../terrain/test-fixtures.js';
import * as config from './config.js';
import { planRefinementCoverage } from './coverage.js';
import { loadRefinements, prepareRefinements } from './prepare.js';

vi.mock('../raster-pool.js', async importOriginal => ({
  ...await importOriginal<typeof import('../raster-pool.js')>(),
  rasterWorkerCount: () => 2
}));
const terrainReads = vi.hoisted(() => ({ opens: 0 }));
vi.mock('../terrain/reader.js', () => ({
  createTerrainReader: async () => { terrainReads.opens++; return {
    async sample() { return { elevationM: 100, source: 'dem' as const }; },
    close() {},
    stats: () => ({ requests: 1, bytesRead: 16, decodedPixels: 4, outputPixels: 4, cacheHits: 0 })
  }; }
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const zones = {
  type: 'FeatureCollection',
  features: [0.48, 0.515].map((west, index) => ({
    type: 'Feature', id: `zone-00${index + 1}`, properties: {},
    geometry: { type: 'Polygon', coordinates: [[[west, 0.48], [west + 0.015, 0.48], [west + 0.015, 0.52], [west, 0.52], [west, 0.48]]] }
  }))
};

async function fixture() {
  const out = await mkdtemp(join(tmpdir(), 'av-refinement-capacity-')); roots.push(out);
  const storage = new TerrainTestStorage(), catalogRef = seedTerrainCatalog(storage);
  const product: ProductDefinition = {
    ...INDEXED_PRODUCT, terrainSubdivisionFactor: undefined,
    grid: { kind: 'regular-latlon', width: 9, height: 7, earthRadiusM: 6371229, lon0: 0.46, lat0: 0.53, dx: 0.01, dy: -0.01, wrapLongitude: false },
    bounds: [0.46, 0.47, 0.54, 0.53], maxNativeZoom: 0, frameHours: [1, 2]
  };
  const mask: CoverageMask = { grid: product.grid, bounds: product.bounds, output: new Uint8Array(8), halo: new Uint8Array(8), tiles: Uint8Array.of(1), maxZoom: 0 };
  for (let i = 0; i < 63; i++) setBit(mask.output, i);
  return { product, mask, out, storage, catalogRef };
}

async function preparedFixture() {
  const options = await fixture();
  const inputs = await prepareRefinements({ ...options, zones });
  const refinements = await loadRefinements({ inputs, out: options.out, baseMask: options.mask });
  expect(refinements).toHaveLength(2);
  return { ...options, refinements };
}

const bytes = (...arrays: ArrayBufferView[]) => arrays.reduce((sum, value) => sum + value.byteLength, 0);
const fieldBytes = (field: GridField) => bytes(field.values, field.flags);
const maskBytes = (mask: CoverageMask) => bytes(mask.output, mask.halo, mask.tiles);

describe('refinement build admission', () => {
  it('inspects the exact producer masks and resources before any terrain acquisition', async () => {
    const options = await fixture(), reads = terrainReads.opens;
    setBit(options.mask.output, 3 * 9 + 3, false);
    const planned = planRefinementCoverage({ ...options, zones });
    const prepareColumns = vi.spyOn(refinement, 'prepareTerrainColumns');
    const inspected = prepareBuild(options.mask, options.product, { maxLevels: 2, refinements: planned });
    expect(planned).toHaveLength(2);
    expect(prepareColumns).toHaveBeenCalledTimes(planned.length);
    for (const [index, patch] of inspected.refinements.entries()) expect(patch.columns).toBe(prepareColumns.mock.results[index].value);
    expect(terrainReads.opens).toBe(reads);
    expect(options.storage.gets).toHaveLength(0);
    expect(inspected.capacity.workingSet.preparedTerrain).toBeGreaterThan(0);
    expect(inspected.capacity.workingSet.refinementMapping).toBeGreaterThan(0);

    const inputs = await prepareRefinements({ ...options, zones });
    const loaded = await loadRefinements({ inputs, out: options.out, baseMask: options.mask });
    const actual = prepareBuild(options.mask, options.product, { maxLevels: 2, refinements: loaded });
    const contents = ({ mask }: { mask: CoverageMask }) => ({ ...mask, output: [...mask.output], halo: [...mask.halo], tiles: [...mask.tiles] });
    expect(planned.map(contents)).toEqual(loaded.map(contents));
    expect(inspected.capacity).toEqual(actual.capacity);
    expect(terrainReads.opens).toBeGreaterThan(reads);
    const scenario = estimateCapacity(options.mask, options.product, inspected.layout.storedCells,
      { frames: options.product.frameHours.length * 2 }, inspected.capacity.refinement);
    expect(scenario.samplePackBytes).toBe(actual.capacity.samplePackBytes * 2);
    expect(scenario.refinement).toEqual(actual.capacity.refinement);
  });

  it('charges no refinement resources when the polygons miss base output cells', async () => {
    const options = await fixture(), reads = terrainReads.opens;
    options.mask.output.fill(0); setBit(options.mask.output, 0);
    const planned = planRefinementCoverage({ ...options, zones });
    expect(planned).toHaveLength(0);
    const inspected = prepareBuild(options.mask, options.product, { maxLevels: 2, refinements: planned });
    const baseline = prepareBuild(options.mask, options.product, { maxLevels: 2 });
    expect(inspected.capacity).toEqual(baseline.capacity);
    expect(terrainReads.opens).toBe(reads);
    expect(options.storage.gets).toHaveLength(0);
  });

  it('reserves all retained patch inputs and packs while composing the existing archive set', async () => {
    const { product, mask, out, refinements } = await preparedFixture();
    const baseline = prepareBuild(mask, product, { maxLevels: 2 });
    const prepared = prepareBuild(mask, product, { maxLevels: 2, refinements });
    const fields = product.layers.map((): GridField => ({ values: new Float32Array(63).fill(1000), flags: new Uint8Array(63).fill(STATUS_VALID) }));
    const mappings = refinements.map(patch => prepareTerrainClearance(mask, patch.mask));
    const columns = refinements.map(patch => prepareTerrainColumns(mask, patch.mask, prepared.indices.active, 2, { clearanceFallback: 'unsupported' }));
    const diagnostics = { ceilingMslM: fields[0].values, buoyancyM2S3: new Float32Array(63).fill(1e10), branch: new Uint8Array(63).fill(2) };
    const fineFields = refinements.map((patch, index) => mappings[index].derive(diagnostics, fields[0].flags, patch.terrain, { intervalStart: '2026-06-21T11:00:00.000Z', validTime: '2026-06-21T12:00:00.000Z' }, false));
    const packs = [createSamplePackBuilder(prepared.layout, product.frameHours.length * product.layers.length), ...prepared.refinements.map(patch => createSamplePackBuilder(patch.layout, product.frameHours.length * TERRAIN_COLUMN_METHOD.outputs.length))];
    try {
      const encodedTerrain = await Promise.all(refinements.flatMap(patch => Object.values(patch.terrain.descriptor.files).map(file => readFile(join(out, file.key)))));
      const decodedTerrain = refinements.reduce((sum, patch) => sum + bytes(patch.terrain.elevationM, patch.terrain.valid), 0);
      const baseAndFinalFields = [...fields, ...fineFields.flatMap(fields => Object.values(fields))].reduce((sum, field) => sum + fieldBytes(field), 0);
      const allMasks = [mask, ...refinements.map(patch => patch.mask)].reduce((sum, item) => sum + maskBytes(item), 0);
      const { workingSet } = prepared.capacity;
      for (const [index, patch] of prepared.refinements.entries()) {
        expect(patch.columns.byteLength).toBe(columns[index].byteLength);
        expect(patch.columns.workspaceBytes).toBe(columns[index].workspaceBytes);
      }
      expect(workingSet.samplePack).toBe(packs.reduce((sum, pack) => sum + pack.byteLength, 0));
      expect(workingSet.preparedTerrain).toBe(decodedTerrain + bytes(...encodedTerrain));
      expect(workingSet.refinementMapping).toBe(columns.reduce((sum, column) => sum + column.byteLength + column.workspaceBytes, 0));
      expect(workingSet.derivedFields).toBe(baseAndFinalFields);
      expect(workingSet.diagnostics).toBe(63 * 9);
      expect(workingSet.rasterSharedInputs).toBe(baseAndFinalFields + allMasks);
      expect(workingSet.indicesAndLayout).toBe(
        bytes(prepared.indices.active, prepared.indices.output) + prepared.layout.indexBytes
        + prepared.refinements.reduce((sum, patch) => sum + maskBytes(patch.mask) + patch.layout.indexBytes, 0)
      );
      expect(prepared.capacity.estimatedPeakBytes).toBeGreaterThan(baseline.capacity.estimatedPeakBytes);
      expect(prepared.capacity.samplePackBytes).toBeGreaterThan(baseline.capacity.samplePackBytes);
      expect(prepared.capacity.tiles).toBe(baseline.capacity.tiles);
      expect(workingSet.normalizedFrame).toBe(baseline.capacity.workingSet.normalizedFrame);
      expect(workingSet.rawCompanions).toBe(baseline.capacity.workingSet.rawCompanions);
      for (const fields of fineFields) {
        expect(fields['usable-lift-agl'].values.some(value => value === 900)).toBe(true);
        expect(fields['usable-lift-msl'].values.some(value => value === 1000)).toBe(true);
      }
    } finally { packs.forEach(pack => pack.close()); }
  });

  it('rejects aggregate packs before opening weather or publishing, even when every pack fits alone', async () => {
    const options = await preparedFixture();
    const baseline = prepareBuild(options.mask, options.product, { maxLevels: 2 });
    const prepared = prepareBuild(options.mask, options.product, { maxLevels: 2, refinements: options.refinements });
    const limit = prepared.capacity.samplePackBytes - 1;
    expect(baseline.capacity.samplePackBytes).toBeLessThan(limit);
    for (const patch of prepared.refinements) {
      const pack = createSamplePackBuilder(patch.layout, options.product.frameHours.length * TERRAIN_COLUMN_METHOD.outputs.length);
      expect(pack.byteLength).toBeLessThan(limit); pack.close();
    }
    const configure = config.configuredRefinements;
    vi.spyOn(config, 'configuredRefinements').mockImplementation(product => configure(product, zones));
    const open = vi.fn<ForecastProvider['open']>(async () => { throw new Error('Unexpected weather acquisition'); });
    const onValidated = vi.fn();
    const originalBudget = Object.getOwnPropertyDescriptor(BUILD_BUDGETS, 'samplePackBytes')!;
    // Exercise the real admission path with small fixture buffers, not a 256 MiB allocation.
    Object.defineProperty(BUILD_BUDGETS, 'samplePackBytes', { ...originalBudget, value: limit });
    try {
      await expect(buildForecast({
        product: options.product, mask: options.mask, out: options.out,
        provider: { id: 'fixture', provider: 'fixture', maxLevels: 2, open }, onValidated,
        refinement: { catalogRef: options.catalogRef, storage: options.storage }
      })).rejects.toThrow(/sample-pack budget exceeded/);
      expect(open).not.toHaveBeenCalled();
      expect(onValidated).not.toHaveBeenCalled();
    } finally { Object.defineProperty(BUILD_BUDGETS, 'samplePackBytes', originalBudget); }
  });
});
