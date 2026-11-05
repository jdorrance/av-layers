import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Grid, SparseCoverage } from '@av/contracts';
import { readLocalFile } from '../local-file.js';
import type { ObjectStorage } from '../storage.js';
import { localPath } from '../validate.js';
import { readPreparedTerrain, type PreparedTerrainRef } from './prepare.js';
import { CATALOG_MAX_BYTES, parseJson, sha256, terrainAssetSchema, terrainCatalogSchema, type TerrainAsset } from './contract.js';
import { readSparsePreparedTerrain, validateSparsePreparedTerrain, type SparseTerrainRef } from './sparse.js';

interface LocalTerrainOptions { ref: PreparedTerrainRef; out: string; grid: Grid; signal?: AbortSignal }

/** Resolve one pinned catalog before preparation; forecast workers load only prepared files. */
export async function loadTerrainCatalog(refInput: TerrainAsset, storage: Pick<ObjectStorage, 'get'>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const ref = terrainAssetSchema.parse(refInput);
  if (ref.bytes > CATALOG_MAX_BYTES || ref.key !== `terrain/catalogs/${ref.sha256}.json`) throw new Error('Invalid terrain catalog reference');
  const result = await storage.get(ref.key, undefined, ref.bytes, signal);
  signal?.throwIfAborted();
  if (!result || result.bytes.byteLength !== ref.bytes || sha256(result.bytes) !== ref.sha256) throw new Error(`Terrain catalog missing or corrupt: ${ref.key}`);
  return parseJson(result.bytes, terrainCatalogSchema, CATALOG_MAX_BYTES);
}

/** Validate the pinned descriptor and arrays once per local forecast session. */
export function loadPreparedTerrain({ ref, out, grid, signal }: LocalTerrainOptions) {
  return readPreparedTerrain(ref, asset => readLocalFile(localPath(out, asset.key), asset.bytes, asset.bytes), grid, signal);
}

/** Copy a complete verified remote preparation into the existing build-plan artifact. */
export async function stagePreparedTerrain({ ref, storage, out, grid, signal }: LocalTerrainOptions & { storage: Pick<ObjectStorage, 'get'> }): Promise<void> {
  const files = new Map<string, Uint8Array>();
  await readPreparedTerrain(ref, async asset => {
    const result = await storage.get(asset.key, undefined, asset.bytes, signal);
    if (!result) throw new Error(`Prepared terrain asset missing: ${asset.key}`);
    files.set(asset.key, result.bytes);
    return result.bytes;
  }, grid, signal);
  // The descriptor is installed last; an interrupted staging directory is never complete.
  const manifest = files.get(ref.key)!;
  files.delete(ref.key);
  files.set(ref.key, manifest);
  for (const [key, bytes] of files) {
    signal?.throwIfAborted();
    const path = localPath(out, key), temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      signal?.throwIfAborted();
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
}

export async function loadSparsePreparedTerrain({ ref, out, grid, coverage, coverageDescriptor, signal, collect = true }: { ref: SparseTerrainRef; out: string; grid: Grid; coverage: SparseCoverage; coverageDescriptor: Uint8Array; signal?: AbortSignal; collect?: boolean }) {
  if (collect) return readSparsePreparedTerrain(ref, asset => readLocalFile(localPath(out, asset.key), asset.bytes, asset.bytes), grid, coverage, coverageDescriptor, signal);
  const validated = await validateSparsePreparedTerrain(ref, asset => readLocalFile(localPath(out, asset.key), asset.bytes, asset.bytes), grid, coverage, coverageDescriptor, signal, false);
  return { descriptor: validated.descriptor, elevationM: new Float32Array(0), valid: new Uint8Array(0) };
}

export async function stageSparsePreparedTerrain({ ref, storage, out, grid, coverage, coverageDescriptor, signal }: { ref: SparseTerrainRef; storage: Pick<ObjectStorage, 'get'>; out: string; grid: Grid; coverage: SparseCoverage; coverageDescriptor: Uint8Array; signal?: AbortSignal }): Promise<void> {
  const pending: Array<{ key: string; path: string; temporary: string }> = [];
  try {
    await validateSparsePreparedTerrain(ref, async asset => {
      const result = await storage.get(asset.key, undefined, asset.bytes, signal);
      if (!result) throw new Error(`Sparse terrain asset missing: ${asset.key}`);
      const path = localPath(out, asset.key), temporary = `${path}.${randomUUID()}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      pending.push({ key: asset.key, path, temporary });
      await writeFile(temporary, result.bytes, { flag: 'wx' });
      return result.bytes;
    }, grid, coverage, coverageDescriptor, signal);
    pending.sort((a, b) => Number(a.key === ref.key) - Number(b.key === ref.key));
    for (const item of pending) { signal?.throwIfAborted(); await rename(item.temporary, item.path); }
  } finally { await Promise.all(pending.map(item => rm(item.temporary, { force: true }))); }
}
