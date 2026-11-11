import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRODUCTS } from '@av/contracts/models';
import { LAYER_IDS, LAYERS, MAX_NATIVE_ZOOM, renderedLayers, manifestV5Schema, sampleResponseV5Schema } from '@av/contracts';
import { describeSparseCoverage } from '../../batch/src/coverage.js';
import { createApp } from '../src/index';
import { NOW, commonPoint, createGroupedV5Fixture, createV5Fixture } from './v5-fixture';

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const upgrades = PRODUCTS.map(product => ({ product, olderZoom: MAX_NATIVE_ZOOM - 2, zoom: MAX_NATIVE_ZOOM }));

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('retained v5 zoom compatibility', () => {
  it('rejects every sample-only tile and TileJSON layer before coverage or archive reads', async () => {
    const layers = LAYER_IDS.filter(layer => LAYERS[layer].delivery === 'samples-only');
    expect(layers).toHaveLength(17);
    const fixture = createV5Fixture({ nativeLayers: ['precip-rate', ...layers] });
    const root = `/v1/models/gfs/runs/${fixture.buildId}`;
    for (const layer of layers) for (const path of [`${root}/layers/${layer}/h001/tilejson.json`, `/tiles/gfs/${fixture.buildId}/${layer}/h001/0/0/0.webp`]) {
      const response = await fixture.request(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ title: 'unknown-resource' });
    }
    expect(fixture.get.mock.calls.some(([key]) => key.startsWith('coverage/') || key.endsWith('.pmtiles'))).toBe(false);
  });

  it('keeps a missing rendered archive descriptor as a publication failure', async () => {
    const fixture = createV5Fixture();
    fixture.manifest.artifacts = fixture.manifest.artifacts.filter(artifact => artifact.layer !== 'precip-rate' || artifact.frame !== 'h001');
    fixture.objects.set(`builds/gfs/${fixture.buildId}/manifest.json`, json(fixture.manifest));
    for (const path of [`/v1/models/gfs/runs/${fixture.buildId}/layers/precip-rate/h001/tilejson.json`, `/tiles/gfs/${fixture.buildId}/precip-rate/h001/0/0/0.webp`]) {
      const response = await fixture.request(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ title: 'publication-invalid' });
    }
    expect(fixture.get.mock.calls.some(([key]) => key.endsWith('.pmtiles'))).toBe(false);
  });

  it('keeps a missing advertised rendered archive as a publication failure', async () => {
    const fixture = createV5Fixture(), surface = fixture.manifest.surfaces.find(surface => surface.kind === 'native')!;
    fixture.native.mask.tiles[0] |= 1;
    const coverage = describeSparseCoverage(fixture.native.mask, fixture.product), prefix = `coverage/${coverage.hash}`;
    surface.coverage = { ...surface.coverage, hash: coverage.hash, maskKey: `${prefix}/manifest.json` };
    surface.samples.coverageHash = coverage.hash;
    fixture.objects.set(`${prefix}/manifest.json`, coverage.bytes);
    fixture.objects.set(`${prefix}/sparse.bin`, coverage.sparseBytes);
    fixture.objects.set(`${prefix}/tiles.bin`, fixture.native.mask.tiles);
    fixture.objects.set(`builds/gfs/${fixture.buildId}/manifest.json`, json(fixture.manifest));
    const response = await fixture.request(`/tiles/gfs/${fixture.buildId}/precip-rate/h001/0/0/0.webp`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ title: 'publication-unavailable' });
    expect(fixture.get.mock.calls.some(([key]) => key.endsWith('/precip-rate/h001.pmtiles'))).toBe(true);
  });

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
      if (product.layers.includes('precip-rate')) expect(body.frames[0].layers['precip-rate']).toMatchObject({ value: 7, status: 'valid', surfaceId: 'native' });
      else expect(body.frames[0].layers).not.toHaveProperty('precip-rate');

      for (const surface of manifest.surfaces) for (const layer of renderedLayers(surface.layers)) {
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

  it.each(PRODUCTS)('retains cached $modelId builds after decreasing the configured zoom', async product => {
    const fixture = createV5Fixture({ product, maxZoom: MAX_NATIVE_ZOOM });
    const path = `/v1/models/${product.modelId}/latest?expand=manifest`;
    const accepted = await fixture.request(path);
    expect(accepted.status).toBe(200);
    await accepted.body?.cancel();
    const limited = createApp({ products: { [product.modelId]: { ...fixture.product, maxNativeZoom: 0 } } });
    const response = await limited.fetch(new Request(`https://api.test${path}`), { BUCKET: fixture.bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) } }, { waitUntil() {} });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ manifest: { buildId: fixture.buildId } });
    expect(fixture.get.mock.calls.some(([, options]) => options?.range)).toBe(false);
    const retainedSample = await limited.fetch(new Request(`https://api.test/v1/models/${product.modelId}/runs/${fixture.buildId}/sample?lat=${commonPoint.lat}&lon=${commonPoint.lon}&frame=all`,
      { headers: { 'cf-connecting-ip': '192.0.2.1' } }), { BUCKET: fixture.bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) } }, { waitUntil() {} });
    expect(retainedSample.status).toBe(200);
    expect(sampleResponseV5Schema.parse(await retainedSample.json()).frames[0].layers['usable-lift-msl'].value).toBe(310.25);
  });

  it.each(PRODUCTS)('serves distinct $modelId zooms and sample layouts from one immutable master', async product => {
    const older = createV5Fixture({ product, maxZoom: MAX_NATIVE_ZOOM, renderZoom: 6 });
    const current = createGroupedV5Fixture({ product, maxZoom: MAX_NATIVE_ZOOM, renderZoom: 8, groups: [[1], [2]],
      buildId: '20261101T000000Z-00000000-0000-0000-0000-000000000002' });
    expect(current.manifest.surfaces.map(surface => surface.coverage.hash)).toEqual(older.manifest.surfaces.map(surface => surface.coverage.hash));
    for (const [key, bytes] of older.objects) if (!key.startsWith('catalog/')) current.objects.set(key, bytes);
    for (const [key, sha] of older.shardSha) current.shardSha.set(key, sha);
    current.objects.set(`catalog/${product.modelId}/latest.json`, json({ version: 1, model: product.modelId, latestBuildId: current.buildId,
      retained: [older.manifest, current.manifest].map(({ buildId, cycle, expiresAt }) => ({ buildId, cycle, expiresAt, manifestKey: `builds/${product.modelId}/${buildId}/manifest.json` })) }));
    for (const expected of [older.manifest, current.manifest, older.manifest]) {
      const root = `/v1/models/${product.modelId}/runs/${expected.buildId}`;
      const response = await current.request(`${root}/sample?lat=${commonPoint.lat}&lon=${commonPoint.lon}&frame=all`);
      expect(response.status).toBe(200);
      const sample = sampleResponseV5Schema.parse(await response.json());
      expect(sample.buildId).toBe(expected.buildId);
      expect(sample.frames.map(frame => frame.layers['usable-lift-msl'].value)).toEqual([310.25, 320.25]);
      const layer = expected.layers[0], frame = expected.frames[0].id, zoom = expected.surfaces[0].coverage.maxZoom;
      const tilejson = await current.request(`${root}/layers/${layer}/${frame}/tilejson.json`);
      expect(tilejson.status).toBe(200); expect(await tilejson.json()).toMatchObject({ maxzoom: zoom });
      const tile = await current.request(`/tiles/${product.modelId}/${expected.buildId}/${layer}/${frame}/${zoom}/0/0.webp`);
      expect(tile.status).toBe(200); await tile.body?.cancel();
      const beyond = await current.request(`/tiles/${product.modelId}/${expected.buildId}/${layer}/${frame}/${zoom + 1}/0/0.webp`);
      expect(beyond.status).toBe(400); await beyond.body?.cancel();
    }
  });

  it('rejects a manifest above the hard wire zoom limit', async () => {
    const fixture = createV5Fixture({ maxZoom: MAX_NATIVE_ZOOM });
    fixture.manifest.surfaces[0].coverage.maxZoom = MAX_NATIVE_ZOOM + 1;
    fixture.objects.set(`builds/${fixture.product.modelId}/${fixture.buildId}/manifest.json`, json(fixture.manifest));
    const response = await fixture.request(`/v1/models/${fixture.product.modelId}/latest?expand=manifest`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ title: 'publication-invalid' });
    expect(fixture.get.mock.calls.some(([, options]) => options?.range)).toBe(false);
  });

  it.each(upgrades)('rejects a $product.modelId descriptor below its rendered zoom', async ({ product, olderZoom }) => {
    const fixture = createV5Fixture({ product, maxZoom: olderZoom });
    fixture.manifest.surfaces[0].coverage.maxZoom++;
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
