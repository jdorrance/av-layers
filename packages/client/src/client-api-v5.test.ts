import { INDEXED_PRODUCT } from '../../../tests/model-fixtures.js';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ExpiredBuildError, InvalidApiResponseError } from './index';
import { createWholeDomainDescriptors, createRecipeIdentity, manifestV5Schema, sampleResponseV5Schema, LIFT_METHOD,
  computeFreshness, latestV5Schema, profileResponseSchema, estimateProfileResponseBytes, MAX_POINT_RESPONSE_BYTES,
  type LayerId, type ManifestV5, type ProfileResponse } from '@av/contracts';
import { deriveSoaringViews } from '@av/soaring';
import { profileRecordBytes } from '@av/forecast';

const expiresAt = '2026-11-02T00:00:00.000Z';
const created = '2026-11-01T00:00:00.000Z';
const buildId = '20261101T000000Z-12345678-1234-4234-8234-123456789abc';
const prefix = `builds/gfs/${buildId}`;
const hash = (char: string) => char.repeat(64);
const gridHash = hash('1');
const descriptors = createWholeDomainDescriptors(INDEXED_PRODUCT);

const manifest: ManifestV5 = manifestV5Schema.parse({
  version: 5, model: 'gfs', buildId, cycle: created, createdAt: created, expiresAt,
  descriptors, recipe: createRecipeIdentity(INDEXED_PRODUCT, hash('a')),
  method: { id: [...new Set(INDEXED_PRODUCT.layers.map(layer => descriptors.layers[layer].methodId))].join('+'), hash: hash('a') },
  frames: [{ id: 'h001', validTime: created, intervalStart: '2026-10-31T23:00:00.000Z', intervalEnd: created }],
  layers: ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'],
  artifacts: (['usable-lift-msl', 'usable-lift-agl', 'precip-rate'] as LayerId[]).map(layer => ({ layer, frame: 'h001', tilesKey: `${prefix}/${layer}/h001.pmtiles`, tilesSha256: hash('b') })),
  surfaces: [
    {
      id: 'fine', kind: 'fine', grid: { kind: 'regular-latlon', width: 2, height: 2, lon0: 0, lat0: 1, dx: 1, dy: -1, wrapLongitude: false, earthRadiusM: 6371229 }, gridHash,
      coverage: { id: 'fine-mask', hash: hash('c'), maskKey: `coverage/${hash('c')}/manifest.json`, maxZoom: 0, gridHash },
      layers: ['usable-lift-msl', 'usable-lift-agl'],
      samples: { format: 'cell-major-block-shards-v1', blockSize: 16, channelOrder: 'frame-then-layer', channelCount: 2, coverageHash: hash('c'), blockCount: 1, storedCells: 1, shards: [{ firstBlock: 0, blockCount: 1, storedCells: 1, bytes: 10, key: `${prefix}/surfaces/fine/samples/0.bin`, sha256: hash('d') }] },
      terrain: { dataId: hash('d'), key: `terrain/prepared/${hash('d')}/manifest.json`, sha256: hash('d'), verticalDatum: 'EGM2008', surface: 'DSM', gridHash, coverageHash: hash('c'), layoutVersion: 1 }
    },
    {
      id: 'native', kind: 'native', grid: { kind: 'regular-latlon', width: 2, height: 2, lon0: 0, lat0: 1, dx: 1, dy: -1, wrapLongitude: false, earthRadiusM: 6371229 }, gridHash,
      coverage: { id: 'native-mask', hash: hash('e'), maskKey: `coverage/${hash('e')}/manifest.json`, maxZoom: 0, gridHash },
      layers: ['precip-rate'],
      samples: { format: 'cell-major-block-shards-v1', blockSize: 16, channelOrder: 'frame-then-layer', channelCount: 1, coverageHash: hash('e'), blockCount: 1, storedCells: 1, shards: [{ firstBlock: 0, blockCount: 1, storedCells: 1, bytes: 5, key: `${prefix}/surfaces/native/samples/0.bin`, sha256: hash('f') }] }
    }
  ],
  source: { provider: 'NOAA', provenanceKey: `${prefix}/provenance.json`, provenanceSha256: hash('a') },
  tool: {}, palettes: ['lift', 'rain'], metrics: {}
});

function latestPayload() {
  return latestV5Schema.parse({
    pointer: { version: 1, model: 'gfs', latestBuildId: buildId, retained: [{ buildId, manifestKey: `${prefix}/manifest.json`, cycle: created, expiresAt }] },
    manifest,
    templates: Object.fromEntries(manifest.layers.map(layer => [layer, `https://api.test/tiles/gfs/${buildId}/${layer}/{frame}/{z}/{x}/{y}.webp`])),
    freshness: computeFreshness(manifest, Date.parse(created))
  });
}

function nativeLatestPayload(includeTemplate = false) {
  const payload = latestPayload(), extended = structuredClone(manifest);
  const product = { ...INDEXED_PRODUCT, layers: [...INDEXED_PRODUCT.layers, 'thermal-velocity' as const] };
  extended.descriptors = createWholeDomainDescriptors(product);
  extended.layers.push('thermal-velocity');
  extended.method.id = [...new Set(extended.layers.map(layer => extended.descriptors.layers[layer].methodId))].join('+');
  const native = extended.surfaces.find(surface => surface.kind === 'native')!;
  native.layers.push('thermal-velocity'); native.samples.channelCount++;
  native.samples.shards[0].bytes *= 2;
  payload.manifest = manifestV5Schema.parse(extended);
  if (includeTemplate) payload.templates!['thermal-velocity'] = 'https://api.test/should-not-render/{frame}/{z}/{x}/{y}.webp';
  return payload;
}

function profileLatestPayload(frameCount = 1, levelCount = 3) {
  const payload = nativeLatestPayload(), extended = payload.manifest!;
  if (extended.version !== 5) throw new Error('Expected a v5 fixture');
  const first = extended.frames[0]!, archives = extended.artifacts, start = Date.parse(first.validTime);
  extended.frames = Array.from({ length: frameCount }, (_, index) => {
    const validTime = new Date(start + index * 3_600_000).toISOString();
    return { ...first, id: `h${String(index + 1).padStart(3, '0')}`, validTime, intervalStart: new Date(start + (index - 1) * 3_600_000).toISOString(), intervalEnd: validTime };
  });
  extended.mapFrameCount = Math.min(24, frameCount);
  extended.artifacts = extended.frames.slice(0, extended.mapFrameCount).flatMap(frame => archives.map(artifact => ({ ...artifact, frame: frame.id, tilesKey: `${prefix}/${artifact.layer}/${frame.id}.pmtiles` })));
  for (const surface of extended.surfaces) {
    const count = surface.kind === 'fine' ? extended.mapFrameCount : frameCount;
    surface.samples.channelCount *= count; surface.samples.shards[0].bytes *= count;
  }
  const native = extended.surfaces.find(surface => surface.kind === 'native')!;
  const recordBytes = profileRecordBytes(levelCount);
  native.profiles = {
    format: 'native-column-profile-v1', blockSize: 16, levelCount, recordBytes,
    coverageHash: native.coverage.hash, blockCount: 1, storedCells: 1,
    groups: Array.from({ length: Math.ceil(frameCount / 16) }, (_, group) => {
      const count = Math.min(16, frameCount - group * 16);
      return { firstFrame: group * 16, frameCount: count, shards: [{ firstBlock: 0, blockCount: 1, storedCells: 1, bytes: count * recordBytes, key: `${prefix}/surfaces/native/profiles/g${group}-b0.bin`, sha256: hash('a') }] };
    })
  };
  payload.manifest = manifestV5Schema.parse(extended);
  return payload;
}

function profilePayload(): ProfileResponse {
  const pinned = profileLatestPayload().manifest!;
  return profileResponseSchema.parse({
    version: 1, model: 'gfs', buildId, cycle: created, createdAt: created, expiresAt, lat: 0.5, lon: 0.5,
    method: pinned.method, source: pinned.source, cell: { index: 2, lat: 0, lon: 0, surfaceId: 'native' },
    frames: pinned.frames.map(frame => ({ ...frame, layers: {
      'precip-rate': { value: 0, status: 'valid', support: 0, interpolated: false, surfaceId: 'native' },
      'thermal-velocity': { value: 0.5, status: 'valid', support: 0, interpolated: false, surfaceId: 'native' }
    }, profile: { modelTerrainM: 100, surfacePressureHpa: 990, status: 'valid', levels: [
      { pressureHpa: 975, heightM: 200, temperatureC: 20, dewPointC: 10, uWindMps: 2, vWindMps: -3, omegaPaS: null },
      { pressureHpa: 925, heightM: 700, temperatureC: 16, dewPointC: null, uWindMps: null, vWindMps: null, omegaPaS: -0.2 }
    ] }, derived: { ...deriveSoaringViews({}), mixedLayerLclM: null, effectiveCloudLimitM: null } }))
  });
}

function samplePayload() {
  return sampleResponseV5Schema.parse({
    version: 5, model: 'gfs', buildId, lat: 0.5, lon: 0.5, method: manifest.method, source: manifest.source, expiresAt,
    surfaces: manifest.surfaces.map(({ id, kind, layers, coverage }) => ({ id, kind, layers, coverage })),
    frames: manifest.frames.map(frame => ({ ...frame, layers: {
      'usable-lift-msl': { value: 310, status: 'valid', support: 4, interpolated: false, surfaceId: 'fine' },
      'usable-lift-agl': { value: 610, status: 'valid', support: 8, interpolated: false, surfaceId: 'fine' },
      'precip-rate': { value: 7, status: 'valid', support: 0, interpolated: false, surfaceId: 'native' }
    } }))
  });
}

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function client(payload: () => unknown = latestPayload) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(payload()));
  return { fetchImpl, client: new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(created) }) };
}

describe('ApiClient v5 pinning', () => {
  it.each([false, true])('pins sample-only native channels without exposing their raster templates (%s)', async includeTemplate => {
    const { client: api } = client(() => nativeLatestPayload(includeTemplate));
    const build = await api.latest('gfs');
    expect(build.manifest.layers).toContain('thermal-velocity');
    expect(build.templates).not.toHaveProperty('thermal-velocity');
    expect(Object.keys(build.templates)).toEqual(manifest.layers);
  });

  it('requires every rendered layer template', async () => {
    const payload = nativeLatestPayload(); delete payload.templates!['precip-rate'];
    const { client: api } = client(() => payload);
    await expect(api.latest('gfs')).rejects.toBeInstanceOf(InvalidApiResponseError);
  });

  it.each(['cell-major-block-shards-v1', 'frame-group-block-shards-v1'] as const)('pins native precipitation and fine lift in %s', async format => {
    const payload = latestPayload();
    if (format === 'frame-group-block-shards-v1') payload.manifest = {
      ...manifest, surfaces: manifest.surfaces.map(surface => ({
        ...surface, samples: { ...surface.samples, format,
          shards: surface.samples.shards.map((shard, blockShard) => ({
            ...shard, group: 0, firstFrame: 0, frameCount: 1, blockShard,
            key: `${prefix}/surfaces/${surface.id}/samples/g0-b${blockShard}.bin`
          })) }
      }))
    };
    const { client: api, fetchImpl } = client(() => payload);
    const build = await api.latest('gfs');
    expect(fetchImpl).toHaveBeenCalledWith('https://api.test/v1/models/gfs/latest?expand=manifest', expect.anything());
    expect(build.manifest.surfaces.every(surface => surface.samples.format === format)).toBe(true);
    expect(build.templates['precip-rate']).toContain('/precip-rate/');
    expect(build.expiresAtMs).toBe(Date.parse(expiresAt));
  });

  it('accepts a matching v5 sample and preserves surface ownership', async () => {
    const { fetchImpl, client: api } = client();
    fetchImpl.mockResolvedValueOnce(jsonResponse(samplePayload()));
    const build = await api.latest('gfs');
    const result = await api.sample(build, { lat: 0.5, lon: 0.5, frames: ['h001'], layers: ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'] });
    expect(result.frames[0]!.layers['usable-lift-msl']).toMatchObject({ surfaceId: 'fine', value: 310 });
    expect(result.frames[0]!.layers['precip-rate']).toMatchObject({ surfaceId: 'native', value: 7 });
  });

  it('rejects a sample whose declared surfaces differ from the pinned build', async () => {
    const payload = samplePayload();
    if (payload.version !== 5) throw new Error('Expected a v5 sample payload');
    payload.surfaces[0]!.coverage.maxZoom = 1;
    const { fetchImpl, client: api } = client();
    fetchImpl.mockResolvedValueOnce(jsonResponse(payload));
    const build = await api.latest('gfs');
    await expect(api.sample(build, { lat: 0.5, lon: 0.5 })).rejects.toBeInstanceOf(InvalidApiResponseError);
  });

  it('rejects a sample using the native lift method instead of the pinned terrain-column method', async () => {
    const payload = samplePayload();
    payload.method.id = `${LIFT_METHOD.id}+${descriptors.layers['precip-rate'].methodId}`;
    const { fetchImpl, client: api } = client();
    fetchImpl.mockResolvedValueOnce(jsonResponse(payload));
    const build = await api.latest('gfs');
    await expect(api.sample(build, { lat: 0.5, lon: 0.5 })).rejects.toBeInstanceOf(InvalidApiResponseError);
  });

  it('rejects a legacy expanded manifest at the cutover boundary', async () => {
    const payload = latestPayload();
    const { client: api } = client(() => ({ ...payload, manifest: { ...manifest, version: 3 } }));
    await expect(api.latest('gfs')).rejects.toBeInstanceOf(InvalidApiResponseError);
  });

  it('rechecks the pinned v5 expiry after an in-flight sample', async () => {
    let now = Date.parse(created);
    let resolveResponse!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(latestPayload()))
      .mockImplementationOnce(() => new Promise(resolve => { resolveResponse = resolve; }));
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => now });
    const build = await api.latest('gfs');
    const pending = api.sample(build, { lat: 0.5, lon: 0.5 });
    now = Date.parse(expiresAt);
    resolveResponse(jsonResponse(samplePayload()));
    await expect(pending).rejects.toBeInstanceOf(ExpiredBuildError);
  });
});

describe('ApiClient multi-point samples', () => {
  const points = [{ lat: 0.123456789, lon: 0.456789123 }, { lat: 0.5, lon: 0.5 }];
  function batch() {
    return { version: 1, model: 'gfs', buildId, expiresAt, points: points.map((point, index) => ({ index, sample: { ...samplePayload(), ...point } })) };
  }
  it('pins all point responses and preserves full coordinates and request order', async () => {
    const { fetchImpl, client: api } = client(); fetchImpl.mockResolvedValueOnce(jsonResponse(batch()));
    const build = await api.latest('gfs'), payload = await api.samples(build, { points });
    const url = new URL(String(fetchImpl.mock.calls[1][0]));
    expect(url.pathname).toBe(`/v1/models/gfs/runs/${buildId}/samples`);
    expect(url.searchParams.get('points')).toBe('0.123456789,0.456789123;0.5,0.5');
    expect(payload.points.map(({ sample }) => ({ lat: sample.lat, lon: sample.lon }))).toEqual(points);
  });
  it.each([
    ['wrong order', (payload: ReturnType<typeof batch>) => { payload.points.reverse(); }],
    ['wrong coordinate', (payload: ReturnType<typeof batch>) => { payload.points[0].sample.lat = 0; }],
    ['missing point', (payload: ReturnType<typeof batch>) => { payload.points.pop(); }],
    ['wrong source', (payload: ReturnType<typeof batch>) => { payload.points[0].sample.source.provenanceSha256 = hash('b'); }],
    ['wrong frame', (payload: ReturnType<typeof batch>) => { payload.points[0].sample.frames[0].intervalStart = created; }],
    ['wrong value', (payload: ReturnType<typeof batch>) => { payload.points[0].sample.frames[0].layers['precip-rate'].value = null; }],
    ['wrong expiry', (payload: ReturnType<typeof batch>) => { payload.expiresAt = created; }],
  ] as const)('rejects %s through the same pinned sample validation', async (_name, edit) => {
    const body = batch(); edit(body);
    const { fetchImpl, client: api } = client(); fetchImpl.mockResolvedValueOnce(jsonResponse(body));
    await expect(api.samples(await api.latest('gfs'), { points })).rejects.toBeInstanceOf(InvalidApiResponseError);
  });
  it('checks aggregate value, point and coordinate limits before fetching', async () => {
    const { fetchImpl, client: api } = client(), build = await api.latest('gfs');
    await expect(api.samples(build, { points: [] })).rejects.toBeInstanceOf(RangeError);
    await expect(api.samples(build, { points: Array(65).fill(points[0]) })).rejects.toBeInstanceOf(RangeError);
    await expect(api.samples(build, { points: [{ lat: NaN, lon: 0 }] })).rejects.toBeInstanceOf(RangeError);
    build.manifest.descriptors.maxSampleValues = 5;
    await expect(api.samples(build, { points })).rejects.toBeInstanceOf(RangeError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

});

describe('ApiClient native profiles', () => {
  it('admits profile scalars independently of the scalar-sample value limit', async () => {
    const payload = profileLatestPayload(); payload.manifest!.descriptors.maxSampleValues = 1;
    const { fetchImpl, client: api } = client(() => payload); fetchImpl.mockResolvedValueOnce(jsonResponse(profilePayload()));
    await expect(api.profile(await api.latest('gfs'), { lat: 0.5, lon: 0.5 })).resolves.toMatchObject({ buildId });
    expect(estimateProfileResponseBytes(24, 30, 30)).toBeLessThan(MAX_POINT_RESPONSE_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(profilePayload())).length).toBeLessThan(estimateProfileResponseBytes(1, 3, 2));
  });

  it('rejects oversized profile JSON selections before fetching data', async () => {
    const payload = profileLatestPayload(30, 256);
    const { fetchImpl, client: api } = client(() => payload);
    await expect(api.profile(await api.latest('gfs'), { lat: 0.5, lon: 0.5, frames: 'all' })).rejects.toThrow('Selected profile response exceeds byte budget');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('defaults extended v5 point products to one frame and checks explicit all selections', async () => {
    const latest = profileLatestPayload(144, 30), pinned = latest.manifest!;
    if (pinned.version !== 5) throw new Error('Expected a v5 fixture');
    const sample = samplePayload();
    if (sample.version !== 5) throw new Error('Expected a v5 sample');
    sample.method = pinned.method;
    sample.surfaces = pinned.surfaces.map(({ id, kind, layers, coverage }) => ({ id, kind, layers, coverage }));
    sample.frames[0]!.layers['thermal-velocity'] = profilePayload().frames[0]!.layers['thermal-velocity']!;
    const points = [{ lat: 0.5, lon: 0.5 }, { lat: 0.25, lon: 0.75 }];
    const batch = { version: 1, model: 'gfs', buildId, expiresAt,
      points: points.map((point, index) => ({ index, sample: { ...sample, ...point } })) };
    const { fetchImpl, client: api } = client(() => latest), build = await api.latest('gfs');
    fetchImpl.mockResolvedValueOnce(jsonResponse(sample)).mockResolvedValueOnce(jsonResponse(batch)).mockResolvedValueOnce(jsonResponse(profilePayload()));
    expect((await api.sample(build, points[0]!)).frames.map(frame => frame.id)).toEqual(['h001']);
    expect((await api.samples(build, { points })).points).toHaveLength(2);
    expect((await api.profile(build, points[0]!)).frames.map(frame => frame.id)).toEqual(['h001']);
    for (const [url] of fetchImpl.mock.calls.slice(1)) expect(new URL(String(url)).searchParams.get('frame')).toBe('h001');
    await expect(api.sample(build, { ...points[0]!, frames: 'all' })).rejects.toThrow('point/frame/layer');
    await expect(api.samples(build, { points, frames: 'all' })).rejects.toThrow('point/frame/layer');
    await expect(api.profile(build, { ...points[0]!, frames: 'all' })).rejects.toThrow('Selected profile response exceeds byte budget');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('loads all native fields while preserving native model ground and missing profile values', async () => {
    const { fetchImpl, client: api } = client(profileLatestPayload); fetchImpl.mockResolvedValueOnce(jsonResponse(profilePayload()));
    const build = await api.latest('gfs'), payload = await api.profile(build, { lat: 0.5, lon: 0.5 });
    const url = new URL(String(fetchImpl.mock.calls[1][0]));
    expect(url.searchParams.get('layers')).toBe('precip-rate,thermal-velocity');
    expect(payload.frames[0].profile.modelTerrainM).toBe(100);
    expect(payload.frames[0].profile.levels[1].dewPointC).toBeNull();
    expect(payload.cell).toMatchObject({ index: 2, lat: 0, lon: 0, surfaceId: 'native' });
  });
  it('retains nullable interior rows and known measurements when model ground is unavailable', async () => {
    for (const missingGround of [false, true]) {
      const body = profilePayload(), profile = body.frames[0].profile;
      profile.levels.splice(1, 0, { pressureHpa: null, heightM: null, temperatureC: null,
        dewPointC: 5, uWindMps: 7, vWindMps: 8, omegaPaS: null });
      if (missingGround) { profile.modelTerrainM = null; profile.status = 'unavailable'; }
      const { fetchImpl, client: api } = client(profileLatestPayload); fetchImpl.mockResolvedValueOnce(jsonResponse(body));
      const result = await api.profile(await api.latest('gfs'), { lat: 0.5, lon: 0.5 });
      expect(result.frames[0].profile.levels).toHaveLength(3);
      expect(result.frames[0].profile.levels[1]).toMatchObject({ heightM: null, temperatureC: null, uWindMps: 7 });
      expect(result.frames[0].profile.modelTerrainM).toBe(missingGround ? null : 100);
    }
  });
  it.each([
    ['wrong build', (payload: ProfileResponse) => { payload.buildId = 'other'; }],
    ['wrong cycle', (payload: ProfileResponse) => { payload.cycle = expiresAt; }],
    ['wrong generation time', (payload: ProfileResponse) => { payload.createdAt = expiresAt; }],
    ['wrong coordinate', (payload: ProfileResponse) => { payload.lat = 0; }],
    ['wrong source', (payload: ProfileResponse) => { payload.source.provenanceSha256 = hash('b'); }],
    ['wrong cell index', (payload: ProfileResponse) => { payload.cell!.index = 4; }],
    ['wrong cell coordinate', (payload: ProfileResponse) => { payload.cell!.lon = 0.1; }],
    ['wrong cell surface', (payload: ProfileResponse) => { payload.cell!.surfaceId = 'fine'; }],
    ['wrong frame selection', (payload: ProfileResponse) => { payload.frames[0].id = 'other'; }],
    ['wrong native ownership', (payload: ProfileResponse) => { payload.frames[0].layers['thermal-velocity'].surfaceId = 'fine'; }],
    ['invalid flags', (payload: ProfileResponse) => { payload.frames[0].layers['thermal-velocity'].support = 256; }],
    ['interpolated values', (payload: ProfileResponse) => { payload.frames[0].layers['thermal-velocity'].interpolated = true; }],
    ['inconsistent coverage', (payload: ProfileResponse) => { payload.cell = null; }],
    ['invalid scalar missingness', (payload: ProfileResponse) => { payload.frames[0].layers['precip-rate'].value = null; }],
    ['invalid vertical order', (payload: ProfileResponse) => { payload.frames[0].profile.levels.reverse(); }],
    ['invalid known height across a gap', (payload: ProfileResponse) => {
      const levels = payload.frames[0].profile.levels;
      levels.splice(1, 0, { ...levels[0], pressureHpa: null, heightM: null, temperatureC: null });
      levels[2].heightM = 150;
    }],
    ['invalid known pressure across a gap', (payload: ProfileResponse) => {
      const levels = payload.frames[0].profile.levels;
      levels.splice(1, 0, { ...levels[0], pressureHpa: null, heightM: null, temperatureC: null });
      levels[2].pressureHpa = 980;
    }],
  ] as const)('rejects %s', async (_name, edit) => {
    const body = profilePayload(); edit(body);
    const { fetchImpl, client: api } = client(profileLatestPayload); fetchImpl.mockResolvedValueOnce(jsonResponse(body));
    await expect(api.profile(await api.latest('gfs'), { lat: 0.5, lon: 0.5 })).rejects.toBeInstanceOf(InvalidApiResponseError);
  });
  it('validates a selected subset and refuses fine fields or unsupported profiles before a request', async () => {
    const body = profilePayload(); delete body.frames[0].layers['precip-rate'];
    const { fetchImpl, client: api } = client(profileLatestPayload); fetchImpl.mockResolvedValueOnce(jsonResponse(body));
    const build = await api.latest('gfs');
    await expect(api.profile(build, { lat: 0.5, lon: 0.5, frames: ['h001'], layers: ['thermal-velocity'] })).resolves.toMatchObject({ buildId });
    await expect(api.profile(build, { lat: 0.5, lon: 0.5, layers: ['usable-lift-msl'] })).rejects.toBeInstanceOf(RangeError);
    await expect(api.profile({ ...build, manifest }, { lat: 0.5, lon: 0.5 })).rejects.toBeInstanceOf(RangeError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('applies the same expiry and cancellation lifecycle to new point routes', async () => {
    let now = Date.parse(created);
    let finish!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(profileLatestPayload())).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => now });
    const build = await api.latest('gfs');
    const pending = api.profile(build, { lat: 0.5, lon: 0.5 });
    now = Date.parse(expiresAt); finish(jsonResponse(profilePayload()));
    await expect(pending).rejects.toBeInstanceOf(ExpiredBuildError);
    const controller = new AbortController(); controller.abort(new Error('superseded'));
    await expect(api.samples(build, { points: [{ lat: 0, lon: 0 }], signal: controller.signal, now: Date.parse(created) })).rejects.toThrow('superseded');
  });
});
