import { DEFAULT_REQUEST_TIMEOUT_MS, MAX_TILE_BYTES } from './format.ts';

/** Bounded raster transport shared by the two map adapters; one instance per mounted overlay. */
export interface RasterTileResponse { data: ArrayBuffer; cacheControl?: string; expires?: string }
export interface RasterTileProtocol {
  scheme: string;
  url(templateOrTileUrl: string): string;
  load(params: { url: string }, controller: AbortController): Promise<RasterTileResponse>;
  dispose(): void;
}
interface TileTask { controller: AbortController; start(): Promise<void> }
const abortError = () => new DOMException('Tile request cancelled', 'AbortError');

export function createRasterTileProtocol(baseUrl: string, options: {
  fetchImpl?: typeof fetch; timeoutMs?: number; retryDelayMs?: number; maxActive?: number; maxQueued?: number;
} = {}): RasterTileProtocol {
  const base = new URL(baseUrl), fetchImpl = options.fetchImpl ?? fetch;
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid raster API base');
  const prefix = `${base.pathname.replace(/\/+$/, '')}/tiles/`;
  const scheme = `av-raster-${crypto.randomUUID()}`, schemePrefix = `${scheme}://`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, retryDelayMs = options.retryDelayMs ?? 200;
  const maxActive = options.maxActive ?? 2, maxQueued = options.maxQueued ?? 64;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(retryDelayMs) || retryDelayMs < 0 || !Number.isInteger(maxActive) || maxActive < 1 || maxActive > 16 || !Number.isInteger(maxQueued) || maxQueued < 1 || maxQueued > 512) throw new Error('Invalid raster request timing');
  const queued: TileTask[] = [], active = new Set<TileTask>();
  let disposed = false;

  function validate(url: string, template: boolean): string {
    if (url.length > 4096) throw new Error('Raster URL exceeds budget');
    const parsed = new URL(template ? url.replace(/\{[zxy]\}/g, '0') : url);
    const path = parsed.pathname.slice(prefix.length);
    if (parsed.origin !== base.origin || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname.startsWith(prefix) || !/^[a-zA-Z0-9_-]{1,128}\/[a-zA-Z0-9_-]{1,128}\/[a-zA-Z0-9_-]{1,128}\/[a-zA-Z0-9_-]{1,128}\/\d{1,2}\/\d{1,10}\/\d{1,10}\.webp$/.test(path)) throw new Error('Raster URL must identify a tile on the configured API');
    return url;
  }
  function pump(): void {
    while (!disposed && active.size < maxActive && queued.length) {
      const task = queued.shift()!; active.add(task);
      void task.start();
    }
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
    const length = response.headers.get('content-length');
    if (!response.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_TILE_BYTES)) || response.headers.get('content-type')?.split(';')[0] !== 'image/webp') {
      void response.body?.cancel().catch(() => {}); throw new Error('Invalid raster response type or size');
    }
    const reader = response.body.getReader(), buffer = new Uint8Array(length === null ? MAX_TILE_BYTES : Number(length));
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
      if (used < 12 || (length !== null && used !== Number(length)) || buffer[0] !== 82 || buffer[1] !== 73 || buffer[2] !== 70 || buffer[3] !== 70 || buffer[8] !== 87 || buffer[9] !== 69 || buffer[10] !== 66 || buffer[11] !== 80) throw new Error('Invalid WebP tile');
      return buffer.slice(0, used).buffer;
    } finally {
      signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock();
    }
  }
  async function request(url: string, signal: AbortSignal): Promise<RasterTileResponse> {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      let response: Response;
      try { response = await fetchImpl(url, { signal, redirect: 'error', headers: { accept: 'image/webp' } }); }
      catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof TypeError) || attempt === 2) throw error;
        await delay(retryDelayMs * (attempt + 1) + Math.random() * retryDelayMs, signal); continue;
      }
      if ([502, 503, 504].includes(response.status) && attempt < 2) {
        void response.body?.cancel().catch(() => {});
        await delay(retryDelayMs * (attempt + 1) + Math.random() * retryDelayMs, signal); continue;
      }
      if (response.status !== 200) { void response.body?.cancel().catch(() => {}); throw new Error(`Raster request failed: HTTP ${response.status}`); }
      return { data: await body(response, signal), cacheControl: response.headers.get('cache-control') ?? undefined, expires: response.headers.get('expires') ?? undefined };
    }
    throw new Error('Raster retry budget exhausted');
  }
  return {
    scheme,
    url: url => `${schemePrefix}${validate(url, true)}`,
    async load(params, external) {
      if (!params.url.startsWith(schemePrefix)) throw new Error('Incorrect raster protocol');
      const url = validate(params.url.slice(schemePrefix.length), false);
      if (disposed) throw abortError();
      external.signal.throwIfAborted();
      if (active.size >= maxActive && queued.length >= maxQueued) throw new Error('Raster request queue is full');
      return new Promise<RasterTileResponse>((resolve, reject) => {
        const controller = new AbortController();
        const abort = () => controller.abort(external.signal.reason ?? abortError());
        const cleanup = () => { clearTimeout(timer); external.signal.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', cancelQueued); };
        const cancelQueued = () => {
          const index = queued.indexOf(task);
          if (index >= 0) { queued.splice(index, 1); cleanup(); reject(controller.signal.reason); pump(); }
        };
        const task: TileTask = { controller, async start() {
          try { const result = await request(url, controller.signal); controller.signal.throwIfAborted(); resolve(result); }
          catch (error) { reject(error); }
          finally { cleanup(); active.delete(task); pump(); }
        } };
        const timer = setTimeout(() => controller.abort(new DOMException('Tile request deadline exceeded', 'TimeoutError')), timeoutMs);
        external.signal.addEventListener('abort', abort, { once: true });
        controller.signal.addEventListener('abort', cancelQueued, { once: true });
        queued.push(task); pump();
      });
    },
    dispose() {
      disposed = true;
      for (const task of [...queued, ...active]) task.controller.abort(abortError());
    }
  };
}
