import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/index';
import { NOW, createV5Fixture } from './v5-fixture';

type Fixture = ReturnType<typeof createV5Fixture>;
class EdgeCache {
  entries = new Map<string, { response: Response; until: number }>();
  matches = 0;
  puts = 0;
  async match(request: Request): Promise<Response | undefined> {
    this.matches++;
    const entry = this.entries.get(request.url);
    return entry && entry.until > Date.now() ? entry.response.clone() : undefined;
  }
  async put(request: Request, response: Response): Promise<void> {
    this.puts++;
    const seconds = Number(/s-maxage=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1] ?? 0);
    const until = Date.parse(response.headers.get('date')!) + seconds * 1000;
    this.entries.set(request.url, { response: new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers }), until });
  }
}
let cache: EdgeCache;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); cache = new EdgeCache(); vi.stubGlobal('caches', { default: cache }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function call(fixture: Fixture, path: string, options: { app?: ReturnType<typeof createApp>; cache?: 'off'; method?: string } = {}): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const response = await (options.app ?? fixture.app).fetch(new Request(`https://api.test${path}`, { method: options.method, headers: { 'cf-connecting-ip': '192.0.2.1' } }), {
    BUCKET: fixture.bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) }, AV_RESPONSE_CACHE: options.cache
  }, { waitUntil(promise) { pending.push(promise); } });
  const bytes = await response.arrayBuffer();
  await Promise.all(pending);
  return new Response(response.status === 304 ? null : bytes, { status: response.status, headers: response.headers });
}
const metadata = ['/v1/catalog', '/v1/models/gfs/latest', '/v1/models/gfs/latest?expand=manifest', '/v1/models/gfs/runs'];
const pointer = (fixture: Fixture) => JSON.parse(new TextDecoder().decode(fixture.objects.get('catalog/gfs/latest.json')!));
const writePointer = (fixture: Fixture, value: unknown) => fixture.objects.set('catalog/gfs/latest.json', new TextEncoder().encode(JSON.stringify(value)));

it.each(metadata)('reuses bounded edge responses while browsers revalidate: %s', async path => {
  const fixture = createV5Fixture();
  const first = await call(fixture, path);
  expect(first.status).toBe(200);
  expect(first.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=15, must-revalidate');
  expect(first.headers.get('x-av-response-cache')).toBe('miss');
  const body = await first.text(), reads = fixture.get.mock.calls.length;
  vi.setSystemTime(NOW + 1000);
  const hit = await call(fixture, path);
  expect(hit.status).toBe(200);
  expect(hit.headers.get('x-av-response-cache')).toBe('hit');
  expect(hit.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=14, must-revalidate');
  expect(await hit.text()).toBe(body);
  expect(fixture.get).toHaveBeenCalledTimes(reads);
  expect(cache.puts).toBe(1);
});

it('keeps expansion variants separate and caps edge freshness by pointer age', async () => {
  const fixture = createV5Fixture();
  await call(fixture, '/v1/models/gfs/latest');
  vi.setSystemTime(NOW + 10_000);
  const expanded = await call(fixture, '/v1/models/gfs/latest?expand=manifest');
  expect(expanded.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=5, must-revalidate');
  expect(await expanded.json()).toHaveProperty('manifest');
  expect(cache.entries.size).toBe(2);
  expect([...cache.entries.values()].every(entry => entry.until === NOW + 15_000)).toBe(true);
  vi.setSystemTime(NOW + 14_000);
  const hit = await call(fixture, '/v1/models/gfs/latest');
  expect(hit.headers.get('cache-control')).toContain('s-maxage=1,');
  expect(hit.headers.get('x-av-response-cache')).toBe('hit');
  vi.setSystemTime(NOW + 15_000);
  const refreshed = await call(fixture, '/v1/models/gfs/latest');
  expect(refreshed.headers.get('x-av-response-cache')).toBe('miss');
  expect(refreshed.headers.get('cache-control')).toContain('s-maxage=15,');
  expect(await refreshed.json()).toMatchObject({ freshness: { ageSeconds: 15 } });
});

it('changes cached discovery when latest or retained membership changes after refresh', async () => {
  const fixture = createV5Fixture(), original = pointer(fixture);
  const next = createV5Fixture({ buildId: '20261101T000000Z-00000000-0000-0000-0000-000000000002' });
  for (const [key, bytes] of next.objects) fixture.objects.set(key, bytes);
  const newer = pointer(fixture);
  writePointer(fixture, { ...newer, retained: [...original.retained, ...newer.retained] });
  expect(await (await call(fixture, '/v1/models/gfs/latest')).json()).toMatchObject({ pointer: { latestBuildId: next.buildId } });
  const firstKeys = new Set(cache.entries.keys());
  writePointer(fixture, { ...newer, latestBuildId: fixture.buildId, retained: [...original.retained, ...newer.retained] });
  vi.setSystemTime(NOW + 15_000);
  const rollback = await call(fixture, '/v1/models/gfs/latest');
  expect(rollback.headers.get('x-av-response-cache')).toBe('miss');
  expect(await rollback.json()).toMatchObject({ pointer: { latestBuildId: fixture.buildId } });
  expect([...cache.entries.keys()].some(key => !firstKeys.has(key))).toBe(true);
  const before = await call(fixture, '/v1/models/gfs/runs');
  expect((await before.json() as { retained: unknown[] }).retained).toHaveLength(2);
  writePointer(fixture, original);
  vi.setSystemTime(NOW + 30_000);
  const pruned = await call(fixture, '/v1/models/gfs/runs');
  expect(pruned.headers.get('x-av-response-cache')).toBe('miss');
  expect((await pruned.json() as { retained: unknown[] }).retained).toHaveLength(1);
});

it('bounds unavailable catalog caching by the remaining negative-pointer deadline', async () => {
  const fixture = createV5Fixture();
  fixture.objects.delete('catalog/gfs/latest.json');
  const first = await call(fixture, '/v1/catalog');
  expect(first.status).toBe(200);
  expect(first.headers.get('cache-control')).toContain('s-maxage=5,');
  expect(await first.json()).toMatchObject({ models: [{ available: false }] });
  vi.setSystemTime(NOW + 4000);
  const hit = await call(fixture, '/v1/catalog');
  expect(hit.headers.get('x-av-response-cache')).toBe('hit');
  expect(hit.headers.get('cache-control')).toContain('s-maxage=1,');
  const installed = createV5Fixture();
  fixture.objects.set('catalog/gfs/latest.json', installed.objects.get('catalog/gfs/latest.json')!);
  vi.setSystemTime(NOW + 5000);
  const ready = await call(fixture, '/v1/catalog');
  expect(ready.headers.get('x-av-response-cache')).toBe('miss');
  expect(await ready.json()).toMatchObject({ models: [{ available: true }] });
});

it('validates deployed products before hits and separates compatible configuration changes', async () => {
  const fixture = createV5Fixture();
  await call(fixture, '/v1/models/gfs/latest?expand=manifest');
  const matches = cache.matches;
  const invalid = createApp({ products: { gfs: { ...fixture.product, attribution: 'Incompatible descriptors' } } });
  const rejected = await call(fixture, '/v1/models/gfs/latest?expand=manifest', { app: invalid });
  expect(rejected.status).toBe(503);
  expect(rejected.headers.get('cache-control')).toBe('no-store');
  expect(cache.matches).toBe(matches);
  const changed = createApp({ products: { gfs: { ...fixture.product, label: 'Updated model label' } } });
  await call(fixture, '/v1/catalog');
  const updated = await call(fixture, '/v1/catalog', { app: changed });
  expect(updated.headers.get('x-av-response-cache')).toBe('miss');
  expect(await updated.json()).toMatchObject({ models: [{ label: 'Updated model label' }] });
});

it('caps runs at retained expiry and re-filters when cache lookup crosses that deadline', async () => {
  const fixture = createV5Fixture(), current = pointer(fixture);
  current.retained.push({ ...current.retained[0], buildId: '20261101T000000Z-00000000-0000-0000-0000-000000000003', manifestKey: 'builds/gfs/20261101T000000Z-00000000-0000-0000-0000-000000000003/manifest.json', expiresAt: new Date(NOW + 2000).toISOString() });
  writePointer(fixture, current);
  const first = await call(fixture, '/v1/models/gfs/runs');
  expect(first.headers.get('cache-control')).toContain('s-maxage=2,');
  const match = cache.match.bind(cache);
  vi.spyOn(cache, 'match').mockImplementation(async request => { const response = await match(request); vi.setSystemTime(NOW + 2000); return response; });
  const crossed = await call(fixture, '/v1/models/gfs/runs');
  expect(crossed.headers.get('cache-control')).toContain('s-maxage=0,');
  expect((await crossed.json() as { retained: unknown[] }).retained).toHaveLength(1);
});

it.each(['/v1/models/gfs/latest', '/v1/catalog'])('rejects a build expiring during edge lookup: %s', async path => {
  const fixture = createV5Fixture();
  await call(fixture, path);
  const match = cache.match.bind(cache);
  vi.spyOn(cache, 'match').mockImplementation(async request => { const response = await match(request); vi.setSystemTime(Date.parse(fixture.manifest.expiresAt)); return response; });
  const expired = await call(fixture, path);
  expect(expired.status).toBe(404);
  expect(expired.headers.get('cache-control')).toBe('no-store');
});

it('bypasses response cache when disabled and keeps health and errors uncached', async () => {
  const fixture = createV5Fixture();
  const bypass = await call(fixture, '/v1/models/gfs/latest', { cache: 'off' });
  expect(bypass.status).toBe(200);
  expect(bypass.headers.get('x-av-response-cache')).toBe('bypass');
  expect(cache.matches).toBe(0); expect(cache.puts).toBe(0);
  for (const path of ['/healthz', '/v1/models/unknown/latest', '/v1/models/gfs/latest?invalid=true']) {
    const response = await call(fixture, path);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect(cache.matches).toBe(0); expect(cache.puts).toBe(0);
});
