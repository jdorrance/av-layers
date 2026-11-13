import { DEFAULT_REQUEST_TIMEOUT_MS, MAX_TILE_BYTES } from '@av/contracts/format';

/** Compressed tile transport shared by map adapters; dispose with the mounted map. */
export interface RasterTileResponse { data: ArrayBuffer; cacheControl?: string; expires?: string }
/** MapLibre source priority and cancellation; dispose after removing its map source. */
export interface RasterTileSourceTransport {
  url(templateOrTileUrl: string): string;
  setInteractive(value: boolean): void;
  dispose(): void;
}
export interface RasterTileProtocol {
  scheme: string;
  url(templateOrTileUrl: string): string;
  load(params: { url: string }, controller: AbortController): Promise<RasterTileResponse>;
  setBuildExpiry(buildId: string, expiresAtMs: number): void;
  prefetch(tileUrl: string, signal?: AbortSignal): Promise<void>;
  evictBuild(buildId?: string): void;
  stats(): { cacheHits: number; cacheMisses: number; cachedBytes: number; cachedTiles: number; coalesced: number };
  dispose(): void;
}
export interface RasterTileSourceProtocol extends RasterTileProtocol {
  createSource(interactive: boolean): RasterTileSourceTransport;
}
interface TileEntry { response: RasterTileResponse; until: number; build: string; weight: number }
interface SourceGroup { interactive: boolean }
interface SourceControls {
  promote(source: SourceGroup): void;
  cancel(source: SourceGroup): void;
}
interface SourceRegistry {
  connect(controls: SourceControls): void;
  resolve(url: string): { url: string; source?: SourceGroup };
}
interface Consumer {
  priority: SourceGroup;
  resolve(value: RasterTileResponse): void;
  reject(reason: unknown): void;
  cleanup(): void;
  cancel(reason: unknown): void;
}
interface TileTask {
  url: string;
  build: string;
  zoom: number;
  requestedAt: number;
  order: number;
  deadlineAt: number;
  controller: AbortController;
  consumers: Set<Consumer>;
  timer: ReturnType<typeof setTimeout>;
}
const abortError = () => new DOMException('Tile request cancelled', 'AbortError');
const timeoutError = () => new DOMException('Tile request deadline exceeded', 'TimeoutError');
const integerWithin = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;

interface RasterTileOptions {
  fetchImpl?: typeof fetch; timeoutMs?: number; retryDelayMs?: number; maxActive?: number; maxQueued?: number;
  maxCacheBytes?: number; maxPrefetchActive?: number;
}

export function createRasterTileProtocol(baseUrl: string, options: RasterTileOptions = {}): RasterTileProtocol {
  return createProtocol(baseUrl, options);
}

/** Add a bounded set of independently prioritized source handles for the preview. */
export function createSourceRasterTileProtocol(baseUrl: string, options: RasterTileOptions & { maxSources?: number } = {}): RasterTileSourceProtocol {
  const maxSources = options.maxSources ?? 2;
  if (!integerWithin(maxSources, 2, 4)) throw new Error('Invalid raster source limit');
  const sources = new Map<string, SourceGroup>();
  let sourceOrder = 0, disposed = false, controls: SourceControls;
  const protocol = createProtocol(baseUrl, options, {
    connect(value) { controls = value; },
    resolve(url) {
      const scoped = /^(source-\d+)\//.exec(url), source = scoped ? sources.get(scoped[1]) : undefined;
      if (scoped && !source) throw abortError();
      return { url: scoped ? url.slice(scoped[0].length) : url, source };
    }
  });
  return {
    ...protocol,
    createSource(interactive) {
      if (disposed) throw abortError();
      if (sources.size >= maxSources) throw new Error('Raster source limit reached');
      const id = `source-${++sourceOrder}`, source: SourceGroup = { interactive };
      sources.set(id, source);
      return {
        url(url) {
          if (!sources.has(id)) throw abortError();
          return protocol.url(url).replace('://', `://${id}/`);
        },
        setInteractive(value) {
          if (!sources.has(id) || source.interactive === value) return;
          source.interactive = value;
          if (value) controls.promote(source);
        },
        dispose() { if (sources.delete(id)) controls.cancel(source); }
      };
    },
    dispose() { disposed = true; protocol.dispose(); sources.clear(); }
  };
}

function createProtocol(baseUrl: string, options: RasterTileOptions, sourceRegistry?: SourceRegistry): RasterTileProtocol {
  const base = new URL(baseUrl), fetchImpl = options.fetchImpl ?? fetch;
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid raster API base');
  const prefix = `${base.pathname.replace(/\/+$/, '')}/tiles/`;
  const scheme = `av-raster-${crypto.randomUUID()}`, schemePrefix = `${scheme}://`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, retryDelayMs = options.retryDelayMs ?? 200;
  const maxActive = options.maxActive ?? 4, maxQueued = options.maxQueued ?? 64;
  const maxCacheBytes = options.maxCacheBytes ?? 48 * 1024 * 1024, maxPrefetchActive = options.maxPrefetchActive ?? Math.min(2, Math.max(1, maxActive - 2));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(retryDelayMs) || retryDelayMs < 0
      || !integerWithin(maxActive, 1, 16) || !integerWithin(maxQueued, 1, 512)
      || !integerWithin(maxCacheBytes, 0, 48 * 1024 * 1024) || !integerWithin(maxPrefetchActive, 0, maxActive)) throw new Error('Invalid raster request limits');
  const queued: TileTask[] = [], active = new Set<TileTask>(), tasks = new Map<string, TileTask>();
  const cache = new Map<string, TileEntry>(), buildExpiry = new Map<string, number>();
  const foreground: SourceGroup = { interactive: true }, background: SourceGroup = { interactive: false };
  let disposed = false, cachedBytes = 0, retainedBytes = 0, cacheHits = 0, cacheMisses = 0, coalesced = 0, order = 0, consumers = 0, dispatchSuspended = false;

  function validate(url: string, template: boolean): string {
    if (url.length > 4096) throw new Error('Raster URL exceeds budget');
    const parsed = new URL(template ? url.replace(/\{[zxy]\}/g, '0') : url);
    const path = parsed.pathname.slice(prefix.length);
    if (parsed.origin !== base.origin || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname.startsWith(prefix) || !/^(?:[a-zA-Z0-9_-]{1,128}\/){4}\d{1,2}\/\d{1,10}\/\d{1,10}\.webp$/.test(path)) throw new Error('Raster URL must identify a tile on the configured API');
    return template ? url : parsed.href;
  }
  function identity(url: string): { build: string; zoom: number } {
    const parts = new URL(url).pathname.slice(prefix.length).split('/');
    return { build: parts[1], zoom: Number(parts[4]) };
  }
  function dropCache(url: string): void {
    const entry = cache.get(url);
    if (entry) { cachedBytes -= entry.response.data.byteLength; retainedBytes -= entry.weight; }
    cache.delete(url);
  }
  function pruneCache(): void {
    const now = Date.now();
    for (const [url, entry] of cache) if (entry.until <= now || (buildExpiry.get(entry.build) ?? Infinity) <= now) dropCache(url);
  }
  function activePrefetches(): number {
    let count = 0;
    for (const task of active) if (!interactive(task)) count++;
    return count;
  }
  function interactive(task: TileTask): boolean {
    for (const consumer of task.consumers) if (consumer.priority.interactive) return true;
    return false;
  }
  function finish(task: TileTask, value?: RasterTileResponse, error?: unknown): void {
    clearTimeout(task.timer);
    if (tasks.get(task.url) === task) tasks.delete(task.url);
    for (const consumer of task.consumers) {
      consumer.cleanup(); task.consumers.delete(consumer);
      if (error !== undefined) consumer.reject(error);
      else consumer.resolve(value!);
    }
  }
  function evictBuild(build?: string): void {
    for (const [url, entry] of cache) if (build === undefined || entry.build === build) dropCache(url);
    for (const task of [...tasks.values()]) if (build === undefined || task.build === build) task.controller.abort(abortError());
    if (build === undefined) buildExpiry.clear();
  }
  function pump(): void {
    while (!disposed && !dispatchSuspended && active.size < maxActive && queued.length) {
      const activePrefetch = activePrefetches();
      let next = -1;
      for (let i = 0; i < queued.length; i++) {
        const task = queued[i];
        if (!interactive(task) && activePrefetch >= maxPrefetchActive) continue;
        const chosen = queued[next];
        if (next < 0 || (interactive(task) && (!interactive(chosen)
            || task.requestedAt > chosen.requestedAt
            || (task.requestedAt === chosen.requestedAt && (task.zoom < chosen.zoom || (task.zoom === chosen.zoom && task.order > chosen.order)))))) next = i;
      }
      if (next < 0) break;
      const [task] = queued.splice(next, 1);
      if (task.deadlineAt <= Date.now()) { task.controller.abort(timeoutError()); continue; }
      active.add(task); void run(task);
    }
  }
  async function run(task: TileTask): Promise<void> {
    try {
      const { until: responseExpiry, ...result } = await request(task.url, task.controller.signal);
      task.controller.signal.throwIfAborted();
      if ((buildExpiry.get(task.build) ?? Infinity) <= Date.now()) throw abortError();
      const until = Math.min(responseExpiry, buildExpiry.get(task.build) ?? Infinity);
      // Include URL/header strings and estimated Map, object and buffer metadata.
      const weight = result.data.byteLength + 256 + 2 * (task.url.length + task.build.length + (result.cacheControl?.length ?? 0) + (result.expires?.length ?? 0));
      if (until > Date.now() && weight <= maxCacheBytes) {
        pruneCache();
        dropCache(task.url);
        while (cache.size && retainedBytes + weight > maxCacheBytes) dropCache(cache.keys().next().value!);
        cache.set(task.url, { response: result, until, build: task.build, weight });
        cachedBytes += result.data.byteLength; retainedBytes += weight;
      }
      finish(task, result);
    } catch (error) { finish(task, undefined, error); }
    finally { active.delete(task); pump(); }
  }
  async function delay(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      const abort = () => { finish(); reject(signal.reason); };
      const timer = setTimeout(() => { finish(); resolve(); }, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  async function body(response: Response, signal: AbortSignal): Promise<ArrayBuffer> {
    const length = response.headers.get('content-length'), size = Number(length);
    if (!response.body || (length !== null && (!/^\d+$/.test(length) || size > MAX_TILE_BYTES)) || response.headers.get('content-type')?.split(';')[0] !== 'image/webp') {
      void response?.body?.cancel().catch(() => {}); throw new Error('Invalid raster response type or size');
    }
    const reader = response.body.getReader(), buffer = new Uint8Array(length === null ? MAX_TILE_BYTES : size);
    const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    let used = 0, chunks = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const result = await reader.read(); signal.throwIfAborted();
        if (result.done) break;
        if (++chunks > 65536 || used + result.value.length > buffer.length) throw new Error('Raster response exceeds byte budget');
        buffer.set(result.value, used); used += result.value.length;
      }
      if (used < 12 || (length !== null && used !== size) || buffer[0] !== 82 || buffer[1] !== 73 || buffer[2] !== 70 || buffer[3] !== 70 || buffer[8] !== 87 || buffer[9] !== 69 || buffer[10] !== 66 || buffer[11] !== 80) throw new Error('Invalid WebP tile');
      return used === buffer.byteLength ? buffer.buffer : buffer.slice(0, used).buffer;
    } finally {
      signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock();
    }
  }
  async function request(url: string, signal: AbortSignal): Promise<RasterTileResponse & { until: number }> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let response: Response | undefined;
      try { response = await fetchImpl(url, { signal, redirect: 'error', headers: { accept: 'image/webp' } }); }
      catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof TypeError) || attempt === 2) throw error;
      }
      if (!response || ([502, 503, 504].includes(response.status) && attempt < 2)) {
        void response?.body?.cancel().catch(() => {});
        await delay(retryDelayMs * (attempt + 1) + Math.random() * retryDelayMs, signal); continue;
      }
      if (response.status !== 200) { void response?.body?.cancel().catch(() => {}); throw new Error(`Raster request failed: HTTP ${response.status}`); }
      const cacheControl = response.headers.get('cache-control') ?? undefined, expires = response.headers.get('expires') ?? undefined;
      const maxAge = Number(/(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? '')?.[1]);
      const age = Number(response.headers.get('age') ?? 0), date = Date.parse(response.headers.get('date') ?? ''), expiration = Date.parse(expires ?? '');
      const freshness = maxAge >= 0 && !/(?:^|,)\s*(?:no-store|no-cache)(?:,|$)/i.test(cacheControl ?? '')
        ? Math.min(Date.now() + Math.max(0, maxAge - (Number.isFinite(age) ? age : 0)) * 1000,
          Number.isFinite(date) ? date + maxAge * 1000 : Infinity) : Date.now();
      return { data: await body(response, signal), cacheControl, expires, until: Math.min(freshness, Number.isFinite(expiration) ? expiration : Infinity) };
    }
  }
  function subscribe(url: string, signal: AbortSignal | undefined, priority: SourceGroup): Promise<RasterTileResponse> {
    const isInteractive = priority.interactive;
    if (disposed) return Promise.reject(abortError());
    if (signal?.aborted) return Promise.reject(signal.reason);
    const { build, zoom } = identity(url), now = Date.now();
    if ((buildExpiry.get(build) ?? Infinity) <= now) { evictBuild(build); return Promise.reject(abortError()); }
    const entry = cache.get(url);
    if (entry && entry.until <= now) dropCache(url);
    const hit = cache.get(url);
    if (hit) {
      cacheHits++; cache.delete(url); cache.set(url, hit);
      return Promise.resolve({ ...hit.response, cacheControl: `public, max-age=${Math.max(0, Math.floor((hit.until - now) / 1000))}, immutable` });
    }
    if (isInteractive) {
      while (consumers >= maxActive + maxQueued || (active.size >= maxActive && queued.length >= maxQueued && !tasks.has(url))) {
        const background = queued.find(task => task.url !== url && !interactive(task));
        if (!background) break;
        background.controller.abort(abortError());
      }
    }
    if (consumers >= maxActive + maxQueued) return Promise.reject(new Error('Raster request queue is full'));
    cacheMisses++;
    let task = tasks.get(url);
    if (task) coalesced++;
    else {
      const prefetchBlocked = !isInteractive && activePrefetches() >= maxPrefetchActive;
      if (queued.length >= maxQueued && (active.size >= maxActive || prefetchBlocked)) return Promise.reject(new Error('Raster request queue is full'));
      const controller = new AbortController();
      const deadline = Math.min(timeoutMs, (buildExpiry.get(build) ?? Infinity) - now);
      task = { url, build, zoom, requestedAt: now, order: ++order, deadlineAt: now + deadline, controller, consumers: new Set(), timer: undefined! };
      const owned = task;
      task.timer = setTimeout(() => controller.abort(timeoutError()), deadline);
      controller.signal.addEventListener('abort', () => {
        const index = queued.indexOf(owned);
        if (index >= 0) queued.splice(index, 1);
        finish(owned, undefined, controller.signal.reason); pump();
      }, { once: true });
      tasks.set(url, task); queued.push(task);
    }
    if (isInteractive) { task.requestedAt = now; task.order = ++order; }
    const owned = task;
    return new Promise<RasterTileResponse>((resolve, reject) => {
      consumers++;
      const consumer: Consumer = { priority, resolve, reject,
        cleanup() { consumers--; signal?.removeEventListener('abort', abort); },
        cancel(reason) {
          if (!owned.consumers.delete(consumer)) return;
          consumer.cleanup(); reject(reason);
          if (!owned.consumers.size) owned.controller.abort(abortError());
          pump();
        }
      };
      const abort = () => consumer.cancel(signal!.reason);
      owned.consumers.add(consumer);
      signal?.addEventListener('abort', abort, { once: true }); pump();
    });
  }
  sourceRegistry?.connect({
    promote(source) {
      for (const task of queued) {
        if ([...task.consumers].some(consumer => consumer.priority === source)) { task.requestedAt = Date.now(); task.order = ++order; }
      }
      pump();
    },
    cancel(source) {
      dispatchSuspended = true;
      for (const task of tasks.values()) for (const consumer of task.consumers) if (consumer.priority === source) consumer.cancel(abortError());
      dispatchSuspended = false; pump();
    }
  });
  return {
    scheme,
    url: url => `${schemePrefix}${validate(url, true)}`,
    async load(params, external) {
      if (!params.url.startsWith(schemePrefix)) throw new Error('Incorrect raster protocol');
      const raw = params.url.slice(schemePrefix.length), scoped = sourceRegistry?.resolve(raw);
      const response = await subscribe(validate(scoped?.url ?? raw, false), external.signal, scoped?.source ?? foreground);
      return { ...response, data: response.data.slice(0) };
    },
    async prefetch(url, signal) { await subscribe(validate(url, false), signal, background); },
    setBuildExpiry(build, until) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(build) || !Number.isFinite(until)) throw new Error('Invalid raster build expiry');
      if (buildExpiry.has(build) && buildExpiry.get(build) !== until) evictBuild(build);
      if (!buildExpiry.has(build) && buildExpiry.size >= 32) {
        const oldest = buildExpiry.keys().next().value!; evictBuild(oldest); buildExpiry.delete(oldest);
      }
      buildExpiry.set(build, until);
      if (until <= Date.now()) evictBuild(build);
    },
    evictBuild,
    stats() { pruneCache(); return { cacheHits, cacheMisses, cachedBytes, cachedTiles: cache.size, coalesced }; },
    dispose() { disposed = true; evictBuild(); }
  };
}
