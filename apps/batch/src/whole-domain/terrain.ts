import type { Grid, SparseCoverage } from '@av/contracts';
import type { TerrainAsset, TerrainStorage } from '../terrain/contract.js';
import { MAX_SPARSE_TERRAIN_BYTES, prepareSparseTerrain, readSparsePreparedTerrain, type SparseTerrainRef } from '../terrain/sparse.js';
import { loadTerrainCatalog, stageSparsePreparedTerrain, loadSparsePreparedTerrain } from '../terrain/staging.js';
import { BUILD_BUDGETS } from '../capacity.js';

export interface WholeDomainTerrainOptions { catalogRef: TerrainAsset; storage: TerrainStorage }
export interface WholeDomainTerrainInput { ref: SparseTerrainRef; grid: Grid; coverage: SparseCoverage; coverageDescriptor: Uint8Array }
export interface PrepareWholeDomainTerrainInput { grid: Grid; coverage: SparseCoverage; coverageDescriptor: Uint8Array; out: string; signal?: AbortSignal }

export async function prepareWholeDomainTerrain(options: WholeDomainTerrainOptions & PrepareWholeDomainTerrainInput): Promise<SparseTerrainRef> {
  const deadline = AbortSignal.timeout(BUILD_BUDGETS.elapsedMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const catalog = await loadTerrainCatalog(options.catalogRef, options.storage, signal);
  const ref = await prepareSparseTerrain({ catalog, storage: options.storage, grid: options.grid, coverage: options.coverage,
    coverageDescriptor: options.coverageDescriptor, signal, limits: { maxArrayBytes: Math.min(MAX_SPARSE_TERRAIN_BYTES, BUILD_BUDGETS.peakRssBytes), maxDurationMs: BUILD_BUDGETS.elapsedMs },
    onReport: report => console.error(JSON.stringify({ phase: 'terrain-preparation', ...report })) });
  await stageSparsePreparedTerrain({ ref, storage: options.storage, out: options.out, grid: options.grid,
    coverage: options.coverage, coverageDescriptor: options.coverageDescriptor, signal });
  return ref;
}

export function loadWholeDomainTerrain(input: WholeDomainTerrainInput & { out: string; signal?: AbortSignal }) {
  return loadSparsePreparedTerrain({ ref: input.ref, out: input.out, grid: input.grid, coverage: input.coverage,
    coverageDescriptor: input.coverageDescriptor, signal: input.signal });
}

export { readSparsePreparedTerrain };
