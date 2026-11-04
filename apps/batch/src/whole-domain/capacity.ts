import { CELL_BYTES, MAX_SAMPLE_VALUES, MAX_TILE_BYTES, RASTER_TILE_SIZE, TERRAIN_COLUMN_METHOD, type ProductDefinition, type SparseCoverageMask, type WholeDomainGrid } from '@av/contracts';
import { prepareShardedSamplePackLayout, type ShardedSamplePackLayout } from '@av/forecast';
import type { PreparedPackedTerrainColumns } from '@av/forecast/refinement';
import { BUILD_BUDGETS, MAX_V5_SHARD_BYTES } from '../capacity.js';
import { rasterWorkerCount, RASTER_WORKER_RESERVE_BYTES } from '../raster-pool.js';
import { ASSET_MAX_BYTES } from '../terrain/contract.js';

export const MAX_PACKED_COLUMN_BYTES = 512 * 1024 * 1024;

export interface WholeDomainCapacityInput {
  product: ProductDefinition;
  plan: WholeDomainGrid;
  nativeBlocks: Uint32Array;
  nativeActive: number;
  maxLevels?: number;
  retainedGeometryFields?: number;
  fine: SparseCoverageMask;
  nativeMaskBytes: number;
  frames: number;
  nativeLayers: number;
  fineLayers: number;
  columns: Pick<PreparedPackedTerrainColumns, 'byteLength' | 'workspaceBufferBytes' | 'workspaceObjectBudgetBytes' | 'outputBufferBytes'>;
  terrainBytes: number;
}

export function wholeDomainSampleLayouts(input: WholeDomainCapacityInput): { native: ShardedSamplePackLayout | null; fine: ShardedSamplePackLayout } {
  const fine = prepareShardedSamplePackLayout(input.plan.fine, input.fine.coverage.blockIds, input.frames * input.fineLayers, MAX_V5_SHARD_BYTES);
  const native = input.nativeLayers ? prepareShardedSamplePackLayout(input.plan.native, input.nativeBlocks, input.frames * input.nativeLayers, MAX_V5_SHARD_BYTES) : null;
  return { native, fine };
}

export interface WholeDomainCapacity {
  frames: number; nativeLayers: number; fineLayers: number;
  nativeStoredCells: number; fineStoredCells: number; nativeSampleBytes: number; fineSampleBytes: number;
  rasterWorkers: number; deriveWorkers: number; deriveFrameCopyBytes: number; rasterSharedInputBytes: number; workingSet: Record<string, number>; estimatedPeakBytes: number; violations: string[];
}

export function admitWholeDomain(input: WholeDomainCapacityInput): WholeDomainCapacity {
  const { columns, fine, frames, nativeActive, nativeLayers, fineLayers, terrainBytes, nativeMaskBytes } = input;
  const maxLevels = input.maxLevels ?? 256, retainedGeometryFields = input.retainedGeometryFields ?? 257;
  if (!Number.isSafeInteger(maxLevels) || maxLevels < 1 || maxLevels > 256 || !Number.isSafeInteger(retainedGeometryFields) || retainedGeometryFields < 0 || retainedGeometryFields > 257) throw new Error('Invalid provider capacity');
  const fineActive = fine.coverage.offsets[fine.coverage.blockIds.length]!;
  const layouts = wholeDomainSampleLayouts(input);
  const nativeSampleBytes = layouts.native?.byteLength ?? 0, fineSampleBytes = layouts.fine.byteLength;
  if (frames * Math.max(nativeLayers, fineLayers) > MAX_SAMPLE_VALUES) throw new Error('Sample value budget exceeded');
  if (layouts.fine.storedCells < 1 || layouts.fine.blockCount < 1) throw new Error('Fine coverage has no sample blocks');
  const nativeCells = input.plan.native.width * input.plan.native.height;
  const nativeFields = nativeCells * input.product.layers.length * CELL_BYTES;
  const fineFields = fineActive * TERRAIN_COLUMN_METHOD.outputs.length * CELL_BYTES;
  const coverageBytes = (mask: SparseCoverageMask) => mask.tiles.byteLength + mask.coverage.blockIds.byteLength + mask.coverage.offsets.byteLength + mask.coverage.output.byteLength + mask.coverage.halo.byteLength;
  const fineMaskBytes = coverageBytes(fine);
  const sharedInputBytes = Math.max(nativeCells * nativeLayers * CELL_BYTES + nativeMaskBytes, fineActive * fineLayers * CELL_BYTES + fineMaskBytes);
  const shards = [...(layouts.native?.shards ?? []), ...layouts.fine.shards];
  const largestShard = shards.reduce((max, shard) => Math.max(max, shard.byteLength), 0);
  const largestShardBlocks = shards.reduce((max, shard) => Math.max(max, shard.blockCount), 0);
  const workingSet = {
    nativeFrame: nativeActive * (7 + (input.product.capabilities.verticalCoordinate === 'model-levels' ? 3 : 2) * maxLevels) * CELL_BYTES,
    prefetchFrame: nativeActive * (7 + (input.product.capabilities.verticalCoordinate === 'model-levels' ? 3 : 2) * maxLevels) * CELL_BYTES,
    nativeFields,
    diagnostics: nativeCells * 9,
    retainedGeometry: nativeActive * retainedGeometryFields * CELL_BYTES,
    rawCompanions: nativeActive * 6 * 9,
    terrain: terrainBytes,
    terrainValidation: Math.min(terrainBytes, ASSET_MAX_BYTES * 1.25),
    columns: columns.byteLength + columns.workspaceBufferBytes + columns.workspaceObjectBudgetBytes + columns.outputBufferBytes,
    coverage: fineMaskBytes + nativeMaskBytes + input.nativeBlocks.length * 72 + 4 + 2 * Math.ceil(nativeCells / 8),
    indices: nativeActive * 4 + nativeCells * 4,
    layouts: (layouts.native?.indexBytes ?? 0) + layouts.fine.indexBytes,
    rasterInline: 2 * 24 * 1024 * 1024 + 8 * (RASTER_TILE_SIZE * RASTER_TILE_SIZE * 4 + MAX_TILE_BYTES),
    rasterSharedInputs: 0,
    rasterWorkerRuntimes: 0,
    deriveWorkerRuntimes: 0,
    deriveWorkerColumns: 0,
    deriveSharedInputs: 0,
    shardAssembly: largestShard + 1024 * 1024 + largestShardBlocks * 64,
    archivesAndValidation: largestShard + 64 * 1024 * 1024,
    runtimeAndNativeReserve: 256 * 1024 * 1024
  };
  const inlinePeakBytes = Object.values(workingSet).reduce((sum, bytes) => sum + bytes, 0);
  let rasterWorkers = rasterWorkerCount(), deriveWorkers = rasterWorkerCount();
  const deriveSharedInputs = terrainBytes + nativeCells * 10 + fineMaskBytes + nativeActive * 4;
  const workerWorkspace = columns.workspaceBufferBytes - nativeActive * (maxLevels * 16 + 45) + Math.min(4, nativeActive) * (maxLevels * 16 + 45);
  const workerColumns = columns.byteLength + workerWorkspace + columns.workspaceObjectBudgetBytes + 32;
  const peak = () => inlinePeakBytes + (rasterWorkers ? sharedInputBytes + rasterWorkers * RASTER_WORKER_RESERVE_BYTES : 0) +
    (deriveWorkers ? deriveSharedInputs + deriveWorkers * (RASTER_WORKER_RESERVE_BYTES + workerColumns) : 0);
  while (peak() > BUILD_BUDGETS.peakRssBytes && (deriveWorkers || rasterWorkers)) {
    if (rasterWorkers > 1) rasterWorkers--;
    else if (deriveWorkers > 1) deriveWorkers--;
    else if (rasterWorkers) rasterWorkers--;
    else deriveWorkers--;
  }
  workingSet.rasterSharedInputs = rasterWorkers ? sharedInputBytes : 0;
  workingSet.rasterWorkerRuntimes = rasterWorkers * RASTER_WORKER_RESERVE_BYTES;
  workingSet.deriveSharedInputs = deriveWorkers ? deriveSharedInputs : 0;
  workingSet.deriveWorkerColumns = deriveWorkers * workerColumns;
  workingSet.deriveWorkerRuntimes = deriveWorkers * RASTER_WORKER_RESERVE_BYTES;
  const estimatedPeakBytes = Object.values(workingSet).reduce((sum, bytes) => sum + bytes, 0);
  const violations: string[] = [];
  if (estimatedPeakBytes > BUILD_BUDGETS.peakRssBytes) violations.push('whole-domain working set exceeds the 2 GiB process budget');
  if (fineFields > 512 * 1024 * 1024) violations.push('live fine packed fields exceed the inline budget');
  return { frames, nativeLayers, fineLayers, nativeStoredCells: layouts.native?.storedCells ?? 0, fineStoredCells: layouts.fine.storedCells,
    nativeSampleBytes, fineSampleBytes, rasterWorkers, deriveWorkers, deriveFrameCopyBytes: Math.max(0, BUILD_BUDGETS.peakRssBytes - estimatedPeakBytes), rasterSharedInputBytes: sharedInputBytes, workingSet, estimatedPeakBytes, violations };
}
