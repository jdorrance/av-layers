import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GFS_GRID, LAYER_IDS } from '@av/contracts';

const coverageFixture = vi.hoisted(async () => {
  const { createHash } = await import('node:crypto');
  const bytes = new Uint8Array(129780);
  for (const row of [359, 360, 361]) for (const col of [0, 1, 719, 720, 721, 1439]) {
    const bit = row * 1440 + col;
    bytes[bit >> 3] |= 1 << (bit & 7);
  }
  const halo = new Uint8Array(129780);
  const tiles = Uint8Array.of(1, ...new Uint8Array(170));
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const manifest = new TextEncoder().encode(JSON.stringify({ id: 'soaring-land-v1', output: { bytes: bytes.length, sha256: sha(bytes) }, halo: { bytes: halo.length, sha256: sha(halo) }, tiles: { bytes: tiles.length, sha256: sha(tiles) } }));
  return { output: bytes.buffer, halo: halo.buffer, tiles: tiles.buffer, manifest: manifest.buffer, hash: sha(manifest) };
});
vi.mock('../../../packages/contracts/coverage/output.bin', async () => ({ default: (await coverageFixture).output }));
vi.mock('../../../packages/contracts/coverage/halo.bin', async () => ({ default: (await coverageFixture).halo }));
vi.mock('../../../packages/contracts/coverage/tiles.bin', async () => ({ default: (await coverageFixture).tiles }));
vi.mock('../../../packages/contracts/coverage/manifest.json', async () => ({ default: (await coverageFixture).manifest }));

import worker from '../src/index';

const now = Date.parse('2026-10-30T00:00:00Z');
const cycle = '2026-10-29T18:00:00Z';
const hash = 'a'.repeat(64);
const coverageHash = (await coverageFixture).hash;
const layers = [...LAYER_IDS];
const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); }, passThroughOnException() {}, props: {} };
let pending: Promise<unknown>[] = [];

function publication(id: string, expiry = new Date(now + 60_000).toISOString()) {
  const prefix = `builds/gfs/${id}`;
  const frames = Array.from({ length: 8 }, (_, i) => ({ id: `f${String((i + 1) * 3).padStart(3, '0')}`, validTime: new Date(now + i * 10_800_000).toISOString(), intervalStart: new Date(now + (i - 1) * 10_800_000).toISOString(), intervalEnd: new Date(now + i * 10_800_000).toISOString() }));
  const artifacts = frames.flatMap(frame => layers.map(layer => ({ layer, frame: frame.id, tilesKey: `${prefix}/${layer}/${frame.id}.pmtiles`, samplesKey: `${prefix}/samples/${layer}/${frame.id}.bin`, tilesSha256: hash, samplesSha256: hash })));
  const manifest = { version: 1, model: 'gfs', buildId: id, cycle, createdAt: new Date(now - 1000).toISOString(), expiresAt: expiry, method: { id: 'dry-lenschow-pbl-1p2-v1', hash }, coverage: { id: 'soaring-land-v1', hash: coverageHash, maskKey: 'masks/v1', maxZoom: 5 }, grid: GFS_GRID, frames, layers, artifacts, source: {} as Record<string, unknown>, tool: { liftRenderStyle: 'transparent-no-lift-v2' } as Record<string, unknown>, palettes: ['lift', 'rain'], metrics: {} };
  const retained = { buildId: id, manifestKey: `${prefix}/manifest.json`, cycle, expiresAt: expiry };
  return { manifest, retained };
}

function sidecar(pub: ReturnType<typeof publication>, payload: unknown = {
  version: 1, model: 'gfs', buildId: pub.manifest.buildId, cycle, provider: 'NOAA', frames: [{ hour: 3, inputs: ['profile.grib2'] }]
}) {
  const key = `builds/gfs/${pub.manifest.buildId}/provenance.json`;
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  pub.manifest.source = { provider: 'NOAA', frameCount: 8, provenanceKey: key, provenanceSha256: sha256 };
  return { key, bytes, sha256, payload };
}

class MemoryCache {
  entries = new Map<string, Response>();
  matches = 0;
  async match(request: Request) { this.matches++; return this.entries.get(request.url)?.clone(); }
  async put(request: Request, response: Response) { this.entries.set(request.url, response.clone()); }
}

class MemoryBucket {
  objects = new Map<string, unknown>();
  reads: { key: string; range?: { offset: number; length: number } }[] = [];
  active = 0;
  maxActive = 0;
  missingSamples = false;
  shortRange = false;
  expireDuringRange = false;
  expireDuringProvenance = false;
  install(...pubs: ReturnType<typeof publication>[]) {
    for (const pub of pubs) this.objects.set(pub.retained.manifestKey, pub.manifest);
    this.objects.set('catalog/gfs/latest.json', { version: 1, model: 'gfs', latestBuildId: pubs.at(-1)!.manifest.buildId, retained: pubs.map(p => p.retained) });
  }
  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const range = options?.range;
    this.reads.push({ key, range });
    if (key.includes('/samples/')) {
      if (this.missingSamples || !range) return null;
      this.active++; this.maxActive = Math.max(this.maxActive, this.active);
      await new Promise(resolve => setTimeout(resolve, 1));
      this.active--;
      if (this.expireDuringRange) vi.setSystemTime(now + 60_000);
      const bytes = new Uint8Array(range.length - (this.shortRange ? 1 : 0));
      const view = new DataView(bytes.buffer);
      for (let i = 0; i + 5 <= bytes.length; i += 5) {
        view.setFloat32(i, key.includes('precip-rate') ? 7 : 310, true);
        view.setUint8(i + 4, key.includes('usable-lift-msl') ? 2 : 0);
      }
      return { size: GFS_GRID.width * GFS_GRID.height * 5, body: true, async arrayBuffer() { return bytes.buffer; } };
    }
    const value = this.objects.get(key);
    if (value === undefined) return null;
    const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value));
    const expire = this.expireDuringProvenance && key.endsWith('/provenance.json');
    return {
      size: bytes.byteLength,
      body: true,
      async json() { return JSON.parse(new TextDecoder().decode(bytes)); },
      async arrayBuffer() {
        if (expire) vi.setSystemTime(now + 60_000);
        return bytes.slice().buffer;
      }
    };
  }
}

let bucket: MemoryBucket;
let cache: MemoryCache;
let limiter: { limit: ReturnType<typeof vi.fn> };
async function call(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', '192.0.2.1');
  const result = await worker.fetch(new Request(`https://api.example${path}`, { ...init, headers }), { BUCKET: bucket as unknown as R2Bucket, SAMPLE_RATE_LIMITER: limiter }, ctx);
  await Promise.all(pending.splice(0));
  return result;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  pending = [];
  bucket = new MemoryBucket();
  limiter = { limit: vi.fn(async () => ({ success: true })) };
  bucket.install(publication('build-1'));
  cache = new MemoryCache();
  vi.stubGlobal('caches', { default: cache });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('read-only worker', () => {
  it('routes metadata, palette suffixes, tilejson and generated OpenAPI', async () => {
    const latest = await call('/v1/models/gfs/latest?expand=manifest');
    expect(latest.status).toBe(200);
    expect(((await latest.json()) as { manifest: { buildId: string } }).manifest.buildId).toBe('build-1');
    expect((await call('/v1/palettes/lift.json')).status).toBe(200);
    expect((await call('/v1/palettes/rain.svg')).headers.get('content-type')).toContain('image/svg+xml');
    const tilejson = await call('/v1/models/gfs/runs/build-1/layers/usable-lift-agl/f003/tilejson.json');
    expect(tilejson.status).toBe(200);
    expect(((await tilejson.json()) as { tiles: string[] }).tiles[0]).toContain('/usable-lift-agl/f003/');
    const spec = await (await call('/openapi.json')).json() as { paths: Record<string, { get: { parameters: { name: string }[]; responses: Record<string, { content?: Record<string, { schema: { type?: string } }> }> } }> };
    for (const path of ['/v1/catalog', '/v1/models/{model}/latest', '/v1/models/{model}/runs/{buildId}/sample', '/v1/models/{model}/runs/{buildId}/provenance', '/tiles/{model}/{buildId}/{layer}/{frame}/{z}/{x}/{y}.webp']) expect(spec.paths[path].get).toBeDefined();
    expect(spec.paths['/v1/models/{model}/runs/{buildId}/sample'].get.parameters.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(['lat', 'lon', 'frame', 'layers']));
    expect(spec.paths['/v1/models/{model}/runs/{buildId}/sample'].get.responses['200'].content?.['application/json'].schema.type).toBe('object');
    expect(spec.paths['/tiles/{model}/{buildId}/{layer}/{frame}/{z}/{x}/{y}.webp'].get.responses['200'].content?.['image/webp']).toBeDefined();
    expect(spec.paths['/v1/models/{model}/runs/{buildId}/sample'].get.responses['429']).toBeDefined();
  });
  it('links verified provenance from compact and full metadata without changing stored manifests', async () => {
    const pub = publication('build-1'), receipt = sidecar(pub);
    bucket.install(pub);
    bucket.objects.set(receipt.key, receipt.bytes);
    const url = 'https://api.example/v1/models/gfs/runs/build-1/provenance';
    const latest = await (await call('/v1/models/gfs/latest?expand=manifest')).json();
    expect(latest).toMatchObject({ manifest: { source: { provenanceUrl: url, provenanceSha256: receipt.sha256 } } });
    const manifestPath = '/v1/models/gfs/runs/build-1';
    cache.entries.set(`https://api.example${manifestPath}`, new Response(JSON.stringify(pub.manifest), { headers: { etag: '"manifest-build-1"' } }));
    const full = await call(manifestPath, { headers: { 'if-none-match': '"manifest-build-1"' } });
    expect(full.status).toBe(200);
    expect(await full.json()).toMatchObject({ source: { provenanceUrl: url } });
    const samplePath = '/v1/models/gfs/runs/build-1/sample?lat=80&lon=0&frame=f003&layers=precip-rate';
    const sampleUrl = `https://api.example${samplePath}`;
    const oldSampleTag = `"sample-${createHash('sha256').update(sampleUrl).digest('hex')}"`;
    cache.entries.set(sampleUrl, new Response(JSON.stringify({ source: pub.manifest.source }), { headers: { etag: oldSampleTag } }));
    const sample = await call(samplePath, { headers: { 'if-none-match': oldSampleTag } });
    expect(sample.status).toBe(200);
    expect(await sample.json()).toMatchObject({ source: { provenanceUrl: url } });
    expect(pub.manifest.source).not.toHaveProperty('provenanceUrl');
    const result = await call(new URL(url).pathname);
    expect(result.status).toBe(200);
    expect(result.headers.get('etag')).toBe(`"${receipt.sha256}"`);
    expect(await result.text()).toBe(new TextDecoder().decode(receipt.bytes));
  });
  it('caches verified provenance while enforcing expiry before cache hits and conditional responses', async () => {
    const pub = publication('build-1'), receipt = sidecar(pub);
    bucket.install(pub);
    bucket.objects.set(receipt.key, receipt.bytes);
    const path = '/v1/models/gfs/runs/build-1/provenance';
    const first = await call(path);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('public, max-age=60');
    vi.setSystemTime(now + 10_000);
    const hit = await call(path, { headers: { 'if-none-match': first.headers.get('etag')! } });
    expect(hit.status).toBe(304);
    expect(hit.headers.get('cache-control')).toBe('public, max-age=50');
    expect(bucket.reads.filter(read => read.key === receipt.key)).toHaveLength(1);
    const cacheReads = cache.matches;
    vi.setSystemTime(now + 60_000);
    const expired = await call(path, { headers: { 'if-none-match': first.headers.get('etag')! } });
    expect(expired.status).toBe(404);
    expect(expired.headers.get('cache-control')).toBe('no-store');
    expect(cache.matches).toBe(cacheReads);
  });
  it('rechecks retained membership before serving cached provenance', async () => {
    const pub = publication('build-1'), receipt = sidecar(pub);
    bucket.install(pub);
    bucket.objects.set(receipt.key, receipt.bytes);
    const path = '/v1/models/gfs/runs/build-1/provenance';
    expect((await call(path)).status).toBe(200);
    const cacheReads = cache.matches;
    bucket.install(publication('build-2'));
    vi.setSystemTime(now + 15_000);
    expect((await call(path)).status).toBe(404);
    expect(cache.matches).toBe(cacheReads);
  });
  it('keeps missing or corrupt provenance failures uncached', async () => {
    const pub = publication('build-1'), receipt = sidecar(pub);
    bucket.install(pub);
    const path = '/v1/models/gfs/runs/build-1/provenance';
    for (const corrupt of [false, true]) {
      if (corrupt) bucket.objects.set(receipt.key, new TextEncoder().encode('{"frames":[]}'));
      const result = await call(path);
      expect(result.status).toBe(503);
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect(await result.json()).toMatchObject({ title: corrupt ? 'publication-invalid' : 'publication-incomplete' });
      expect(cache.entries.size).toBe(0);
    }
    bucket.objects.set(receipt.key, receipt.bytes);
    expect((await call(path)).status).toBe(200);
  });
  it.each([
    { provenanceKey: 'private/other.json', provenanceSha256: hash },
    { provenanceKey: 'builds/gfs/build-1/provenance.json' },
    { provenanceSha256: hash },
    { provenanceKey: 'builds/gfs/build-1/provenance.json', provenanceSha256: 'not-a-sha256' }
  ])('rejects invalid provenance references before cache or object access: %j', async source => {
    const pub = publication('build-1');
    pub.manifest.source = { ...source, frames: [] };
    bucket.install(pub);
    const result = await call('/v1/models/gfs/runs/build-1/provenance');
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ title: 'publication-invalid' });
    expect(cache.matches).toBe(0);
    expect(bucket.reads.map(read => read.key)).toEqual(['catalog/gfs/latest.json', pub.retained.manifestKey]);
  });
  it('rejects hash-valid provenance with invalid JSON or mismatched identity', async () => {
    const pub = publication('build-1');
    const receipt = sidecar(pub, { version: 1, model: 'gfs', buildId: 'another-build', cycle, frames: [] });
    bucket.install(pub);
    bucket.objects.set(receipt.key, receipt.bytes);
    expect((await call('/v1/models/gfs/runs/build-1/provenance')).status).toBe(503);
    bucket = new MemoryBucket();
    const malformed = new TextEncoder().encode('not JSON');
    pub.manifest.source.provenanceSha256 = createHash('sha256').update(malformed).digest('hex');
    bucket.install(pub);
    bucket.objects.set(receipt.key, malformed);
    expect((await call('/v1/models/gfs/runs/build-1/provenance')).status).toBe(503);
    expect(cache.entries.size).toBe(0);
  });
  it('refuses provenance that expires during its object read', async () => {
    const pub = publication('build-1'), receipt = sidecar(pub);
    bucket.install(pub);
    bucket.objects.set(receipt.key, receipt.bytes);
    bucket.expireDuringProvenance = true;
    const result = await call('/v1/models/gfs/runs/build-1/provenance');
    expect(result.status).toBe(404);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(cache.entries.size).toBe(0);
  });
  it('serves legacy inline receipts at the same URL and preserves them in the full manifest', async () => {
    const pub = publication('legacy');
    const frames = [{ hour: 3, inputs: ['legacy.grib2'] }];
    pub.manifest.source = { provider: 'NOAA', frames };
    bucket.install(pub);
    const url = 'https://api.example/v1/models/gfs/runs/legacy/provenance';
    const latest = await (await call('/v1/models/gfs/latest?expand=manifest')).json() as { manifest: { source: Record<string, unknown> } };
    expect(latest.manifest.source).toEqual({ provider: 'NOAA', frameCount: 1, provenanceUrl: url });
    expect(await (await call('/v1/models/gfs/runs/legacy')).json()).toMatchObject({ source: { frames, provenanceUrl: url } });
    const result = await call(new URL(url).pathname);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ version: 1, model: 'gfs', buildId: 'legacy', cycle, provider: 'NOAA', frames });
    expect(bucket.reads.some(read => read.key.endsWith('/provenance.json'))).toBe(false);
  });
  it('does not advertise provenance when a legacy build has no receipts', async () => {
    const latest = await (await call('/v1/models/gfs/latest?expand=manifest')).json() as { manifest: { source: Record<string, unknown> } };
    expect(latest.manifest.source).not.toHaveProperty('provenanceUrl');
    expect((await call('/v1/models/gfs/runs/build-1/provenance')).status).toBe(404);
  });
  it('advertises transparent no-lift and invalidates old palette JSON and SVG validators', async () => {
    const latest = await (await call('/v1/models/gfs/latest?expand=manifest')).json() as { palettes: { id: string; noLiftColor?: string }[] };
    expect(latest.palettes.find(palette => palette.id === 'lift')?.noLiftColor).toBe('#00000000');
    for (const extension of ['json', 'svg']) {
      const path = `/v1/palettes/lift.${extension}`;
      const result = await call(path, { headers: { 'if-none-match': '"palette-lift-v1"' } });
      expect(result.status).toBe(200);
      expect(result.headers.get('etag')).toBe('"palette-lift-v2"');
      if (extension === 'json') expect(await result.json()).toMatchObject({ noLiftColor: '#00000000' });
      else expect(await result.text()).toContain('fill="#00000000"/><text x="32" y="545">no usable lift (transparent)</text>');
      expect((await call(path, { headers: { 'if-none-match': '"palette-lift-v2"' } })).status).toBe(304);
      const rain = await call(`/v1/palettes/rain.${extension}`, { headers: { 'if-none-match': '"palette-rain-v1"' } });
      expect(rain.status).toBe(200);
      expect(rain.headers.get('etag')).toBe('"palette-rain-v2"');
    }
  });
  it('matches the expanded legend to retained legacy and marked builds', async () => {
    const old = publication('legacy'), current = publication('current');
    delete old.manifest.tool.liftRenderStyle;
    bucket.install(current, old);
    let result = await call('/v1/models/gfs/latest?expand=manifest');
    expect(result.status).toBe(200);
    let body = await result.json() as { palettes: { id: string; noLiftColor?: string }[] };
    expect(body.palettes.find(p => p.id === 'lift')?.noLiftColor).toBe('#55184d');
    expect((await call('/v1/models/gfs/runs/current')).status).toBe(200);
    expect((await (await call('/v1/palettes/lift.json')).json() as { noLiftColor: string }).noLiftColor).toBe('#00000000');
    bucket = new MemoryBucket();
    bucket.install(old, current);
    result = await call('/v1/models/gfs/latest?expand=manifest');
    expect(result.status).toBe(200);
    body = await result.json() as { palettes: { id: string; noLiftColor?: string }[] };
    expect(body.palettes.find(p => p.id === 'lift')?.noLiftColor).toBe('#00000000');
    expect((await call('/v1/models/gfs/runs/legacy')).status).toBe(200);
  });
  it('validates route parameter lengths and rejects unknown models and layers', async () => {
    expect((await call(`/v1/models/${'a'.repeat(129)}/latest`)).status).toBe(400);
    expect((await call(`/v1/models/gfs/runs/${'a'.repeat(129)}`)).status).toBe(400);
    expect((await call('/v1/models/unknown/latest')).status).toBe(404);
    expect((await call('/v1/models/gfs/runs/build-1/layers/unknown/f003/tilejson.json')).status).toBe(404);
  });
  it('rejects noncanonical encoded paths, duplicate/unknown query and bad tile coordinates', async () => {
    for (const path of ['/v1/models/%67fs/latest', '/v1/models/gfs/latest?expand=manifest&expand=manifest', '/v1/models/gfs/latest?other=x', '/v1/models/gfs/runs/build-1/sample?lat=0&lon=0&lat=1', '/tiles/gfs/build-1/usable-lift-agl/f003/01/0/0.webp', '/tiles/gfs/build-1/usable-lift-agl/f003/1/2/0.webp']) {
      const result = await call(path);
      expect(result.status, path).toBe(400);
      expect(result.headers.get('cache-control')).toBe('no-store');
    }
  });
  it('refreshes a stale per-model pointer once on membership miss before blank or cache', async () => {
    const first = '/tiles/gfs/build-1/usable-lift-agl/f003/1/0/0.webp';
    expect((await call(first)).status).toBe(200);
    const newer = publication('build-2');
    bucket.install(publication('build-1'), newer);
    const before = bucket.reads.filter(r => r.key === 'catalog/gfs/latest.json').length;
    expect((await call('/tiles/gfs/build-2/usable-lift-agl/f003/1/0/0.webp')).status).toBe(200);
    expect(bucket.reads.filter(r => r.key === 'catalog/gfs/latest.json').length - before).toBe(1);
    const cacheReads = cache.matches;
    const missing = await call('/tiles/gfs/unknown/usable-lift-agl/f003/1/0/0.webp');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { title: string }).title).toBe('not-retained');
    expect(cache.matches).toBe(cacheReads);
    expect(bucket.reads.filter(r => r.key === 'catalog/gfs/latest.json').length - before).toBe(2);
  });
  it('caches pointers independently per model and refreshes after fifteen seconds', async () => {
    const other = publication('other');
    bucket.objects.set('catalog/hrrr/latest.json', { version: 1, model: 'hrrr', latestBuildId: 'other', retained: [other.retained] });
    expect((await call('/v1/models/gfs/runs')).status).toBe(200);
    expect((await call('/v1/models/hrrr/runs')).status).toBe(200);
    expect((await call('/v1/models/gfs/runs')).status).toBe(200);
    expect(bucket.reads.filter(r => r.key === 'catalog/gfs/latest.json')).toHaveLength(1);
    expect(bucket.reads.filter(r => r.key === 'catalog/hrrr/latest.json')).toHaveLength(1);
    vi.setSystemTime(now + 15_000);
    expect((await call('/v1/models/gfs/runs')).status).toBe(200);
    expect(bucket.reads.filter(r => r.key === 'catalog/gfs/latest.json')).toHaveLength(2);
  });
  it('does not advertise an unavailable regional publication as usable', async () => {
    const other = publication('other');
    const retained = { ...other.retained, manifestKey: 'builds/hrrr/other/manifest.json' };
    bucket.objects.set('catalog/hrrr/latest.json', { version: 1, model: 'hrrr', latestBuildId: 'other', retained: [retained] });
    bucket.objects.set(retained.manifestKey, { ...other.manifest, model: 'hrrr' });
    const catalog = await (await call('/v1/catalog')).json() as { models: { model: string; available: boolean; error?: string }[] };
    expect(catalog.models.find(m => m.model === 'hrrr')).toMatchObject({ available: false, error: 'coverage-unavailable' });
    expect((await call('/v1/models/hrrr/latest')).status).toBe(503);
  });
  it('validates resource and expiry before cached blank and reduces TTL on hits', async () => {
    const url = '/tiles/gfs/build-1/usable-lift-agl/f003/1/0/0.webp';
    const first = await call(url);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('image/webp');
    expect(first.headers.get('cache-control')).toBe('public, max-age=60');
    const webp = await first.arrayBuffer();
    expect(webp.byteLength).toBeGreaterThan(25);
    const bytes = new Uint8Array(webp);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe('WEBP');
    const dims = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0;
    expect((dims & 0x3fff) + 1).toBe(256);
    expect(((dims >>> 14) & 0x3fff) + 1).toBe(256);
    vi.setSystemTime(now + 10_000);
    expect((await call(url)).headers.get('cache-control')).toBe('public, max-age=50');
    expect((await call('/tiles/gfs/build-1/usable-lift-agl/f999/1/0/0.webp')).status).toBe(404);
    const hits = cache.matches;
    vi.setSystemTime(now + 60_000);
    const expired = await call(url);
    expect(expired.status).toBe(404);
    expect(expired.headers.get('cache-control')).toBe('no-store');
    expect(cache.matches).toBe(hits);
  });
  it('refuses retained builds with old coverage before cache, blank tiles or sample ranges', async () => {
    const old = publication('old-build');
    old.manifest.coverage.hash = 'b'.repeat(64);
    bucket.install(old, publication('build-1'));
    for (const path of ['/tiles/gfs/old-build/usable-lift-agl/f003/1/0/0.webp', '/v1/models/gfs/runs/old-build/sample?lat=0&lon=0&frame=all']) {
      const hits = cache.matches;
      const result = await call(path);
      expect(result.status).toBe(503);
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect(((await result.json()) as { title: string }).title).toBe('coverage-unavailable');
      expect(cache.matches).toBe(hits);
    }
    expect(bucket.reads.filter(r => r.key.includes('/samples/'))).toHaveLength(0);
  });
  it('limits sample requests before any R2 reads and fails closed if limiter or client IP is unavailable', async () => {
    const path = '/v1/models/gfs/runs/build-1/sample?lat=0&lon=0';
    limiter.limit.mockResolvedValue({ success: false });
    let result = await call(path, { headers: { 'cf-connecting-ip': '2001:db8::1', 'x-forwarded-for': '203.0.113.1' } });
    expect(result.status).toBe(429);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(limiter.limit).toHaveBeenCalledWith({ key: '2001:db8::1' });
    expect(bucket.reads).toHaveLength(0);
    limiter.limit.mockRejectedValue(new Error('unavailable'));
    result = await call(path);
    expect(result.status).toBe(503);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(bucket.reads).toHaveLength(0);
    result = await worker.fetch(new Request(`https://api.example${path}`, { headers: { 'x-forwarded-for': '192.0.2.7' } }), { BUCKET: bucket as unknown as R2Bucket, SAMPLE_RATE_LIMITER: limiter }, ctx);
    expect(result.status).toBe(503);
    result = await worker.fetch(new Request(`https://api.example${path}`, { headers: { 'cf-connecting-ip': '192.0.2.1' } }), { BUCKET: bucket as unknown as R2Bucket, SAMPLE_RATE_LIMITER: undefined as never }, ctx);
    expect(result.status).toBe(503);
    expect(bucket.reads).toHaveLength(0);
  });
  it('allows a missing IP only with the explicit local flag and a working limiter', async () => {
    const path = '/v1/models/gfs/runs/build-1/sample?lat=0&lon=0&layers=precip-rate';
    const request = () => new Request(`http://localhost:8787${path}`);
    const bindings = { BUCKET: bucket as unknown as R2Bucket, SAMPLE_RATE_LIMITER: limiter };
    expect((await worker.fetch(request(), bindings, ctx)).status).toBe(503);
    expect((await worker.fetch(request(), { ...bindings, AV_LOCAL_DEVELOPMENT: 'false' }, ctx)).status).toBe(503);
    expect((await worker.fetch(request(), { ...bindings, AV_LOCAL_DEVELOPMENT: 'true', SAMPLE_RATE_LIMITER: undefined as never }, ctx)).status).toBe(503);
    expect((await worker.fetch(request(), { ...bindings, AV_LOCAL_DEVELOPMENT: 'true' }, ctx)).status).toBe(200);
    expect(limiter.limit).toHaveBeenCalledWith({ key: 'localhost' });
    limiter.limit.mockResolvedValue({ success: false });
    expect((await worker.fetch(request(), { ...bindings, AV_LOCAL_DEVELOPMENT: 'true' }, ctx)).status).toBe(429);
  });
  it('rejects malformed client IPs even in local development', async () => {
    const path = '/v1/models/gfs/runs/build-1/sample?lat=0&lon=0';
    for (const ip of ['999.1.1.1', '1.2.3', '01.2.3.4', '1.2.3.4.5', 'abcd:ef', '::::', '2001:db8::1::2', '::ffff:999.1.1.1', 'garbage']) {
      for (const local of [undefined, 'true']) {
        const result = await worker.fetch(new Request(`https://api.example${path}`, { headers: { 'cf-connecting-ip': ip } }), { BUCKET: bucket as unknown as R2Bucket, SAMPLE_RATE_LIMITER: limiter, AV_LOCAL_DEVELOPMENT: local }, ctx);
        expect(result.status, ip).toBe(503);
      }
    }
    expect(limiter.limit).not.toHaveBeenCalled();
    expect(bucket.reads).toHaveLength(0);
  });
  it('uses valid IPv4 and IPv6 addresses as limiter keys', async () => {
    const path = '/v1/models/gfs/runs/build-1/sample?lat=0&lon=0&layers=precip-rate';
    for (const ip of ['192.0.2.1', '2001:db8::1', '::1', '::ffff:192.0.2.1']) {
      expect((await call(path, { headers: { 'cf-connecting-ip': ip } })).status, ip).toBe(200);
      expect(limiter.limit).toHaveBeenLastCalledWith({ key: ip });
    }
  });
  it('rejects repeated uncached samples before further R2 reads', async () => {
    let count = 0;
    limiter.limit.mockImplementation(async () => ({ success: ++count <= 2 }));
    for (const lon of ['0', '0.01']) expect((await call(`/v1/models/gfs/runs/build-1/sample?lat=0&lon=${lon}&layers=precip-rate`)).status).toBe(200);
    const readCount = bucket.reads.length;
    expect((await call('/v1/models/gfs/runs/build-1/sample?lat=0&lon=0.02&layers=precip-rate')).status).toBe(429);
    expect(bucket.reads).toHaveLength(readCount);
  });
  it('reports an expected but absent archive as 503 and does not cache it', async () => {
    const result = await call('/tiles/gfs/build-1/usable-lift-agl/f003/0/0/0.webp');
    expect(result.status).toBe(503);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(cache.entries.size).toBe(0);
  });
  it('serves HEAD, ETags, CORS and structured method errors', async () => {
    const path = '/tiles/gfs/build-1/usable-lift-agl/f003/1/0/0.webp';
    const first = await call(path);
    expect(first.headers.get('access-control-allow-origin')).toBe('*');
    const head = await call(path, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('etag')).toBe(first.headers.get('etag'));
    expect((await call(path, { headers: { 'if-none-match': first.headers.get('etag')! } })).status).toBe(304);
    const invalid = await call(path, { method: 'POST' });
    expect(invalid.status).toBe(405);
    expect(invalid.headers.get('access-control-allow-origin')).toBe('*');
    expect((await call(path, { method: 'OPTIONS' })).status).toBe(204);
  });
  it('performs at most 24 bounded, independent coalesced ranges at concurrency four', async () => {
    const result = await call('/v1/models/gfs/runs/build-1/sample?lat=0.125&lon=179.875&frame=all');
    expect(result.status).toBe(200);
    const body = await result.json() as { frames: { layers: Record<string, { status: string; value: number | null }> }[] };
    expect(body.frames).toHaveLength(8);
    expect(body.frames[0].layers['usable-lift-msl'].status).toBe('unavailable');
    expect(body.frames[0].layers['usable-lift-agl'].value).toBe(310);
    expect(body.frames[0].layers['precip-rate'].value).toBe(7);
    const reads = bucket.reads.filter(r => r.key.includes('/samples/'));
    expect(reads).toHaveLength(24);
    expect(new Set(reads.map(r => r.key)).size).toBe(24);
    expect(reads.every(r => r.range?.length === 14400)).toBe(true);
    expect(bucket.maxActive).toBeLessThanOrEqual(4);
    expect(bucket.maxActive).toBeGreaterThan(1);
    await call('/v1/models/gfs/runs/build-1/sample?lon=179.875&lat=.125&frame=all');
    expect(bucket.reads.filter(r => r.key.includes('/samples/'))).toHaveLength(24);
  });
  it('does zero numeric reads outside coverage and fails missing or short ranges visibly', async () => {
    let result = await call('/v1/models/gfs/runs/build-1/sample?lat=-50&lon=0&frame=all');
    expect(result.status).toBe(200);
    expect(((await result.json()) as { frames: { layers: Record<string, { status: string }> }[] }).frames[0].layers['precip-rate'].status).toBe('outside-domain');
    expect(bucket.reads.filter(r => r.key.includes('/samples/'))).toHaveLength(0);
    bucket.missingSamples = true;
    result = await call('/v1/models/gfs/runs/build-1/sample?lat=0&lon=0&layers=precip-rate');
    expect(result.status).toBe(503);
    expect(result.headers.get('cache-control')).toBe('no-store');
    bucket.missingSamples = false; bucket.shortRange = true;
    expect((await call('/v1/models/gfs/runs/build-1/sample?lat=0&lon=0&layers=precip-rate')).status).toBe(503);
  });
  it('rejects oversized selection, malformed coordinates and invalid pointers', async () => {
    expect((await call('/v1/models/gfs/runs/build-1/sample?lat=0&lon=0&frame=f001,f002,f003,f004,f005,f006,f007,f008,f009')).status).toBe(429);
    for (const query of ['lat=nan&lon=0', 'lat=91&lon=0', 'lat=0&lon=', 'lat=0&lon=0&layers=precip-rate,precip-rate']) {
      const result = await call(`/v1/models/gfs/runs/build-1/sample?${query}`);
      expect(result.status).toBe(400);
      expect(result.headers.get('access-control-allow-origin')).toBe('*');
    }
    const invalid = new MemoryBucket();
    invalid.objects.set('catalog/gfs/latest.json', { version: 1, model: 'gfs', retained: [] });
    bucket = invalid;
    const result = await call('/v1/models/gfs/latest');
    expect(result.status).toBe(503);
    expect(result.headers.get('cache-control')).toBe('no-store');
  });
  it('checks expiry again after an in-flight numeric read', async () => {
    bucket.expireDuringRange = true;
    const result = await call('/v1/models/gfs/runs/build-1/sample?lat=0&lon=0&layers=precip-rate');
    expect(result.status).toBe(404);
    expect(cache.entries.size).toBe(0);
  });
  it('serves warm tile GET, HEAD and 304 responses without re-reading manifest.json from R2', async () => {
    const path = '/tiles/gfs/build-1/usable-lift-agl/f003/1/0/0.webp';
    const first = await call(path);
    expect(first.status).toBe(200);
    const manifestReadsAfterCold = bucket.reads.filter(r => r.key === 'builds/gfs/build-1/manifest.json').length;
    expect(manifestReadsAfterCold).toBe(1);
    expect((await call(path)).status).toBe(200);
    expect((await call(path, { method: 'HEAD' })).status).toBe(200);
    expect((await call(path, { headers: { 'if-none-match': first.headers.get('etag')! } })).status).toBe(304);
    expect(bucket.reads.filter(r => r.key === 'builds/gfs/build-1/manifest.json')).toHaveLength(1);
  });
  it('rejects inherited object property names on palette endpoints with 404', async () => {
    for (const bad of ['constructor.json', 'toString.json', 'valueOf.svg']) {
      const res = await call(`/v1/palettes/${bad}`);
      expect(res.status, bad).toBe(404);
    }
    expect((await call('/v1/palettes/__proto__.json')).status).toBe(400);
  });
  it('logs diagnostic details when an unexpected storage error occurs while returning a safe 503', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(bucket, 'get').mockRejectedValueOnce(new Error('R2 backend timeout'));
    const res = await call('/v1/models/gfs/latest');
    expect(res.status).toBe(503);
    expect(errorSpy).toHaveBeenCalledWith(
      'Unhandled API error',
      expect.objectContaining({
        method: 'GET',
        path: '/v1/models/gfs/latest',
        error: expect.objectContaining({ message: 'R2 backend timeout' })
      })
    );
  });
});
