import { afterEach, expect, it, vi } from 'vitest';
import { createRasterTileProtocol } from './client-raster';
const base = 'https://api.test';
const tile = (x = 0) => `${base}/tiles/gfs/build/usable-lift-msl/f003/7/${x}/50.webp`;
const webp = () => new Response(Uint8Array.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]), { headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=100' } });
const disposals: Array<() => void> = [];
function setup(options: Parameters<typeof createRasterTileProtocol>[1]) { const protocol = createRasterTileProtocol(base, options); disposals.push(protocol.dispose); return protocol; }
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
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl });
  const pending = Array.from({ length: 5 }, (_, i) => protocol.load({ url: protocol.url(tile(i)) }, new AbortController()));
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  for (let i = 0; i < pending.length; i++) {
    finish[i](webp());
    expect((await pending[i]).cacheControl).toBe('public, max-age=100');
    expect(fetchImpl.mock.calls.length).toBe(Math.min(i + 3, 5));
  }
});
it('bounds admission and disposes both queued and active requests without starting queued work', async () => {
  const { fetchImpl } = heldFetch(), protocol = setup({ fetchImpl });
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
  const { fetchImpl, finish } = heldFetch(), protocol = setup({ fetchImpl });
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
  const protocol = setup({ fetchImpl }), controllers = [new AbortController(), new AbortController()];
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
