import { CELL_BYTES, coverageIndices, expectedTiles, forecastGrids, LAYERS, MAX_GRID_CELLS, MAX_NATIVE_ZOOM, MAX_RETAINED_BUILDS, sameGrid, MAX_SAMPLE_RANGE_BYTES, MAX_SAMPLE_VALUES, RETENTION_DAYS, SAMPLE_BLOCK_SIZE, TERRAIN_CLEARANCE_METHOD, type CoverageMask, type Manifest, type ProductDefinition } from '@av/contracts';
import { prepareSamplePackLayout } from '@av/forecast';
import { terrainClearanceMappingBytes } from '@av/forecast/refinement';
import { MAX_PREPARED_TERRAIN_BYTES, PREPARED_TERRAIN_CELL_BYTES, type PreparedTerrain } from './terrain/prepare.js';
import { MAX_RASTER_SHARED_INPUT_BYTES, rasterWorkerCount, RASTER_WORKER_RESERVE_BYTES } from './raster-pool.js';
import type { LoadedRefinement } from './refinement/prepare.js';

/** Admission budgets, not predictions about an unknown runner or upstream service. */
export const BUILD_BUDGETS = {
  gridCells: MAX_GRID_CELLS,
  tiles: 300_000,
  samplePackBytes: 256 * 1024 * 1024,
  elapsedMs: 50 * 60_000,
  peakRssBytes: 2 * 1024 ** 3
} as const;

export const MAX_BUILD_LIFETIME_MS = 6 * 3_600_000;
export type PreparedBuild = ReturnType<typeof prepareBuild<LoadedRefinement>> & { terrain?: PreparedTerrain };

export interface CapacityScenario {
  frames?: number;
  layers?: number;
  models?: number;
  nativeZoom?: number;
  cadenceHours?: number;
  retentionDays?: number;
}

/** Project deeper levels conservatively; exact coverage must be regenerated before admission. */
export function estimateCapacity(mask: CoverageMask, product: ProductDefinition, storedCells: number, scenario: CapacityScenario = {}, refinement: { gridCells: number; storedCells: number } = { gridCells: 0, storedCells: 0 }) {
  const frames = scenario.frames ?? product.frameHours.length, layers = scenario.layers ?? product.layers.length;
  const models = scenario.models ?? 1, nativeZoom = scenario.nativeZoom ?? product.maxNativeZoom;
  const cadenceHours = scenario.cadenceHours ?? 12, retentionDays = scenario.retentionDays ?? RETENTION_DAYS;
  if ([frames, layers, models, nativeZoom].some(n => !Number.isSafeInteger(n)) || frames < 1 || layers < 1 || models < 1 || nativeZoom < 0 || nativeZoom > 24 || !Number.isFinite(cadenceHours) || cadenceHours <= 0 || !Number.isFinite(retentionDays) || retentionDays <= 0) throw new RangeError('Invalid capacity scenario');
  if (Object.values(refinement).some(value => !Number.isSafeInteger(value) || value < 0)) throw new RangeError('Invalid refinement capacity');
  if (mask.maxZoom > product.maxNativeZoom || mask.maxZoom > MAX_NATIVE_ZOOM) throw new Error('Coverage exceeds the admitted native zoom');
  const tilesByZoom = Array.from({ length: nativeZoom + 1 }, (_, z) => z <= mask.maxZoom
    ? expectedTiles(mask, z).length
    : expectedTiles(mask, mask.maxZoom).length * 4 ** (z - mask.maxZoom));
  const channels = frames * layers, tiles = tilesByZoom.reduce((sum, n) => sum + n, 0) * channels * models;
  const refinementChannels = frames * TERRAIN_CLEARANCE_METHOD.outputs.length;
  const samplePackBytes = (storedCells * channels + refinement.storedCells * refinementChannels) * CELL_BYTES;
  const retainedPerModel = Math.ceil(retentionDays * 24 / cadenceHours);
  // A two-by-two neighborhood spans at most B + 3 cell records in a (B + 1)-wide block.
  const pointRangeBytes = (SAMPLE_BLOCK_SIZE + 3) * (channels + (refinement.storedCells ? refinementChannels : 0)) * CELL_BYTES;
  const violations: string[] = [];
  if (nativeZoom > product.maxNativeZoom) violations.push('native zoom exceeds the trusted product; regenerate coverage and prove a benefit before raising it');
  if (mask.grid.width * mask.grid.height + refinement.gridCells > BUILD_BUDGETS.gridCells) violations.push('grid-cell budget exceeded');
  if (!Number.isSafeInteger(tiles) || tiles > BUILD_BUDGETS.tiles) violations.push('tile budget exceeded');
  if (!Number.isSafeInteger(samplePackBytes) || samplePackBytes > BUILD_BUDGETS.samplePackBytes) violations.push('sample-pack budget exceeded');
  if (channels > MAX_SAMPLE_VALUES) violations.push('all-frame point response exceeds the result budget; define bounded products before adding channels');
  if (pointRangeBytes > MAX_SAMPLE_RANGE_BYTES) violations.push('point range exceeds the byte budget');
  if (retainedPerModel >= MAX_RETAINED_BUILDS) violations.push('retention leaves no room for a replacement build');
  return {
    frames, layers, models, nativeZoom, cadenceHours, retentionDays, channels, tilesByZoom, tiles,
    quarterSamples: tiles * 256 * 256 * 4,
    samplePackBytes, totalSamplePackBytes: samplePackBytes * models,
    point: { reads: refinement.storedCells ? 2 : 1, worstCaseRangeBytes: pointRangeBytes, values: channels },
    retainedPerModel, retainedSampleBytes: retainedPerModel * samplePackBytes * models,
    archiveObjectsPerBuild: channels * models,
    bounds: { projectedZooms: nativeZoom > mask.maxZoom, excludesArchiveBytes: true },
    refinement, budgets: BUILD_BUDGETS, violations
  };
}

/** Prepare reusable geometry/counts and reject resource growth before acquiring weather. */
export function prepareBuild<Refinement extends { mask: CoverageMask } = LoadedRefinement>(mask: CoverageMask, product: ProductDefinition, resources: { maxLevels: number; retainedGeometryFields?: number; frameCount?: number; terrainBytes?: number; refinements?: readonly Refinement[] }) {
  if (!Array.isArray(product.layers) || !product.layers.length || new Set(product.layers).size !== product.layers.length || product.layers.some(layer => !Object.hasOwn(LAYERS, layer))) throw new Error('Product requires unique implemented scalar layers');
  if (!Array.isArray(product.frameHours) || !product.frameHours.length || product.frameHours.some((hour, index) => !Number.isSafeInteger(hour) || (index > 0 && hour <= product.frameHours[index - 1]))) throw new Error('Product requires strictly ascending integer frame hours');
  if (!Number.isFinite(product.intervalHours) || product.intervalHours <= 0 || product.intervalHours > product.frameHours[0]) throw new Error('Product interval must be positive and not exceed its first frame');
  if (mask.maxZoom !== product.maxNativeZoom || !sameGrid(mask.grid, product.grid)) throw new Error('Coverage does not match the trusted product');
  if (mask.grid.width * mask.grid.height > BUILD_BUDGETS.gridCells) throw new Error('Grid-cell budget exceeded');
  if ((resources.refinements ?? []).reduce((sum, item) => sum + item.mask.grid.width * item.mask.grid.height, mask.grid.width * mask.grid.height) > BUILD_BUDGETS.gridCells) throw new Error('Aggregate grid-cell budget exceeded');
  const indices = coverageIndices(mask), layout = prepareSamplePackLayout(mask.grid, mask.output, mask.halo);
  if (!indices.output.length || !indices.active.length) throw new Error('Coverage must contain output and active cells before acquisition');
  if (resources.refinements?.length && (!product.layers.includes('usable-lift-msl') || !product.layers.includes('usable-lift-agl'))) throw new Error('Terrain clearance requires native MSL and AGL layers');
  let refinementMappingBytes = 0, refinementTerrainBytes = 0, refinementMaskBytes = 0;
  const refinementSize = { gridCells: 0, storedCells: 0 };
  const refinements = (resources.refinements ?? []).map(item => {
    const active = coverageIndices(item.mask), layout = prepareSamplePackLayout(item.mask.grid, item.mask.output, item.mask.halo);
    if (!active.output.length) throw new Error('Refinement coverage is empty');
    const cells = item.mask.grid.width * item.mask.grid.height;
    refinementSize.gridCells += cells;
    refinementSize.storedCells += layout.storedCells;
    refinementMappingBytes += terrainClearanceMappingBytes(active.active.length);
    refinementTerrainBytes += cells * PREPARED_TERRAIN_CELL_BYTES;
    refinementMaskBytes += item.mask.output.byteLength + item.mask.halo.byteLength + item.mask.tiles.byteLength;
    return { ...item, layout };
  });
  const capacity = estimateCapacity(mask, product, layout.storedCells, resources.frameCount !== undefined ? { frames: resources.frameCount } : {}, refinementSize);
  if (!Number.isSafeInteger(resources.maxLevels) || resources.maxLevels < 1 || resources.maxLevels > 256) throw new Error('Invalid normalized level budget');
  const retainedGeometryFields = resources.retainedGeometryFields ?? 0;
  if (!Number.isSafeInteger(retainedGeometryFields) || retainedGeometryFields < 0 || retainedGeometryFields > 257) throw new Error('Invalid retained geometry budget');
  const terrainBytes = resources.terrainBytes ?? 0;
  if (!Number.isSafeInteger(terrainBytes) || terrainBytes < 0 || terrainBytes > MAX_PREPARED_TERRAIN_BYTES) throw new Error('Invalid prepared terrain byte budget');
  const cells = mask.grid.width * mask.grid.height, activeCells = indices.active.length;
  const rasterWorkers = rasterWorkerCount();
  const fieldsPerLevel = product.capabilities.verticalCoordinate === 'model-levels' ? 3 : 2;
  const workingSet = {
    samplePack: capacity.samplePackBytes,
    derivedFields: (cells * product.layers.length + refinementSize.gridCells * TERRAIN_CLEARANCE_METHOD.outputs.length) * CELL_BYTES,
    normalizedFrame: activeCells * (7 + fieldsPerLevel * resources.maxLevels) * CELL_BYTES,
    diagnostics: refinements.length ? cells * 9 : 0,
    retainedGeometry: activeCells * retainedGeometryFields * CELL_BYTES,
    // Validation can hold encoded bytes and decoded arrays together.
    preparedTerrain: (terrainBytes + refinementTerrainBytes) * 2,
    refinementMapping: refinementMappingBytes,
    rawCompanions: activeCells * 6 * 9,
    decoderReservations: 128 * 1024 * 1024,
    rendererAndEncoder: 64 * 1024 * 1024,
    rasterSharedInputs: rasterWorkers ? (cells * product.layers.length + refinementSize.gridCells * TERRAIN_CLEARANCE_METHOD.outputs.length) * CELL_BYTES + mask.output.byteLength + mask.halo.byteLength + mask.tiles.byteLength + refinementMaskBytes : 0,
    rasterWorkerRuntimes: rasterWorkers * RASTER_WORKER_RESERVE_BYTES,
    indicesAndLayout: indices.active.byteLength + indices.output.byteLength + layout.indexBytes + refinementMaskBytes + refinements.reduce((sum, patch) => sum + patch.layout.indexBytes, 0),
    archiveAndValidation: 2 * BUILD_BUDGETS.samplePackBytes + cells * 4,
    runtimeAndNativeReserve: 256 * 1024 * 1024
  };
  const estimatedPeakBytes = Object.values(workingSet).reduce((total, bytes) => total + bytes, 0);
  if (workingSet.rasterSharedInputs > MAX_RASTER_SHARED_INPUT_BYTES) throw new Error('Raster shared input byte budget exceeded');
  if (estimatedPeakBytes > BUILD_BUDGETS.peakRssBytes) throw new Error('Complete build working-set budget exceeded');
  if (capacity.violations.length) throw new Error(`Build exceeds capacity: ${capacity.violations.join('; ')}`);
  return { indices, layout, refinements, capacity: { ...capacity, rasterWorkers, workingSet, estimatedPeakBytes } };
}

/** Gate recorded build metrics against the same budgets used by build admission. */
export function checkPerformance(manifest: Manifest) {
  const failures: string[] = [];
  const metric = (key: string): number => {
    const value = manifest.metrics[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) { failures.push(`missing or invalid ${key}`); return NaN; }
    return value;
  };
  const elapsedMs = metric('elapsedMs'), peakRssBytes = metric('peakRssBytes');
  const counts = manifest.metrics.tiles;
  const validCounts = Array.isArray(counts) && counts.length === manifest.coverage.maxZoom + 1 && counts.every(n => Number.isSafeInteger(n) && n >= 0);
  if (!validCounts) failures.push('missing or invalid tile counts');
  const tiles = validCounts ? counts.reduce((sum: number, count: number) => sum + count, 0) * manifest.artifacts.length : NaN;
  const grids = forecastGrids(manifest);
  const observed = { elapsedMs, peakRssBytes, tiles,
    samplePackBytes: grids.reduce((sum, grid) => sum + grid.samples.bytes, 0),
    gridCells: grids.reduce((sum, grid) => sum + grid.grid.width * grid.grid.height, 0) };
  for (const key of Object.keys(BUILD_BUDGETS) as (keyof typeof BUILD_BUDGETS)[]) {
    if (observed[key] > BUILD_BUDGETS[key]) failures.push(`${key}: ${observed[key]} exceeds ${BUILD_BUDGETS[key]}`);
  }
  return { version: 1, buildId: manifest.buildId, cycle: manifest.cycle, observed, budgets: BUILD_BUDGETS, passed: failures.length === 0, failures };
}
