import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ExpiredBuildError, InvalidApiResponseError } from './client';
import { GFS_PRODUCT, createWholeDomainDescriptors, createRecipeIdentity, manifestV5Schema, publishedSampleResponseSchema, LIFT_METHOD, type LayerId, type ManifestV5 } from './index';
import { computeFreshness, latestSchema } from './publication';

const expiresAt = '2026-11-02T00:00:00.000Z';
const created = '2026-11-01T00:00:00.000Z';
const buildId = 'v5-client-1';
const prefix = `builds/gfs/${buildId}`;
const hash = (char: string) => char.repeat(64);
const gridHash = hash('1');
const descriptors = createWholeDomainDescriptors(GFS_PRODUCT);

const manifest: ManifestV5 = manifestV5Schema.parse({
  version: 5, model: 'gfs', buildId, cycle: created, createdAt: created, expiresAt,
  descriptors, recipe: createRecipeIdentity(GFS_PRODUCT, hash('a')),
  method: { id: [...new Set(GFS_PRODUCT.layers.map(layer => descriptors.layers[layer].methodId))].join('+'), hash: hash('a') },
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
  return latestSchema.parse({
    pointer: { version: 1, model: 'gfs', latestBuildId: buildId, retained: [{ buildId, manifestKey: `${prefix}/manifest.json`, cycle: created, expiresAt }] },
    manifest,
    templates: Object.fromEntries(manifest.layers.map(layer => [layer, `https://api.test/tiles/gfs/${buildId}/${layer}/{frame}/{z}/{x}/{y}.webp`])),
    freshness: computeFreshness(manifest, Date.parse(created))
  });
}

function samplePayload() {
  return publishedSampleResponseSchema.parse({
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
  it('pins a v5 manifest with native precipitation and fine lift surfaces', async () => {
    const { client: api, fetchImpl } = client();
    const build = await api.latest('gfs');
    expect(fetchImpl).toHaveBeenCalledWith('https://api.test/v1/models/gfs/latest?expand=manifest', expect.anything());
    expect(build.manifest.version).toBe(5);
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

  it('rejects a v5 sample for a legacy pinned build', async () => {
    const legacy = { ...manifest, version: 3, surfaces: undefined, coverage: { id: 'native-mask', hash: hash('e'), maskKey: `coverage/${hash('e')}/manifest.json`, maxZoom: 0 }, grid: manifest.surfaces[1]!.grid, samples: { format: 'cell-major-blocks-v1', blockSize: 16, storedCells: 1, channelCount: 3, bytes: 15, key: `${prefix}/samples.bin`, sha256: hash('a') }, patches: undefined };
    const latest = latestSchema.parse({
      pointer: { version: 1, model: 'gfs', latestBuildId: buildId, retained: [{ buildId, manifestKey: `${prefix}/manifest.json`, cycle: created, expiresAt }] },
      manifest: legacy,
      templates: Object.fromEntries(manifest.layers.map(layer => [layer, `https://api.test/tiles/gfs/${buildId}/${layer}/{frame}/{z}/{x}/{y}.webp`])),
      freshness: computeFreshness(legacy, Date.parse(created))
    });
    const { fetchImpl, client: api } = client(() => latest);
    fetchImpl.mockResolvedValueOnce(jsonResponse(samplePayload()));
    const build = await api.latest('gfs');
    await expect(api.sample(build, { lat: 0.5, lon: 0.5 })).rejects.toBeInstanceOf(InvalidApiResponseError);
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
