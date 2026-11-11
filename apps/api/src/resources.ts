import { DEFAULT_REQUEST_TIMEOUT_MS, MAX_PROVENANCE_BYTES, parseBoundedJson, ResourceLimitError } from '@av/contracts';
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

export interface RequestMetrics {
  r2Reads: number;
  r2Bytes: number;
  cacheHits: number;
  coalesced: number;
  admitMs?: number;
  r2WaitMs?: number;
  responseCache?: 'hit' | 'miss' | 'bypass';
  route?: string;
  model?: string;
  buildId?: string;
  problemCode?: string;
}
export interface WaitContext { waitUntil(promise: Promise<unknown>): void; metrics?: RequestMetrics; responseCacheEnabled?: boolean }
export function countCacheHit(ctx?: WaitContext): void { if (ctx?.metrics) ctx.metrics.cacheHits++; }

const activeR2Waits = new WeakMap<RequestMetrics, { started: number; count: number }>();

function startR2Wait(metrics: RequestMetrics): () => void {
  let wait = activeR2Waits.get(metrics);
  if (!wait) {
    wait = { started: performance.now(), count: 0 };
    activeR2Waits.set(metrics, wait);
  }
  wait.count++;
  return () => {
    if (--wait.count > 0) return;
    metrics.r2WaitMs = (metrics.r2WaitMs ?? 0) + (performance.now() - wait.started);
    activeR2Waits.delete(metrics);
  };
}

export function r2WaitDuration(metrics: RequestMetrics, finished: number): number | undefined {
  const wait = activeR2Waits.get(metrics);
  return wait ? (metrics.r2WaitMs ?? 0) + (finished - wait.started) : metrics.r2WaitMs;
}

export function getR2Object(bucket: R2Bucket, key: string, ctx?: WaitContext, options?: Omit<R2GetOptions, 'onlyIf'> & { onlyIf?: undefined }): Promise<R2ObjectBody | null>;
export function getR2Object(bucket: R2Bucket, key: string, ctx: WaitContext | undefined, options: R2GetOptions): Promise<R2Object | R2ObjectBody | null>;
export async function getR2Object(bucket: R2Bucket, key: string, ctx?: WaitContext, options?: R2GetOptions): Promise<R2Object | R2ObjectBody | null> {
  const metrics = ctx?.metrics;
  if (!metrics) return bucket.get(key, options);
  const stopWait = startR2Wait(metrics);
  metrics.r2Reads++;
  try { return await bucket.get(key, options); }
  finally { stopWait(); }
}

export function waitFor<T>(promise: Promise<T>, signal?: AbortSignal, discard?: (value: T) => void): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let cancelled = false;
    const abort = () => { cancelled = true; reject(signal.reason); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { if (cancelled) discard?.(value); else resolve(value); }, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

interface QueuedRead<T> {
  key: string;
  load: (signal: AbortSignal) => Promise<T>;
  ctx?: WaitContext;
  consumers: number;
  started: boolean;
  settled: boolean;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve(value: T): void;
  reject(error: unknown): void;
  promise: Promise<T>;
}

/** Share only completed plain values, never an R2 object, response or readable stream. */
export class MaterializedReads<T> {
  private pending = new Map<string, { promise: Promise<T>; deadlineError?: Error }>();
  private queued = new Map<string, QueuedRead<T>>();
  private queue: QueuedRead<T>[] = [];
  private waiters = 0;
  constructor(readonly maxPending = 16, readonly timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, readonly maxWaiters = 32, readonly maxQueued = 64) {}
  run(key: string, load: (signal: AbortSignal) => Promise<T>, ctx?: WaitContext, waiterSignal?: AbortSignal): Promise<T> {
    if (waiterSignal?.aborted) return Promise.reject(waiterSignal.reason);
    const existing = this.pending.get(key);
    if (existing?.deadlineError) return Promise.reject(existing.deadlineError);
    if (this.waiters >= this.maxWaiters) return Promise.reject(new ResourceLimitError('Too many concurrent object waiters'));
    if (existing) {
      this.waiters++; if (ctx?.metrics) ctx.metrics.coalesced++;
      return waitFor(existing.promise, waiterSignal).finally(() => { this.waiters--; });
    }
    const waiting = this.queued.get(key);
    if (waiting && !waiting.settled) {
      this.waiters++; waiting.consumers++; if (ctx?.metrics) ctx.metrics.coalesced++;
      return this.consume(waiting, waiterSignal);
    }
    this.waiters++;
    if (this.pending.size < this.maxPending) return this.own(key, load, ctx, waiterSignal);
    if (this.queue.length >= this.maxQueued) {
      this.waiters--;
      return Promise.reject(new ResourceLimitError('Too many queued object reads'));
    }
    return this.enqueue(key, load, ctx, waiterSignal);
  }
  private consume(entry: QueuedRead<T>, waiterSignal?: AbortSignal): Promise<T> {
    return waitFor(entry.promise, waiterSignal).finally(() => this.release(entry));
  }
  private release(entry: QueuedRead<T>): void {
    this.waiters--;
    entry.consumers--;
    if (!entry.started && entry.consumers === 0 && !entry.settled) this.drop(entry);
  }
  private drop(entry: QueuedRead<T>): void {
    entry.settled = true;
    clearTimeout(entry.timer);
    if (this.queued.get(entry.key) === entry) this.queued.delete(entry.key);
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
    entry.reject(new ResourceLimitError('Object read deadline exceeded'));
  }
  private enqueue(key: string, load: (signal: AbortSignal) => Promise<T>, ctx?: WaitContext, waiterSignal?: AbortSignal): Promise<T> {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
    const entry: QueuedRead<T> = { key, load, ctx, consumers: 1, started: false, settled: false, deadline: Date.now() + this.timeoutMs, resolve, reject, promise };
    entry.timer = setTimeout(() => { if (!entry.started && !entry.settled) this.drop(entry); }, this.timeoutMs);
    this.queue.push(entry);
    this.queued.set(key, entry);
    ctx?.waitUntil(promise.then(() => undefined, () => undefined));
    return this.consume(entry, waiterSignal);
  }
  private own(key: string, load: (signal: AbortSignal) => Promise<T>, ctx?: WaitContext, waiterSignal?: AbortSignal): Promise<T> {
    const entry = this.execute(key, load, ctx);
    return waitFor(entry.promise, waiterSignal).finally(() => { this.waiters--; });
  }
  private execute(key: string, load: (signal: AbortSignal) => Promise<T>, ctx?: WaitContext, timeoutMs = this.timeoutMs): { promise: Promise<T>; deadlineError?: Error } {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const entry: { promise: Promise<T>; deadlineError?: Error } = { promise: undefined as unknown as Promise<T> };
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      const error = new ResourceLimitError('Object read deadline exceeded');
      entry.deadlineError = error;
      controller.abort(error);
      reject(error);
    }, timeoutMs); });
    // R2 get() cannot be cancelled. A caller deadline must not release its
    // owner's admission slot while that underlying operation is still alive.
    const operation = (async () => load(controller.signal))().finally(() => { this.pending.delete(key); this.drain(); });
    entry.promise = Promise.race([operation, deadline]).catch(error => { controller.abort(error); throw error; }).finally(() => { clearTimeout(timer); });
    this.pending.set(key, entry);
    ctx?.waitUntil(operation.then(() => undefined, () => undefined));
    return entry;
  }
  private drain(): void {
    while (this.pending.size < this.maxPending && this.queue.length) {
      const entry = this.queue.shift()!;
      if (this.queued.get(entry.key) === entry) this.queued.delete(entry.key);
      if (entry.settled || entry.consumers === 0 || entry.deadline <= Date.now()) { entry.settled = true; clearTimeout(entry.timer); entry.reject(new ResourceLimitError('Object read deadline exceeded')); continue; }
      entry.started = true;
      clearTimeout(entry.timer);
      const owner = this.execute(entry.key, entry.load, entry.ctx, entry.deadline - Date.now());
      owner.promise.then(value => { if (!entry.settled) { entry.settled = true; entry.resolve(value); } },
        error => { if (!entry.settled) { entry.settled = true; entry.reject(error); } });
    }
  }
}

const MAX_IN_FLIGHT_READ_BYTES = 32 * 1024 * 1024;
let reservedReadBytes = 0;
export function inFlightAllocationBytes(): number { return reservedReadBytes; }

export function reserveAllocation(bytes: number): () => void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || reservedReadBytes + bytes > MAX_IN_FLIGHT_READ_BYTES) throw new ResourceLimitError('In-flight read byte budget exceeded');
  reservedReadBytes += bytes;
  let released = false;
  return () => { if (!released) { released = true; reservedReadBytes -= bytes; } };
}

export async function readBoundedStream(stream: ReadableStream<Uint8Array>, limit: number, ctx?: WaitContext, options: { signal?: AbortSignal; timeoutMs?: number; reserved?: boolean; exactLength?: boolean } = {}): Promise<Uint8Array> {
  let release: () => void;
  try {
    release = options.reserved || (options.exactLength && limit === 0)
      ? () => {} : reserveAllocation(limit * (options.exactLength ? 1 : 2));
  }
  catch (error) { void stream.cancel(error).catch(() => {}); throw error; }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    reader = stream.getReader();
    const bytes = new Uint8Array(limit);
    let length = 0, chunks = 0, failure: { reason: unknown } | undefined;
    const cancel = (reason: unknown) => { failure = { reason }; void reader!.cancel(reason).catch(() => {}); };
    abort = () => cancel(options.signal!.reason);
    timer = setTimeout(() => cancel(new ResourceLimitError('Object body deadline exceeded')), options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    for (;;) {
      const next = await reader.read();
      if (failure) throw failure.reason;
      if (next.done) break;
      if (++chunks > 65_536) { const error = new ResourceLimitError('Stream fragmentation exceeds budget'); cancel(error); throw error; }
      if (ctx?.metrics) ctx.metrics.r2Bytes += next.value.byteLength;
      if (length + next.value.byteLength > limit) {
        const error = new ResourceLimitError('Response exceeds byte budget'); cancel(error); throw error;
      }
      bytes.set(next.value, length); length += next.value.byteLength;
    }
    if (options.exactLength && length !== limit) throw new RangeError('Response length differs from object size');
    return length === limit ? bytes : bytes.slice(0, length);
  } finally { clearTimeout(timer); if (abort) options.signal?.removeEventListener('abort', abort); release(); reader?.releaseLock(); }
}

export async function readObjectBytes(object: R2ObjectBody, limit: number, range = false, ctx?: WaitContext, signal?: AbortSignal, reserved = false): Promise<Uint8Array> {
  if (signal?.aborted) { void object.body.cancel(signal.reason).catch(() => {}); throw signal.reason; }
  if (!Number.isSafeInteger(limit) || limit < 0 || (!range && (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > limit))) {
    void object.body.cancel().catch(() => {});
    throw new ResourceLimitError('Object exceeds byte budget');
  }
  const metrics = ctx?.metrics;
  const stopWait = metrics && startR2Wait(metrics);
  try { return await readBoundedStream(object.body, range ? limit : object.size, ctx, { signal, reserved, exactLength: !range }); }
  finally { stopWait?.(); }
}

export function estimateJsonBytes(value: unknown): number {
  if (typeof value === 'string') return 24 + value.length * 2;
  if (value === null || typeof value !== 'object') return 16;
  if (Array.isArray(value)) return 40 + value.length * 8 + value.reduce((sum, item) => sum + estimateJsonBytes(item), 0);
  return 64 + Object.entries(value).reduce((sum, [key, item]) => sum + 32 + 24 + key.length * 2 + estimateJsonBytes(item), 0);
}
export async function readObjectJson(object: R2ObjectBody, limit: number, ctx?: WaitContext, signal?: AbortSignal, maxTokens?: number): Promise<{ value: unknown; bytes: number; estimatedBytes: number }> {
  const bytes = await readObjectBytes(object, limit, false, ctx, signal), value = parseBoundedJson(bytes, maxTokens);
  return { value, bytes: bytes.byteLength, estimatedBytes: estimateJsonBytes(value) };
}

// Reserve before constructing a body. One lease covers the payload and both Cache API
// tee branches; it is released only after every branch consumes, cancels or expires.
let responseBytes = 0;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const CACHED_RESPONSE_BYTES = 'x-av-cached-bytes';
interface BodyLease { size: number; retain(): void; release(): void }
const bodyLeases = new WeakMap<ReadableStream<Uint8Array>, BodyLease>();
export function transferBodyLease(from: ReadableStream<Uint8Array> | null, to: ReadableStream<Uint8Array> | null): void {
  if (!from || !to || from === to) return;
  const lease = bodyLeases.get(from);
  if (lease) {
    bodyLeases.set(to, lease);
  }
}
function reserveResponse(size: number): BodyLease {
  const reserved = Math.max(1, size) * 4;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_PROVENANCE_BYTES || responseBytes + reserved > MAX_RESPONSE_BYTES) throw new ResourceLimitError('Outgoing response byte budget exceeded');
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
export function createBoundedResponse(size: number, create: () => Response, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Response {
  const lease = reserveResponse(size);
  let response: Response;
  try { response = create(); } catch (error) { lease.release(); throw error; }
  return wrapResponse(response, lease, timeoutMs);
}
/** Wrap a streaming cache hit before reading it; API-created bodies already have a lease. */
export function boundResponse(response: Response, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Response {
  if (!response.body || bodyLeases.has(response.body)) return response;
  const size = response.headers.has('content-length') ? Number(response.headers.get('content-length')) : 1024 * 1024;
  try { return createBoundedResponse(size, () => response, timeoutMs); }
  catch (error) { void response.body.cancel().catch(() => {}); throw error; }
}
/** Cache API streams can lose Content-Length; cache-owned metadata retains the reservation. */
export function boundCachedResponse(response: Response, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Response {
  const value = response.headers.get(CACHED_RESPONSE_BYTES);
  if (value === null) return boundResponse(response, timeoutMs);
  try {
    if (!/^(?:0|[1-9]\d{0,6})$/.test(value)) throw new ResourceLimitError('Invalid cached response size');
    const headers = new Headers(response.headers);
    headers.delete(CACHED_RESPONSE_BYTES);
    return createBoundedResponse(Number(value), () => new Response(response.body, { status: response.status, statusText: response.statusText, headers }), timeoutMs);
  } catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
}
export function forkResponseForCache(response: Response, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): { client: Response; cache: Response } {
  const bounded = boundResponse(response, timeoutMs);
  if (!bounded.body) return { client: bounded, cache: bounded.clone() };
  const lease = bodyLeases.get(bounded.body)!;
  let copy: Response;
  try {
    copy = bounded.clone();
  } catch (error) {
    void bounded.body.cancel(error).catch(() => {});
    throw error;
  }
  // Each tee branch has its own reference. The original source keeps its guard
  // until it drains, so neither sibling can release another stream's permit.
  lease.retain(); lease.retain();
  const cache = wrapResponse(copy, lease, timeoutMs);
  cache.headers.set(CACHED_RESPONSE_BYTES, String(lease.size));
  return { client: wrapResponse(bounded, lease, timeoutMs), cache };
}

const binaryReads = new WeakMap<R2Bucket, MaterializedReads<Uint8Array>>();
export const MAX_SAMPLE_CONCURRENT_READS_PER_REQUEST = 4;
export function binaryRead(bucket: R2Bucket, key: string, load: (signal: AbortSignal) => Promise<Uint8Array>, ctx: WaitContext, waiterSignal?: AbortSignal): Promise<Uint8Array> {
  let reads = binaryReads.get(bucket);
  if (!reads) { reads = new MaterializedReads(8, DEFAULT_REQUEST_TIMEOUT_MS, 96); binaryReads.set(bucket, reads); }
  return reads.run(key, load, ctx, waiterSignal);
}
