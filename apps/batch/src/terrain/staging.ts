import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Grid } from '@av/contracts';
import { readLocalFile } from '../local-file.js';
import type { ObjectStorage } from '../storage.js';
import { localPath } from '../validate.js';
import { readPreparedTerrain, type PreparedTerrainRef } from './prepare.js';
import { CATALOG_MAX_BYTES, parseJson, sha256, terrainAssetSchema, terrainCatalogSchema, type TerrainAsset } from './contract.js';

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
