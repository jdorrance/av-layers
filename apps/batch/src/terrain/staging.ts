import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Grid } from '@av/contracts';
import { readLocalFile } from '../local-file.js';
import type { ObjectStorage } from '../storage.js';
import { localPath } from '../validate.js';
import { readPreparedTerrain, type PreparedTerrainRef } from './prepare.js';

interface LocalTerrainOptions { ref: PreparedTerrainRef; out: string; grid: Grid; signal?: AbortSignal }

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
