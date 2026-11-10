import { INDEXED_PRODUCT, SPLIT_PRODUCT } from '../../../tests/model-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CELL_BYTES, MAX_SAMPLE_RANGE_BYTES, sampleResponseV5Schema, type ManifestV5 } from '@av/contracts';
import { ApiClient, layerMaxZoom, previewRasterSource, windyTileOptions } from '@av/client';
import { createApp } from '../src/index';
import { coverageMemory } from '../src/coverage';
import { inFlightAllocationBytes } from '../src/resources';
import { NOW, commonPoint, createGroupedV5Fixture, createV5Fixture, finePoint } from './v5-fixture';

const regionalGroups = [[1, 9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24]];
const cases = [
  { product: INDEXED_PRODUCT, maxZoom: 9, groups: Array.from({ length: 12 }, (_, i) => [i * 2 + 1, i * 2 + 2]),
    retainedGroups: [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [13, 14, 15], [16, 17, 18], [19, 20, 21], [22, 23, 24]] },
  { product: SPLIT_PRODUCT, maxZoom: 10, groups: regionalGroups, retainedGroups: regionalGroups }
];

function merge(target: ReturnType<typeof createV5Fixture>, source: ReturnType<typeof createV5Fixture>) {
  for (const [key, value] of source.objects) target.objects.set(key, value);
  for (const [key, value] of source.shardSha) target.shardSha.set(key, value);
}

async function sampleBody(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return sampleResponseV5Schema.parse(await response.json());
}

function expectFrames(body: ReturnType<typeof sampleResponseV5Schema.parse>, manifest: ManifestV5, indices: number[]) {
  expect(body.buildId).toBe(manifest.buildId);
  expect(body.frames.map(({ layers: _layers, ...frame }) => frame)).toEqual(indices.map(index => manifest.frames[index]));
  for (const [position, index] of indices.entries()) {
    const layers = body.frames[position].layers;
    expect(Object.keys(layers).sort()).toEqual([...manifest.layers].sort());
    expect(layers['usable-lift-msl']).toMatchObject({ value: 310.25 + index * 10, status: 'valid', surfaceId: 'fine' });
    expect(layers['usable-lift-agl']).toMatchObject({ value: 610.25 + index * 10, status: 'valid', surfaceId: 'fine' });
    if (manifest.layers.includes('precip-rate')) expect(layers['precip-rate']).toMatchObject({ value: 7 + index, status: 'valid', surfaceId: 'native' });
  }
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('frame-group v5 serving', () => {
  it.each(cases)('maps all $product.modelId frames and every group boundary while retaining earlier groups and the legacy layout', async options => {
    const fixture = createGroupedV5Fixture({ ...options, buildId: '20261101T000000Z-00000000-0000-0000-0000-000000000002' });
    const legacy = createV5Fixture(options);
    const retained = createGroupedV5Fixture({ product: options.product, maxZoom: options.maxZoom - 1, groups: options.retainedGroups,
      buildId: '20261101T000000Z-00000000-0000-0000-0000-000000000003' });
    merge(fixture, legacy); merge(fixture, retained);
    fixture.objects.set(`catalog/${options.product.modelId}/latest.json`, new TextEncoder().encode(JSON.stringify({
      version: 1, model: options.product.modelId, latestBuildId: fixture.buildId,
      retained: [legacy.manifest, retained.manifest, fixture.manifest].map(({ buildId, cycle, expiresAt }) => ({ buildId, cycle, expiresAt, manifestKey: `builds/${options.product.modelId}/${buildId}/manifest.json` }))
    })));
    const legacyPath = `/v1/models/${options.product.modelId}/runs/${legacy.buildId}/sample?lat=${commonPoint.lat}&lon=${commonPoint.lon}&frame=all`;
    const previous = await sampleBody(await fixture.request(legacyPath));
    expectFrames(previous, legacy.manifest, [0, 1]);
    const retainedPath = `/v1/models/${options.product.modelId}/runs/${retained.buildId}/sample?lat=${commonPoint.lat}&lon=${commonPoint.lon}&frame=all`;
    const retainedBefore = await sampleBody(await fixture.request(retainedPath));
    expectFrames(retainedBefore, retained.manifest, retained.manifest.frames.map((_, index) => index));
    const api = new ApiClient({ baseUrl: 'https://api.test', now: () => NOW, fetchImpl: async input => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      return fixture.request(url.pathname + url.search);
    } });
    const pinned = await api.latest(options.product.modelId);
    for (const layer of pinned.manifest.layers) {
      const zoom = layerMaxZoom(pinned.manifest, layer);
      expect(zoom).toBe(options.maxZoom);
      expect(previewRasterSource(pinned.templates[layer], pinned.manifest.frames[0].id, zoom, 'Fixture').maxzoom).toBe(zoom);
      expect(windyTileOptions(zoom, 0.5, 'Fixture').maxNativeZoom).toBe(zoom);
    }
    const indices = fixture.manifest.frames.map((_, index) => index);
    const series = await api.sample(pinned, { ...commonPoint, frames: 'all' });
    expectFrames(sampleResponseV5Schema.parse(series), fixture.manifest, indices);
    let firstFrame = 0;
    for (const group of options.groups) {
      for (const index of [firstFrame, firstFrame + group.length - 1]) {
        const frame = fixture.manifest.frames[index];
        expectFrames(await sampleBody(await fixture.sample(commonPoint.lat, commonPoint.lon, `&frame=${frame.id}`)), fixture.manifest, [index]);
      }
      firstFrame += group.length;
    }
    expect(await sampleBody(await fixture.request(legacyPath))).toEqual(previous);
    expect(await sampleBody(await fixture.request(retainedPath))).toEqual(retainedBefore);
    expect(coverageMemory(fixture.bucket).leaseRefs).toBe(0);
    expect(inFlightAllocationBytes()).toBe(0);
  });

  it.each(cases)('limits an all-frame $product.modelId request to four reads and the combined byte budget', async options => {
    const fixture = createGroupedV5Fixture(options), original = fixture.get.getMockImplementation()!;
    const reads = options.groups.length * fixture.manifest.surfaces.length;
    let active = 0, peak = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fixture.get.mockImplementation(async (key, options) => {
      if (options?.range) { active++; peak = Math.max(peak, active); await gate; active--; }
      return original(key, options);
    });
    const pending = fixture.sample(commonPoint.lat, commonPoint.lon, '&frame=all');
    try { await vi.waitFor(() => expect(active).toBe(4)); }
    finally { release(); }
    const body = await sampleBody(await pending);
    expectFrames(body, fixture.manifest, fixture.manifest.frames.map((_, index) => index));
    const ranges = fixture.get.mock.calls.flatMap(([, options]) => options?.range ? [options.range] : []);
    expect(ranges).toHaveLength(reads);
    const bytes = ranges.reduce((total, range) => total + range.length, 0);
    expect(bytes).toBe(fixture.manifest.frames.length * fixture.manifest.layers.length * CELL_BYTES);
    expect(bytes).toBeLessThanOrEqual(MAX_SAMPLE_RANGE_BYTES);
    expect(peak).toBe(4);
    expect(inFlightAllocationBytes()).toBe(0);
  });

  it('serves twenty mixed concurrent requests at distinct positions within the bucket read limit', async () => {
    const fixtures = cases.map(options => createGroupedV5Fixture(options)), bucket = fixtures[0].bucket;
    merge(fixtures[0], fixtures[1]);
    const app = createApp({ products: Object.fromEntries(fixtures.map(fixture => [fixture.product.modelId, fixture.product])) });
    const original = fixtures[0].get.getMockImplementation()!;
    let active = 0, peak = 0;
    fixtures[0].get.mockImplementation(async (key, options) => {
      if (!options?.range) return original(key, options);
      active++; peak = Math.max(peak, active);
      try { await new Promise(resolve => setTimeout(resolve, 1)); return await original(key, options); }
      finally { active--; }
    });
    const owners: Promise<unknown>[] = [];
    const queries = Array.from({ length: 20 }, (_, index) => {
      const fixture = fixtures[index % 2], point = finePoint(index * 7 % 60, 16), all = index % 5 === 0;
      const frameIndex = index % fixture.manifest.frames.length;
      return { fixture, point, frame: all ? 'all' : fixture.manifest.frames[frameIndex].id,
        indices: all ? fixture.manifest.frames.map((_, index) => index) : [frameIndex] };
    });
    const bodies = await Promise.all(queries.map(async ({ fixture, point, frame }) => {
      const response = await app.fetch(new Request(`https://api.test/v1/models/${fixture.product.modelId}/runs/${fixture.buildId}/sample?lat=${point.lat}&lon=${point.lon}&frame=${frame}`, { headers: { 'cf-connecting-ip': '192.0.2.1' } }),
        { BUCKET: bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) }, AV_RESPONSE_CACHE: 'off' }, { waitUntil: promise => owners.push(promise) });
      return sampleBody(response);
    }));
    await Promise.all(owners);
    for (const [index, body] of bodies.entries()) expectFrames(body, queries[index].fixture.manifest, queries[index].indices);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    const ranges = new Set(fixtures[0].get.mock.calls.flatMap(([key, options]) => options?.range ? [`${key}:${options.range.offset}:${options.range.length}`] : []));
    expect(ranges.size).toBeGreaterThan(20);
    expect(active).toBe(0);
    expect(coverageMemory(bucket).leaseRefs).toBe(0);
    expect(inFlightAllocationBytes()).toBe(0);
  });
});
