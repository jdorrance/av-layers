import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalGridJson, sampleResponseV5Schema } from '@av/contracts';
import { coverageMemory, resolveSparseCoverage } from '../src/coverage';
import { inFlightAllocationBytes } from '../src/resources';
import { NOW, commonPoint, createV5Fixture, createGroupedV5Fixture, finePoint } from './v5-fixture';

type V5Body = {
  version: 5;
  surfaces: { id: string; kind: 'native' | 'fine'; layers: string[]; coverage: { id: string; maxZoom: number } }[];
  frames: { id: string; layers: Record<string, { value: number | null; status: string; support: number; interpolated: boolean; surfaceId: string }> }[];
};

function groupedFixture() {
  return createGroupedV5Fixture({ groups: [[1], [2, 3], [4], [5], [6]] });
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('API v5 metadata', () => {
  it.each(['success', 'failure', 'both-abort'] as const)('cancels coalesced samples while a shared range settles: %s', async outcome => {
    const fixture = createV5Fixture(), original = fixture.get.getMockImplementation()!;
    let started!: () => void, finish!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let bodyReads = 0;
    fixture.get.mockImplementation(async (key, options) => {
      const object = await original(key, options);
      if (!object || !options?.range || !object.range) return object;
      const reader = object.body.getReader();
      return { ...object, body: new ReadableStream<Uint8Array>({ async pull(controller) {
        bodyReads++; started(); await pending;
        if (outcome === 'failure') { controller.error(new Error('range failed')); return; }
        const chunk = await reader.read();
        if (!chunk.done) controller.enqueue(chunk.value);
        controller.close();
      } }) };
    });
    const abort = new AbortController(), abortSecond = new AbortController(), owners: Promise<unknown>[] = [];
    const url = `https://api.test/v1/models/gfs/runs/${fixture.buildId}/sample?lat=${commonPoint.lat}&lon=${commonPoint.lon}&layers=usable-lift-msl`;
    const call = (signal?: AbortSignal) => fixture.app.fetch(new Request(url, { signal, headers: { 'cf-connecting-ip': '192.0.2.1' } }), { BUCKET: fixture.bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) } }, { waitUntil: promise => owners.push(promise) });
    const first = call(abort.signal), second = call(abortSecond.signal);
    await reading;
    await vi.waitFor(() => expect(coverageMemory(fixture.bucket).leaseRefs).toBe(2));
    abort.abort();
    expect((await first).status).toBe(503);
    expect(coverageMemory(fixture.bucket).leaseRefs).toBe(1);
    expect(inFlightAllocationBytes()).toBeGreaterThan(0);
    expect(bodyReads).toBe(1);
    if (outcome === 'both-abort') {
      abortSecond.abort();
      expect((await second).status).toBe(503);
      expect(coverageMemory(fixture.bucket).leaseRefs).toBe(0);
      expect(coverageMemory(fixture.bucket).leasedBytes).toBe(0);
      expect(inFlightAllocationBytes()).toBeGreaterThan(0);
    }
    finish();
    const result = await second;
    expect(result.status).toBe(outcome === 'success' ? 200 : 503);
    await result.body?.cancel();
    await Promise.all(owners);
    expect(bodyReads).toBe(1);
    expect(fixture.get.mock.calls.filter(([, options]) => options?.range)).toHaveLength(1);
    expect(coverageMemory(fixture.bucket).leaseRefs).toBe(0);
    expect(coverageMemory(fixture.bucket).leasedBytes).toBe(0);
    expect(inFlightAllocationBytes()).toBe(0);
  });
  it('keeps a shared cold sparse load admitted after its first waiter aborts', async () => {
    const fixture = createV5Fixture(), original = fixture.get.getMockImplementation()!;
    let started!: () => void, finish!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    fixture.get.mockImplementation(async (key, options) => {
      const object = await original(key, options);
      if (!object || !key.endsWith('/sparse.bin')) return object;
      const reader = object.body.getReader();
      return { ...object, body: new ReadableStream<Uint8Array>({ async pull(controller) {
        started(); await pending;
        const chunk = await reader.read();
        if (!chunk.done) controller.enqueue(chunk.value);
        controller.close();
      } }) };
    });
    const abort = new AbortController(), owners: Promise<unknown>[] = [];
    const url = `https://api.test/v1/models/gfs/runs/${fixture.buildId}/sample?lat=${commonPoint.lat}&lon=${commonPoint.lon}&layers=usable-lift-msl`;
    const call = (signal?: AbortSignal) => fixture.app.fetch(new Request(url, { signal, headers: { 'cf-connecting-ip': '192.0.2.1' } }), { BUCKET: fixture.bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) } }, { waitUntil: promise => owners.push(promise) });
    const first = call(abort.signal), second = call();
    await reading;
    await vi.waitFor(() => expect(coverageMemory(fixture.bucket).leaseRefs).toBe(2));
    const before = coverageMemory(fixture.bucket).leasedBytes;
    abort.abort();
    expect((await first).status).toBe(503);
    expect(coverageMemory(fixture.bucket).leaseRefs).toBe(1);
    expect(coverageMemory(fixture.bucket).leasedBytes).toBe(before);
    expect(inFlightAllocationBytes()).toBeGreaterThanOrEqual(before);
    finish();
    const result = await second;
    expect(result.status).toBe(200);
    await result.body?.cancel();
    await Promise.all(owners);
    expect(fixture.get.mock.calls.filter(([key]) => key.endsWith('/sparse.bin'))).toHaveLength(1);
    expect(coverageMemory(fixture.bucket).leaseRefs).toBe(0);
    expect(coverageMemory(fixture.bucket).leasedBytes).toBe(0);
    expect(inFlightAllocationBytes()).toBe(0);
  });
  it('retains a cold-load reservation after its only waiter aborts', async () => {
    const fixture = createV5Fixture(), original = fixture.get.getMockImplementation()!;
    let started!: () => void, finish!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    fixture.get.mockImplementation(async (key, options) => {
      const object = await original(key, options);
      if (!object || !key.endsWith('/sparse.bin')) return object;
      const reader = object.body.getReader();
      return { ...object, body: new ReadableStream<Uint8Array>({ async pull(controller) {
        started(); await pending;
        const chunk = await reader.read();
        if (!chunk.done) controller.enqueue(chunk.value);
        controller.close();
      } }) };
    });
    const abort = new AbortController(), owners: Promise<unknown>[] = [];
    const url = `https://api.test/v1/models/gfs/runs/${fixture.buildId}/sample?lat=${commonPoint.lat}&lon=${commonPoint.lon}&layers=usable-lift-msl`;
    const response = fixture.app.fetch(new Request(url, { signal: abort.signal, headers: { 'cf-connecting-ip': '192.0.2.1' } }), { BUCKET: fixture.bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) } }, { waitUntil: promise => owners.push(promise) });
    await reading;
    const reserved = coverageMemory(fixture.bucket).leasedBytes;
    expect(reserved).toBeGreaterThan(0);
    abort.abort();
    const cancelled = await response;
    expect(cancelled.status).toBe(503);
    await cancelled.body?.cancel();
    expect(coverageMemory(fixture.bucket).leaseRefs).toBe(0);
    expect(coverageMemory(fixture.bucket).leasedBytes).toBe(reserved);
    expect(inFlightAllocationBytes()).toBeGreaterThanOrEqual(reserved);
    finish();
    await Promise.all(owners);
    expect(coverageMemory(fixture.bucket).leasedBytes).toBe(0);
    expect(inFlightAllocationBytes()).toBe(0);
  });
  it('documents the coverage fields returned in v5 catalog surfaces', async () => {
    const fixture = createV5Fixture();
    const catalog = await (await fixture.request('/v1/catalog')).json() as { models: { surfaces: unknown }[] };
    const surfaces = sampleResponseV5Schema.shape.surfaces.parse(catalog.models[0].surfaces);
    type Schema = { properties: Record<string, Schema>; items: Schema; required: string[]; type: string; pattern: string };
    const spec = await (await fixture.request('/openapi.json')).json() as { paths: Record<string, { get: { responses: Record<string, { content: Record<string, { schema: Schema }> }> } }> };
    const schema = spec.paths['/v1/catalog'].get.responses[200].content['application/json'].schema.properties.models.items.properties.surfaces.items.properties.coverage;
    expect(schema.required).toContain('gridHash');
    expect(schema.properties.gridHash).toMatchObject({ type: 'string', pattern: '^[a-f0-9]{64}$' });
    for (const surface of surfaces) {
      expect(Object.keys(surface.coverage).sort()).toEqual(Object.keys(schema.properties).sort());
      expect(surface.coverage.gridHash).toMatch(new RegExp(schema.properties.gridHash.pattern!));
      expect(schema.required.every(key => key in surface.coverage)).toBe(true);
    }
  });
  it('releases coverage when a sample range fails', async () => {
    const fixture = createV5Fixture();
    const original = fixture.get.getMockImplementation()!;
    fixture.get.mockImplementation(async (key, options) => {
      if (options?.range) throw new Error('range failed');
      return original(key, options);
    });
    expect((await fixture.sample(commonPoint.lat, commonPoint.lon)).status).toBe(503);
    expect(coverageMemory(fixture.bucket).leasedBytes).toBe(0);
  });
  it('releases coverage after a cancelled request and delayed range failure', async () => {
    const fixture = createV5Fixture(), original = fixture.get.getMockImplementation()!;
    let started!: () => void, finish!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    fixture.get.mockImplementation(async (key, options) => {
      if (options?.range) { started(); await pending; throw new Error('range failed'); }
      return original(key, options);
    });
    const controller = new AbortController();
    const request = new Request(`https://api.test/v1/models/gfs/runs/${fixture.buildId}/sample?lat=${commonPoint.lat}&lon=${commonPoint.lon}`, { signal: controller.signal, headers: { 'cf-connecting-ip': '192.0.2.1' } });
    const response = fixture.app.fetch(request, { BUCKET: fixture.bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) } }, { waitUntil() {} });
    await reading;
    expect(coverageMemory(fixture.bucket).leasedBytes).toBeGreaterThan(0);
    controller.abort();
    finish();
    expect((await response).status).toBe(503);
    expect(coverageMemory(fixture.bucket).leasedBytes).toBe(0);
  });
  it('publishes native precipitation and fine lift surfaces with output constraints', async () => {
    const { request, manifest } = createV5Fixture();
    const latest = await request('/v1/models/gfs/latest?expand=manifest');
    expect(latest.status).toBe(200);
    expect(await latest.json()).toMatchObject({ manifest: { version: 5, surfaces: [{ id: 'fine', kind: 'fine', layers: ['usable-lift-msl', 'usable-lift-agl'] }, { id: 'native', kind: 'native', layers: ['precip-rate'] }] } });
    const tilejson = await request(`/v1/models/gfs/runs/${manifest.buildId}/layers/precip-rate/h001/tilejson.json`);
    expect(tilejson.status).toBe(200);
    expect(await tilejson.json()).toMatchObject({ maxzoom: 1, bounds: manifest.descriptors.bounds });
    const catalog = await request('/v1/catalog');
    expect((await catalog.json() as { models: { surfaces?: unknown }[] }).models[0]!.surfaces).toHaveLength(2);
  });

  it('rejects self-consistent surfaces and scientific metadata that do not match the product', async () => {
    for (const change of [
      (m: ReturnType<typeof createV5Fixture>['manifest']) => { m.surfaces[0]!.coverage.id = 'other-policy'; },
      (m: ReturnType<typeof createV5Fixture>['manifest']) => {
        const surface = m.surfaces[0]!, grid = surface.grid;
        if (grid.kind === 'regular-latlon') grid.dx /= 2;
        const hash = createHash('sha256').update(canonicalGridJson(grid)).digest('hex');
        surface.gridHash = hash; surface.coverage.gridHash = hash; surface.terrain!.gridHash = hash;
      },
      (m: ReturnType<typeof createV5Fixture>['manifest']) => { m.surfaces[1]!.coverage.maxZoom = 2; },
      (m: ReturnType<typeof createV5Fixture>['manifest']) => { m.descriptors.layers['usable-lift-agl'].verticalReference = 'model-AGL'; }
    ]) {
      const fixture = createV5Fixture();
      change(fixture.manifest);
      fixture.objects.set(`builds/gfs/${fixture.buildId}/manifest.json`, new TextEncoder().encode(JSON.stringify(fixture.manifest)));
      expect((await fixture.request('/v1/models/gfs/latest?expand=manifest')).status).toBe(503);
    }
  });

  it('reads descriptor and tiles without loading the sparse mask', async () => {
    const fixture = createV5Fixture();
    const response = await fixture.request(`/tiles/gfs/${fixture.buildId}/usable-lift-msl/h001/0/0/0.webp`);
    expect(response.status).toBe(200);
    expect(fixture.get.mock.calls.some(([key]) => key.endsWith('/sparse.bin'))).toBe(false);
    expect(fixture.get.mock.calls.filter(([key]) => key.startsWith('coverage/')).map(([key]) => key.split('/').pop())).toEqual(['manifest.json', 'tiles.bin']);
    expect((await fixture.sample(commonPoint.lat, commonPoint.lon, '&layers=usable-lift-msl')).status).toBe(200);
    expect(fixture.get.mock.calls.filter(([key]) => key.endsWith('/manifest.json') && key.startsWith('coverage/'))).toHaveLength(1);
    expect(fixture.get.mock.calls.filter(([key]) => key.endsWith('/tiles.bin'))).toHaveLength(1);
  });
});

describe('API v5 sampling', () => {
  it('charges new group layouts added to a shared cached and leased mask', async () => {
    const fixture = groupedFixture(), legacy = await resolveSparseCoverage(fixture.bucket, fixture.fine.surface);
    const before = coverageMemory(fixture.bucket);
    const grouped = await resolveSparseCoverage(fixture.bucket, fixture.manifest.surfaces[0]);
    const after = coverageMemory(fixture.bucket);
    expect(grouped.coverage.mask).toBe(legacy.coverage.mask);
    expect(grouped.coverage.layouts.size).toBe(3);
    expect(after.leasedBytes).toBeGreaterThan(before.leasedBytes);
    expect(after.cachedBytes).toBeGreaterThan(before.cachedBytes);
    expect(inFlightAllocationBytes()).toBeGreaterThanOrEqual(after.leasedBytes);
    legacy.release(); grouped.release();
    expect(coverageMemory(fixture.bucket).leasedBytes).toBe(0);
    expect(inFlightAllocationBytes()).toBe(0);
  });

  it('plans varying frame groups locally for single and all frames with four reads per request', async () => {
    const fixture = groupedFixture(), original = fixture.get.getMockImplementation()!;
    let active = 0, peak = 0, started!: () => void, release!: () => void;
    const four = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    fixture.get.mockImplementation(async (key, options) => {
      if (options?.range) { active++; peak = Math.max(peak, active); if (active === 4) started(); await gate; active--; }
      return original(key, options);
    });
    const all = fixture.sample(commonPoint.lat, commonPoint.lon, '&frame=all');
    await four; expect(peak).toBe(4); release();
    const response = await all;
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as V5Body;
    expect(body.frames.map(frame => frame.layers['precip-rate'].value)).toEqual([7, 8, 9, 10, 11, 12]);
    expect(body.frames.map(frame => frame.layers['usable-lift-msl'].value)).toEqual([310.25, 320.25, 330.25, 340.25, 350.25, 360.25]);
    expect(peak).toBe(4);
    const single = await fixture.sample(commonPoint.lat, commonPoint.lon, '&frame=h003&layers=precip-rate');
    expect(single.status).toBe(200);
    expect((await single.json() as V5Body).frames[0].layers['precip-rate'].value).toBe(9);
    expect(fixture.get.mock.calls.filter(([key, options]) => options?.range && key.includes('/samples/g'))).toHaveLength(11);
  });

  it('serves all frames from both surfaces with Float32 values, support and ownership', async () => {
    const { sample } = createV5Fixture();
    const response = await sample(commonPoint.lat, commonPoint.lon, '&frame=all');
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as V5Body;
    expect(body.version).toBe(5);
    expect(body.frames.map(frame => frame.id)).toEqual(['h001', 'h002']);
    expect(body.frames.map(frame => frame.layers['usable-lift-msl'])).toEqual([
      { value: 310.25, status: 'valid', support: 4, interpolated: false, surfaceId: 'fine' },
      { value: 320.25, status: 'valid', support: 4, interpolated: false, surfaceId: 'fine' }
    ]);
    expect(body.frames.map(frame => frame.layers['usable-lift-agl'].value)).toEqual([610.25, 620.25]);
    expect(body.frames.map(frame => frame.layers['precip-rate'].value)).toEqual([7, 8]);
    expect(body.frames.every(frame => frame.layers['precip-rate'].surfaceId === 'native')).toBe(true);
  });

  it('selects single, listed and default frames', async () => {
    const { sample } = createV5Fixture();
    const single = await sample(commonPoint.lat, commonPoint.lon, '&frame=h002&layers=precip-rate');
    const singleBody = await single.json() as V5Body;
    expect(singleBody.frames.map(frame => frame.id)).toEqual(['h002']);
    expect(singleBody.frames[0]!.layers['precip-rate'].value).toBe(8);
    const listed = await sample(commonPoint.lat, commonPoint.lon, '&frame=h002,h001&layers=precip-rate');
    expect((await listed.json() as V5Body).frames.map(frame => frame.id)).toEqual(['h001', 'h002']);
    const fallback = await sample(commonPoint.lat, commonPoint.lon, '&layers=precip-rate');
    expect((await fallback.json() as V5Body).frames).toHaveLength(1);
  });

  it('reads only the selected surface and reports output, halo and outside policy', async () => {
    const nativeOnly = createV5Fixture();
    const nativeResponse = await nativeOnly.sample(commonPoint.lat, commonPoint.lon, '&layers=precip-rate&frame=all');
    expect(nativeResponse.status).toBe(200);
    expect(nativeOnly.get.mock.calls.some(([key]) => key.includes('/surfaces/fine/'))).toBe(false);
    const fineOnly = createV5Fixture();
    const fineResponse = await fineOnly.sample(commonPoint.lat, commonPoint.lon, '&layers=usable-lift-msl&frame=all');
    expect(fineResponse.status).toBe(200);
    expect(fineOnly.get.mock.calls.some(([key]) => key.includes('/surfaces/native/'))).toBe(false);
    const rangeReads = fineOnly.get.mock.calls.filter(([, options]) => options?.range).length;
    expect(rangeReads).toBeGreaterThan(0);
    const halo = await fineOnly.sample(9.5, -180, '&layers=usable-lift-msl&frame=h002');
    expect((await halo.json() as V5Body).frames[0]!.layers['usable-lift-msl']).toMatchObject({ value: null, status: 'outside-domain', support: 0, surfaceId: 'fine' });
    expect(fineOnly.get.mock.calls.filter(([, options]) => options?.range)).toHaveLength(rangeReads);
    const nativeRangeReads = nativeOnly.get.mock.calls.filter(([, options]) => options?.range).length;
    const nativeHalo = await nativeOnly.sample(10, -180, '&layers=precip-rate');
    expect((await nativeHalo.json() as V5Body).frames[0]!.layers['precip-rate'].status).toBe('outside-domain');
    expect(nativeOnly.get.mock.calls.filter(([, options]) => options?.range)).toHaveLength(nativeRangeReads);
  });

  it('interpolates valid support and keeps exact Float32 nodes across block and wrap boundaries', async () => {
    const { sample } = createV5Fixture();
    const interpolated = finePoint(2.5, 16.5);
    const result = await sample(interpolated.lat, interpolated.lon, '&layers=usable-lift-msl');
    expect((await result.json() as V5Body).frames[0]!.layers['usable-lift-msl']).toMatchObject({ value: 315.25, status: 'valid', support: 4, interpolated: true });
    const boundary = await sample(finePoint(15.5, 16.5).lat, finePoint(15.5, 16.5).lon, '&layers=usable-lift-msl');
    expect((await boundary.json() as V5Body).frames[0]!.layers['usable-lift-msl'].value).toBe(315.25);
    const east = await sample(commonPoint.lat, 180, '&layers=usable-lift-msl');
    const west = await sample(commonPoint.lat, -180, '&layers=usable-lift-msl');
    expect((await east.json() as V5Body).frames[0]!.layers['usable-lift-msl'].value).toBe(310.25);
    expect((await west.json() as V5Body).frames[0]!.layers['usable-lift-msl'].value).toBe(310.25);
  });

  it('preserves no-lift, unavailable fallback and surface-specific timing values', async () => {
    const { sample } = createV5Fixture();
    const noLift = finePoint(4, 17);
    expect((await (await sample(noLift.lat, noLift.lon, '&layers=usable-lift-msl')).json() as V5Body).frames[0]!.layers['usable-lift-msl'])
      .toEqual({ value: null, status: 'no-usable-lift', support: 0, interpolated: false, surfaceId: 'fine' });
    const exactUnavailable = finePoint(5, 17);
    expect((await (await sample(exactUnavailable.lat, exactUnavailable.lon, '&layers=usable-lift-agl')).json() as V5Body).frames[0]!.layers['usable-lift-agl'])
      .toEqual({ value: null, status: 'unavailable', support: 0, interpolated: false, surfaceId: 'fine' });
    const unavailable = finePoint(4.9, 17.1);
    const unavailableCell = (await (await sample(unavailable.lat, unavailable.lon, '&layers=usable-lift-agl')).json() as V5Body).frames[0]!.layers['usable-lift-agl'];
    expect(unavailableCell).toMatchObject({ value: null, status: 'unavailable', interpolated: false, surfaceId: 'fine' });
    const fallbackPoint = finePoint(4.6, 17.6);
    const fallback = (await (await sample(fallbackPoint.lat, fallbackPoint.lon, '&layers=usable-lift-agl')).json() as V5Body).frames[0]!.layers['usable-lift-agl'];
    expect(fallback).toMatchObject({ value: 610.25, status: 'valid', interpolated: false, surfaceId: 'fine' });
  });
});

describe('API v5 corruption and lifecycle', () => {
  it.each(['missing', 'wrong', 'size', 'range'] as const)('rejects %s grouped shard metadata', async variant => {
    const fixture = groupedFixture(), original = fixture.get.getMockImplementation()!;
    fixture.get.mockImplementation(async (key, options) => {
      const object = await original(key, options);
      if (!object || !options?.range || !object.range) return object;
      if (variant === 'missing') return { ...object, customMetadata: undefined };
      if (variant === 'wrong') return { ...object, customMetadata: { sha256: 'f'.repeat(64) } };
      if (variant === 'size') return { ...object, size: object.size + 1 };
      return { ...object, range: { ...options.range, length: options.range.length + 1 } };
    });
    const response = await fixture.sample(commonPoint.lat, commonPoint.lon, '&frame=h003&layers=precip-rate');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ title: 'publication-incomplete' });
  });

  it('rejects missing and corrupt sparse coverage', async () => {
    const missing = createV5Fixture();
    missing.objects.delete(`coverage/${missing.fine.surface.coverage.hash}/manifest.json`);
    const missingResponse = await missing.sample(commonPoint.lat, commonPoint.lon, '&layers=usable-lift-msl');
    expect(missingResponse.status).toBe(503);
    expect(await missingResponse.json()).toMatchObject({ title: 'coverage-unavailable' });
    const corrupt = createV5Fixture();
    const key = `coverage/${corrupt.fine.surface.coverage.hash}/sparse.bin`;
    const bytes = corrupt.objects.get(key)!;
    corrupt.objects.set(key, Uint8Array.from(bytes, (value, index) => index ? value : value ^ 1));
    const corruptResponse = await corrupt.sample(commonPoint.lat, commonPoint.lon, '&layers=usable-lift-msl');
    expect(corruptResponse.status).toBe(503);
    expect(await corruptResponse.json()).toMatchObject({ title: 'coverage-unavailable' });
    expect(corrupt.get.mock.calls.some(([, options]) => options?.range)).toBe(false);
  });

  it('rejects missing, sha-mismatched, range-mismatched and short sample shards', async () => {
    const missing = createV5Fixture();
    missing.objects.delete(missing.native.surface.samples.shards[0]!.key);
    expect((await missing.sample(commonPoint.lat, commonPoint.lon, '&layers=precip-rate')).status).toBe(503);
    const sha = createV5Fixture();
    sha.shardSha.set(sha.native.surface.samples.shards[0]!.key, 'f'.repeat(64));
    const shaResponse = await sha.sample(commonPoint.lat, commonPoint.lon, '&layers=precip-rate');
    expect(shaResponse.status).toBe(503);
    expect(await shaResponse.json()).toMatchObject({ title: 'publication-incomplete' });
    const range = createV5Fixture();
    const original = range.get.getMockImplementation()!;
    range.get.mockImplementation(async (key, options) => {
      const object = await original(key, options);
      return key === range.native.surface.samples.shards[0]!.key && object?.range ? { ...object, range: { offset: object.range.offset + 1, length: object.range.length } } : object;
    });
    expect((await range.sample(commonPoint.lat, commonPoint.lon, '&layers=precip-rate')).status).toBe(503);
    const short = createV5Fixture();
    const base = short.get.getMockImplementation()!;
    short.get.mockImplementation(async (key, options) => {
      const object = await base(key, options);
      if (key !== short.native.surface.samples.shards[0]!.key || !options?.range) return object;
      const bytes = short.objects.get(key)!.slice(options.range.offset, options.range.offset + options.range.length - 1);
      return { size: short.objects.get(key)!.length, range: options.range, customMetadata: { sha256: short.shardSha.get(key)! }, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
    });
    expect((await short.sample(commonPoint.lat, commonPoint.lon, '&layers=precip-rate')).status).toBe(503);
  });

  it('rejects a manifest whose shard metadata disagrees with coverage', async () => {
    const fixture = createV5Fixture();
    fixture.manifest.surfaces[1]!.samples.shards[0]!.bytes += 1;
    fixture.objects.set(`builds/gfs/${fixture.buildId}/manifest.json`, new TextEncoder().encode(JSON.stringify(fixture.manifest)));
    const response = await fixture.sample(commonPoint.lat, commonPoint.lon, '&layers=precip-rate');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ title: 'publication-invalid' });
    expect(fixture.get.mock.calls.some(([, options]) => options?.range)).toBe(false);
  });

  it('refuses an expired pinned build before numeric reads', async () => {
    const fixture = createV5Fixture();
    const expiredAt = new Date(NOW - 1000).toISOString();
    fixture.manifest.expiresAt = expiredAt;
    fixture.objects.set(`builds/gfs/${fixture.buildId}/manifest.json`, new TextEncoder().encode(JSON.stringify(fixture.manifest)));
    const catalog = JSON.parse(new TextDecoder().decode(fixture.objects.get('catalog/gfs/latest.json')!));
    catalog.retained[0].expiresAt = expiredAt;
    fixture.objects.set('catalog/gfs/latest.json', new TextEncoder().encode(JSON.stringify(catalog)));
    const response = await fixture.sample(commonPoint.lat, commonPoint.lon, '&frame=all');
    expect(response.status).toBe(404);
    expect(fixture.get.mock.calls.some(([, options]) => options?.range)).toBe(false);
  });
});
