import type { Grid, SparseCoverage } from '@av/contracts';
import type { TerrainAsset, TerrainStorage } from '../terrain/contract.js';
import { MAX_SPARSE_TERRAIN_BYTES, prepareSparseTerrain, type SparseTerrainOptions, type SparseTerrainRef } from '../terrain/sparse.js';
import { loadTerrainCatalog, stageSparsePreparedTerrain, loadSparsePreparedTerrain } from '../terrain/staging.js';
import { openTerrainSourceCache } from '../terrain/source-cache.js';

const TERRAIN_PREPARATION_MS = 90 * 60_000;
const SOURCE_CACHE_BYTES = 2 * 1024 ** 3;

export interface WholeDomainTerrainOptions { catalogRef: TerrainAsset; storage: TerrainStorage; cacheOnly?: boolean; sourceCacheDir?: string; reuseFrom?: SparseTerrainOptions['reuseFrom'] }
export interface WholeDomainTerrainInput { ref: SparseTerrainRef; grid: Grid; coverage: SparseCoverage; coverageDescriptor: Uint8Array }
export interface PrepareWholeDomainTerrainInput { grid: Grid; coverage: SparseCoverage; coverageDescriptor: Uint8Array; out: string; signal?: AbortSignal }

/** Prepare or verify the reusable R2 terrain independently of a forecast cycle. */
export async function ensureWholeDomainTerrain(options: WholeDomainTerrainOptions & Omit<PrepareWholeDomainTerrainInput, 'out'>): Promise<SparseTerrainRef> {
  const deadline = AbortSignal.timeout(TERRAIN_PREPARATION_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  console.error(JSON.stringify({ phase: 'terrain-preparation', stage: 'catalog' }));
  const catalog = await loadTerrainCatalog(options.catalogRef, options.storage, signal);
  const sourceCache = options.sourceCacheDir && !options.cacheOnly
    ? await openTerrainSourceCache({ storage: options.storage, catalog, directory: options.sourceCacheDir, maxBytes: SOURCE_CACHE_BYTES, signal })
    : undefined;
  try {
    return await prepareSparseTerrain({ catalog, storage: sourceCache?.storage ?? options.storage, grid: options.grid, coverage: options.coverage,
      coverageDescriptor: options.coverageDescriptor, signal, limits: { maxArrayBytes: MAX_SPARSE_TERRAIN_BYTES, maxDurationMs: TERRAIN_PREPARATION_MS },
      cacheOnly: options.cacheOnly, checkpoints: true, reuseFrom: options.reuseFrom,
      ...(sourceCache ? { prefetchSources: (keys: readonly string[]) => sourceCache.prefetch(keys, signal) } : {}),
      onProgress: ({ phase: stage, ...progress }) => console.error(JSON.stringify({ phase: 'terrain-preparation', stage, ...progress })),
      onReport: report => console.error(JSON.stringify({ phase: 'terrain-preparation', ...report })) });
  } finally {
    if (sourceCache) {
      await sourceCache.close();
      console.error(JSON.stringify({ phase: 'terrain-source-cache', ...sourceCache.stats() }));
    }
  }
}

export async function prepareWholeDomainTerrain(options: WholeDomainTerrainOptions & PrepareWholeDomainTerrainInput): Promise<SparseTerrainRef> {
  const deadline = AbortSignal.timeout(TERRAIN_PREPARATION_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const ref = await ensureWholeDomainTerrain({ ...options, signal });
  console.error(JSON.stringify({ phase: 'terrain-preparation', stage: 'staging', key: ref.key }));
  await stageSparsePreparedTerrain({ ref, storage: options.storage, out: options.out, grid: options.grid,
    coverage: options.coverage, coverageDescriptor: options.coverageDescriptor, signal });
  return ref;
}

export function loadWholeDomainTerrain(input: WholeDomainTerrainInput & { out: string; signal?: AbortSignal; collect?: boolean }) {
  return loadSparsePreparedTerrain({ ref: input.ref, out: input.out, grid: input.grid, coverage: input.coverage,
    coverageDescriptor: input.coverageDescriptor, signal: input.signal, collect: input.collect });
}
