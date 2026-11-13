import { stat } from 'node:fs/promises';
import { localPath, readLocalFile } from './local-file.js';
import type { ForecastSourceStore } from './provider.js';
import { isPrivateUpstreamKey, privateUpstreamPrefix } from './source.js';

/** Read a producer's local store using the same model-scoped keys as private R2. */
export function localForecastSource(directory: string, model: string): ForecastSourceStore {
  const pathFor = (key: string): string => {
    if (!isPrivateUpstreamKey(key, privateUpstreamPrefix(model))) throw new Error('Invalid local forecast source key');
    return localPath(directory, key);
  };
  return {
    async head(key, signal) {
      signal?.throwIfAborted();
      try {
        const info = await stat(pathFor(key));
        if (!info.isFile()) throw new Error('Forecast source must be a file');
        return { size: info.size, etag: `"${info.ino}-${info.size}-${info.mtimeMs}"` };
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
    async get(key, range, maximum, signal) {
      signal?.throwIfAborted();
      if (range || maximum === undefined) throw new Error('Local forecast source requires bounded whole-object reads');
      try {
        const bytes = await readLocalFile(pathFor(key), maximum);
        signal?.throwIfAborted();
        return { bytes, etag: '' };
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    }
  };
}
