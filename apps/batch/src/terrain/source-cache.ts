import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ASSET_MAX_BYTES, sha256, terrainAssetSchema, type TerrainAsset, type TerrainCatalog, type TerrainStorage } from './contract.js';
import { localTerrainStorage } from './local-store.js';

interface Entry {
  key: string; bytes: number; present: boolean; refs: number;
  loading?: Promise<Proof>; controller?: AbortController;
}
type Proof = NonNullable<Awaited<ReturnType<TerrainStorage['head']>>>;
interface Download { entry: Entry; asset: TerrainAsset; signal: AbortSignal; resolve(proof: Proof): void; reject(error: unknown): void }
interface TerrainSourceCacheStats {
  hits: number; downloads: number; downloadBytes: number; remoteRequests: number;
  cachedBytes: number; reservedBytes: number; peakBytes: number; activeDownloads: number; peakDownloads: number;
}
export interface TerrainSourceCache {
  storage: TerrainStorage;
  prefetch(keys: readonly string[], signal?: AbortSignal): Promise<() => void>;
  stats(): TerrainSourceCacheStats;
  close(): Promise<void>;
}

/** Own a bounded directory of verified COGs; all other terrain operations retain their storage owner. */
export async function openTerrainSourceCache(options: {
  storage: TerrainStorage; catalog: TerrainCatalog; directory: string; maxBytes: number; signal?: AbortSignal;
}): Promise<TerrainSourceCache> {
  const { maxBytes } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid terrain source cache byte budget');
  options.signal?.throwIfAborted();
  const directory = resolve(options.directory), assetDirectory = join(directory, 'terrain/assets');
  const local = localTerrainStorage(directory), assets = new Map<string, TerrainAsset>();
  const sizes = new Map<string, number>();
  for (const tile of options.catalog.tiles) {
    const asset = terrainAssetSchema.parse(tile.asset);
    if (!asset.key.startsWith('terrain/assets/')) continue;
    if ((sizes.has(asset.sha256) && sizes.get(asset.sha256) !== asset.bytes)
        || (assets.has(asset.key) && assets.get(asset.key)!.sha256 !== asset.sha256)) throw new Error('Inconsistent terrain source asset');
    assets.set(asset.key, asset); sizes.set(asset.sha256, asset.bytes);
  }
  const stopped = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, stopped.signal]) : stopped.signal;
  const entries = new Map<string, Entry>(), queue: Download[] = [], loads = new Set<Promise<Proof>>(), reads = new Set<Promise<unknown>>();
  const stats: TerrainSourceCacheStats = { hits: 0, downloads: 0, downloadBytes: 0, remoteRequests: 0, cachedBytes: 0, reservedBytes: 0, peakBytes: 0, activeDownloads: 0, peakDownloads: 0 };
  let mutation = Promise.resolve(), pumping = false, repump = false, close: Promise<void> | undefined;
  const serialize = <T>(run: () => T | Promise<T>): Promise<T> => {
    const result = mutation.then(run);
    mutation = result.then(() => undefined, () => undefined);
    return result;
  };
  const touch = (entry: Entry) => { entries.delete(entry.key); entries.set(entry.key, entry); };
  const recordPeak = () => { stats.peakBytes = Math.max(stats.peakBytes, stats.cachedBytes + stats.reservedBytes); };
  async function remove(entry: Entry) {
    await rm(join(directory, entry.key), { force: true });
    if (entry.present) stats.cachedBytes -= entry.bytes;
    entry.present = false;
  }
  async function admit(bytes: number): Promise<boolean> {
    while (stats.cachedBytes + stats.reservedBytes + bytes > maxBytes) {
      let victim: Entry | undefined;
      for (const entry of entries.values()) if (entry.present && !entry.refs && !entry.loading) { victim = entry; break; }
      if (!victim) return false;
      await remove(victim); entries.delete(victim.key);
    }
    return true;
  }
  await mkdir(assetDirectory, { recursive: true });
  const retained: { entry: Entry; modified: number }[] = [];
  for (const file of await readdir(assetDirectory, { withFileTypes: true })) {
    signal.throwIfAborted();
    if (/^[a-f0-9]{64}\.tif\.[a-f0-9-]{36}\.tmp$/.test(file.name)) { await rm(join(assetDirectory, file.name), { force: true }); continue; }
    if (!/^[a-f0-9]{64}\.tif$/.test(file.name)) continue;
    if (!file.isFile()) throw new Error('Terrain source cache requires regular files');
    const info = await stat(join(assetDirectory, file.name));
    if (!Number.isSafeInteger(info.size) || info.size < 1 || info.size > ASSET_MAX_BYTES) { await rm(join(assetDirectory, file.name)); continue; }
    retained.push({ entry: { key: `terrain/assets/${file.name}`, bytes: info.size, present: true, refs: 0 }, modified: info.mtimeMs });
  }
  for (const { entry } of retained.sort((left, right) => left.modified - right.modified)) { entries.set(entry.key, entry); stats.cachedBytes += entry.bytes; }
  await admit(0); recordPeak();

  async function download(job: Download): Promise<void> {
    let present = false, proof: Proof | undefined, failure: unknown, failed = false;
    try {
      job.signal.throwIfAborted(); stats.remoteRequests++;
      const result = await options.storage.get(job.asset.key, undefined, job.asset.bytes, job.signal, () => { stats.remoteRequests++; });
      if (result) stats.downloadBytes += result.bytes.byteLength;
      job.signal.throwIfAborted();
      if (!result || result.bytes.byteLength !== job.asset.bytes || sha256(result.bytes) !== job.asset.sha256) throw new Error(`Terrain source asset integrity mismatch: ${job.asset.key}`);
      await local.put(job.entry.key, result.bytes, { ifNoneMatch: '*' });
      present = true;
      proof = await local.head(job.entry.key, job.signal) ?? undefined;
      if (!proof || proof.size !== job.asset.bytes || proof.computedSha256 !== job.asset.sha256) throw new Error(`Terrain source cache integrity mismatch: ${job.asset.key}`);
      stats.downloads++;
    } catch (error) { failed = true; failure = error; }
    await serialize(() => {
      stats.activeDownloads--; stats.reservedBytes -= job.asset.bytes;
      if (present) { job.entry.present = true; job.entry.bytes = job.asset.bytes; stats.cachedBytes += job.asset.bytes; touch(job.entry); }
      recordPeak();
    });
    if (failed) job.reject(failure); else job.resolve(proof!);
    void pump();
  }
  async function pump(): Promise<void> {
    if (pumping) { repump = true; return; }
    pumping = true; repump = false;
    try {
      while (queue.length) {
        const job = queue[0];
        if (job.signal.aborted) { queue.shift(); job.reject(job.signal.reason); continue; }
        let admitted: boolean;
        try { admitted = await serialize(async () => {
            if (stats.activeDownloads === 4 || !await admit(job.asset.bytes)) return false;
            stats.activeDownloads++; stats.peakDownloads = Math.max(stats.peakDownloads, stats.activeDownloads);
            stats.reservedBytes += job.asset.bytes; recordPeak(); return true;
          }); }
        catch (error) { queue.shift(); job.reject(error); continue; }
        if (!admitted) return;
        queue.shift();
        void download(job);
      }
    } finally { pumping = false; if (repump) { repump = false; void pump(); } }
  }
  function release(entries: readonly Entry[]): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const entry of entries) if (--entry.refs === 0 && entry.loading) entry.controller?.abort(new Error('Terrain source read abandoned'));
      void pump();
    };
  }
  async function pin(selected: readonly TerrainAsset[]): Promise<Entry[]> {
    return serialize(() => {
      signal.throwIfAborted();
      return selected.map(asset => {
        if (asset.bytes > maxBytes) throw new Error('Terrain source asset exceeds cache byte budget');
        const key = `terrain/assets/${asset.sha256}.tif`;
        let entry = entries.get(key);
        if (!entry) { entry = { key, bytes: asset.bytes, present: false, refs: 0 }; entries.set(key, entry); }
        entry.refs++; touch(entry); return entry;
      });
    });
  }
  async function materialize(entry: Entry, asset: TerrainAsset, waiterSignal: AbortSignal): Promise<Proof> {
    // The abandoned download keeps its reservation until it settles.
    while (entry.loading && entry.controller?.signal.aborted) await entry.loading.catch(() => {});
    waiterSignal.throwIfAborted();
    if (entry.loading) return entry.loading;
    const controller = new AbortController(), ownerSignal = AbortSignal.any([signal, controller.signal]);
    entry.controller = controller;
    const promise = (async () => {
      if (entry.present) {
        const proof = await local.head(entry.key, ownerSignal);
        if (proof?.size === asset.bytes && proof.computedSha256 === asset.sha256) { stats.hits++; return proof; }
        await serialize(() => remove(entry));
      }
      ownerSignal.throwIfAborted();
      return new Promise<Proof>((resolve, reject) => {
        queue.push({ entry, asset, signal: ownerSignal, resolve, reject });
        ownerSignal.addEventListener('abort', () => { void pump(); }, { once: true });
        void pump();
      });
    })();
    const loading = promise.finally(() => { entry.loading = undefined; entry.controller = undefined; loads.delete(loading); void pump(); });
    entry.loading = loading; loads.add(loading);
    return loading;
  }
  function wait<T>(promise: Promise<T>, waiterSignal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(waiterSignal.reason);
      promise.then(resolve, reject).finally(() => waiterSignal.removeEventListener('abort', abort));
      if (waiterSignal.aborted) abort(); else waiterSignal.addEventListener('abort', abort, { once: true });
    });
  }
  function read<T>(asset: TerrainAsset, waiterSignal: AbortSignal | undefined, run: (entry: Entry, proof: Proof, signal: AbortSignal) => Promise<T>): Promise<T> {
    const promise = (async () => {
      const combined = waiterSignal ? AbortSignal.any([signal, waiterSignal]) : signal;
      combined.throwIfAborted();
      const [entry] = await pin([asset]), unpin = release([entry]);
      try { const proof = await wait(materialize(entry, asset, combined), combined); combined.throwIfAborted(); return await run(entry, proof, combined); }
      finally { unpin(); }
    })();
    reads.add(promise); void promise.then(() => reads.delete(promise), () => reads.delete(promise));
    return promise;
  }
  const storage: TerrainStorage = {
    head(key, waiterSignal) {
      const asset = assets.get(key);
      return asset ? read(asset, waiterSignal, async (_entry, proof) => proof) : options.storage.head(key, waiterSignal);
    },
    get(key, range, maxReadBytes, waiterSignal, onRetry) {
      const asset = assets.get(key);
      if (!asset) return options.storage.get(key, range, maxReadBytes, waiterSignal, onRetry);
      return read(asset, waiterSignal, async (entry, proof, signal) => {
        const result = await local.get(entry.key, range, maxReadBytes, signal, onRetry);
        if (!result || result.etag !== proof.etag) throw new Error(`Terrain source cache changed during read: ${key}`);
        return result;
      });
    },
    put: (...args) => options.storage.put(...args)
  };
  return {
    storage,
    async prefetch(keys, waiterSignal) {
      const selected = [...new Set(keys)].map(key => { const asset = assets.get(key); if (!asset) throw new Error(`Unknown terrain source asset: ${key}`); return asset; });
      const unique = [...new Map(selected.map(asset => [asset.sha256, asset])).values()];
      if (unique.reduce((sum, asset) => sum + asset.bytes, 0) > maxBytes) throw new Error('Terrain source window exceeds cache byte budget');
      const combined = waiterSignal ? AbortSignal.any([signal, waiterSignal]) : signal;
      combined.throwIfAborted();
      const pinned = await pin(unique), unpin = release(pinned), work = pinned.map((entry, index) => materialize(entry, unique[index], combined));
      try { await wait(Promise.all(work), combined); return unpin; }
      catch (error) { unpin(); await Promise.allSettled(work); throw error; }
    },
    stats: () => ({ ...stats }),
    close() { return close ??= (async () => { stopped.abort(new Error('Terrain source cache closed')); await Promise.allSettled([...loads, ...reads]); await mutation; })(); }
  };
}
