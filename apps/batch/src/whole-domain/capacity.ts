import { CELL_BYTES, coverageAtZoom, LAYERS, layerSurface, MAX_TILE_BYTES, RASTER_TILE_SIZE, renderedLayers, TERRAIN_COLUMN_METHOD, type CoverageMask, type ProductDefinition, type SparseCoverageMask, type WholeDomainGrid } from '@av/contracts';
import { prepareShardedSamplePackLayout, profileRecordBytes, type ShardedSamplePackLayout } from '@av/forecast';
import type { PreparedPackedTerrainColumns } from '@av/forecast/refinement';
import { BUILD_BUDGETS, MAX_V5_SHARD_BYTES, normalizedFrameBytes } from '../capacity.js';
import { rasterWorkerCount, RASTER_WORKER_RESERVE_BYTES } from '../raster-pool.js';
import { ASSET_MAX_BYTES } from '../terrain/contract.js';
import { samplePackWriterBufferBytes } from '../sample-pack-v5.js';

export const MAX_PACKED_COLUMN_BYTES = 512 * 1024 * 1024;

export interface WholeDomainCapacityInput {
  product: ProductDefinition;
  plan: WholeDomainGrid;
  nativeBlocks: Uint32Array;
  nativeActive: number;
  nativeMask: Pick<CoverageMask, 'tiles' | 'maxZoom'>;
  maxLevels?: number;
  retainedGeometryFields?: number;
  auxiliarySurfaceFields?: number;
  auxiliaryLevelFields?: number;
  groupFrames?: number;
  fine: SparseCoverageMask;
  nativeMaskBytes: number;
  frames: number;
  mapFrames?: number;
  nativeLayers: number;
  fineLayers: number;
  columns: Pick<PreparedPackedTerrainColumns, 'byteLength' | 'workspaceBufferBytes' | 'workspaceObjectBudgetBytes' | 'outputBufferBytes'>;
  terrainBytes: number;
}

export function wholeDomainSampleLayouts(input: Omit<WholeDomainCapacityInput, 'nativeMask'>): { native: ShardedSamplePackLayout | null; fine: ShardedSamplePackLayout | null } {
  const frames = input.groupFrames ?? input.frames;
  const fineFrames = Math.min(input.mapFrames ?? input.frames, frames);
  const fine = fineFrames ? prepareShardedSamplePackLayout(input.plan.fine, input.fine.coverage.blockIds, fineFrames * input.fineLayers, MAX_V5_SHARD_BYTES) : null;
  const native = input.nativeLayers ? prepareShardedSamplePackLayout(input.plan.native, input.nativeBlocks, frames * input.nativeLayers, MAX_V5_SHARD_BYTES) : null;
  return { native, fine };
}

export interface WholeDomainCapacity {
  frames: number; mapFrames: number; nativeLayers: number; fineLayers: number; tiles: number;
  nativeStoredCells: number; fineStoredCells: number; nativeSampleBytes: number; fineSampleBytes: number; profileBytes: number; numericBytes: number;
  rasterWorkers: number; deriveWorkers: number; prefetchFrameCount: 0 | 1; deriveFrameCopyBytes: number; rasterSharedInputBytes: number; workingSet: Record<string, number>; estimatedPeakBytes: number; violations: string[];
}

function coveredTiles(mask: Pick<CoverageMask, 'tiles' | 'maxZoom'>): number {
  const bits = (4 ** (mask.maxZoom + 1) - 1) / 3;
  let count = 0;
  for (let i = 0; i < bits; i++) count += (mask.tiles[i >> 3]! >> (i & 7)) & 1;
  return count;
}

export function admitWholeDomain(input: WholeDomainCapacityInput): WholeDomainCapacity {
  const { columns, fine, frames, nativeActive, nativeLayers, fineLayers, terrainBytes, nativeMaskBytes } = input;
  const mapFrames = input.mapFrames ?? frames;
  if (!Number.isSafeInteger(frames) || frames < 1 || !Number.isSafeInteger(mapFrames) || mapFrames < 0 || mapFrames > frames) throw new Error('Invalid frame capacity');
  const maxLevels = input.maxLevels ?? 256, retainedGeometryFields = input.retainedGeometryFields ?? 257;
  if (!Number.isSafeInteger(maxLevels) || maxLevels < 1 || maxLevels > 256 || !Number.isSafeInteger(retainedGeometryFields) || retainedGeometryFields < 0 || retainedGeometryFields > 257) throw new Error('Invalid provider capacity');
  const fineActive = fine.coverage.offsets[fine.coverage.blockIds.length]!;
  const layouts = wholeDomainSampleLayouts(input);
  const nativeSampleBytes = (layouts.native?.storedCells ?? 0) * frames * nativeLayers * CELL_BYTES, fineSampleBytes = (layouts.fine?.storedCells ?? 0) * mapFrames * fineLayers * CELL_BYTES;
  const nativeSampleOnly = input.product.layers.filter(layer => layerSurface(layer) === 'native' && LAYERS[layer].delivery === 'samples-only').length;
  const renderedNativeLayers = nativeLayers - nativeSampleOnly;
  const tiles = mapFrames * (renderedNativeLayers * coveredTiles(coverageAtZoom(input.nativeMask, input.product.maxNativeZoom)) +
    fineLayers * coveredTiles(coverageAtZoom(fine, input.product.maxNativeZoom)));
  if (fineActive < 1 || fine.coverage.blockIds.length < 1) throw new Error('Fine coverage has no sample blocks');
  const nativeCells = input.plan.native.width * input.plan.native.height;
  const nativeFields = nativeCells * (mapFrames ? renderedLayers(input.product.layers).length : renderedNativeLayers) * CELL_BYTES;
  const fineFields = mapFrames ? fineActive * TERRAIN_COLUMN_METHOD.outputs.length * CELL_BYTES : 0;
  const coverageBytes = (mask: SparseCoverageMask) => mask.tiles.byteLength + mask.coverage.blockIds.byteLength + mask.coverage.offsets.byteLength + mask.coverage.output.byteLength + mask.coverage.halo.byteLength;
  const fineMaskBytes = coverageBytes(fine);
  const sharedInputBytes = Math.max(nativeCells * renderedNativeLayers * CELL_BYTES + nativeMaskBytes, fineActive * fineLayers * CELL_BYTES + fineMaskBytes);
  const profileLayout = nativeSampleOnly ? prepareShardedSamplePackLayout(input.plan.native, input.nativeBlocks, input.groupFrames ?? frames, MAX_V5_SHARD_BYTES, profileRecordBytes(maxLevels)) : null;
  const profileBytes = (profileLayout?.storedCells ?? 0) * frames * profileRecordBytes(maxLevels);
  const numericBytes = nativeSampleBytes + fineSampleBytes + profileBytes;
  const shards = [...(layouts.native?.shards ?? []), ...(layouts.fine?.shards ?? []), ...(profileLayout?.shards ?? [])];
  const largestShard = shards.reduce((max, shard) => Math.max(max, shard.byteLength), 0);
  const largestShardBlocks = shards.reduce((max, shard) => Math.max(max, shard.blockCount), 0);
  const auxiliarySurface = input.auxiliarySurfaceFields ?? 0, auxiliaryLevels = input.auxiliaryLevelFields ?? 0;
  if (![auxiliarySurface, auxiliaryLevels].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 32)) throw new RangeError('Invalid auxiliary field capacity');
  const nativeFrame = normalizedFrameBytes(nativeActive, input.product.capabilities.verticalCoordinate, { maxLevels, auxiliarySurfaceFields: auxiliarySurface, auxiliaryLevelFields: auxiliaryLevels });
  const workingSet = {
    nativeFrame,
    prefetchFrame: nativeFrame,
    nativeFields,
    packedNativeFields: nativeActive * nativeSampleOnly * CELL_BYTES,
    profiles: nativeSampleOnly ? nativeCells * 4 + profileRecordBytes(maxLevels) : 0,
    diagnostics: mapFrames ? nativeCells * 9 : 0,
    retainedGeometry: nativeActive * retainedGeometryFields * CELL_BYTES,
    rawCompanions: nativeActive * 6 * 9,
    terrain: mapFrames ? terrainBytes : 0,
    terrainValidation: mapFrames ? Math.min(terrainBytes, ASSET_MAX_BYTES * 1.25) : 0,
    columns: columns.byteLength + (mapFrames ? columns.workspaceBufferBytes + columns.workspaceObjectBudgetBytes + columns.outputBufferBytes : 0),
    coverage: fineMaskBytes + nativeMaskBytes + input.nativeBlocks.length * 72 + 4 + 2 * Math.ceil(nativeCells / 8),
    indices: nativeActive * 4 + nativeCells * 4,
    layouts: (layouts.native?.indexBytes ?? 0) + (layouts.fine?.indexBytes ?? 0) + (profileLayout?.indexBytes ?? 0),
    rasterInline: mapFrames ? 2 * 24 * 1024 * 1024 + 8 * (RASTER_TILE_SIZE * RASTER_TILE_SIZE * 4 + MAX_TILE_BYTES) : 0,
    rasterSharedInputs: 0,
    rasterWorkerRuntimes: 0,
    deriveWorkerRuntimes: 0,
    deriveWorkerColumns: 0,
    deriveSharedInputs: 0,
    shardAssembly: largestShard + largestShardBlocks * 64,
    packBuffers: [layouts.native, layouts.fine, profileLayout].reduce((bytes, layout) => bytes + (layout ? samplePackWriterBufferBytes(layout) : 0), 0),
    archivesAndValidation: largestShard + 64 * 1024 * 1024,
    runtimeAndNativeReserve: 256 * 1024 * 1024
  };
  let inlinePeakBytes = Object.values(workingSet).reduce((sum, bytes) => sum + bytes, 0);
  let prefetchFrameCount: 0 | 1 = 1;
  if (inlinePeakBytes > BUILD_BUDGETS.peakRssBytes) {
    prefetchFrameCount = 0;
    inlinePeakBytes -= workingSet.prefetchFrame;
    workingSet.prefetchFrame = 0;
  }
  const maximumWorkers = mapFrames ? rasterWorkerCount(undefined, input.product.execution.workers) : 0;
  let rasterWorkers = 0, deriveWorkers = 0, selectedTotal = -1, selectedImbalance = Number.POSITIVE_INFINITY;
  const deriveJobCopyBytes = nativeActive * Uint32Array.BYTES_PER_ELEMENT + nativeCells * (2 * Float32Array.BYTES_PER_ELEMENT + 2 * Uint8Array.BYTES_PER_ELEMENT);
  const deriveSharedInputs = terrainBytes + fine.coverage.blockIds.byteLength + fine.coverage.offsets.byteLength + fine.coverage.output.byteLength + fine.coverage.halo.byteLength
    + nativeActive * Uint32Array.BYTES_PER_ELEMENT + deriveJobCopyBytes;
  const workerColumns = columns.byteLength + columns.workspaceBufferBytes + columns.workspaceObjectBudgetBytes;
  for (let raster = 0; raster <= maximumWorkers; raster++) for (let derive = 0; derive <= maximumWorkers; derive++) {
    const peak = inlinePeakBytes + (raster ? sharedInputBytes + raster * RASTER_WORKER_RESERVE_BYTES - workingSet.rasterInline : 0) +
      (derive ? deriveSharedInputs + derive * (RASTER_WORKER_RESERVE_BYTES + workerColumns) : 0);
    const total = raster + derive, imbalance = Math.abs(raster - derive);
    if (peak > BUILD_BUDGETS.peakRssBytes || total < selectedTotal || (total === selectedTotal &&
        (imbalance > selectedImbalance || (imbalance === selectedImbalance && raster <= rasterWorkers)))) continue;
    rasterWorkers = raster; deriveWorkers = derive; selectedTotal = total; selectedImbalance = imbalance;
  }
  if (rasterWorkers) workingSet.rasterInline = 0;
  workingSet.rasterSharedInputs = rasterWorkers ? sharedInputBytes : 0;
  workingSet.rasterWorkerRuntimes = rasterWorkers * RASTER_WORKER_RESERVE_BYTES;
  workingSet.deriveSharedInputs = deriveWorkers ? deriveSharedInputs : 0;
  workingSet.deriveWorkerColumns = deriveWorkers * workerColumns;
  workingSet.deriveWorkerRuntimes = deriveWorkers * RASTER_WORKER_RESERVE_BYTES;
  const estimatedPeakBytes = Object.values(workingSet).reduce((sum, bytes) => sum + bytes, 0);
  const violations: string[] = [];
  if (!Number.isSafeInteger(tiles) || tiles > BUILD_BUDGETS.tiles) violations.push('tile budget exceeded');
  if (!Number.isSafeInteger(numericBytes) || numericBytes > BUILD_BUDGETS.numericBytes) violations.push('aggregate scalar and profile bytes exceed the build budget');
  if (estimatedPeakBytes > BUILD_BUDGETS.peakRssBytes) violations.push('whole-domain working set exceeds the 2 GiB process budget');
  if (fineFields > 512 * 1024 * 1024) violations.push('live fine packed fields exceed the inline budget');
  return { frames, mapFrames, nativeLayers, fineLayers, tiles, nativeStoredCells: layouts.native?.storedCells ?? 0, fineStoredCells: layouts.fine?.storedCells ?? 0,
    nativeSampleBytes, fineSampleBytes, profileBytes, numericBytes, rasterWorkers, deriveWorkers, prefetchFrameCount,
    deriveFrameCopyBytes: deriveWorkers ? deriveJobCopyBytes + Math.max(0, BUILD_BUDGETS.peakRssBytes - estimatedPeakBytes) : 0,
    rasterSharedInputBytes: sharedInputBytes, workingSet, estimatedPeakBytes, violations };
}
