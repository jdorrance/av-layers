import { afterEach, expect, it, vi } from 'vitest';
import { createRasterTileProtocol, createSourceRasterTileProtocol } from './client-raster';
const base = 'https://api.test';
const tile = (x = 0) => `${base}/tiles/gfs/build/usable-lift-msl/f003/7/${x}/50.webp`;
const webp = () => new Response(Uint8Array.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]), { headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=100' } });
const disposals: Array<() => void> = [];
function setup(options: Parameters<typeof createRasterTileProtocol>[1]) { const protocol = createRasterTileProtocol(base, options); disposals.push(protocol.dispose); return protocol; }
function setupSources(options: Parameters<typeof createRasterTileProtocol>[1]) { const protocol = createSourceRasterTileProtocol(base, options); disposals.push(protocol.dispose); return protocol; }
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });
function heldFetch() {
  const finish: Array<(response: Response) => void> = [];
  const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise((resolve, reject) => {
    const abort = () => reject(init!.signal!.reason);
    init!.signal!.addEventListener('abort', abort, { once: true });
    finish.push(response => { init!.signal!.removeEventListener('abort', abort); resolve(response); });
  }));
  return { fetchImpl, finish };
}
it('admits two active requests, drains queued tiles, and preserves cache metadata', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 2 });
  const pending = Array.from({ length: 5 }, (_, i) => protocol.load({ url: protocol.url(tile(i)) }, new AbortController()));
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  for (let i = 0; i < pending.length; i++) {
    finish[i](webp());
    await vi.waitFor(() => expect(fetchImpl.mock.calls.length).toBe(Math.min(i + 3, 5)));
  }
  for (const result of await Promise.all(pending)) {
    expect(result.cacheControl).toBe('public, max-age=100');
  }
});
it('honors custom active and queued limits and drains the admitted queue', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 3, maxQueued: 1 });
  const pending = Array.from({ length: 4 }, (_, i) => protocol.load({ url: protocol.url(tile(i)) }, new AbortController()));
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  await expect(protocol.load({ url: protocol.url(tile(4)) }, new AbortController())).rejects.toThrow('queue is full');
  for (let i = 0; i < pending.length; i++) {
    finish[i](webp());
    await pending[i];
  }
  expect(fetchImpl).toHaveBeenCalledTimes(4);
});
it.each([{ maxActive: 0 }, { maxActive: 17 }, { maxActive: 1.5 }, { maxActive: NaN }, { maxQueued: 0 }, { maxQueued: 513 }, { maxQueued: 1.5 }, { maxQueued: Infinity }])('rejects invalid raster admission limits: %j', options => {
  expect(() => createRasterTileProtocol(base, options)).toThrow('Invalid raster request');
});
it('bounds admission and disposes both queued and active requests without starting queued work', async () => {
  const { fetchImpl } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 2 });
  const promises = Array.from({ length: 67 }, (_, i) => protocol.load({ url: protocol.url(tile(i)) }, new AbortController()));
  const outcomes = Promise.allSettled(promises);
  await expect(promises[66]).rejects.toThrow('queue is full');
  protocol.dispose();
  const settled = await outcomes;
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(settled.every(item => item.status === 'rejected')).toBe(true);
  await expect(protocol.load({ url: protocol.url(tile()) }, new AbortController())).rejects.toMatchObject({ name: 'AbortError' });
});
it('removes a cancelled queued request before it can consume a network slot', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 2 });
  const controllers = Array.from({ length: 3 }, () => new AbortController());
  const pending = controllers.map((c, i) => protocol.load({ url: protocol.url(tile(i)) }, c));
  const cancelled = expect(pending[2]).rejects.toMatchObject({ name: 'AbortError' });
  controllers[2].abort(); await cancelled;
  finish[0](webp()); finish[1](webp()); await Promise.all(pending.slice(0, 2));
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it('retries transient failures finitely and never substitutes an empty successful tile', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('busy', { status: 503 })).mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(webp());
  const protocol = setup({ fetchImpl, retryDelayMs: 0 });
  expect((await protocol.load({ url: protocol.url(tile()) }, new AbortController())).data.byteLength).toBe(12);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  protocol.evictBuild();
  fetchImpl.mockReset().mockImplementation(async () => new Response('busy', { status: 503 }));
  await expect(protocol.load({ url: protocol.url(tile()) }, new AbortController())).rejects.toThrow('HTTP 503');
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  fetchImpl.mockReset().mockResolvedValue(new Response('missing', { status: 404 }));
  await expect(protocol.load({ url: protocol.url(tile()) }, new AbortController())).rejects.toThrow('HTTP 404');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it('enforces the total deadline during body consumption and cancels the stalled stream', async () => {
  vi.useFakeTimers(); const cancel = vi.fn();
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'image/webp' } }));
  const protocol = setup({ fetchImpl, timeoutMs: 10 });
  const pending = expect(protocol.load({ url: protocol.url(tile()) }, new AbortController())).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(11); await pending; expect(cancel).toHaveBeenCalled();
});
it('cancels an active response body on caller abort and releases its slot for a queued tile', async () => {
  const cancelled = [vi.fn(), vi.fn()];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(async () => new Response(new ReadableStream({ cancel: cancelled[0] }), { headers: { 'content-type': 'image/webp' } }))
    .mockImplementationOnce(async () => new Response(new ReadableStream({ cancel: cancelled[1] }), { headers: { 'content-type': 'image/webp' } }))
    .mockImplementation(async () => webp());
  const protocol = setup({ fetchImpl, maxActive: 2 }), controllers = [new AbortController(), new AbortController()];
  const active = controllers.map((controller, i) => protocol.load({ url: protocol.url(tile(i)) }, controller));
  const rejected = active.map(pending => expect(pending).rejects.toMatchObject({ name: 'AbortError' }));
  const queued = protocol.load({ url: protocol.url(tile(2)) }, new AbortController());
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  await Promise.resolve(); await Promise.resolve();
  controllers[0].abort(); await rejected[0];
  expect((await queued).data.byteLength).toBe(12); expect(cancelled[0]).toHaveBeenCalled();
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  controllers[1].abort(); await rejected[1]; expect(cancelled[1]).toHaveBeenCalled();
});
it('cancels retry backoff on disposal and does not make another request', async () => {
  vi.useFakeTimers(); const fetchImpl = vi.fn<typeof fetch>(async () => new Response('busy', { status: 503 }));
  const protocol = setup({ fetchImpl });
  const pending = expect(protocol.load({ url: protocol.url(tile()) }, new AbortController())).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(1); protocol.dispose(); await pending;
  await vi.advanceTimersByTimeAsync(1000); expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it.each(['https://other.test/tiles/gfs/build/layer/f003/0/0/0.webp', 'https://api.test/v1/catalog', `${tile()}?bypass=1`, `${tile()}#fragment`, 'https://user@api.test/tiles/gfs/build/layer/f003/0/0/0.webp'])('rejects an untrusted or non-tile URL before fetching: %s', url => {
  const fetchImpl = vi.fn<typeof fetch>(), protocol = setup({ fetchImpl });
  expect(() => protocol.url(url)).toThrow(); expect(fetchImpl).not.toHaveBeenCalled();
});
it('rejects oversized and corrupt bodies without retries', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(1024 * 1024 + 1), { headers: { 'content-type': 'image/webp' } }));
  const protocol = setup({ fetchImpl });
  await expect(protocol.load({ url: protocol.url(tile()) }, new AbortController())).rejects.toThrow('byte budget');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  fetchImpl.mockResolvedValue(new Response('not an image', { headers: { 'content-type': 'image/webp' } }));
  await expect(protocol.load({ url: protocol.url(tile()) }, new AbortController())).rejects.toThrow('Invalid WebP');
});
it('returns independent cached buffers and expires entries at the pinned build deadline', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  const fetchImpl = vi.fn<typeof fetch>(async () => webp()), protocol = setup({ fetchImpl });
  protocol.setBuildExpiry('build', 10_100);
  const first = await protocol.load({ url: protocol.url(tile()) }, new AbortController());
  new Uint8Array(first.data)[0] = 0;
  const second = await protocol.load({ url: protocol.url(tile()) }, new AbortController());
  expect(new Uint8Array(second.data)[0]).toBe(82);
  expect(second.data).not.toBe(first.data);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(protocol.stats()).toMatchObject({ cacheHits: 1, cachedBytes: 12, cachedTiles: 1 });
  await vi.advanceTimersByTimeAsync(101);
  expect(protocol.stats().cachedBytes).toBe(0);
  await expect(protocol.load({ url: protocol.url(tile()) }, new AbortController())).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it.each([true, false])('preserves cached bytes after the map transfers a delivered tile buffer (length header=%s)', async lengthHeader => {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const response = webp();
    if (lengthHeader) response.headers.set('content-length', '12');
    return response;
  }), protocol = setup({ fetchImpl });
  const first = await protocol.load({ url: protocol.url(tile()) }, new AbortController());
  const transferred = structuredClone(first.data, { transfer: [first.data] });
  expect(first.data.byteLength).toBe(0);
  expect(transferred.byteLength).toBe(12);
  const cached = await protocol.load({ url: protocol.url(tile()) }, new AbortController());
  expect(new Uint8Array(cached.data)).toEqual(new Uint8Array(transferred));
  expect(fetchImpl).toHaveBeenCalledOnce();
});
it('coalesces prefetch and interactive consumers while cancelling them independently', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl });
  const background = new AbortController();
  const prefetch = protocol.prefetch(tile(), background.signal);
  const prefetchAborted = expect(prefetch).rejects.toMatchObject({ name: 'AbortError' });
  const interactive = protocol.load({ url: protocol.url(tile()) }, new AbortController());
  background.abort(); await prefetchAborted;
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0][1]!.signal!.aborted).toBe(false);
  finish[0](webp());
  expect((await interactive).data.byteLength).toBe(12);
  expect(protocol.stats().coalesced).toBe(1);
});
it('dispatches newer interactive work ahead of prefetch and older interactive work', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 1 });
  const first = protocol.load({ url: protocol.url(tile(0)) }, new AbortController());
  const background = protocol.prefetch(tile(1));
  const old = protocol.load({ url: protocol.url(tile(2)) }, new AbortController());
  const newest = protocol.load({ url: protocol.url(tile(3)) }, new AbortController());
  finish[0](webp()); await first;
  expect(fetchImpl.mock.calls[1][0]).toBe(tile(3));
  finish[1](webp()); await newest;
  expect(fetchImpl.mock.calls[2][0]).toBe(tile(2));
  finish[2](webp()); await old;
  expect(fetchImpl.mock.calls[3][0]).toBe(tile(1));
  finish[3](webp()); await background;
});
it('promotes an already queued prefetch when an interactive consumer joins', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 1 });
  const first = protocol.load({ url: protocol.url(tile()) }, new AbortController());
  const background = protocol.prefetch(tile(1));
  const older = protocol.load({ url: protocol.url(tile(2)) }, new AbortController());
  const promoted = protocol.load({ url: protocol.url(tile(1)) }, new AbortController());
  finish[0](webp()); await first;
  expect(fetchImpl.mock.calls[1][0]).toBe(tile(1));
  finish[1](webp()); await Promise.all([background, promoted]);
  finish[2](webp()); await older;
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});
it('evicts the least-recently-used tile within payload and metadata memory', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => webp()), protocol = setup({ fetchImpl, maxCacheBytes: 1100 });
  const load = (x: number) => protocol.load({ url: protocol.url(tile(x)) }, new AbortController());
  await load(0); await load(1); await load(0); await load(2);
  expect(protocol.stats()).toMatchObject({ cachedBytes: 24, cachedTiles: 2, cacheHits: 1 });
  await load(1);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  protocol.evictBuild('build');
  expect(protocol.stats()).toMatchObject({ cachedBytes: 0, cachedTiles: 0 });
});
it('accounts response Age and disables caching for no-store responses', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const response = webp(); response.headers.set('age', '99'); return response;
  }), protocol = setup({ fetchImpl });
  await protocol.prefetch(tile());
  expect(protocol.stats().cachedTiles).toBe(1);
  await vi.advanceTimersByTimeAsync(1001);
  expect(protocol.stats().cachedTiles).toBe(0);
  fetchImpl.mockImplementation(async () => { const response = webp(); response.headers.set('cache-control', 'no-store'); return response; });
  await protocol.prefetch(tile());
  expect(protocol.stats().cachedTiles).toBe(0);
});
it('supports twelve admitted requests and limits simultaneous prefetches', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 12, maxPrefetchActive: 2 });
  const background = Array.from({ length: 3 }, (_, i) => protocol.prefetch(tile(i)));
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  const foreground = Array.from({ length: 10 }, (_, i) => protocol.load({ url: protocol.url(tile(i + 3)) }, new AbortController()));
  expect(fetchImpl).toHaveBeenCalledTimes(12);
  for (const done of finish.slice()) done(webp());
  await Promise.all(foreground);
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(13));
  finish[12](webp()); await Promise.all(background);
});
it('admits interactive work by dropping queued background work when the queue is full', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 1, maxQueued: 1 });
  const active = protocol.load({ url: protocol.url(tile()) }, new AbortController());
  const background = expect(protocol.prefetch(tile(1))).rejects.toMatchObject({ name: 'AbortError' });
  const foreground = protocol.load({ url: protocol.url(tile(2)) }, new AbortController());
  await background;
  finish[0](webp()); await active;
  expect(fetchImpl.mock.calls[1][0]).toBe(tile(2));
  finish[1](webp()); await foreground;
});
it('expires active and queued work at the build deadline', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  const { fetchImpl } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 1 });
  protocol.setBuildExpiry('build', 10_010);
  const requests = [0, 1].map(x => protocol.load({ url: protocol.url(tile(x)) }, new AbortController()));
  const outcomes = Promise.allSettled(requests);
  await vi.advanceTimersByTimeAsync(11);
  expect((await outcomes).every(result => result.status === 'rejected')).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it('aborts an initial consumer independently and returns distinct coalesced buffers', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl });
  const initial = new AbortController();
  const cancelled = expect(protocol.load({ url: protocol.url(tile()) }, initial)).rejects.toMatchObject({ name: 'AbortError' });
  const next = protocol.load({ url: protocol.url(tile()) }, new AbortController());
  const last = protocol.load({ url: protocol.url(tile()) }, new AbortController());
  initial.abort(); await cancelled;
  expect(fetchImpl.mock.calls[0][1]!.signal!.aborted).toBe(false);
  finish[0](webp());
  const [a, b] = await Promise.all([next, last]);
  expect(a.data).not.toBe(b.data);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('reserves interactive slots under the default prefetch cap', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl });
  const background = Array.from({ length: 4 }, (_, index) => protocol.prefetch(tile(index)));
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  const foreground = protocol.load({ url: protocol.url(tile(4)) }, new AbortController());
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  for (const done of finish.splice(0)) done(webp());
  await foreground;
  expect(fetchImpl).toHaveBeenCalledTimes(5);
  for (const done of finish.splice(0)) done(webp());
  await Promise.all(background);
});

it('drops expired cache entries before a newer tile can evict a live one', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const fetchImpl = vi.fn<typeof fetch>(async url => {
    const response = webp();
    if (String(url).endsWith('/1/50.webp')) response.headers.set('cache-control', 'public, max-age=1');
    return response;
  }), protocol = setup({ fetchImpl, maxCacheBytes: 1100 });
  const load = (x: number) => protocol.load({ url: protocol.url(tile(x)) }, new AbortController());
  await load(0); await load(1);
  await vi.advanceTimersByTimeAsync(1500);
  await load(2); await load(0);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});

it('defaults to four interactive fetches within the measured viewport budget', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl });
  const requests = Array.from({ length: 5 }, (_, i) => protocol.load({ url: protocol.url(tile(i)) }, new AbortController()));
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  for (const done of finish.slice()) done(webp());
  await Promise.all(requests.slice(0, 4));
  expect(fetchImpl).toHaveBeenCalledTimes(5);
  finish[4](webp()); await requests[4];
});

it('charges long tile URLs and headers against cache admission for small blank tiles', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => webp()), protocol = setup({ fetchImpl, maxCacheBytes: 1024 });
  const longUrl = `${base}/tiles/gfs/${'b'.repeat(128)}/${'l'.repeat(128)}/${'f'.repeat(128)}/0/0/0.webp`;
  const load = () => protocol.load({ url: protocol.url(longUrl) }, new AbortController());
  await load(); await load();
  expect(protocol.stats()).toMatchObject({ cachedBytes: 0, cachedTiles: 0 });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  fetchImpl.mockImplementation(async () => { const response = webp(); response.headers.set('cache-control', `public, max-age=100, extension=${'h'.repeat(1024)}`); return response; });
  await protocol.prefetch(tile());
  expect(protocol.stats().cachedTiles).toBe(0);
});

it('preserves the queued prefetch being promoted when the subscriber budget is full', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 1, maxQueued: 2 });
  const active = protocol.load({ url: protocol.url(tile()) }, new AbortController());
  const target = protocol.prefetch(tile(1)).then(() => true, () => false);
  const unrelated = expect(protocol.prefetch(tile(2))).rejects.toMatchObject({ name: 'AbortError' });
  const promoted = protocol.load({ url: protocol.url(tile(1)) }, new AbortController());
  await unrelated;
  finish[0](webp()); await active;
  expect(fetchImpl.mock.calls[1][0]).toBe(tile(1));
  finish[1](webp()); await promoted;
  expect(await target).toBe(true);
  expect(protocol.stats().coalesced).toBe(1);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it('bounds queued prefetches even when the prefetch lane cannot dispatch', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl, maxActive: 2, maxQueued: 1, maxPrefetchActive: 0 });
  const background = protocol.prefetch(tile());
  await expect(protocol.prefetch(tile(1))).rejects.toThrow('queue is full');
  expect(fetchImpl).not.toHaveBeenCalled();
  const promoted = protocol.load({ url: protocol.url(tile()) }, new AbortController());
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  finish[0](webp()); await Promise.all([background, promoted]);
});


it('keeps prepared map sources in the background lane and promotes them without refetching', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setupSources({ fetchImpl });
  const source = protocol.createSource(false);
  const prepared = Array.from({ length: 4 }, (_, i) => protocol.load({ url: source.url(tile(i)) }, new AbortController()));
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  const interactive = protocol.load({ url: protocol.url(tile(4)) }, new AbortController());
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  source.setInteractive(true);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  for (const done of finish.slice()) done(webp());
  await interactive;
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(5));
  finish[4](webp()); await Promise.all(prepared);
  expect(new Set(fetchImpl.mock.calls.map(([url]) => url)).size).toBe(5);
});

it('delivers owned buffers for background map loads and preserves the byte cache after transfer', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => webp()), protocol = setupSources({ fetchImpl });
  const source = protocol.createSource(false), load = () => protocol.load({ url: source.url(tile()) }, new AbortController());
  const first = await load();
  structuredClone(first.data, { transfer: [first.data] });
  expect(first.data.byteLength).toBe(0);
  const cached = await load();
  expect(cached.data.byteLength).toBe(12);
  structuredClone(cached.data, { transfer: [cached.data] });
  expect((await protocol.load({ url: protocol.url(tile()) }, new AbortController())).data.byteLength).toBe(12);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it('disposes a source without cancelling shared tiles or starting its queued work', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setupSources({ fetchImpl, maxActive: 1 });
  const source = protocol.createSource(false), target = protocol.createSource(true);
  const abandoned = [0, 1, 2].map(x => protocol.load({ url: source.url(tile(x)) }, new AbortController()));
  const outcomes = Promise.allSettled(abandoned), staleUrl = source.url(tile(3));
  const visible = protocol.load({ url: target.url(tile(0)) }, new AbortController());
  expect(fetchImpl).toHaveBeenCalledOnce();
  source.dispose();
  expect((await outcomes).every(result => result.status === 'rejected')).toBe(true);
  expect(fetchImpl.mock.calls[0][1]!.signal!.aborted).toBe(false);
  finish[0](webp()); await visible;
  expect(fetchImpl).toHaveBeenCalledOnce();
  await expect(protocol.load({ url: staleUrl }, new AbortController())).rejects.toMatchObject({ name: 'AbortError' });
  expect(() => source.url(tile())).toThrow();
  source.dispose();
});

it('limits retained source handles and releases them for the next selection', async () => {
  const protocol = setupSources({ fetchImpl: vi.fn<typeof fetch>(async () => webp()) });
  const first = protocol.createSource(true), second = protocol.createSource(false);
  expect(() => protocol.createSource(false)).toThrow('source limit');
  first.dispose();
  const next = protocol.createSource(false), url = next.url(tile());
  second.dispose(); protocol.dispose();
  await expect(protocol.load({ url }, new AbortController())).rejects.toMatchObject({ name: 'AbortError' });
  expect(() => protocol.createSource(false)).toThrow();
});

it('demotes queued source work while allowing the current admitted read to settle', async () => {
  const { fetchImpl, finish } = heldFetch(), protocol = setupSources({ fetchImpl, maxActive: 1, maxPrefetchActive: 0 });
  const source = protocol.createSource(true);
  const active = protocol.load({ url: source.url(tile()) }, new AbortController());
  const queued = protocol.load({ url: source.url(tile(1)) }, new AbortController());
  source.setInteractive(false);
  finish[0](webp()); await active;
  expect(fetchImpl).toHaveBeenCalledOnce();
  source.setInteractive(true);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  finish[1](webp()); await queued;
});
