import { CELL_BYTES, coverageAtZoom, coverageIndices, expectedTiles, forecastGrids, LAYERS, MAX_GRID_CELLS, MAX_NATIVE_ZOOM, MAX_RETAINED_BUILDS, sameGrid, MAX_SAMPLE_RANGE_BYTES, MAX_SAMPLE_VALUES, RETENTION_DAYS, SAMPLE_BLOCK_SIZE, TERRAIN_COLUMN_METHOD, type CoverageMask, type Manifest, type ManifestV5, type ProductDefinition } from '@av/contracts';
import { prepareSamplePackLayout } from '@av/forecast';
import { prepareTerrainColumns } from '@av/forecast/refinement';
import { MAX_PREPARED_TERRAIN_BYTES, PREPARED_TERRAIN_CELL_BYTES, type PreparedTerrain } from './terrain/prepare.js';
import { MAX_RASTER_SHARED_INPUT_BYTES, rasterWorkerCount, RASTER_WORKER_RESERVE_BYTES } from './raster-pool.js';
import type { LoadedRefinement } from './refinement/prepare.js';

/** Admission budgets, not predictions about an unknown runner or upstream service. */
export const BUILD_BUDGETS = {
  gridCells: MAX_GRID_CELLS,
  tiles: 4_000_000,
  samplePackBytes: 256 * 1024 * 1024,
  numericBytes: 64 * 1024 ** 3,
  elapsedMs: 50 * 60_000,
  peakRssBytes: 2 * 1024 ** 3
} as const;

export const MAX_BUILD_LIFETIME_MS = 6 * 3_600_000;
export const MAX_V5_SHARD_BYTES = 64 * 1024 * 1024;
export type PreparedBuild = ReturnType<typeof prepareBuild<LoadedRefinement>> & { terrain?: PreparedTerrain };

interface FrameResources { maxLevels: number; auxiliarySurfaceFields?: number; auxiliaryLevelFields?: number }
export function normalizedFrameBytes(activeCells: number, verticalCoordinate: ProductDefinition['capabilities']['verticalCoordinate'], resources: FrameResources): number {
  const { maxLevels, auxiliarySurfaceFields = 0, auxiliaryLevelFields = 0 } = resources;
  if (!Number.isSafeInteger(activeCells) || activeCells < 0 || !Number.isSafeInteger(maxLevels) || maxLevels < 1 || maxLevels > 256
      || ![auxiliarySurfaceFields, auxiliaryLevelFields].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 32)) throw new RangeError('Invalid normalized frame dimensions');
  const fieldsPerLevel = (verticalCoordinate === 'model-levels' ? 3 : 2) + auxiliaryLevelFields;
  const bytes = activeCells * (7 + auxiliarySurfaceFields + fieldsPerLevel * maxLevels) * CELL_BYTES;
  if (!Number.isSafeInteger(bytes)) throw new RangeError('Unsafe normalized frame bytes');
  return bytes;
}

export interface CapacityScenario {
  frames?: number;
  layers?: number;
  models?: number;
  nativeZoom?: number;
  cadenceHours?: number;
  retentionDays?: number;
}

/** Count v3/v4 single-pack storage and project coverage for an explicit scenario. */
export function estimateCapacity(mask: CoverageMask, product: ProductDefinition, storedCells: number, scenario: CapacityScenario = {}, refinement: { gridCells: number; storedCells: number } = { gridCells: 0, storedCells: 0 }) {
  const frames = scenario.frames ?? product.frameHours.length, layers = scenario.layers ?? product.layers.length;
  const models = scenario.models ?? 1, nativeZoom = scenario.nativeZoom ?? product.maxNativeZoom;
  const cadenceHours = scenario.cadenceHours ?? 12, retentionDays = scenario.retentionDays ?? RETENTION_DAYS;
  if ([frames, layers, models, nativeZoom].some(n => !Number.isSafeInteger(n)) || frames < 1 || layers < 1 || models < 1 || nativeZoom < 0 || nativeZoom > 24 || !Number.isFinite(cadenceHours) || cadenceHours <= 0 || !Number.isFinite(retentionDays) || retentionDays <= 0) throw new RangeError('Invalid capacity scenario');
  if (Object.values(refinement).some(value => !Number.isSafeInteger(value) || value < 0)) throw new RangeError('Invalid refinement capacity');
  if (mask.maxZoom > MAX_NATIVE_ZOOM) throw new Error('Coverage exceeds the admitted native zoom');
  const tilesByZoom = Array.from({ length: nativeZoom + 1 }, (_, z) => z <= mask.maxZoom
    ? expectedTiles(mask, z).length
    : expectedTiles(mask, mask.maxZoom).length * 4 ** (z - mask.maxZoom));
  const channels = frames * layers, tiles = tilesByZoom.reduce((sum, n) => sum + n, 0) * channels * models;
  const refinementChannels = frames * TERRAIN_COLUMN_METHOD.outputs.length;
  const samplePackBytes = (storedCells * channels + refinement.storedCells * refinementChannels) * CELL_BYTES;
  const retainedPerModel = Math.ceil(retentionDays * 24 / cadenceHours);
  // A two-by-two neighborhood spans at most B + 3 cell records in a (B + 1)-wide block.
  const pointRangeBytes = (SAMPLE_BLOCK_SIZE + 3) * (channels + (refinement.storedCells ? refinementChannels : 0)) * CELL_BYTES;
  const violations: string[] = [];
  if (nativeZoom > product.maxNativeZoom) violations.push('native zoom exceeds configured product target');
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

/** Prepare v3/v4 geometry/counts and reject resource growth before acquiring weather. */
export function prepareBuild<Refinement extends { mask: CoverageMask } = LoadedRefinement>(mask: CoverageMask, product: ProductDefinition, resources: FrameResources & { retainedGeometryFields?: number; frameCount?: number; terrainBytes?: number; refinements?: readonly Refinement[] }) {
  mask = coverageAtZoom(mask, product.maxNativeZoom);
  if (!Array.isArray(product.layers) || !product.layers.length || new Set(product.layers).size !== product.layers.length || product.layers.some(layer => !Object.hasOwn(LAYERS, layer))) throw new Error('Product requires unique implemented scalar layers');
  if (!Array.isArray(product.frameHours) || !product.frameHours.length || product.frameHours.some((hour, index) => !Number.isSafeInteger(hour) || (index > 0 && hour <= product.frameHours[index - 1]))) throw new Error('Product requires strictly ascending integer frame hours');
  if (!Number.isFinite(product.intervalHours) || product.intervalHours <= 0 || product.intervalHours > product.frameHours[0]) throw new Error('Product interval must be positive and not exceed its first frame');
  if (mask.maxZoom !== product.maxNativeZoom || !sameGrid(mask.grid, product.grid)) throw new Error('Coverage does not match the trusted product');
  if (mask.grid.width * mask.grid.height > BUILD_BUDGETS.gridCells) throw new Error('Grid-cell budget exceeded');
  if ((resources.refinements ?? []).reduce((sum, item) => sum + item.mask.grid.width * item.mask.grid.height, mask.grid.width * mask.grid.height) > BUILD_BUDGETS.gridCells) throw new Error('Aggregate grid-cell budget exceeded');
  if (!Number.isSafeInteger(resources.maxLevels) || resources.maxLevels < 1 || resources.maxLevels > 256) throw new Error('Invalid normalized level budget');
  const indices = coverageIndices(mask), layout = prepareSamplePackLayout(mask.grid, mask.output, mask.halo);
  if (!indices.output.length || !indices.active.length) throw new Error('Coverage must contain output and active cells before acquisition');
  if (resources.refinements?.length && (!product.layers.includes('usable-lift-msl') || !product.layers.includes('usable-lift-agl'))) throw new Error('Terrain refinement requires native MSL and AGL layers');
  let refinementMappingBytes = 0, refinementTerrainBytes = 0, refinementMaskBytes = 0;
  const refinementSize = { gridCells: 0, storedCells: 0 };
  const refinements = (resources.refinements ?? []).map(item => {
    const active = coverageIndices(item.mask), layout = prepareSamplePackLayout(item.mask.grid, item.mask.output, item.mask.halo);
    if (!active.output.length) throw new Error('Refinement coverage is empty');
    const cells = item.mask.grid.width * item.mask.grid.height;
    const columns = prepareTerrainColumns(mask, item.mask, indices.active, resources.maxLevels, { clearanceFallback: 'unsupported' });
    refinementSize.gridCells += cells;
    refinementSize.storedCells += layout.storedCells;
    refinementMappingBytes += columns.byteLength + columns.workspaceBytes;
    refinementTerrainBytes += cells * PREPARED_TERRAIN_CELL_BYTES;
    refinementMaskBytes += item.mask.output.byteLength + item.mask.halo.byteLength + item.mask.tiles.byteLength;
    return { ...item, layout, columns };
  });
  const capacity = estimateCapacity(mask, product, layout.storedCells, resources.frameCount !== undefined ? { frames: resources.frameCount } : {}, refinementSize);
  const retainedGeometryFields = resources.retainedGeometryFields ?? 0;
  if (!Number.isSafeInteger(retainedGeometryFields) || retainedGeometryFields < 0 || retainedGeometryFields > 257) throw new Error('Invalid retained geometry budget');
  const terrainBytes = resources.terrainBytes ?? 0;
  if (!Number.isSafeInteger(terrainBytes) || terrainBytes < 0 || terrainBytes > MAX_PREPARED_TERRAIN_BYTES) throw new Error('Invalid prepared terrain byte budget');
  const cells = mask.grid.width * mask.grid.height, activeCells = indices.active.length;
  const rasterWorkers = rasterWorkerCount(undefined, product.execution.workers);
  const workingSet = {
    samplePack: capacity.samplePackBytes,
    derivedFields: (cells * product.layers.length + refinementSize.gridCells * TERRAIN_COLUMN_METHOD.outputs.length) * CELL_BYTES,
    normalizedFrame: normalizedFrameBytes(activeCells, product.capabilities.verticalCoordinate, resources),
    diagnostics: refinements.length ? cells * 9 : 0,
    retainedGeometry: activeCells * retainedGeometryFields * CELL_BYTES,
    // Validation can hold encoded bytes and decoded arrays together.
    preparedTerrain: (terrainBytes + refinementTerrainBytes) * 2,
    refinementMapping: refinementMappingBytes,
    rawCompanions: activeCells * 6 * 9,
    decoderReservations: 128 * 1024 * 1024,
    rendererAndEncoder: 64 * 1024 * 1024,
    rasterSharedInputs: rasterWorkers ? (cells * product.layers.length + refinementSize.gridCells * TERRAIN_COLUMN_METHOD.outputs.length) * CELL_BYTES + mask.output.byteLength + mask.halo.byteLength + mask.tiles.byteLength + refinementMaskBytes : 0,
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

function rendererTileCount(renderer: unknown): number {
  if (!renderer || typeof renderer !== 'object' || Array.isArray(renderer)) return NaN;
  const shards = 'shards' in renderer ? renderer.shards : [renderer];
  if (!Array.isArray(shards) || !shards.length) return NaN;
  let total = 0;
  for (const shard of shards) {
    if (!shard || typeof shard !== 'object' || Array.isArray(shard)) return NaN;
    for (const kind of ['native', 'fine'] as const) {
      const surface = shard[kind];
      if (!surface || typeof surface !== 'object' || Array.isArray(surface) || !Number.isSafeInteger(surface.tiles) || surface.tiles < 0) return NaN;
      total += surface.tiles;
    }
  }
  return Number.isSafeInteger(total) ? total : NaN;
}

/** Gate recorded build metrics against the same budgets used by build admission. */
export function checkPerformance(manifest: Manifest | ManifestV5) {
  const failures: string[] = [];
  const metric = (key: string): number => {
    const value = manifest.metrics[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) { failures.push(`missing or invalid ${key}`); return NaN; }
    return value;
  };
  const elapsedMs = metric('elapsedMs'), peakRssBytes = metric('peakRssBytes');
  const counts = manifest.metrics.tiles;
  const maxZoom = manifest.version === 5 ? Math.max(...manifest.surfaces.map(surface => surface.coverage.maxZoom)) : manifest.coverage.maxZoom;
  const validCounts = Array.isArray(counts) && counts.length === maxZoom + 1 && counts.every(n => Number.isSafeInteger(n) && n >= 0);
  let tiles: number;
  if (manifest.version === 5 && manifest.metrics.renderer !== undefined) {
    tiles = rendererTileCount(manifest.metrics.renderer);
    if (!Number.isSafeInteger(tiles) || tiles < manifest.artifacts.length) failures.push('missing or invalid renderer tile counts');
    const capacity = manifest.metrics.capacity;
    if (capacity && typeof capacity === 'object' && 'tiles' in capacity &&
        (!Number.isSafeInteger(capacity.tiles) || capacity.tiles !== tiles)) failures.push('rendered tile count differs from admitted coverage');
  } else {
    // Older single-surface v5 records share one coverage mask across every archive.
    if (!validCounts || (manifest.version === 5 && manifest.surfaces.length !== 1)) failures.push('missing or invalid tile counts');
    tiles = validCounts ? counts.reduce((sum: number, count: number) => sum + count, 0) * manifest.artifacts.length : NaN;
    if (!Number.isSafeInteger(tiles)) failures.push('unsafe tile count');
  }
  if (manifest.version === 5) {
    let samplePackBytes = 0, emittedSampleBytes = 0, profileBytes = 0, gridCells = 0;
    for (const surface of manifest.surfaces) {
      if (surface.kind === 'native') gridCells += surface.grid.width * surface.grid.height;
      const shardBytes = surface.samples.storedCells * surface.samples.channelCount * CELL_BYTES;
      if (!Number.isSafeInteger(shardBytes) || !Number.isSafeInteger(surface.samples.storedCells) || !Number.isSafeInteger(surface.samples.channelCount)) failures.push('unsafe v5 sample size');
      for (const shard of surface.samples.shards) {
        const channels = 'frameCount' in shard ? shard.frameCount * surface.layers.length : surface.samples.channelCount;
        const bytes = shard.storedCells * channels * CELL_BYTES;
        if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(shard.bytes) || shard.bytes <= 0 || bytes !== shard.bytes) { failures.push('invalid v5 shard size'); continue; }
        samplePackBytes = Math.max(samplePackBytes, shard.bytes);
        emittedSampleBytes += shard.bytes;
        if (shard.bytes > MAX_V5_SHARD_BYTES) failures.push(`samplePackBytes: ${shard.bytes} exceeds ${MAX_V5_SHARD_BYTES}`);
      }
      for (const group of surface.profiles?.groups ?? []) for (const shard of group.shards) {
        const bytes = shard.storedCells * group.frameCount * surface.profiles!.recordBytes;
        if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(shard.bytes) || bytes <= 0 || bytes !== shard.bytes) { failures.push('invalid v5 profile shard size'); continue; }
        profileBytes += bytes;
        if (bytes > MAX_V5_SHARD_BYTES) failures.push(`profile shard bytes: ${bytes} exceeds ${MAX_V5_SHARD_BYTES}`);
      }
    }
    const numericBytes = emittedSampleBytes + profileBytes;
    if (!Number.isSafeInteger(numericBytes)) failures.push('unsafe v5 numeric bytes');
    const observed = { elapsedMs, peakRssBytes, tiles, samplePackBytes, emittedSampleBytes, profileBytes, numericBytes, gridCells };
    for (const key of ['gridCells', 'tiles', 'elapsedMs', 'peakRssBytes', 'numericBytes'] as const) {
      if (observed[key] > BUILD_BUDGETS[key]) failures.push(`${key}: ${observed[key]} exceeds ${BUILD_BUDGETS[key]}`);
    }
    return { version: 1, buildId: manifest.buildId, cycle: manifest.cycle, observed, budgets: { ...BUILD_BUDGETS, samplePackBytes: MAX_V5_SHARD_BYTES }, passed: failures.length === 0, failures };
  }
  const grids = forecastGrids(manifest);
  const samplePackBytes = grids.reduce((sum, grid) => sum + grid.samples.bytes, 0);
  const observed = { elapsedMs, peakRssBytes, tiles, samplePackBytes, emittedSampleBytes: samplePackBytes, profileBytes: 0, numericBytes: samplePackBytes,
    gridCells: grids.reduce((sum, grid) => sum + grid.grid.width * grid.grid.height, 0) };
  for (const key of Object.keys(BUILD_BUDGETS) as (keyof typeof BUILD_BUDGETS)[]) {
    if (observed[key] > BUILD_BUDGETS[key]) failures.push(`${key}: ${observed[key]} exceeds ${BUILD_BUDGETS[key]}`);
  }
  return { version: 1, buildId: manifest.buildId, cycle: manifest.cycle, observed, budgets: BUILD_BUDGETS, passed: failures.length === 0, failures };
}
