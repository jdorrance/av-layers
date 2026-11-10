import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAYERS, MAX_SAMPLE_POINTS, MAX_SAMPLE_RANGE_BYTES, getProduct, layerSurface, multiPointSampleResponseSchema, sampleResponseV5Schema } from '@av/contracts';
import { serveSample, serveSamples } from '../src/sample';
import { coverageMemory } from '../src/coverage';
import { inFlightAllocationBytes, MAX_SAMPLE_CONCURRENT_READS_PER_REQUEST } from '../src/resources';
import { NOW, commonPoint, createGroupedV5Fixture, createV5Fixture, finePoint, nativePoint } from './v5-fixture';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

type Fixture = ReturnType<typeof createV5Fixture>;
function batch(fixture: Fixture, points: string, selection = '', signal?: AbortSignal) {
  const url = new URL(`https://api.test/v1/models/gfs/runs/${fixture.buildId}/samples?points=${points}${selection}`);
  return serveSamples(new Request(url, { signal }), fixture.bucket, { waitUntil() {}, responseCacheEnabled: false }, fixture.manifest, url);
}
const numericReads = (fixture: Fixture) => fixture.get.mock.calls.filter(([, options]) => options?.range);

async function body(response: Response) {
  expect(response.status).toBe(200);
  const bytes = await response.arrayBuffer();
  expect(response.headers.get('etag')).toBe(`"${createHash('sha256').update(new Uint8Array(bytes)).digest('hex')}"`);
  return multiPointSampleResponseSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

describe('version-5 batch samples', () => {
  it.each([undefined, true] as const)('serves single and batch MSL values using the build sampling marker %s', async useStoredMslNoLift => {
    const fixture = createV5Fixture(), point = finePoint(3.5, 16.5), layer = 'usable-lift-msl';
    if (useStoredMslNoLift) {
      fixture.manifest.tool.useStoredMslNoLift = useStoredMslNoLift;
      fixture.objects.set(`builds/gfs/${fixture.buildId}/manifest.json`, new TextEncoder().encode(JSON.stringify(fixture.manifest)));
    }
    const selection = `&layers=${layer}`;
    const scalar = await fixture.sample(point.lat, point.lon, selection);
    expect(scalar.status).toBe(200);
    const sample = sampleResponseV5Schema.parse(await scalar.json());
    const bulk = await body(await batch(fixture, `${point.lat},${point.lon}`, selection));
    expect(bulk.points[0]!.sample).toEqual(sample);
    expect(sample.frames[0]!.layers[layer]!.value).toBeCloseTo(useStoredMslNoLift ? 235.1875 : 313.583333);
  });

  it('preserves exact coordinates, ordering and duplicates while merging overlapping immutable ranges', async () => {
    const fixture = createV5Fixture(), precise = { lat: 8.912345678901, lon: -179.876543210987 };
    const result = await body(await batch(fixture, `${precise.lat},${precise.lon};${commonPoint.lat},${commonPoint.lon};${precise.lat},${precise.lon}`, '&layers=precip-rate'));
    expect(result.points.map(({ index, sample }) => ({ index, lat: sample.lat, lon: sample.lon }))).toEqual([
      { index: 0, ...precise }, { index: 1, ...commonPoint }, { index: 2, ...precise }
    ]);
    expect(result.points[0]!.sample).toEqual(result.points[2]!.sample);
    for (const { sample } of result.points) expect(sample.frames[0]!.layers['precip-rate']!.value).toBeCloseTo(7);
    expect(numericReads(fixture)).toHaveLength(1);
    expect(coverageMemory(fixture.bucket).leaseRefs).toBe(0);
    expect(inFlightAllocationBytes()).toBe(0);
  });

  it('serves all 64 duplicate points from a single numeric range', async () => {
    const fixture = createV5Fixture(), points = Array.from({ length: MAX_SAMPLE_POINTS }, () => '9,-180').join(';');
    const result = await body(await batch(fixture, points, '&layers=precip-rate'));
    expect(result.points).toHaveLength(MAX_SAMPLE_POINTS);
    expect(numericReads(fixture)).toHaveLength(1);
  });

  it('returns explicit absence for outside points with zero numeric reads', async () => {
    const fixture = createV5Fixture(), result = await body(await batch(fixture, '-50,0;89,100'));
    expect(result.points.every(({ sample }) => Object.values(sample.frames[0]!.layers).every(value => value.status === 'outside-domain'))).toBe(true);
    expect(numericReads(fixture)).toHaveLength(0);
  });

  it('keeps native samples after map hours and returns unavailable fine layers without loading them', async () => {
    const fixture = createV5Fixture({ mapFrameCount: 1 });
    const result = await body(await batch(fixture, '9,-180', '&frame=h002'));
    expect(result.points[0]!.sample.frames[0]!.layers['usable-lift-msl']).toMatchObject({ value: null, status: 'unavailable', surfaceId: 'fine' });
    expect(result.points[0]!.sample.frames[0]!.layers['usable-lift-agl']).toMatchObject({ value: null, status: 'unavailable', surfaceId: 'fine' });
    expect(result.points[0]!.sample.frames[0]!.layers['precip-rate']).toMatchObject({ value: 8, status: 'valid', surfaceId: 'native' });
    expect(fixture.get.mock.calls.some(([key]) => key.includes(fixture.fine.surface.coverage.hash))).toBe(false);
    expect(numericReads(fixture)).toHaveLength(1);
  });

  it.each(['', ',', '91,0', '0,181', 'NaN,0', '0,0;', '0,0,1', '1x,2', '0x10,0'])('refuses malformed coordinates before coverage reads: %s', async points => {
    const fixture = createV5Fixture();
    await expect(batch(fixture, points)).rejects.toMatchObject({ status: 400, code: 'invalid-query' });
    expect(fixture.get).not.toHaveBeenCalled();
  });

  it('admits point count and aggregate output values before coverage reads', async () => {
    const fixture = createV5Fixture();
    await expect(batch(fixture, Array.from({ length: 65 }, () => '9,-180').join(';'), '&layers=precip-rate')).rejects.toMatchObject({ status: 429, code: 'sample-limit' });
    await expect(batch(fixture, Array.from({ length: 64 }, () => '9,-180').join(';'), '&frame=all')).rejects.toMatchObject({ status: 429, code: 'sample-limit' });
    expect(fixture.get).not.toHaveBeenCalled();
  });

  it('requires selected layers to belong to the build', async () => {
    const fixture = createV5Fixture();
    await expect(batch(fixture, '9,-180', '&layers=cloud-cover-total')).rejects.toMatchObject({ status: 404, code: 'unknown-layer' });
    expect(fixture.get).not.toHaveBeenCalled();
  });

  it('reports legacy batch capability as unavailable before reading coverage', async () => {
    const fixture = createV5Fixture(), url = new URL(`https://api.test/v1/models/gfs/runs/${fixture.buildId}/samples?points=9,-180`);
    const legacy = { ...fixture.manifest, version: 4 } as unknown as Parameters<typeof serveSamples>[3];
    await expect(serveSamples(new Request(url), fixture.bucket, { waitUntil() {} }, legacy, url)).rejects.toMatchObject({ status: 409, code: 'unsupported-publication' });
    expect(fixture.get).not.toHaveBeenCalled();
  });

  it('serves published sample-only channels through the shared scalar and batch engine', async () => {
    const fixture = createV5Fixture(), layer = 'cloud-cover-total';
    fixture.manifest.layers = [layer]; fixture.manifest.surfaces = [fixture.native.surface];
    fixture.native.surface.layers = [layer]; fixture.manifest.descriptors.layers = { [layer]: LAYERS[layer] };
    fixture.manifest.artifacts = [];
    const result = await body(await batch(fixture, '9,-180', `&layers=${layer}`));
    expect(result.points[0]!.sample.frames[0]!.layers[layer]).toMatchObject({ value: 7, surfaceId: 'native', status: 'valid' });
    const url = new URL(`https://api.test/v1/models/gfs/runs/${fixture.buildId}/sample?lat=9&lon=-180&layers=${layer}`);
    const response = await serveSample(new Request(url), fixture.bucket, { waitUntil() {}, responseCacheEnabled: false }, fixture.manifest, url);
    expect(response.status).toBe(200);
    expect(sampleResponseV5Schema.parse(await response.json())).toEqual(result.points[0]!.sample);
  });

  it('narrows scattered single-hour queries inside the combined byte budget', async () => {
    const fixture = createV5Fixture({ frameHours: Array.from({ length: 85 }, (_, index) => index + 1) });
    const points = Array.from({ length: 64 }, (_, index) => finePoint(index % 16 * 4 + 0.25, 16.25 + Math.floor(index / 16)));
    const result = await body(await batch(fixture, points.map(({ lat, lon }) => `${lat},${lon}`).join(';'), '&layers=usable-lift-msl'));
    expect(result.points).toHaveLength(64);
    expect(numericReads(fixture).reduce((total, [, options]) => total + options!.range!.length, 0)).toBeLessThanOrEqual(MAX_SAMPLE_RANGE_BYTES);
    expect(coverageMemory(fixture.bucket).leaseRefs).toBe(0);
    expect(inFlightAllocationBytes()).toBe(0);
  });

  it('keeps compacted timeline and scattered point values identical to one-frame groups', async () => {
    const nativeLayers = getProduct('gfs')!.layers.filter(layer => layerSurface(layer) === 'native');
    const hours = Array.from({ length: 24 }, (_, index) => index + 1);
    const packed = createGroupedV5Fixture({ groups: [hours], nativeLayers });
    const hourly = createGroupedV5Fixture({ groups: hours.map(hour => [hour]), nativeLayers });
    const layers = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate', 'thermal-velocity', 'thermal-top-msl',
      'surface-lcl-msl', 'bl-mean-wind-u', 'bl-mean-wind-v', 'wind-10m-u', 'wind-10m-v', 'cloud-cover-total'];
    const points = Array.from({ length: 8 }, (_, index) => finePoint(index * 8 + 1.25, 16.5));
    const coordinates = points.map(({ lat, lon }) => `${lat},${lon}`).join(';');
    const selection = `&frame=h020&layers=${layers.join(',')}`;
    expect(await body(await batch(packed, coordinates, selection))).toEqual(await body(await batch(hourly, coordinates, selection)));
    const ranges = numericReads(packed);
    expect(ranges.reduce((total, [, options]) => total + options!.range!.length, 0)).toBeLessThanOrEqual(MAX_SAMPLE_RANGE_BYTES);
    packed.get.mockClear(); hourly.get.mockClear();
    const point = `${points[0]!.lat},${points[0]!.lon}`;
    const timeline = `&frame=${packed.manifest.frames.slice(0, 23).map(frame => frame.id).join(',')}&layers=${layers.join(',')}`;
    expect(await body(await batch(packed, point, timeline))).toEqual(await body(await batch(hourly, point, timeline)));
    expect(numericReads(packed).length).toBeLessThanOrEqual(MAX_SAMPLE_CONCURRENT_READS_PER_REQUEST);
    expect(numericReads(packed).reduce((total, [, options]) => total + options!.range!.length, 0)).toBeLessThan(10_000);
    expect(coverageMemory(packed.bucket).leaseRefs).toBe(0);
    expect(inFlightAllocationBytes()).toBe(0);
  });

  it('reads sparse hours for 64 points without copying intervening channels', async () => {
    const hours = Array.from({ length: 24 }, (_, index) => index + 1);
    const nativeLayers = getProduct('gfs')!.layers.filter(layer => layerSurface(layer) === 'native');
    const packed = createGroupedV5Fixture({ groups: [hours], nativeLayers });
    const hourly = createGroupedV5Fixture({ groups: hours.map(hour => [hour]), nativeLayers });
    const points = Array.from({ length: 64 }, (_, index) => nativePoint(index % 16 * 2 + 0.25, 8.25 + Math.floor(index / 16) % 3 + (index >= 48 ? 0.1 : 0)));
    const coordinates = points.map(({ lat, lon }) => `${lat},${lon}`).join(';');
    const selection = '&frame=h001,h024&layers=wind-10m-u';
    expect(await body(await batch(packed, coordinates, selection))).toEqual(await body(await batch(hourly, coordinates, selection)));
    expect(numericReads(packed).reduce((total, [, options]) => total + options!.range!.length, 0)).toBeLessThan(10_000);
    expect(coverageMemory(packed.bucket).leaseRefs).toBe(0);
    expect(inFlightAllocationBytes()).toBe(0);
  });

  it('preserves samples across compacted f024/f027 groups on the complete 40-frame axis', async () => {
    const nativeLayers = getProduct('gfs')!.layers.filter(layer => layerSurface(layer) === 'native');
    const hours = [...Array.from({ length: 24 }, (_, index) => index + 1), ...Array.from({ length: 16 }, (_, index) => 27 + index * 3)];
    const nativeValue = (layer: typeof nativeLayers[number], frame: number, x: number, y: number) => {
      if (layer === 'wind-10m-u' && x === 0 && y === 9) return null;
      if (layer === 'wind-10m-v' && frame === 24 && x === 16 && y === 9) return 0;
      return (frame + 1) / 10 + x / 100 + y / 1000 + nativeLayers.indexOf(layer) / 10000;
    };
    const packed = createGroupedV5Fixture({ groups: [hours.slice(0, 24), hours.slice(24)], nativeLayers, nativeValue });
    const hourly = createGroupedV5Fixture({ groups: hours.map(hour => [hour]), nativeLayers, nativeValue });
    const points = [finePoint(4, 17), finePoint(5, 17), nativePoint(31.75, 8.35), nativePoint(0, 9), nativePoint(16, 9)];
    const layers = 'usable-lift-msl,usable-lift-agl,thermal-velocity,wind-10m-u,wind-10m-v';
    const selection = `&frame=h024,h027&layers=${layers}`, coordinates = points.map(({ lat, lon }) => `${lat},${lon}`).join(';');
    const result = await body(await batch(packed, coordinates, selection));
    expect(result).toEqual(await body(await batch(hourly, coordinates, selection)));
    expect(result.points[0]!.sample.frames.map(frame => frame.layers['usable-lift-msl']!.status)).toEqual(['no-usable-lift', 'no-usable-lift']);
    expect(result.points[1]!.sample.frames.every(frame => frame.layers['usable-lift-agl']!.status === 'unavailable')).toBe(true);
    expect(result.points[3]!.sample.frames.every(frame => frame.layers['wind-10m-u']!.status === 'unavailable')).toBe(true);
    expect(result.points[4]!.sample.frames[1]!.layers['wind-10m-v']).toMatchObject({ value: 0, status: 'valid' });
    expect(result.points[0]!.sample.frames.map(frame => frame.intervalStart)).toEqual([23, 26].map(hour => new Date(NOW + hour * 3_600_000).toISOString()));
    for (const surface of packed.manifest.surfaces) for (const shard of surface.samples.shards) expect(numericReads(packed).some(([key]) => key === shard.key)).toBe(true);
    expect(numericReads(packed).reduce((total, [, options]) => total + options!.range!.length, 0)).toBeLessThanOrEqual(MAX_SAMPLE_RANGE_BYTES);
    const point = points[2]!, url = new URL(`https://api.test/v1/models/gfs/runs/${packed.buildId}/sample?lat=${point.lat}&lon=${point.lon}${selection}`);
    const single = await serveSample(new Request(url), packed.bucket, { waitUntil() {}, responseCacheEnabled: false }, packed.manifest, url);
    expect(sampleResponseV5Schema.parse(await single.json())).toEqual(result.points[2]!.sample);
    for (const fixture of [packed, hourly]) expect(coverageMemory(fixture.bucket).leaseRefs).toBe(0);
    expect(inFlightAllocationBytes()).toBe(0);
  });

  it('limits frame-group reads to four and drains every lease', async () => {
    const fixture = createGroupedV5Fixture({ groups: [[1], [2], [3], [4], [5], [6]] });
    const original = fixture.get.getMockImplementation()!;
    let active = 0, peak = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fixture.get.mockImplementation(async (key, options) => {
      if (!options?.range) return original(key, options);
      active++; peak = Math.max(peak, active);
      try { await gate; return await original(key, options); } finally { active--; }
    });
    const pending = batch(fixture, '9,-180;8.9,-179.9', '&frame=all');
    try { await vi.waitFor(() => expect(active).toBe(4)); } finally { release(); }
    const result = await body(await pending);
    expect(result.points.every(({ sample }) => sample.frames.length === 6)).toBe(true);
    expect(peak).toBe(4);
    expect(peak).toBeLessThanOrEqual(MAX_SAMPLE_CONCURRENT_READS_PER_REQUEST);
    expect(active).toBe(0);
    expect(coverageMemory(fixture.bucket).leaseRefs).toBe(0);
    expect(inFlightAllocationBytes()).toBe(0);
  });

  it('drains a successful sibling coverage load after another surface fails', async () => {
    const fixture = createV5Fixture(), original = fixture.get.getMockImplementation()!;
    let started!: () => void, release!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    fixture.get.mockImplementation(async (key, options) => {
      if (key === fixture.native.surface.coverage.maskKey) return null;
      if (key === fixture.fine.surface.coverage.maskKey) { started(); await gate; }
      return original(key, options);
    });
    const owners: Promise<unknown>[] = [], url = new URL(`https://api.test/v1/models/gfs/runs/${fixture.buildId}/samples?points=9,-180`);
    const pending = serveSamples(new Request(url), fixture.bucket, { waitUntil: promise => { owners.push(promise); }, responseCacheEnabled: false }, fixture.manifest, url);
    void pending.catch(() => {});
    await reading;
    await vi.waitFor(() => expect(coverageMemory(fixture.bucket).leaseRefs).toBe(1));
    release();
    await expect(pending).rejects.toThrow('Coverage descriptor missing');
    await Promise.allSettled(owners);
    expect(coverageMemory(fixture.bucket).leaseRefs).toBe(0);
    expect(inFlightAllocationBytes()).toBe(0);
  });

  it('canonicalizes frame and layer selections while preserving point permutations', async () => {
    const fixture = createV5Fixture(), points = '9,-180;8.9,-179.9';
    const first = await body(await batch(fixture, points, '&frame=h002,h001&layers=precip-rate,usable-lift-msl'));
    const canonical = await body(await batch(fixture, points, '&frame=h001,h002&layers=usable-lift-msl,precip-rate'));
    expect(canonical).toEqual(first);
    const reversed = await body(await batch(fixture, '8.9,-179.9;9,-180', '&frame=h001,h002&layers=usable-lift-msl,precip-rate'));
    expect(reversed.points[0]!.sample).toEqual(first.points[1]!.sample);
    expect(reversed.points[1]!.sample).toEqual(first.points[0]!.sample);
  });

  it('cancels one batch waiter while retaining the shared range and coverage for a survivor', async () => {
    const fixture = createV5Fixture(), original = fixture.get.getMockImplementation()!;
    let started!: () => void, release!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    fixture.get.mockImplementation(async (key, options) => {
      if (options?.range) { started(); await gate; }
      return original(key, options);
    });
    const controller = new AbortController(), first = batch(fixture, '9,-180;8.9,-179.9', '&layers=precip-rate', controller.signal);
    const second = batch(fixture, '9,-180;8.9,-179.9', '&layers=precip-rate');
    await reading;
    await vi.waitFor(() => expect(coverageMemory(fixture.bucket).leaseRefs).toBe(2));
    controller.abort(new Error('batch cancelled'));
    await expect(first).rejects.toThrow('batch cancelled');
    expect(coverageMemory(fixture.bucket).leaseRefs).toBe(1);
    release();
    expect((await body(await second)).points).toHaveLength(2);
    expect(numericReads(fixture)).toHaveLength(1);
    expect(coverageMemory(fixture.bucket).leaseRefs).toBe(0);
    expect(inFlightAllocationBytes()).toBe(0);
  });
});
