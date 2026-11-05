import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAYERS, MAX_SAMPLE_POINTS, multiPointSampleResponseSchema, sampleResponseV5Schema } from '@av/contracts';
import { serveSample, serveSamples } from '../src/sample';
import { coverageMemory } from '../src/coverage';
import { inFlightAllocationBytes } from '../src/resources';
import { NOW, commonPoint, createGroupedV5Fixture, createV5Fixture, finePoint } from './v5-fixture';

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

  it('rejects the combined merged byte cost before reading any numeric object', async () => {
    const fixture = createV5Fixture({ frameHours: Array.from({ length: 85 }, (_, index) => index + 1) });
    const points = Array.from({ length: 64 }, (_, index) => finePoint(index % 16 * 4 + 0.25, 16.25 + Math.floor(index / 16)));
    await expect(batch(fixture, points.map(({ lat, lon }) => `${lat},${lon}`).join(';'), '&layers=usable-lift-msl')).rejects.toMatchObject({ status: 429, code: 'sample-limit' });
    expect(numericReads(fixture)).toHaveLength(0);
    expect(coverageMemory(fixture.bucket).leaseRefs).toBe(0);
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
    expect(peak).toBe(4); expect(active).toBe(0);
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
