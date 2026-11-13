import { sha256 } from './coverage';
import { readBoundedStream, reserveAllocation, type WaitContext } from './resources';

interface StoredBytes { bytes: Uint8Array; until: number; etag?: string }

function target(key: string, ctx?: WaitContext): { cache: Cache; request: Request } | undefined {
  const cache = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches?.default;
  if (!cache || !ctx?.cacheOrigin || ctx.responseCacheEnabled === false) return;
  return { cache, request: new Request(`${ctx.cacheOrigin}/__av-storage/v1/${encodeURIComponent(key)}`) };
}

/** Read bounded internal cache bytes, preserving the originating absolute deadline. */
export async function matchStorageBytes(key: string, limit: number, ctx: WaitContext | undefined, signal: AbortSignal): Promise<StoredBytes | undefined> {
  const store = target(key, ctx);
  if (!store) return;
  let hit: Response | undefined;
  try { hit = await store.cache.match(store.request); }
  catch { signal.throwIfAborted(); return; }
  let release: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    if (!hit?.body) return;
    const until = Number(hit.headers.get('x-av-until'));
    const length = Number(hit.headers.get('x-av-bytes'));
    const digest = hit.headers.get('x-av-sha256');
    if (!Number.isSafeInteger(until) || until <= Date.now() || !Number.isSafeInteger(length) || length < 1 || length > limit || !digest || !/^[a-f0-9]{64}$/.test(digest)) return;
    release = reserveAllocation(length * 3);
    const bytes = await readBoundedStream(hit.body, length, undefined, { signal, exactLength: true, reserved: true });
    if (await sha256(bytes) !== digest || until <= Date.now()) return;
    signal.throwIfAborted();
    return { bytes, until, etag: hit.headers.get('x-av-etag') ?? undefined };
  } catch {
    signal.throwIfAborted();
    return;
  } finally { release?.(); void hit?.body?.cancel().catch(() => {}); }
}

/** Optional writes retain their byte permit until Cache API settlement. */
export async function storeStorageBytes(key: string, value: StoredBytes, ctx?: WaitContext): Promise<void> {
  const store = target(key, ctx);
  if (!store || value.until <= Date.now() || !value.bytes.byteLength) return;
  let release: (() => void) | undefined;
  try {
    release = reserveAllocation(value.bytes.byteLength * 2);
    const headers = new Headers({ 'content-type': 'application/octet-stream', 'content-length': String(value.bytes.byteLength),
      'x-av-bytes': String(value.bytes.byteLength), 'x-av-until': String(value.until), 'x-av-sha256': await sha256(value.bytes),
      'date': new Date().toUTCString(), 'cache-control': `public, max-age=${Math.max(0, Math.floor((value.until - Date.now()) / 1000))}` });
    if (value.etag) headers.set('x-av-etag', value.etag);
    if (value.until > Date.now()) await store.cache.put(store.request, new Response(value.bytes, { headers }));
  } catch { /* Storage cache population is optional. */ }
  finally { release?.(); }
}
