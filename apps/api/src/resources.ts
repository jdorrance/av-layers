import { parseBoundedJson, ResourceLimitError } from '@av/contracts';
export { parseBoundedJson, ResourceLimitError } from '@av/contracts';

/** Cache limits account retained typed arrays and estimated decoded object storage. */
export class ByteCache<K, V> {
  private entries = new Map<K, { value: V; bytes: number; until: number }>();
  private used = 0;
  constructor(readonly maxEntries: number, readonly maxBytes: number) {}
  get size(): number { return this.entries.size; }
  get bytes(): number { return this.used; }
  get(key: K, now = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.until <= now) { this.delete(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  delete(key: K): void {
    const entry = this.entries.get(key);
    if (entry) this.used -= entry.bytes;
    this.entries.delete(key);
  }
  set(key: K, value: V, bytes: number, until = Infinity): void {
    this.delete(key);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes || until <= Date.now()) return;
    while (this.entries.size >= this.maxEntries || this.used + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
    this.entries.set(key, { value, bytes, until });
    this.used += bytes;
  }
}

export interface RequestMetrics { r2Reads: number; r2Bytes: number; cacheHits: number; coalesced: number; responseCache?: 'hit' | 'miss' | 'bypass' }
export interface WaitContext { waitUntil(promise: Promise<unknown>): void; metrics?: RequestMetrics; responseCacheEnabled?: boolean }
export function countRead(ctx?: WaitContext): void { if (ctx?.metrics) ctx.metrics.r2Reads++; }
export function countCacheHit(ctx?: WaitContext): void { if (ctx?.metrics) ctx.metrics.cacheHits++; }

/** Share only completed plain values, never an R2 object, response or readable stream. */
export class MaterializedReads<T> {
  private pending = new Map<string, { promise: Promise<T>; waiters: number }>();
  private waiters = 0;
  constructor(readonly maxPending = 16, readonly timeoutMs = 15_000, readonly maxWaiters = 32) {}
  run(key: string, load: (signal: AbortSignal) => Promise<T>, ctx?: WaitContext): Promise<T> {
    const existing = this.pending.get(key);
    if (this.waiters >= this.maxWaiters) return Promise.reject(new ResourceLimitError('Too many concurrent object waiters'));
    if (existing) { existing.waiters++; this.waiters++; if (ctx?.metrics) ctx.metrics.coalesced++; return existing.promise; }
    if (this.pending.size >= this.maxPending) return Promise.reject(new ResourceLimitError('Too many concurrent object reads'));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { const error = new ResourceLimitError('Object read deadline exceeded'); controller.abort(error); reject(error); }, this.timeoutMs); });
    const operation = Promise.resolve().then(() => load(controller.signal));
    this.waiters++;
    const entry: { promise: Promise<T>; waiters: number } = {
      promise: Promise.race([operation, deadline]).catch(error => { controller.abort(error); throw error; }).finally(() => { clearTimeout(timer); this.waiters -= entry.waiters; this.pending.delete(key); }),
      waiters: 1
    };
    this.pending.set(key, entry);
    ctx?.waitUntil(entry.promise.then(() => undefined, () => undefined));
    return entry.promise;
  }
}

const MAX_IN_FLIGHT_READ_BYTES = 32 * 1024 * 1024;
let reservedReadBytes = 0;

export function reserveAllocation(bytes: number): () => void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || reservedReadBytes + bytes > MAX_IN_FLIGHT_READ_BYTES) throw new ResourceLimitError('In-flight read byte budget exceeded');
  reservedReadBytes += bytes;
  let released = false;
  return () => { if (!released) { released = true; reservedReadBytes -= bytes; } };
}

export async function readBoundedStream(stream: ReadableStream<Uint8Array>, limit: number, ctx?: WaitContext, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Uint8Array> {
  let release: () => void;
  try { release = reserveAllocation(limit * 2); }
  catch (error) { void stream.cancel(error).catch(() => {}); throw error; }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    reader = stream.getReader();
    const bytes = new Uint8Array(limit);
    let length = 0, chunks = 0, failure: unknown;
    const cancel = (reason: unknown) => { failure = reason; void reader!.cancel(reason).catch(() => {}); };
    abort = () => cancel(options.signal!.reason);
    timer = setTimeout(() => cancel(new ResourceLimitError('Object body deadline exceeded')), options.timeoutMs ?? 15_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    for (;;) {
      const next = await reader.read();
      if (failure) throw failure;
      if (next.done) break;
      if (++chunks > 65_536) { const error = new ResourceLimitError('Stream fragmentation exceeds budget'); cancel(error); throw error; }
      if (ctx?.metrics) ctx.metrics.r2Bytes += next.value.byteLength;
      if (length + next.value.byteLength > limit) {
        const error = new ResourceLimitError('Response exceeds byte budget'); cancel(error); throw error;
      }
      bytes.set(next.value, length); length += next.value.byteLength;
    }
    return length === limit ? bytes : bytes.slice(0, length);
  } finally { clearTimeout(timer); if (abort) options.signal?.removeEventListener('abort', abort); release(); reader?.releaseLock(); }
}

export async function readObjectBytes(object: R2ObjectBody, limit: number, range = false, ctx?: WaitContext, signal?: AbortSignal): Promise<Uint8Array> {
  if (signal?.aborted) { void object.body?.cancel?.(signal.reason); throw signal.reason; }
  if (!range && (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > limit)) {
    await object.body?.cancel?.();
    throw new ResourceLimitError('Object exceeds byte budget');
  }
  // The fallback supports in-memory storage test doubles; real R2 bodies are bounded while streaming.
  const bytes = typeof object.body?.getReader === 'function'
    ? await readBoundedStream(object.body, limit, ctx, { signal })
    : new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength > limit) throw new ResourceLimitError('Object exceeds byte budget');
  if (ctx?.metrics && typeof object.body?.getReader !== 'function') ctx.metrics.r2Bytes += bytes.byteLength;
  return bytes;
}

export function estimateJsonBytes(value: unknown): number {
  if (typeof value === 'string') return 24 + value.length * 2;
  if (value === null || typeof value !== 'object') return 16;
  if (Array.isArray(value)) return 40 + value.length * 8 + value.reduce((sum, item) => sum + estimateJsonBytes(item), 0);
  return 64 + Object.entries(value).reduce((sum, [key, item]) => sum + 32 + 24 + key.length * 2 + estimateJsonBytes(item), 0);
}
export async function readObjectJson(object: R2ObjectBody, limit: number, ctx?: WaitContext, signal?: AbortSignal): Promise<{ value: unknown; bytes: number; estimatedBytes: number }> {
  const bytes = await readObjectBytes(object, limit, false, ctx, signal), value = parseBoundedJson(bytes);
  return { value, bytes: bytes.byteLength, estimatedBytes: estimateJsonBytes(value) };
}

// Reserve before constructing a body. One lease covers the payload and both Cache API
// tee branches; it is released only after every branch consumes, cancels or expires.
let responseBytes = 0;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
interface BodyLease { size: number; retain(): void; release(): void }
const bodyLeases = new WeakMap<ReadableStream<Uint8Array>, BodyLease>();
function reserveResponse(size: number): BodyLease {
  const reserved = Math.max(1, size) * 4;
  if (!Number.isSafeInteger(size) || size < 0 || size > 1024 * 1024 || responseBytes + reserved > MAX_RESPONSE_BYTES) throw new ResourceLimitError('Outgoing response byte budget exceeded');
  responseBytes += reserved;
  let refs = 1;
  return { size, retain() { refs++; }, release() { if (--refs === 0) responseBytes -= reserved; } };
}
function wrapResponse(response: Response, lease: BodyLease, timeoutMs: number): Response {
  if (!response.body) { lease.release(); return response; }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, released = false, length = 0, failure: unknown;
  const release = () => { if (!released) { released = true; clearTimeout(timer); lease.release(); } };
  try {
    reader = response.body.getReader();
    timer = setTimeout(() => { failure = new ResourceLimitError('Response body deadline exceeded'); void reader!.cancel(failure).catch(() => {}); release(); }, timeoutMs);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader!.read();
          if (failure) throw failure;
          if (next.done) { controller.close(); release(); }
          else {
            length += next.value.byteLength;
            if (length > lease.size) { void reader!.cancel().catch(() => {}); throw new ResourceLimitError('Outgoing body exceeds declared size'); }
            controller.enqueue(next.value);
          }
        } catch (error) { controller.error(error); release(); }
      },
      cancel(reason) { release(); return reader!.cancel(reason); }
    }, { highWaterMark: 0 });
    bodyLeases.set(body, lease);
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) { release(); throw error; }
}
/** The callback cannot allocate a payload until the outgoing byte permit exists. */
export function createBoundedResponse(size: number, create: () => Response, timeoutMs = 15_000): Response {
  const lease = reserveResponse(size);
  let response: Response;
  try { response = create(); } catch (error) { lease.release(); throw error; }
  return wrapResponse(response, lease, timeoutMs);
}
/** Wrap a streaming cache hit before reading it; API-created bodies already have a lease. */
export function boundResponse(response: Response, timeoutMs = 15_000): Response {
  if (!response.body || bodyLeases.has(response.body)) return response;
  const size = response.headers.has('content-length') ? Number(response.headers.get('content-length')) : 1024 * 1024;
  try { return createBoundedResponse(size, () => response, timeoutMs); }
  catch (error) { void response.body.cancel().catch(() => {}); throw error; }
}
export function forkResponseForCache(response: Response, timeoutMs = 15_000): { client: Response; cache: Response } {
  const bounded = boundResponse(response, timeoutMs);
  if (!bounded.body) return { client: bounded, cache: bounded.clone() };
  const lease = bodyLeases.get(bounded.body)!;
  const copy = bounded.clone();
  // Retain each tee branch before either can pull. The original source keeps its
  // own reference, so draining the cache cannot free the pending client body.
  lease.retain(); lease.retain();
  return { client: wrapResponse(bounded, lease, timeoutMs), cache: wrapResponse(copy, lease, timeoutMs) };
}

const binaryReads = new WeakMap<R2Bucket, MaterializedReads<Uint8Array>>();
export function binaryRead(bucket: R2Bucket, key: string, load: (signal: AbortSignal) => Promise<Uint8Array>, ctx: WaitContext): Promise<Uint8Array> {
  let reads = binaryReads.get(bucket);
  if (!reads) { reads = new MaterializedReads(8); binaryReads.set(bucket, reads); }
  return reads.run(key, load, ctx);
}
