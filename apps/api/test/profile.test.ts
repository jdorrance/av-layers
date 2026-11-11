import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CELL_BYTES, MAX_PROFILE_LEVELS, LAYER_IDS, layerSurface, profileResponseSchema, sampleResponseV5Schema, type LayerId } from '@av/contracts';
import { nativeColumnCloudDiagnostics } from '@av/soaring';
import { prepareShardedSamplePackLayout, profileRecordBytes } from '@av/forecast';
import { coverageMemory } from '../src/coverage';
import { inFlightAllocationBytes, MAX_SAMPLE_CONCURRENT_READS_PER_REQUEST } from '../src/resources';
import { createApp } from '../src/index';
import { NOW, attachNativeProfiles, createGroupedV5Fixture, createV5Fixture, nativePoint } from './v5-fixture';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function nativeValue(layer: LayerId, _frame: number, x: number): number | null {
  const values: Partial<Record<LayerId, number>> = {
    'precip-rate': 2, 'thermal-velocity': 2, 'thermal-top-msl': 700, 'pbl-height-agl': 700,
    'sensible-heat-flux': 150, 'latent-heat-flux': 50, 'surface-lcl-msl': 1350, 'cape-jkg': 30,
    'cloud-cover-total': 80, 'cloud-cover-low': 25, 'sfc-temp-c': 20, 'sfc-dewpoint-c': 10,
    'mslp-hpa': 1010, 'wind-10m-u': 3, 'wind-10m-v': 4, 'wind-gust-10m': 8,
    'bl-mean-wind-u': 2, 'bl-mean-wind-v': 1
  };
  return layer === 'sfc-temp-c' ? 20 + x * 0.01 : values[layer] ?? null;
}
const layers = LAYER_IDS.filter(layer => layerSurface(layer) === 'native');
const fixture = () => attachNativeProfiles(createV5Fixture({ nativeLayers: layers, nativeValue }));
type Fixture = ReturnType<typeof fixture>;
const path = (f: Fixture, query = 'lat=8.8&lon=-115.3125') => `/v1/models/gfs/runs/${f.buildId}/profile?${query}`;
const ranges = (f: Fixture) => f.get.mock.calls.filter(([, options]) => options?.range);
const profileReads = (f: Fixture) => ranges(f).filter(([key]) => key.includes('/profiles/'));

async function read(response: Response) {
  const bytes = await response.arrayBuffer(), text = new TextDecoder().decode(bytes);
  expect(response.status, text).toBe(200);
  expect(response.headers.get('etag')).toBe(`"${createHash('sha256').update(new Uint8Array(bytes)).digest('hex')}"`);
  return profileResponseSchema.parse(JSON.parse(text));
}
const assertReleased = (f: Fixture) => {
  expect(coverageMemory(f.bucket).leaseRefs).toBe(0);
  expect(coverageMemory(f.bucket).leasedBytes).toBe(0);
  expect(inFlightAllocationBytes()).toBe(0);
};

function splitLastNativePacks(f: Fixture) {
  const surface = f.manifest.surfaces.find(surface => surface.kind === 'native')!;
  const split = <T extends { key: string; sha256: string; firstBlock: number; blockCount: number; storedCells: number; bytes: number }>(shards: readonly T[], channels: number, recordBytes: number): T[] => {
    if (shards.length !== 1) throw new Error('Fixture expects one original shard');
    const original = shards[0]!, source = f.objects.get(original.key)!;
    const layout = prepareShardedSamplePackLayout(surface.grid, f.native.mask.coverage.blockIds, channels, undefined, recordBytes);
    return Array.from({ length: layout.blockCount }, (_, ordinal) => {
      const block = layout.block(ordinal), bytes = source.slice(block.byteOffset, block.byteOffset + block.byteLength);
      const key = original.key.replace(/(b|\/)0\.bin$/, (_match, prefix: string) => `${prefix}${ordinal}.bin`);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      f.objects.set(key, bytes); f.shardSha.set(key, sha256);
      return { ...original, firstBlock: ordinal, blockCount: 1, storedCells: bytes.length / (channels * recordBytes), bytes: bytes.length, key, sha256,
        ...('blockShard' in original ? { blockShard: ordinal } : {}) };
    });
  };
  const samples = surface.samples;
  if (samples.format === 'frame-group-block-shards-v1') {
    const last = samples.shards[samples.shards.length - 1]!, start = samples.shards.findIndex(shard => shard.group === last.group);
    samples.shards.splice(start, samples.shards.length - start, ...split(samples.shards.slice(start), last.frameCount * surface.layers.length, CELL_BYTES));
  } else samples.shards = split(samples.shards, samples.channelCount, CELL_BYTES);
  const profiles = surface.profiles!, last = profiles.groups[profiles.groups.length - 1]!;
  last.shards = split(last.shards, last.frameCount, profiles.recordBytes);
  f.objects.set(`builds/${f.manifest.model}/${f.buildId}/manifest.json`, new TextEncoder().encode(JSON.stringify(f.manifest)));
  return surface;
}

describe('native profile API', () => {
  it.each([false, true])('honors declared scalar/profile partitions with grouped samples=%s', async grouped => {
    const varyingTemperature = (layer: LayerId, frame: number, x: number) => layer === 'sfc-temp-c'
      ? nativeValue(layer, frame, x)! + frame : nativeValue(layer, frame, x);
    const options = { nativeLayers: layers, nativeValue: varyingTemperature };
    const f = attachNativeProfiles(grouped ? createGroupedV5Fixture({ ...options, groups: [[1], [2, 3]] })
      : createV5Fixture({ ...options, frameHours: [1, 2, 3] }), { groupSize: grouped ? 1 : 3 });
    splitLastNativePacks(f);
    const point = nativePoint(20, 8), result = await read(await f.request(path(f, `lat=${point.lat}&lon=${point.lon}&frame=h003,h001`)));
    expect(result.cell?.index).toBe(8 * 32 + 20);
    expect(result.frames.map(frame => frame.id)).toEqual(['h001', 'h003']);
    for (const [index, frame] of result.frames.entries()) {
      expect(frame.profile.modelTerrainM).toBe(120);
      expect(frame.profile.levels[0]!.temperatureC).toBe(15 + 2 * index);
      expect(frame.profile.levels[0]!.uWindMps).toBe(22);
      expect(frame.layers['sfc-temp-c']!.value).toBeCloseTo(20.2 + 2 * index);
    }
    expect(profileReads(f).some(([key]) => key.endsWith('-b1.bin'))).toBe(true);
    const scalar = sampleResponseV5Schema.parse(await (await f.sample(point.lat, point.lon, '&frame=h003&layers=sfc-temp-c')).json());
    expect(scalar.frames[0]!.layers['sfc-temp-c']!.value).toBe(result.frames[1]!.layers['sfc-temp-c']!.value);
    assertReleased(f);
  });

  it.each(['samples', 'profiles'] as const)('rejects malformed declared %s partitions before numeric reads', async kind => {
    const f = fixture(), surface = splitLastNativePacks(f);
    const shards = kind === 'samples' ? surface.samples.shards : surface.profiles!.groups[0]!.shards;
    shards[1]!.firstBlock = 0;
    f.objects.set(`builds/${f.manifest.model}/${f.buildId}/manifest.json`, new TextEncoder().encode(JSON.stringify(f.manifest)));
    const result = await f.request(path(f));
    expect(result.status).toBe(503); await result.body?.cancel();
    expect(ranges(f)).toHaveLength(0); assertReleased(f);
  });

  it.each(['temperature', 'pressure', 'height', 'ground'] as const)('preserves %s gaps and only suppresses dependent point diagnostics', async missing => {
    const f = attachNativeProfiles(createV5Fixture({ nativeLayers: layers, nativeValue }), { levels: 3,
      profile: (_frame, x) => ({ modelTerrainM: missing === 'ground' ? null : 100 + x, surfacePressureHpa: 1000,
        status: missing === 'ground' ? 'unavailable' : 'valid', levels: [
          { pressureHpa: 980, heightM: 200, temperatureC: 20, dewPointC: 10, uWindMps: 2, vWindMps: 3, omegaPaS: null },
          { pressureHpa: missing === 'pressure' ? null : 940, heightM: missing === 'height' ? null : 400,
            temperatureC: missing === 'temperature' ? null : 17, dewPointC: 8, uWindMps: 5, vWindMps: 6, omegaPaS: null },
          { pressureHpa: 850, heightM: 1000, temperatureC: 10, dewPointC: 5, uWindMps: 7, vWindMps: 8, omegaPaS: null }
        ] }) });
    const response = await f.request(path(f));
    expect(response.status).toBe(200);
    const body = profileResponseSchema.parse(await response.json());
    for (const frame of body.frames) {
      expect(frame.profile.levels).toHaveLength(3);
      expect(frame.profile.levels[1]!.uWindMps).toBe(5);
      expect(frame.profile.surfacePressureHpa).toBe(1000);
      expect(frame.derived.mixedLayerLclM).toBeNull();
      if (missing === 'temperature') expect(frame.profile.levels[1]!.temperatureC).toBeNull();
      if (missing === 'pressure') expect(frame.profile.levels[1]!.pressureHpa).toBeNull();
      if (missing === 'height') expect(frame.profile.levels[1]!.heightM).toBeNull();
      if (missing === 'ground') {
        expect(frame.profile.modelTerrainM).toBeNull(); expect(frame.profile.status).toBe('unavailable');
        expect(frame.derived.dryHcritM).toBeNull();
      }
      if (missing === 'height' || missing === 'ground') expect(frame.derived.blTopWindSpeedMps).toBeNull();
      else expect(frame.derived.blTopWindSpeedMps).toBeCloseTo(Math.hypot(6, 7));
    }
    assertReleased(f);
  });

  it('publishes profile and batch schemas in OpenAPI', async () => {
    const f = fixture(), response = await f.request('/openapi.json');
    expect(response.status).toBe(200);
    const spec = await response.json() as { paths: Record<string, { get: { parameters: { name: string }[]; responses: Record<string, unknown> } }> };
    const root = '/v1/models/{model}/runs/{buildId}';
    expect(spec.paths[`${root}/samples`]!.get.parameters.map(parameter => parameter.name)).toContain('points');
    expect(spec.paths[`${root}/profile`]!.get.parameters.map(parameter => parameter.name)).toEqual(expect.arrayContaining(['lat', 'lon', 'frame', 'layers']));
    expect(spec.paths[`${root}/profile`]!.get.responses['409']).toBeDefined();
  });

  it.each([
    { location: 'a cell center', point: nativePoint(6, 8), donorX: 6, donorWindU: 3 },
    { location: 'an off-node point', point: nativePoint(5.75, 8.2), donorX: 6, donorWindU: 3, pointWindU: 2 },
    { location: 'the midpoint between cell centers', point: nativePoint(5.5, 8), donorX: 5, donorWindU: -1, pointWindU: 1 }
  ])('uses one native cell for scalar layers, levels, and derived diagnostics at $location', async ({ point, donorX, donorWindU, pointWindU }) => {
    const f = attachNativeProfiles(createV5Fixture({ nativeLayers: layers,
      nativeValue: (layer, frame, x) => layer === 'wind-10m-u' ? 3 + 4 * (x - 6) : nativeValue(layer, frame, x) }));
    const body = await read(await f.request(path(f, `lat=${point.lat}&lon=${point.lon}&frame=all`)));
    if (pointWindU !== undefined) {
      const sample = await f.sample(point.lat, point.lon, '&frame=all&layers=wind-10m-u');
      expect(sample.status).toBe(200);
      const pointSamples = sampleResponseV5Schema.parse(await sample.json());
      expect(pointSamples.frames.map(frame => frame.layers['wind-10m-u']?.value)).toEqual([pointWindU, pointWindU]);
      expect(pointSamples.frames.every(frame => frame.layers['wind-10m-u']?.interpolated)).toBe(true);
    }
    expect(body.lat).toBe(point.lat); expect(body.lon).toBe(point.lon);
    expect(body.cell).toEqual({ index: 8 * 32 + donorX, ...nativePoint(donorX, 8), surfaceId: 'native' });
    expect(body.frames).toHaveLength(2);
    const terrainM = 100 + donorX, temperatureC = Math.fround(20 + donorX * 0.01), levelWindU = 2 + donorX;
    for (const frame of body.frames) {
      expect(frame.profile).toMatchObject({ status: 'valid', modelTerrainM: terrainM, surfacePressureHpa: 987.6 });
      expect(frame.profile.levels.map(level => level.uWindMps)).toEqual([levelWindU, levelWindU]);
      expect(Object.keys(frame.layers).sort()).toEqual([...layers].sort());
      expect(frame.layers['sfc-temp-c']).toMatchObject({ value: temperatureC, interpolated: false, surfaceId: 'native' });
      expect(frame.layers['wind-10m-u']).toMatchObject({ value: donorWindU, interpolated: false, surfaceId: 'native' });
      const input = { terrainM, surfacePressureHpa: 987.6, surfaceTemperatureC: temperatureC, surfaceDewPointC: 10,
        levels: frame.profile.levels.map(level => ({ ...level, heightM: level.heightM ?? NaN,
          temperatureC: level.temperatureC ?? NaN, uMps: level.uWindMps, vMps: level.vWindMps })) };
      const cloud = nativeColumnCloudDiagnostics(input, 700);
      expect(frame.derived.mixedLayerLclM).toBeCloseTo(cloud.mixedLayerLclM!);
      expect(frame.derived.effectiveCloudLimitM).toBeCloseTo(cloud.effectiveCloudLimitM!);
      expect(frame.derived.blTopWindSpeedMps).toBeCloseTo(Math.hypot(levelWindU, -3));
      expect(frame.derived.wind10mSpeedMps).toBeCloseTo(Math.hypot(donorWindU, 4));
    }
    expect(profileReads(f)).toHaveLength(1);
    expect(f.get.mock.calls.some(([key]) => key.startsWith('coverage/') && key.includes(f.fine.surface.coverage.hash))).toBe(false);
    assertReleased(f);
  });

  it('defaults extended profiles to the first frame and supports bounded complete-field pages', async () => {
    const grid = { kind: 'regular-latlon' as const, width: 1, height: 18, lon0: -180, lat0: 17, dx: 360, dy: -1, wrapLongitude: true, earthRadiusM: 6371229 };
    const f = attachNativeProfiles(createV5Fixture({ grid, nativeLayers: layers, nativeValue, mapFrameCount: 24, frameHours: Array.from({ length: 144 }, (_, index) => index + 1) }), { levels: 21, groupSize: 16 });
    const first = await read(await f.request(path(f, 'lat=9&lon=-180')));
    expect(first.frames.map(frame => frame.id)).toEqual(['h001']);
    expect(first.frames[0]!.profile.levels).toHaveLength(21);
    expect(Object.keys(first.frames[0]!.layers)).toHaveLength(18);
    const selection = f.manifest.frames.slice(0, 24).map(frame => frame.id).join(',');
    const body = await read(await f.request(path(f, `lat=9&lon=-180&frame=${selection}`)));
    expect(body.frames).toHaveLength(24);
    expect(body.frames.length * Object.keys(body.frames[0]!.layers).length).toBeGreaterThan(256);
    const before = ranges(f).length, all = await f.request(path(f, 'lat=9&lon=-180&frame=all'));
    expect(all.status).toBe(429); await all.body?.cancel();
    expect(ranges(f)).toHaveLength(before);
    assertReleased(f);
  });

  it('retains all profile levels and derived soaring diagnostics when selecting fewer scalar channels', async () => {
    const f = fixture(), body = await read(await f.request(path(f, 'lat=8.8&lon=-115.3125&frame=h002&layers=wind-10m-v,wind-10m-u')));
    expect(body.frames.map(frame => frame.id)).toEqual(['h002']);
    expect(Object.keys(body.frames[0]!.layers)).toEqual(['wind-10m-u', 'wind-10m-v']);
    expect(body.frames[0]!.profile.levels).toHaveLength(2);
    expect(body.frames[0]!.derived.usableLiftTopV2M).not.toBeNull();
    expect(body.frames[0]!.derived.blTopWindSpeedMps).not.toBeNull();
    expect(body.frames[0]!.derived.cuPotentialM).toBe(-650);
    expect(body.frames[0]!.derived.cumulus).toBe(false);
    assertReleased(f);
  });

  it('retains nocturnal profiles, clouds and winds while thermal outputs remain zero', async () => {
    const f = attachNativeProfiles(createV5Fixture({ nativeLayers: layers,
      nativeValue: (layer, frame, x) => layer === 'thermal-velocity' ? 0 : layer === 'thermal-top-msl' ? 100 + x : nativeValue(layer, frame, x) }));
    const body = await read(await f.request(path(f)));
    for (const frame of body.frames) {
      expect(frame.profile.status).toBe('valid'); expect(frame.profile.levels).toHaveLength(2);
      expect(frame.layers['thermal-velocity']!.value).toBe(0);
      expect(frame.layers['cloud-cover-total']!.value).toBe(80);
      expect(frame.derived.wind10mSpeedMps).toBe(5);
      expect(frame.derived.blTopWindSpeedMps).toBeGreaterThan(0);
      expect(frame.derived.cumulus).toBe(false); expect(frame.derived.overdeveloped).toBe(false);
    }
  });

  it.each([
    { terrain: 500.4, top: 500.4, velocity: 0, packed: 500, topWind: Math.hypot(3, 12), shear: 8 },
    { terrain: 500.6, top: 500.6, velocity: 0, packed: 501, topWind: Math.hypot(3, 12.02), shear: 8.02 },
    { terrain: 500.4, top: 500.45, velocity: 2, packed: 500, topWind: 5, shear: 0 },
    { terrain: 500.6, top: 500.8, velocity: 0.2, packed: 501, topWind: 5, shear: 0 }
  ])('selects the native layer top across V1 terrain rounding for terrain $terrain and top $top', async ({ terrain, top, velocity, packed, topWind, shear }) => {
    const f = attachNativeProfiles(createV5Fixture({ nativeLayers: layers,
      nativeValue: (layer, frame, x) => layer === 'thermal-velocity' ? velocity : layer === 'thermal-top-msl' ? top
        : layer === 'pbl-height-agl' ? 500 : nativeValue(layer, frame, x) }), {
      profile: () => ({ modelTerrainM: terrain, surfacePressureHpa: 1000, status: 'valid', levels: [
        { pressureHpa: 980, heightM: 600, temperatureC: 18, dewPointC: 9, uWindMps: 3, vWindMps: 4, omegaPaS: null },
        { pressureHpa: 920, heightM: 1100, temperatureC: 15, dewPointC: 7, uWindMps: 3, vWindMps: 14, omegaPaS: null }
      ] })
    });
    const body = await read(await f.request(path(f)));
    const frame = body.frames[0]!;
    expect(frame.profile.modelTerrainM).toBe(packed);
    expect(frame.layers['thermal-top-msl']!.value).toBe(Math.fround(top));
    expect(frame.derived.blTopWindSpeedMps).toBeCloseTo(topWind, 5);
    expect(frame.derived.blWindShearMps).toBeCloseTo(shear, 5);
    if (velocity > 0) expect(frame.derived.overdeveloped).not.toBeNull();
    assertReleased(f);
  });

  it('returns outside-domain frames without reading scalar or profile ranges', async () => {
    const f = fixture(), body = await read(await f.request(path(f, 'lat=-50&lon=0')));
    expect(body.cell).toBeNull();
    expect(body.frames.every(frame => frame.profile.status === 'outside-domain' && frame.profile.surfacePressureHpa === null && !frame.profile.levels.length)).toBe(true);
    expect(body.frames.every(frame => Object.values(frame.layers).every(layer => layer.status === 'outside-domain'))).toBe(true);
    expect(ranges(f)).toHaveLength(0); assertReleased(f);
  });

  it('reports profiles unavailable for a retained build without them', async () => {
    const f = createV5Fixture(), response = await f.request(path(f));
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ title: 'profile-unavailable' });
    expect(ranges(f)).toHaveLength(0);
  });

  it.each(['lat=91&lon=0', 'lat=0&lon=181', 'lat=NaN&lon=0', 'lat=0&lon=0&layers=usable-lift-msl'])('rejects invalid native profile selection: %s', async query => {
    const f = fixture(), response = await f.request(path(f, query));
    expect(response.status).toBe(400); await response.body?.cancel();
    expect(ranges(f)).toHaveLength(0);
  });

  it.each(['missing', 'sha256', 'range', 'short', 'codec'] as const)('fails closed for %s profile data and releases leases', async defect => {
    const f = fixture(), surface = f.manifest.surfaces.find(surface => surface.kind === 'native')!, key = surface.profiles!.groups[0]!.shards[0]!.key;
    if (defect === 'missing') f.objects.delete(key);
    if (defect === 'sha256') f.shardSha.set(key, '0'.repeat(64));
    if (defect === 'codec') f.objects.get(key)!.fill(0);
    if (defect === 'range' || defect === 'short') {
      const original = f.get.getMockImplementation()!;
      f.get.mockImplementation(async (objectKey, options) => {
        const object = await original(objectKey, options);
        if (objectKey !== key || !object || !options?.range) return object;
        if (defect === 'range') return { ...object, range: { ...options.range, offset: options.range.offset + 1 } };
        return { ...object, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(options.range!.length - 1)); controller.close(); } }) };
      });
    }
    const response = await f.request(path(f));
    expect(response.status).toBe(503); await response.body?.cancel(); assertReleased(f);
  });

  it('rejects oversized profile responses before coverage reads', async () => {
    const f = attachNativeProfiles(createV5Fixture({ frameHours: Array.from({ length: 85 }, (_, index) => index + 1) }), { groupSize: 1 });
    const surface = f.manifest.surfaces.find(surface => surface.kind === 'native')!, profiles = surface.profiles!;
    profiles.levelCount = MAX_PROFILE_LEVELS; profiles.recordBytes = profileRecordBytes(MAX_PROFILE_LEVELS);
    for (const group of profiles.groups) for (const shard of group.shards) shard.bytes = shard.storedCells * group.frameCount * profiles.recordBytes;
    f.objects.set(`builds/gfs/${f.buildId}/manifest.json`, new TextEncoder().encode(JSON.stringify(f.manifest)));
    const response = await f.request(path(f, 'lat=8.8&lon=-115.3125&frame=all'));
    expect(response.status).toBe(429); expect(await response.json()).toMatchObject({ title: 'sample-limit' });
    expect(f.get.mock.calls.some(([key]) => key.startsWith('coverage/'))).toBe(false);
    expect(ranges(f)).toHaveLength(0); assertReleased(f);
  });

  it('charges the packed span between selected frames before numeric reads', async () => {
    const grid = { kind: 'regular-latlon' as const, width: 1, height: 18, lon0: -180, lat0: 17, dx: 360, dy: -1, wrapLongitude: true, earthRadiusM: 6371229 };
    const f = attachNativeProfiles(createV5Fixture({ grid, frameHours: Array.from({ length: 85 }, (_, index) => index + 1) }));
    const profiles = f.manifest.surfaces.find(surface => surface.kind === 'native')!.profiles!;
    profiles.levelCount = MAX_PROFILE_LEVELS; profiles.recordBytes = profileRecordBytes(MAX_PROFILE_LEVELS);
    for (const group of profiles.groups) for (const shard of group.shards) shard.bytes = shard.storedCells * group.frameCount * profiles.recordBytes;
    f.objects.set(`builds/gfs/${f.buildId}/manifest.json`, new TextEncoder().encode(JSON.stringify(f.manifest)));
    const response = await f.request(path(f, 'lat=9&lon=-180&frame=h001,h085'));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ detail: 'Selected profile ranges exceed the byte budget' });
    expect(ranges(f)).toHaveLength(0); assertReleased(f);
  });

  it('bounds profile and scalar concurrency together at four reads', async () => {
    const f = attachNativeProfiles(createGroupedV5Fixture({ groups: [[1], [2], [3], [4], [5], [6]], nativeLayers: layers, nativeValue }), { groupSize: 1 });
    const original = f.get.getMockImplementation()!;
    let active = 0, peak = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.get.mockImplementation(async (key, options) => {
      if (!options?.range) return original(key, options);
      active++; peak = Math.max(peak, active);
      try { await gate; return await original(key, options); } finally { active--; }
    });
    const pending = f.request(path(f, 'lat=8.8&lon=-115.3125&frame=all'));
    try { await vi.waitFor(() => expect(active).toBe(4)); } finally { release(); }
    expect((await read(await pending)).frames).toHaveLength(6);
    expect(peak).toBe(4);
    expect(peak).toBeLessThanOrEqual(MAX_SAMPLE_CONCURRENT_READS_PER_REQUEST);
    expect(active).toBe(0); assertReleased(f);
  });

  it('releases an aborted profile request while its R2 owner drains', async () => {
    const f = fixture(), original = f.get.getMockImplementation()!;
    let started!: () => void, release!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.get.mockImplementation(async (key, options) => { if (options?.range) { started(); await gate; } return original(key, options); });
    const controller = new AbortController(), owners: Promise<unknown>[] = [];
    const pending = f.app.fetch(new Request(`https://api.test${path(f)}`, { signal: controller.signal, headers: { 'cf-connecting-ip': '192.0.2.1' } }),
      { BUCKET: f.bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) }, AV_RESPONSE_CACHE: 'off' }, { waitUntil: promise => owners.push(promise) });
    await reading; controller.abort();
    const response = await pending;
    expect(response.status).toBe(503); await response.body?.cancel();
    expect(coverageMemory(f.bucket).leaseRefs).toBe(0);
    release(); await Promise.all(owners); assertReleased(f);
  });

  it.each(['profile', 'samples'] as const)('applies rate and query middleware to /%s before binary work', async endpoint => {
    const f = fixture(), app = createApp({ products: { gfs: f.product } });
    const query = endpoint === 'profile' ? 'lat=9&lon=-180' : 'points=9,-180';
    const url = `https://api.test/v1/models/gfs/runs/${f.buildId}/${endpoint}?${query}`;
    const denied = await app.fetch(new Request(url, { headers: { 'cf-connecting-ip': '192.0.2.1' } }), { BUCKET: f.bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: false }) } }, { waitUntil() {} });
    expect(denied.status).toBe(429); await denied.body?.cancel(); expect(f.get).not.toHaveBeenCalled();
    const duplicate = await app.fetch(new Request(`${url}&${query}`, { headers: { 'cf-connecting-ip': '192.0.2.1' } }), { BUCKET: f.bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) } }, { waitUntil() {} });
    expect(duplicate.status).toBe(400); await duplicate.body?.cancel(); expect(f.get).not.toHaveBeenCalled();
  });
});
