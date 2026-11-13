import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, attachNativeProfiles, createV5Fixture } from './v5-fixture';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const edgePolicy = 'cloudflare-cdn-cache-control';
const tilePath = (fixture: ReturnType<typeof createV5Fixture>) =>
  `/tiles/${fixture.manifest.model}/${fixture.buildId}/usable-lift-agl/h001/1/0/0.webp`;

function client(fixture = createV5Fixture()) {
  const pending: Promise<unknown>[] = [];
  const limiter = { limit: vi.fn(async () => ({ success: true })) };
  const request = async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('cf-connecting-ip', '192.0.2.1');
    const result = await fixture.app.fetch(new Request(`https://api.test${path}`, { ...init, headers }),
      { BUCKET: fixture.bucket, SAMPLE_RATE_LIMITER: limiter }, { waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending.splice(0));
    return result;
  };
  return { ...fixture, request, limiter };
}

describe('front-of-Worker tile caching', () => {
  it('returns expiry-bounded tile policies for GET, HEAD and conditional responses', async () => {
    const fixture = client(), path = tilePath(fixture);
    const first = await fixture.request(path);
    expect(first.status).toBe(200);
    expect(first.headers.get(edgePolicy)).toBe('public, max-age=86400, must-revalidate');
    expect(first.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
    expect(first.headers.get('access-control-expose-headers')?.split(', ')).toEqual(expect.arrayContaining(['Cf-Cache-Status', 'Age']));
    await first.arrayBuffer();

    vi.setSystemTime(Date.parse(fixture.manifest.expiresAt) - 1500);
    for (const init of [{ method: 'HEAD' }, { headers: { 'if-none-match': first.headers.get('etag')! } }]) {
      const result = await fixture.request(path, init);
      expect(result.status).toBe(init.method === 'HEAD' ? 200 : 304);
      expect(result.headers.get(edgePolicy)).toBe('public, max-age=1, must-revalidate');
      expect(await result.text()).toBe('');
    }
    vi.setSystemTime(Date.parse(fixture.manifest.expiresAt));
    const expired = await fixture.request(path, { headers: { 'if-none-match': first.headers.get('etag')! } });
    expect(expired.status).toBe(404);
    expect(expired.headers.get(edgePolicy)).toBe('no-store');
    await expired.arrayBuffer();
  });

  it('never reads or writes tile responses through the in-handler Cache API', async () => {
    const cache = {
      match: vi.fn(async (request: Request) => new URL(request.url).pathname.startsWith('/tiles/')
        ? new Response('stale tile') : undefined),
      put: vi.fn(async (_request: Request, response: Response) => { await response.arrayBuffer(); })
    };
    vi.stubGlobal('caches', { default: cache });
    const fixture = client(), path = tilePath(fixture);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await fixture.request(path);
      expect(result.status).toBe(200);
      expect(result.headers.get('x-av-response-cache')).toBe('not-applicable');
      const bytes = new Uint8Array(await result.arrayBuffer());
      expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
    }
    const tileCalls = [...cache.match.mock.calls, ...cache.put.mock.calls]
      .filter(([request]) => new URL(request.url).pathname.startsWith('/tiles/'));
    expect(tileCalls).toEqual([]);
    expect(cache.put).toHaveBeenCalled();
  });

  it('refuses to populate the front cache when a tile expires during a storage read', async () => {
    const fixture = client(), get = fixture.get.getMockImplementation()!;
    fixture.get.mockImplementation(async (key, options) => {
      const result = await get(key, options);
      if (key.endsWith('/tiles.bin')) vi.setSystemTime(Date.parse(fixture.manifest.expiresAt));
      return result;
    });
    const result = await fixture.request(tilePath(fixture));
    expect(result.status).toBe(404);
    expect(result.headers.get(edgePolicy)).toBe('no-store');
    expect(result.headers.get('cache-control')).toBe('no-store');
    await result.arrayBuffer();
  });

  it('keeps discovery, point data and other successful responses outside the front cache', async () => {
    const fixture = client(attachNativeProfiles(createV5Fixture()));
    const prefix = `/v1/models/${fixture.manifest.model}/runs/${fixture.buildId}`;
    for (const path of ['/healthz', '/docs', '/openapi.json', '/v1/catalog',
      `/v1/models/${fixture.manifest.model}/latest?expand=manifest`, `/v1/models/${fixture.manifest.model}/runs`,
      prefix, `${prefix}/provenance`, `${prefix}/layers/usable-lift-agl/h001/tilejson.json`,
      `${prefix}/sample?lat=9&lon=-180&layers=precip-rate`,
      `${prefix}/samples?points=9,-180&layers=precip-rate`, `${prefix}/profile?lat=9&lon=-180`]) {
      const result = await fixture.request(path);
      expect(result.status, path).toBe(200);
      expect(result.headers.get(edgePolicy), path).toBe('no-store');
      await result.arrayBuffer();
    }
    expect(fixture.limiter.limit).toHaveBeenCalledTimes(3);
  });

  it('keeps repeated point requests subject to rate limits', async () => {
    const fixture = client(), path = `/v1/models/${fixture.manifest.model}/runs/${fixture.buildId}/sample?lat=9&lon=-180&layers=precip-rate`;
    const first = await fixture.request(path);
    expect(first.status).toBe(200);
    expect(first.headers.get(edgePolicy)).toBe('no-store');
    await first.arrayBuffer();
    const reads = fixture.get.mock.calls.length;
    fixture.limiter.limit.mockResolvedValue({ success: false });
    const rejected = await fixture.request(path);
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get(edgePolicy)).toBe('no-store');
    expect(fixture.limiter.limit).toHaveBeenCalledTimes(2);
    expect(fixture.get).toHaveBeenCalledTimes(reads);
    await rejected.arrayBuffer();
  });

  it('keeps early rejections, tile failures and preflight outside the front cache', async () => {
    const fixture = client(createV5Fixture({ coveredTile: true })), path = tilePath(fixture);
    for (const [url, init, status] of [
      [path, { method: 'POST' }, 405], [path, { method: 'OPTIONS' }, 204],
      [path.replace('/1/0/0.webp', '/0/0/0.webp'), undefined, 503],
      [path.replace('/h001/', '/h999/'), undefined, 404],
      [path + '?unknown=1', undefined, 400], [path.replace('/tiles/', '/%74iles/'), undefined, 400],
      ['/docs?unknown=1', undefined, 400], ['/openapi.json?unknown=1', undefined, 400],
      ['/unknown', undefined, 404], [path + '?' + 'x'.repeat(16 * 1024), undefined, 400]
    ] satisfies [string, RequestInit | undefined, number][]) {
      const result = await fixture.request(url, init);
      expect(result.status, url).toBe(status);
      expect(result.headers.get(edgePolicy), url).toBe('no-store');
      await result.arrayBuffer();
    }
  });
});
