import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ASSET_MAX_BYTES, type TerrainStorage } from './contract.js';

class MetadataChanged extends Error {}

/** Immutable filesystem storage for local ingestion and preparation; the same commands use R2 in CI. */
export function localTerrainStorage(directory: string): TerrainStorage {
  const root = resolve(directory), etags = new Map<string, { size: number; mtime: number; ctime: number; inode: number; etag: string; computedSha256: string }>();
  function pathFor(key: string) {
    if (!/^terrain\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/.test(key) || key.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid local terrain object key');
    return join(root, key);
  }
  async function retry<T>(key: string, signal: AbortSignal | undefined, run: (fresh: boolean) => Promise<T>, onRetry?: () => void): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      if (attempt) onRetry?.();
      try { return await run(attempt > 0); }
      catch (error) {
        if (!(error instanceof MetadataChanged)) throw error;
        etags.delete(key);
        signal?.throwIfAborted();
        if (attempt >= 2) throw error;
      }
    }
  }
  async function head(key: string, signal?: AbortSignal, fresh = false) {
    const path = pathFor(key);
    try {
      const file = await open(path, 'r');
      try {
        signal?.throwIfAborted();
        const info = await file.stat();
        if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > ASSET_MAX_BYTES) throw new Error('Local terrain object exceeds file byte budget');
        const cached = etags.get(key);
        if (!fresh && cached?.size === info.size && cached.mtime === info.mtimeMs && cached.ctime === info.ctimeMs && cached.inode === info.ino) return cached;
        const hash = createHash('md5'), sha = createHash('sha256');
        for await (const chunk of file.createReadStream({ autoClose: false })) { signal?.throwIfAborted(); hash.update(chunk); sha.update(chunk); }
        const after = await file.stat();
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new MetadataChanged('Local terrain object changed during hashing');
        const entry = { size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs, inode: info.ino, etag: `"${hash.digest('hex')}"`, computedSha256: sha.digest('hex') };
        if (etags.size >= 1024) etags.delete(etags.keys().next().value!);
        etags.set(key, entry);
        return entry;
      } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  return {
    head: async (key, signal) => retry(key, signal, async fresh => { const info = await head(key, signal, fresh); return info ? { size: info.size, etag: info.etag, computedSha256: info.computedSha256 } : null; }),
    get: async (key, range, maxBytes = 32 * 1024 * 1024, signal, onRetry) => {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ASSET_MAX_BYTES) throw new Error('Invalid local terrain read budget');
      return retry(key, signal, async fresh => {
        const info = await head(key, signal, fresh);
        if (!info) return null;
        const offset = range?.offset ?? 0, length = range?.length ?? info.size;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > maxBytes || offset + length > info.size) throw new Error('Invalid or oversized local terrain read');
        const file = await open(pathFor(key), 'r'), bytes = Buffer.alloc(length);
        try {
          const before = await file.stat();
          if (before.size !== info.size || before.ino !== info.inode || before.mtimeMs !== info.mtime || before.ctimeMs !== info.ctime) throw new MetadataChanged('Local terrain object changed before reading');
          let position = 0;
          while (position < length) {
            signal?.throwIfAborted();
            const result = await file.read(bytes, position, length - position, offset + position);
            if (!result.bytesRead) throw new Error('Short local terrain read');
            position += result.bytesRead;
          }
          const after = await file.stat();
          if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new MetadataChanged('Local terrain object changed during reading');
        } finally { await file.close(); }
        return { bytes, etag: info.etag };
      }, onRetry);
    },
    put: async (key, bytes, condition) => {
      if (condition.ifNoneMatch !== '*' || condition.ifMatch !== undefined) throw new Error('Local terrain writes must be immutable creates');
      if (!bytes.length || bytes.length > ASSET_MAX_BYTES) throw new Error('Local terrain object exceeds file byte budget');
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, 'wx');
      try {
        try { await file.writeFile(bytes); await file.sync(); }
        finally { await file.close(); }
        await link(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    }
  };
}
