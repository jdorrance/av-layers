import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GFS_PRODUCT, ICON_EU_PRODUCT, manifestV5Schema, sampleResponseV5Schema } from '@av/contracts';
import { createApp } from '../src/index';
import { NOW, commonPoint, createV5Fixture } from './v5-fixture';

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const upgrades = [
  { product: GFS_PRODUCT, olderZoom: 7, zoom: 8 },
  { product: ICON_EU_PRODUCT, olderZoom: 8, zoom: 9 },
  { product: GFS_PRODUCT, olderZoom: 8, zoom: 9 },
  { product: ICON_EU_PRODUCT, olderZoom: 9, zoom: 10 }
];

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('retained v5 zoom compatibility', () => {
  it.each(upgrades)('serves retained and new $product.modelId builds after upgrading z$olderZoom to z$zoom', async ({ product, olderZoom, zoom }) => {
    const previous = createV5Fixture({ product, maxZoom: olderZoom });
    const current = createV5Fixture({ product, maxZoom: zoom, buildId: '20261101T000000Z-00000000-0000-0000-0000-000000000002' });
    for (const [key, value] of previous.objects) if (!key.startsWith('catalog/')) current.objects.set(key, value);
    for (const [key, value] of previous.shardSha) current.shardSha.set(key, value);
    const manifests = [previous.manifest, current.manifest];
    current.objects.set(`catalog/${product.modelId}/latest.json`, json({
      version: 1, model: product.modelId, latestBuildId: current.buildId,
      retained: manifests.map(({ buildId, cycle, expiresAt }) => ({ buildId, cycle, expiresAt, manifestKey: `builds/${product.modelId}/${buildId}/manifest.json` }))
    }));
    const latest = await current.request(`/v1/models/${product.modelId}/latest?expand=manifest`);
    expect(latest.status).toBe(200);
    expect(await latest.json()).toMatchObject({ manifest: { buildId: current.buildId, surfaces: current.manifest.surfaces.map(surface => ({ coverage: { maxZoom: surface.coverage.maxZoom } })) } });

    for (const manifest of manifests) {
      const root = `/v1/models/${product.modelId}/runs/${manifest.buildId}`;
      const response = await current.request(root);
      expect(response.status).toBe(200);
      const served = manifestV5Schema.parse(await response.json());
      expect(served.surfaces).toEqual(manifest.surfaces);
      const sample = await current.request(`${root}/sample?lat=${commonPoint.lat}&lon=${commonPoint.lon}&frame=all`);
      expect(sample.status).toBe(200);
      const body = sampleResponseV5Schema.parse(await sample.json());
      expect(body.buildId).toBe(manifest.buildId);
      expect(body.frames.map(frame => frame.id)).toEqual(manifest.frames.map(frame => frame.id));
      expect(body.frames[0].layers['usable-lift-msl']).toMatchObject({ value: 310.25, status: 'valid', surfaceId: 'fine' });
      expect(body.frames[0].layers['usable-lift-agl']).toMatchObject({ value: 610.25, status: 'valid', surfaceId: 'fine' });
      if (product.modelId === 'gfs') expect(body.frames[0].layers['precip-rate']).toMatchObject({ value: 7, status: 'valid', surfaceId: 'native' });
      else expect(body.frames[0].layers).not.toHaveProperty('precip-rate');

      for (const surface of manifest.surfaces) for (const layer of surface.layers) {
        const frame = manifest.frames[0].id, maxZoom = surface.coverage.maxZoom;
        const tilejson = await current.request(`${root}/layers/${layer}/${frame}/tilejson.json`);
        expect(tilejson.status).toBe(200);
        expect(await tilejson.json()).toMatchObject({ maxzoom: maxZoom });
        const tile = await current.request(`/tiles/${product.modelId}/${manifest.buildId}/${layer}/${frame}/${maxZoom}/0/0.webp`);
        expect(tile.status).toBe(200);
        expect(tile.headers.get('content-type')).toBe('image/webp');
        expect(new TextDecoder().decode(new Uint8Array(await tile.arrayBuffer()).subarray(0, 4))).toBe('RIFF');
        const beyond = await current.request(`/tiles/${product.modelId}/${manifest.buildId}/${layer}/${frame}/${maxZoom + 1}/0/0.webp`);
        expect(beyond.status).toBe(400);
        await beyond.body?.cancel();
      }
    }
  });

  it.each([GFS_PRODUCT, ICON_EU_PRODUCT])('rejects a cached $modelId manifest above its configured maximum', async product => {
    const fixture = createV5Fixture({ product, maxZoom: product.maxNativeZoom });
    const path = `/v1/models/${product.modelId}/latest?expand=manifest`;
    const accepted = await fixture.request(path);
    expect(accepted.status).toBe(200);
    await accepted.body?.cancel();
    const limited = createApp({ products: { [product.modelId]: { ...fixture.product, maxNativeZoom: product.maxNativeZoom - 1 } } });
    const response = await limited.fetch(new Request(`https://api.test${path}`), { BUCKET: fixture.bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) } }, { waitUntil() {} });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ title: 'publication-invalid' });
    expect(fixture.get.mock.calls.some(([, options]) => options?.range)).toBe(false);
  });

  it.each(upgrades)('keeps descriptor zoom binding for lower-zoom $product.modelId manifests', async ({ product, olderZoom }) => {
    const fixture = createV5Fixture({ product, maxZoom: olderZoom });
    fixture.manifest.surfaces[0].coverage.maxZoom--;
    fixture.objects.set(`builds/${product.modelId}/${fixture.buildId}/manifest.json`, json(fixture.manifest));
    const latest = await fixture.request(`/v1/models/${product.modelId}/latest?expand=manifest`);
    expect(latest.status).toBe(200);
    await latest.body?.cancel();
    for (const path of [
      `/tiles/${product.modelId}/${fixture.buildId}/usable-lift-msl/h001/0/0/0.webp`,
      `/v1/models/${product.modelId}/runs/${fixture.buildId}/sample?lat=${commonPoint.lat}&lon=${commonPoint.lon}&layers=usable-lift-msl`
    ]) {
      const response = await fixture.request(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ title: 'coverage-unavailable' });
    }
    expect(fixture.get.mock.calls.some(([, options]) => options?.range)).toBe(false);
  });
});
