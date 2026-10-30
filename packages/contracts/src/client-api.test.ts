import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ExpiredBuildError, InvalidApiResponseError, noLiftLabel, type LatestPayload } from './client';
import type { Manifest, ModelPointer } from '@av/contracts';

const expiresAt = '2026-10-31T00:00:00.000Z';
const created = '2026-10-30T00:00:00.000Z';
it('labels transparent and legacy opaque no-lift legend swatches accurately', () => {
  expect(noLiftLabel('#00000000')).toBe('no usable lift (transparent)');
  expect(noLiftLabel('#55184d')).toBe('no usable lift');
});
const layerIds = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'] as const;
const frames = ['f003', 'f006', 'f009', 'f012', 'f015', 'f018', 'f021', 'f024'].map((id, index) => {
  const start = new Date(Date.parse(created) + index * 3 * 3600_000 + 3 * 3600_000).toISOString();
  const end = new Date(Date.parse(start) + 3 * 3600_000).toISOString();
  return { id, validTime: start, intervalStart: start, intervalEnd: end };
});

function manifest(): Manifest {
  return {
    version: 1,
    model: 'gfs',
    buildId: '20261030T000000Z-abc',
    cycle: created,
    createdAt: created,
    expiresAt,
    method: { id: 'dry-lenschow-pbl-1p2-v1', hash: 'a'.repeat(64) },
    coverage: { id: 'soaring-land-v1', hash: 'b'.repeat(64), maskKey: 'masks/soaring-land-v1', maxZoom: 5 },
    grid: { width: 1440, height: 721, lon0: -180, lat0: 90, dx: 0.25, dy: -0.25, wrapLongitude: true },
    frames,
    layers: [...layerIds],
    artifacts: layerIds.flatMap(layer => frames.map(frame => ({
      layer,
      frame: frame.id,
      tilesKey: `builds/gfs/20261030T000000Z-abc/${layer}/${frame.id}.pmtiles`,
      samplesKey: `builds/gfs/20261030T000000Z-abc/samples/${layer}/${frame.id}.bin`,
      tilesSha256: 'c'.repeat(64),
      samplesSha256: 'd'.repeat(64)
    }))),
    source: { nativeResolutionDeg: 0.25, model: 'GFS' },
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
  function samplePayload(): unknown {
    return {
      model: 'gfs',
      buildId: '20261030T000000Z-abc',
      lat: -32.9,
      lon: -68.9,
      method: { id: 'dry-lenschow-pbl-1p2-v1' },
      source: { record: 'test' },
      coverage: { id: 'soaring-land-v1' },
      expiresAt,
      frames: frames.map(frame => ({
        ...frame,
        layers: Object.fromEntries(layerIds.map(layer => [layer, { value: 310, status: 'valid', support: 4, interpolated: false }]))
      }))
    };
  }

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
