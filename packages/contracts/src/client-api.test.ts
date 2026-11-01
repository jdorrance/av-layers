import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ExpiredBuildError, InvalidApiResponseError, noLiftLabel, type LatestPayload } from './client';
import { GFS_GRID, GFS_PRODUCT, createProductDescriptors, createRecipeIdentity, type Manifest, type ModelPointer } from '@av/contracts';

const expiresAt = '2026-10-31T00:00:00.000Z';
const created = '2026-10-30T00:00:00.000Z';
it('labels transparent and opaque no-lift legend swatches accurately', () => {
  expect(noLiftLabel('#00000000')).toBe('no usable lift (transparent)');
  expect(noLiftLabel('#55184d')).toBe('no usable lift');
});
const layerIds = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'] as const;
const frames = ['f003', 'f006', 'f009', 'f012', 'f015', 'f018', 'f021', 'f024'].map((id, index) => {
  const start = new Date(Date.parse(created) + index * 3 * 3600_000 + 3 * 3600_000).toISOString();
  const end = new Date(Date.parse(start) + 3 * 3600_000).toISOString();
  return { id, validTime: end, intervalStart: start, intervalEnd: end };
});

function manifest(): Manifest {
  return {
    version: 3, descriptors: createProductDescriptors(), recipe: createRecipeIdentity(GFS_PRODUCT, 'a'.repeat(64)),
    model: 'gfs',
    buildId: '20261030T000000Z-abc',
    cycle: created,
    createdAt: created,
    expiresAt,
    method: { id: 'dry-lenschow-pbl-1p2-v1', hash: 'a'.repeat(64) },
    coverage: { id: 'soaring-land-v1', hash: 'b'.repeat(64), maskKey: 'masks/soaring-land-v1', maxZoom: 5 },
    grid: GFS_GRID,
    frames,
    layers: [...layerIds],
    artifacts: layerIds.flatMap(layer => frames.map(frame => ({
      layer,
      frame: frame.id,
      tilesKey: `builds/gfs/20261030T000000Z-abc/${layer}/${frame.id}.pmtiles`,
      tilesSha256: 'c'.repeat(64)
    }))),
    samples: { format: 'cell-major-blocks-v1', blockSize: 16, storedCells: 365296, channelCount: 24, bytes: 43835520, key: 'builds/gfs/20261030T000000Z-abc/samples.bin', sha256: 'd'.repeat(64) },
    source: { provider: 'NOAA', provenanceKey: 'builds/gfs/20261030T000000Z-abc/provenance.json', provenanceSha256: 'a'.repeat(64), nativeResolutionDeg: 0.25, model: 'GFS' },
    tool: { name: 'av-batch', version: '0.0.0' },
    palettes: ['lift', 'rain'],
    metrics: {}
  };
}

function pointer(): ModelPointer {
  return {
    version: 1,
    model: 'gfs',
    latestBuildId: '20261030T000000Z-abc',
    retained: [{ buildId: '20261030T000000Z-abc', manifestKey: 'builds/gfs/20261030T000000Z-abc/manifest.json', cycle: created, expiresAt }]
  };
}

function latestPayload(): LatestPayload {
  return {
    pointer: pointer(),
    manifest: manifest(),
    templates: Object.fromEntries(layerIds.map(layer => [layer, `https://api.test/tiles/gfs/20261030T000000Z-abc/${layer}/{frame}/{z}/{x}/{y}.webp`])),
    bounds: [-180, -55, 180, 65],
    maxNativeZoom: 5,
    palettes: [{ id: 'lift', edges: [0, 300], colors: ['#000000', '#ffffff'], units: 'm' }],
    coverage: { id: 'soaring-land-v1', hash: 'b'.repeat(64), maskKey: 'masks/soaring-land-v1', maxZoom: 5 },
    freshness: { ageSeconds: 10, expiresAt }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('ApiClient.latest', () => {
  it('fetches one expanded manifest and pins the returned build', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(latestPayload()));
    const client = new ApiClient({ baseUrl: 'https://api.test/', fetchImpl, now: () => Date.parse(created) });
    const build = await client.latest('gfs');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.test/v1/models/gfs/latest?expand=manifest');
    expect(build.manifest.buildId).toBe('20261030T000000Z-abc');
    expect(build.templates['usable-lift-msl']).toContain('/usable-lift-msl/{frame}/{z}/{x}/{y}.webp');
    expect(build.maxNativeZoom).toBe(5);
    expect(build.expiresAtMs).toBe(Date.parse(expiresAt));
  });

  it('preserves forecast-horizon metadata without rejecting retained historical forecasts', async () => {
    const payload = latestPayload();
    payload.manifest!.expiresAt = '2026-11-06T00:00:00.000Z';
    payload.pointer.retained[0]!.expiresAt = payload.manifest!.expiresAt;
    payload.freshness = { ageSeconds: 90000, expiresAt: payload.manifest!.expiresAt, cycle: created,
      latestValidTime: frames.at(-1)!.validTime, horizonExhausted: true, horizonRemainingSeconds: 0 };
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: async () => jsonResponse(payload),
      now: () => Date.parse('2026-10-31T06:00:00Z') });
    const build = await client.latest('gfs');
    expect(build.freshness).toEqual(payload.freshness);
    expect(build.manifest.frames).toEqual(frames);
  });

  it.each([
    ['missing freshness', () => ({ ...latestPayload(), freshness: undefined })],
    ['invalid manifest without freshness', () => ({ ...latestPayload(), freshness: undefined, manifest: { ...manifest(), method: null } })],
    ['invalid method', () => ({ ...latestPayload(), manifest: { ...manifest(), method: null } })],
    ['invalid frame time', () => ({ ...latestPayload(), manifest: { ...manifest(), frames: [{ ...frames[0], validTime: 'not-a-time' }] } })],
    ['incomplete pointer', () => ({ ...latestPayload(), pointer: { model: 'gfs', latestBuildId: manifest().buildId } })],
    ['missing expanded manifest', () => ({ ...latestPayload(), manifest: undefined })]
  ])('rejects %s at the response boundary', async (_name, payload) => {
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: async () => jsonResponse(payload()), now: () => Date.parse(created) });
    await expect(client.latest('gfs')).rejects.toBeInstanceOf(InvalidApiResponseError);
  });

  it.each(['identity', 'length', 'padding', 'byte'])('rejects expanded coverage %s disagreement', async kind => {
    const payload = latestPayload();
    if (kind === 'identity') payload.coverage!.hash = 'f'.repeat(64);
    else {
      payload.coverage!.tileBits = new Array(171).fill(0);
      if (kind === 'length') payload.coverage!.tileBits!.pop();
      if (kind === 'padding') payload.coverage!.tileBits![170] = 128;
      if (kind === 'byte') payload.coverage!.tileBits![0] = 256;
    }
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: async () => jsonResponse(payload), now: () => Date.parse(created) });
    await expect(client.latest('gfs')).rejects.toBeInstanceOf(InvalidApiResponseError);
  });

  it('rejects a manifest that does not match the pinned pointer build', async () => {
    const payload = latestPayload();
    payload.manifest = { ...payload.manifest!, buildId: 'other' };
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: (async () => jsonResponse(payload)) as typeof fetch });
    await expect(client.latest('gfs')).rejects.toBeInstanceOf(InvalidApiResponseError);
  });

  it('rejects an expired build before returning a viewable model', async () => {
    const client = new ApiClient({
      baseUrl: 'https://api.test',
      fetchImpl: (async () => jsonResponse(latestPayload())) as typeof fetch,
      now: () => Date.parse(expiresAt) + 1
    });
    await expect(client.latest('gfs')).rejects.toBeInstanceOf(ExpiredBuildError);
  });

  it('propagates structured problem details', async () => {
    const client = new ApiClient({
      baseUrl: 'https://api.test',
      fetchImpl: (async () => jsonResponse({ type: 'not-retained', detail: 'expired', status: 404 }, 404)) as typeof fetch
    });
    await expect(client.latest('gfs')).rejects.toMatchObject({ status: 404, code: 'not-retained', message: 'expired' });
  });
});

describe('ApiClient.sample', () => {
  function samplePayload() {
    return {
      model: 'gfs',
      buildId: '20261030T000000Z-abc',
      lat: -32.9,
      lon: -68.9,
      method: manifest().method,
      source: manifest().source,
      coverage: manifest().coverage,
      expiresAt,
      frames: frames.map(frame => ({
        ...frame,
        layers: Object.fromEntries(layerIds.map(layer => [layer, { value: 310, status: 'valid', support: layer === 'precip-rate' ? 0 : 4, interpolated: false }]))
      }))
    };
  }

  const malformed: Array<[string, (p: ReturnType<typeof samplePayload>) => void]> = [
    ['empty frames', p => { p.frames = []; }],
    ['missing frame', p => { p.frames.pop(); }],
    ['duplicate frame', p => { p.frames[1] = p.frames[0]; }],
    ['wrong time', p => { p.frames[0].validTime = created; }],
    ['missing latitude', p => { Object.assign(p, { lat: undefined }); }],
    ['missing expiry', p => { Object.assign(p, { expiresAt: undefined }); }],
    ['wrong expiry', p => { p.expiresAt = created; }],
    ['wrong method hash', p => { p.method.hash = 'f'.repeat(64); }],
    ['wrong coverage hash', p => { p.coverage.hash = 'f'.repeat(64); }],
    ['wrong source', p => { p.source.provenanceSha256 = 'f'.repeat(64); }],
    ['missing layer', p => { delete p.frames[0].layers['precip-rate']; }],
    ['extra layer', p => { p.frames[0].layers.extra = p.frames[0].layers['precip-rate']; }],
    ['invalid rain support', p => { p.frames[0].layers['precip-rate'].support = 4; }],
    ['unknown support bit', p => { p.frames[0].layers['usable-lift-agl'].support = 32; }],
    ['support integer overflow', p => { p.frames[0].layers['usable-lift-agl'].support = 2 ** 32; }],
    ['valid null', p => { Object.assign(p.frames[0].layers['precip-rate'], { value: null }); }],
    ['outside with value', p => { p.frames[0].layers['precip-rate'].status = 'outside-domain'; }],
    ['no lift rain', p => { p.frames[0].layers['precip-rate'].status = 'no-usable-lift'; }]
  ];
  it.each(malformed)('rejects %s in the complete sample contract', async (_name, edit) => {
    const payload = samplePayload(); edit(payload);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(latestPayload())).mockResolvedValueOnce(jsonResponse(payload));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(created) });
    const build = await client.latest('gfs');
    await expect(client.sample(build, { lat: -32.9, lon: -68.9 })).rejects.toBeInstanceOf(InvalidApiResponseError);
  });
  it('validates a legitimate partial selection and refuses absent identifiers before fetching', async () => {
    const payload = samplePayload(); payload.frames = [{ ...payload.frames[2], layers: { 'precip-rate': payload.frames[2].layers['precip-rate'] } }];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(latestPayload())).mockResolvedValueOnce(jsonResponse(payload));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(created) });
    const build = await client.latest('gfs');
    expect((await client.sample(build, { lat: -32.9, lon: -68.9, frames: ['f009'], layers: ['precip-rate'] })).frames).toHaveLength(1);
    await expect(client.sample(build, { lat: 0, lon: 0, frames: ['not-in-build'] })).rejects.toBeInstanceOf(RangeError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('supports more than eight frames within the admitted result budget', async () => {
    const latest = latestPayload(), extra = { ...frames[7], id: 'f027' };
    latest.manifest!.frames = [...frames, extra];
    latest.manifest!.artifacts.push(...layerIds.map(layer => ({ layer, frame: extra.id, tilesKey: `builds/gfs/${latest.manifest!.buildId}/${layer}/${extra.id}.pmtiles`, tilesSha256: 'a'.repeat(64) })));
    latest.manifest!.samples.channelCount = 27; latest.manifest!.samples.bytes = latest.manifest!.samples.storedCells * 27 * 5;
    const payload = samplePayload(); payload.frames.push({ ...payload.frames[7], id: extra.id });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(latest)).mockResolvedValueOnce(jsonResponse(payload));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(created) });
    const build = await client.latest('gfs');
    expect((await client.sample(build, { lat: -32.9, lon: -68.9 })).frames).toHaveLength(9);
  });

  it('requests the explicit all-8-frame × all-3-layer series in one call', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(latestPayload()))
      .mockResolvedValueOnce(jsonResponse(samplePayload()));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(created) });
    const build = await client.latest('gfs');
    const series = await client.sample(build, { lat: -32.9, lon: -68.9, frames: 'all', layers: [...layerIds] });
    const url = new URL(String(fetchImpl.mock.calls[1][0]));
    expect(url.pathname).toBe('/v1/models/gfs/runs/20261030T000000Z-abc/sample');
    expect(url.searchParams.get('frame')).toBe('all');
    expect(url.searchParams.get('layers')).toBe('usable-lift-msl,usable-lift-agl,precip-rate');
    expect(series.frames).toHaveLength(8);
    expect(Object.keys(series.frames[0].layers)).toHaveLength(3);
  });

  it('fails before issuing a request when the pinned build has expired', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(latestPayload()));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: fetchImpl as typeof fetch, now: () => Date.parse(created) });
    const build = await client.latest('gfs');
    await expect(client.sample(build, { lat: 0, lon: 0, now: Date.parse(expiresAt) })).rejects.toBeInstanceOf(ExpiredBuildError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects responses that cross the pinned expiry while in flight', async () => {
    let now = Date.parse(created);
    let resolveResponse!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(latestPayload()))
      .mockImplementationOnce(() => new Promise(resolve => { resolveResponse = resolve; }));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => now });
    const build = await client.latest('gfs');
    const pending = client.sample(build, { lat: 0, lon: 0 });
    now = Date.parse(expiresAt);
    resolveResponse(jsonResponse(samplePayload()));
    await expect(pending).rejects.toBeInstanceOf(ExpiredBuildError);
  });

  it('rejects a sample for a different model or mismatched coordinates or malformed layer status', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(latestPayload()))
      .mockResolvedValueOnce(jsonResponse({ ...(samplePayload() as object), model: 'hrrr' }))
      .mockResolvedValueOnce(jsonResponse({ ...(samplePayload() as object), lat: 12, lon: 34 }))
      .mockResolvedValueOnce(jsonResponse({
        ...(samplePayload() as object),
        frames: [{ ...frames[0], layers: Object.fromEntries(layerIds.map(layer => [layer, { value: 310, status: 'bogus', support: 0, interpolated: false }])) }]
      }));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(created) });
    const build = await client.latest('gfs');
    await expect(client.sample(build, { lat: -32.9, lon: -68.9 })).rejects.toBeInstanceOf(InvalidApiResponseError);
    await expect(client.sample(build, { lat: -32.9, lon: -68.9 })).rejects.toBeInstanceOf(InvalidApiResponseError);
    await expect(client.sample(build, { lat: -32.9, lon: -68.9 })).rejects.toBeInstanceOf(InvalidApiResponseError);
  });

  it('rejects out-of-range coordinates and oversized requests', async () => {
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: (async () => jsonResponse(latestPayload())) as typeof fetch, now: () => Date.parse(created) });
    const build = await client.latest('gfs');
    await expect(client.sample(build, { lat: 91, lon: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(client.sample(build, { lat: 0, lon: 0, layers: [...layerIds, ...layerIds] })).rejects.toBeInstanceOf(RangeError);
  });

  it('cancels in-flight requests through AbortSignal', async () => {
    const pending = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }) as typeof fetch;
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: pending });
    const controller = new AbortController();
    const request = client.latest('gfs', { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('bounded request lifecycle', () => {
  it('retries a transient read once and never retries invalid JSON or not-retained responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('busy', { status: 503 })).mockResolvedValueOnce(jsonResponse(latestPayload()));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(created), retryDelayMs: 0 });
    expect((await client.latest('gfs')).manifest.buildId).toBe(pointer().latestBuildId);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const response of [new Response('invalid'), new Response('{}', { status: 404 })]) {
      fetchImpl.mockReset().mockResolvedValue(response); await expect(client.latest('gfs')).rejects.toThrow(); expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
  it('aborts on its deadline and preserves caller cancellation', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => { signal = init?.signal ?? undefined; return new Promise(() => {}); });
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, requestTimeoutMs: 5 });
    await expect(client.latest('gfs')).rejects.toThrow('Request deadline exceeded'); expect(signal?.aborted).toBe(true);
    const abort = new AbortController(); abort.abort(new Error('changed selection'));
    await expect(client.latest('gfs', { signal: abort.signal })).rejects.toThrow('changed selection'); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('cancels oversized response streams before parsing', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel })));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });
    await expect(client.latest('gfs')).rejects.toThrow('Response exceeds byte budget'); expect(cancel).toHaveBeenCalledTimes(1); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
