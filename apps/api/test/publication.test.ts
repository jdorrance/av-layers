import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index';
import { admit, manifest } from '../src/publication';
import { NOW, createV5Fixture } from './v5-fixture';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const retained = (m: ReturnType<typeof createV5Fixture>['manifest']) => ({ buildId: m.buildId, manifestKey: `builds/${m.model}/${m.buildId}/manifest.json`, cycle: m.cycle, expiresAt: m.expiresAt });

describe('validated publication reuse', () => {
  it('shares cold static validation and reuses it while rechecking retained-entry binding', async () => {
    const fixture = createV5Fixture(), entry = await admit(fixture.bucket, fixture.manifest.model, fixture.buildId);
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const load = () => manifest(fixture.bucket, fixture.manifest.model, fixture.buildId, entry, undefined, fixture.product);
    const [first, second] = await Promise.all([load(), load()]);
    expect(first).toBe(second);
    expect(digest).toHaveBeenCalledTimes(fixture.manifest.surfaces.length);
    const reads = fixture.get.mock.calls.length;
    digest.mockClear();
    expect(await load()).toBe(first);
    expect(digest).not.toHaveBeenCalled();
    expect(fixture.get).toHaveBeenCalledTimes(reads);
    await expect(manifest(fixture.bucket, fixture.manifest.model, fixture.buildId, { ...entry, cycle: '2026-10-31T00:00:00Z' }, undefined, fixture.product)).rejects.toThrow('retained entry');
    await load();
    expect(digest).toHaveBeenCalledTimes(fixture.manifest.surfaces.length);
  });

  it('retries failed validation for a new product identity against a warm manifest', async () => {
    const fixture = createV5Fixture(), entry = retained(fixture.manifest);
    await manifest(fixture.bucket, fixture.manifest.model, fixture.buildId, entry, undefined, fixture.product);
    const product = { ...fixture.product }, digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('digest unavailable'));
    await expect(manifest(fixture.bucket, fixture.manifest.model, fixture.buildId, entry, undefined, product)).rejects.toThrow('digest unavailable');
    digest.mockClear();
    await manifest(fixture.bucket, fixture.manifest.model, fixture.buildId, entry, undefined, product);
    expect(digest).toHaveBeenCalledTimes(fixture.manifest.surfaces.length);
  });

  it('validates again after manifest eviction', async () => {
    const fixture = createV5Fixture(), entry = retained(fixture.manifest);
    const load = () => manifest(fixture.bucket, fixture.manifest.model, fixture.buildId, entry, undefined, fixture.product);
    await load();
    for (let i = 0; i < 65; i++) {
      const other = createV5Fixture({ buildId: `20261101T000000Z-00000000-0000-0000-0000-${String(i + 2).padStart(12, '0')}` });
      for (const [key, value] of other.objects) fixture.objects.set(key, value);
      await manifest(fixture.bucket, other.manifest.model, other.buildId, retained(other.manifest), undefined, fixture.product);
    }
    const digest = vi.spyOn(crypto.subtle, 'digest');
    await load();
    expect(digest).toHaveBeenCalledTimes(fixture.manifest.surfaces.length);
    expect(fixture.get.mock.calls.filter(([key]) => key === entry.manifestKey)).toHaveLength(2);
  });

  it('admits warm cache hits and rejects a newly incompatible product before cache delivery', async () => {
    const fixture = createV5Fixture();
    const cache = { match: vi.fn(async () => new Response(Uint8Array.of(1, 2, 3), { headers: { 'content-type': 'image/webp', 'content-length': '3' } })) };
    vi.stubGlobal('caches', { default: cache });
    const path = `/tiles/${fixture.manifest.model}/${fixture.buildId}/usable-lift-agl/h001/1/0/0.webp`;
    const first = await fixture.request(path);
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const warm = await fixture.request(path);
    expect(warm.status).toBe(200);
    expect(warm.headers.get('x-av-r2-reads')).toBe('0');
    expect(warm.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
    await warm.arrayBuffer();
    expect(digest).not.toHaveBeenCalled();
    const matches = cache.match.mock.calls.length;
    const changed = createApp({ products: { [fixture.manifest.model]: { ...fixture.product, attribution: 'Changed deployment attribution' } } });
    const rejected = await changed.fetch(new Request(`https://api.test${path}`), { BUCKET: fixture.bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) } }, { waitUntil() {} });
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('cache-control')).toBe('no-store');
    expect(cache.match).toHaveBeenCalledTimes(matches);
    await rejected.arrayBuffer();
    vi.setSystemTime(Date.parse(fixture.manifest.expiresAt));
    const expired = await fixture.request(path);
    expect(expired.status).toBe(404);
    expect(expired.headers.get('cache-control')).toBe('no-store');
    expect(cache.match).toHaveBeenCalledTimes(matches);
    await expired.arrayBuffer();
  });

  it.each([new Error('R2 backend timeout'), new TypeError('R2 transport failure')])('returns a retryable status for a storage $name', async error => {
    const fixture = createV5Fixture();
    fixture.get.mockRejectedValueOnce(error);
    const outage = await fixture.request(`/v1/models/${fixture.manifest.model}/latest`);
    expect(outage.status).toBe(503);
    expect(await outage.json()).toMatchObject({ title: 'publication-unavailable', status: 503 });
  });

  it('returns a retryable status for an incomplete R2 provenance body', async () => {
    const fixture = createV5Fixture(), get = fixture.get.getMockImplementation()!;
    fixture.get.mockImplementation(async (key, options) => {
      if (!key.endsWith('/provenance.json')) return get(key, options);
      return { size: fixture.objects.get(key)!.byteLength, body: new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(123)); controller.close(); } }) };
    });
    const result = await fixture.request(`/v1/models/${fixture.manifest.model}/runs/${fixture.buildId}/provenance`);
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ title: 'publication-unavailable', status: 503 });
  });
});
