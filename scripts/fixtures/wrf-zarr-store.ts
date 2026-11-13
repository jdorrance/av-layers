import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { ForecastSourceStore } from '../../apps/batch/src/provider.js';
import ready from './wrf-zarr/_ready.json' with { type: 'json' };

/** Serve the producer-encoded fixture at its canonical private-source keys. */
export function createWrfFixtureStore(): ForecastSourceStore {
  const directory = fileURLToPath(new URL('./wrf-zarr/', import.meta.url));
  const prefix = `upstream/${ready.model_id}/${ready.cycle_partition}/`;
  const latest = Buffer.from(JSON.stringify({ model_id: ready.model_id, cycle_partition: ready.cycle_partition,
    publish_origin_utc: ready.publish_origin_utc, ready_key: `${prefix}_ready.json` }));
  const read = async (key: string): Promise<Buffer | null> => {
    if (key === `upstream/${ready.model_id}/latest.json`) return latest;
    if (!key.startsWith(prefix) || !/^(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/.test(key) || key.split('/').some(part => part === '.' || part === '..')) {
      throw new Error(`Unexpected WRF fixture key: ${key}`);
    }
    try { return await readFile(join(directory, key.slice(prefix.length))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  return {
    async get(key, range, maximum, signal) {
      signal?.throwIfAborted();
      if (range || !maximum) throw new Error('Fixture requires bounded whole-object reads');
      const bytes = await read(key);
      signal?.throwIfAborted();
      if (!bytes) return null;
      if (bytes.length > maximum) throw new Error('WRF fixture read exceeds byte budget');
      return { bytes, etag: `"${hash(bytes)}"` };
    },
    async head(key, signal) {
      signal?.throwIfAborted();
      const bytes = await read(key);
      return bytes ? { size: bytes.length, etag: `"${hash(bytes)}"`, computedSha256: hash(bytes) } : null;
    }
  };
}
