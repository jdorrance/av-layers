import { INDEXED_PRODUCT } from '../../../tests/model-fixtures';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as contracts from '@av/contracts';
import { PRODUCTS } from '@av/contracts/models';
import { layerSurface, renderedLayers, mapFrameCount, sourceIntervalHours, createRecipeIdentity, createWholeDomainDescriptors, encodeSparseCoverage, gridToGeographic, isCovered, manifestV5Schema, SAMPLE_BLOCK_SIZE, MAX_MANIFEST_BYTES, MAX_SAMPLE_VALUES, type ForecastSurfaceV5, type ManifestV5, type ProductDefinition } from '@av/contracts';

import worker, { createApp } from '../src/index';
import { prepareShardedSamplePackLayout } from '@av/forecast';
import { createV5Fixture } from './v5-fixture';
import { describeSparseCoverage, loadCoverage } from '../../batch/src/coverage';
import { loadBundledFineCoverage, nativeSparseMask, wholeDomainPlan } from '../../batch/src/whole-domain/coverage';
import { coverageMemory } from '../src/coverage';
import { inFlightAllocationBytes } from '../src/resources';

const now = Date.parse('2026-10-30T00:00:00Z');
const cycle = '2026-10-29T18:00:00.000Z';
const hash = 'a'.repeat(64);
const buildId = (ordinal: number) => `20261029T180000Z-00000000-0000-0000-0000-${String(ordinal).padStart(12, '0')}`;
const primary = buildId(1), secondary = buildId(2), bad = buildId(3), archived = buildId(4);
const fixtureGrid = { kind: 'regular-latlon' as const, width: 32, height: 18, lon0: -180, lat0: 8, dx: 11.25, dy: -1, wrapLongitude: true, earthRadiusM: 6371229 };
const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); }, passThroughOnException() {}, props: {} };
let pending: Promise<unknown>[] = [];

function publication(id: string, expiry = new Date(now + 60_000).toISOString(), frameCount = 8) {
  const fixture = createV5Fixture({ product: INDEXED_PRODUCT, grid: fixtureGrid, bounds: [-180, -10, 180, 9],
    maxZoom: 5, buildId: id, cycleTime: Date.parse(cycle), frameHours: Array.from({ length: frameCount }, (_, i) => (i + 1) * 3),
    framePrefix: 'f', coveredTile: true });
  const { manifest } = fixture;
  manifest.expiresAt = expiry;
  const retained = { buildId: id, manifestKey: `builds/gfs/${id}/manifest.json`, cycle, expiresAt: expiry };
  return { ...fixture, retained };
}

function sidecar(pub: ReturnType<typeof publication>, payload: unknown = {
  version: 1, model: 'gfs', buildId: pub.manifest.buildId, cycle, provider: 'NOAA', frames: [{ hour: 3, inputs: ['profile.grib2'] }]
}) {
  const key = `builds/gfs/${pub.manifest.buildId}/provenance.json`;
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  pub.manifest.source = { provider: 'NOAA', provenanceKey: key, provenanceSha256: sha256 };
  return { key, bytes, sha256, payload };
}

class MemoryCache {
  entries = new Map<string, Response>();
  matches = 0;
  async match(request: Request) { this.matches++; return this.entries.get(request.url)?.clone(); }
  async put(request: Request, response: Response) { this.entries.set(request.url, new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers })); }
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
  private shardSha = new Map<string, string>();
  install(...pubs: ReturnType<typeof publication>[]) {
    for (const pub of pubs) {
      for (const [key, value] of pub.objects) this.objects.set(key, value);
      for (const [key, value] of pub.shardSha) this.shardSha.set(key, value);
      this.objects.set(pub.retained.manifestKey, pub.manifest);
    }
    this.objects.set('catalog/gfs/latest.json', { version: 1, model: 'gfs', latestBuildId: pubs.at(-1)!.manifest.buildId, retained: pubs.map(p => p.retained) });
  }
  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const range = options?.range;
    this.reads.push({ key, range });
    const value = this.objects.get(key);
    const sha256 = this.shardSha.get(key);
    if (sha256 && value instanceof Uint8Array) {
      if (this.missingSamples || !range) return null;
      this.active++; this.maxActive = Math.max(this.maxActive, this.active);
      await new Promise(resolve => setTimeout(resolve, 1));
      this.active--;
      if (this.expireDuringRange) vi.setSystemTime(now + 60_000);
      const bytes = value.slice(range.offset, range.offset + range.length - (this.shortRange ? 1 : 0));
      return { size: value.byteLength, range, customMetadata: { sha256 }, body: stream(bytes) };
    }
    if (value === undefined) return null;
    const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value));
    const expire = this.expireDuringProvenance && key.endsWith('/provenance.json');
    return {
      size: bytes.byteLength,
      body: stream(bytes, () => { if (expire) vi.setSystemTime(now + 60_000); })
    };
  }
}

function stream(bytes: Uint8Array, onRead = () => {}): ReadableStream<Uint8Array> {
  return new ReadableStream({ pull(controller) { onRead(); controller.enqueue(bytes); controller.close(); } }, { highWaterMark: 0 });
}

interface SparseShard { bytes: number; sha256: string }

class SparseMemoryBucket extends MemoryBucket {
  maxInFlight = 0;
  constructor(private seeded: Map<string, unknown>, private shards: Map<string, SparseShard>) { super(); }
  override async get(key: string, options?: { range?: { offset: number; length: number } }) {
    this.reads.push({ key, range: options?.range });
    this.maxInFlight = Math.max(this.maxInFlight, inFlightAllocationBytes());
    const shard = this.shards.get(key);
    if (shard) {
      if (!options?.range) return null;
      this.active++; this.maxActive = Math.max(this.maxActive, this.active);
      await new Promise(resolve => setTimeout(resolve, 1));
      this.active--;
      const bytes = new Uint8Array(options.range.length);
      return { size: shard.bytes, range: options.range, customMetadata: { sha256: shard.sha256 }, body: stream(bytes) };
    }
    const value = this.seeded.get(key);
    if (value === undefined) return null;
    const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value));
    return { size: bytes.byteLength, body: stream(bytes) };
  }
}

async function realSurface(product: ProductDefinition, kind: 'fine' | 'native', prefix: string) {
  const fine = kind === 'fine' ? await loadBundledFineCoverage(product, wholeDomainPlan(product)!) : undefined;
  const mask = fine?.mask ?? nativeSparseMask(await loadCoverage(product));
  const description = fine ?? describeSparseCoverage(mask, product);
  const layers = product.layers.filter(layer => layerSurface(layer) === kind);
  const frames = kind === 'fine' ? mapFrameCount(product) : product.frameHours.length;
  const channels = frames * layers.length;
  const id = kind;
  const shards: Extract<ForecastSurfaceV5['samples'], { format: 'frame-group-block-shards-v1' }>['shards'] = [];
  let firstFrame = 0;
  for (let group = 0; group < 4; group++) {
    const frameCount = Math.floor(frames * (group + 1) / 4) - firstFrame;
    const layout = prepareShardedSamplePackLayout(mask.grid, mask.coverage.blockIds, frameCount * layers.length);
    shards.push(...layout.shards.map((shard, blockShard) => ({
      group, firstFrame, frameCount, blockShard,
      firstBlock: shard.firstBlock, blockCount: shard.blockCount, storedCells: shard.byteLength / (frameCount * layers.length * 5),
      bytes: shard.byteLength, key: `${prefix}/surfaces/${id}/samples/g${group}-b${blockShard}.bin`, sha256: 'd'.repeat(64)
    })));
    firstFrame += frameCount;
  }
  const layout = prepareShardedSamplePackLayout(mask.grid, mask.coverage.blockIds, channels);
  const shardInfo = new Map(shards.map(shard => [shard.key, { bytes: shard.bytes, sha256: shard.sha256 }]));
  const gridHash = description.descriptor.gridHash;
  const terrain = kind === 'fine' ? { dataId: 'e'.repeat(64), key: `terrain/prepared/${'e'.repeat(64)}/manifest.json`, sha256: 'e'.repeat(64), verticalDatum: 'EGM2008' as const, surface: 'DSM' as const, gridHash, coverageHash: description.hash, layoutVersion: 1 as const } : undefined;
  const surface: ForecastSurfaceV5 = {
    id, kind, grid: mask.grid, gridHash,
    coverage: { id: product.coverageId, hash: description.hash, maskKey: `coverage/${description.hash}/manifest.json`, maxZoom: product.maxNativeZoom, gridHash },
    layers,
    samples: {
      format: 'frame-group-block-shards-v1', blockSize: SAMPLE_BLOCK_SIZE, channelOrder: 'frame-then-layer', channelCount: channels,
      coverageHash: description.hash, blockCount: layout.blockCount, storedCells: layout.storedCells, shards
    },
    ...(terrain ? { terrain } : {})
  };
  const prefixCoverage = `coverage/${description.hash}`;
  const objects = new Map<string, unknown>([
    [`${prefixCoverage}/manifest.json`, description.bytes],
    [`${prefixCoverage}/sparse.bin`, encodeSparseCoverage(mask.coverage)],
    [`${prefixCoverage}/tiles.bin`, mask.tiles]
  ]);
  let samplePoint: { lat: number; lon: number } | undefined;
  const grid = mask.grid;
  outer: for (let i = 0; i < layout.blockCount; i++) {
    const block = layout.block(i);
    for (let y = 0; y < block.height; y++) for (let x = 0; x < block.width; x++) {
      const point = gridToGeographic(grid, block.column + x, block.row + y);
      if (point && isCovered(mask, point.lat, point.lon)) { samplePoint = point; break outer; }
    }
  }
  if (!samplePoint) throw new Error('No covered sparse cell');
  return { surface, samplePoint, shards, shardInfo, objects };
}

async function realPublication(product: ProductDefinition, buildId: string) {
  const prefix = `builds/${product.modelId}/${buildId}`, cycle = new Date(now).toISOString(), expiresAt = new Date(now + 60_000).toISOString();
  const fine = await realSurface(product, 'fine', prefix);
  const surfaces: ManifestV5['surfaces'] = [fine.surface];
  const objects = new Map(fine.objects), shards = new Map(fine.shardInfo);
  if (product.layers.some(layer => layerSurface(layer) === 'native')) {
    const native = await realSurface(product, 'native', prefix);
    surfaces.push(native.surface);
    for (const [key, value] of native.objects) objects.set(key, value);
    for (const [key, value] of native.shardInfo) shards.set(key, value);
  }
  const frames: ManifestV5['frames'] = product.frameHours.map(hour => ({
    id: `f${String(hour).padStart(3, '0')}`, validTime: new Date(now + hour * 3_600_000).toISOString(),
    intervalStart: new Date(now + (hour - sourceIntervalHours(product, hour)) * 3_600_000).toISOString(), intervalEnd: new Date(now + hour * 3_600_000).toISOString()
  }));
  const artifacts: ManifestV5['artifacts'] = frames.slice(0, mapFrameCount(product)).flatMap(frame => renderedLayers(product.layers).map(layer => ({ layer, frame: frame.id, tilesKey: `${prefix}/${layer}/${frame.id}.pmtiles`, tilesSha256: 'f'.repeat(64) })));
  const provenanceKey = `${prefix}/provenance.json`, provenance = new TextEncoder().encode(JSON.stringify({ version: 1, model: product.modelId, buildId, cycle, frames: [] }));
  const manifest = manifestV5Schema.parse({
    version: 5, model: product.modelId, buildId, cycle, createdAt: cycle, expiresAt,
    descriptors: createWholeDomainDescriptors(product), recipe: createRecipeIdentity(product, 'a'.repeat(64)),
    method: { id: Object.keys(createWholeDomainDescriptors(product).methods).join('+'), hash: 'a'.repeat(64) }, frames, mapFrameCount: mapFrameCount(product), layers: product.layers, artifacts, surfaces,
    source: { provider: product.source.modelFamily.toUpperCase(), provenanceKey, provenanceSha256: createHash('sha256').update(provenance).digest('hex') },
    tool: {}, palettes: ['lift', 'rain'], metrics: {}
  });
  const manifestKey = `${prefix}/manifest.json`;
  objects.set(manifestKey, new TextEncoder().encode(JSON.stringify(manifest)));
  objects.set(provenanceKey, provenance);
  objects.set(`catalog/${product.modelId}/latest.json`, { version: 1, model: product.modelId, latestBuildId: buildId, retained: [{ buildId, manifestKey, cycle, expiresAt }] });
  return { manifest, objects, shards, samplePoint: fine.samplePoint };
}

async function callSparse(bucket: SparseMemoryBucket, path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', '192.0.2.1');
  const result = await worker.fetch(new Request(`https://api.example${path}`, { ...init, headers }), { BUCKET: bucket as unknown as R2Bucket, SAMPLE_RATE_LIMITER: limiter, AV_RESPONSE_CACHE: 'off' }, ctx);
  await Promise.all(pending.splice(0));
  return result;
}

let app: ReturnType<typeof createApp>;
let bucket: MemoryBucket;
let cache: MemoryCache;
type RateLimit = Parameters<typeof worker.fetch>[1]['SAMPLE_RATE_LIMITER']['limit'];
let limiter: { limit: ReturnType<typeof vi.fn<RateLimit>> };
async function call(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', '192.0.2.1');
  const result = await app.fetch(new Request(`https://api.example${path}`, { ...init, headers }), { BUCKET: bucket as unknown as R2Bucket, SAMPLE_RATE_LIMITER: limiter }, ctx);
  await Promise.all(pending.splice(0));
  return result;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  pending = [];
  bucket = new MemoryBucket();
  limiter = { limit: vi.fn<RateLimit>(async () => ({ success: true })) };
  const fixture = publication(primary);
  bucket.install(fixture);
  app = createApp({ products: Object.fromEntries(PRODUCTS.map(product => [product.modelId, product.modelId === 'gfs' ? fixture.product : product])) });
  cache = new MemoryCache();
  vi.stubGlobal('caches', { default: cache });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('read-only worker', () => {
  it('serves configured real fine coverages concurrently and reuses warm sparse masks', async () => {
    const publications = await Promise.all(PRODUCTS.map(product => realPublication(product, '20261030T000000Z-12345678-1234-4234-8234-123456789abc')));
    const sparse = new SparseMemoryBucket(new Map(publications.flatMap(item => [...item.objects])), new Map(publications.flatMap(item => [...item.shards])));
    const paths = publications.map(({ manifest, samplePoint }) => `/v1/models/${manifest.model}/runs/${manifest.buildId}/sample?lat=${samplePoint.lat}&lon=${samplePoint.lon}&frame=${manifest.frames[0].id}&layers=usable-lift-msl`);
    const binding = vi.spyOn(contracts, 'assertSampleLayoutBindingV5');
    for (const response of await Promise.all(paths.map(path => callSparse(sparse, path)))) {
      expect(response.status, await response.clone().text()).toBe(200);
      await response.arrayBuffer();
    }
    const coldReads = sparse.reads.filter(item => item.key.endsWith('/sparse.bin')).length;
    expect(coldReads).toBe(PRODUCTS.length);
    expect(binding).toHaveBeenCalledTimes(PRODUCTS.length);
    for (const path of [...paths, ...paths]) {
      const response = await callSparse(sparse, path);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get('x-av-response-cache')).toBe('bypass');
      await response.arrayBuffer();
    }
    expect(binding).toHaveBeenCalledTimes(PRODUCTS.length);
    expect(sparse.reads.filter(item => item.key.endsWith('/sparse.bin'))).toHaveLength(coldReads);
    expect(coverageMemory(sparse as unknown as R2Bucket)).toMatchObject({ leasedBytes: 0 });
    expect(coverageMemory(sparse as unknown as R2Bucket).cachedBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
    expect(sparse.maxInFlight).toBeLessThanOrEqual(32 * 1024 * 1024);
  }, 120_000);

  it('bounds outgoing copies for coalesced large provenance waiters before constructing their responses', async () => {
    const pub = publication(primary);
    const payload = { version: 1, model: 'gfs', buildId: primary, cycle, frames: [{ pad: '' }] };
    payload.frames[0].pad = 'x'.repeat(1024 * 1024 - new TextEncoder().encode(JSON.stringify(payload)).length);
    const receipt = sidecar(pub, payload);
    bucket.install(pub); bucket.objects.set(receipt.key, receipt.bytes);
    const results = await Promise.all(Array.from({ length: 20 }, () => app.fetch(new Request(`https://api.example/v1/models/gfs/runs/${primary}/provenance`), {
      BUCKET: bucket as unknown as R2Bucket, SAMPLE_RATE_LIMITER: limiter, AV_RESPONSE_CACHE: 'off'
    }, ctx)));
    expect(results.every(response => response.status === 200 || response.status === 503)).toBe(true);
    const successes = results.filter(response => response.status === 200);
    expect(successes.length).toBeGreaterThan(0); expect(successes.length).toBeLessThanOrEqual(4);
    expect(bucket.reads.filter(read => read.key === receipt.key)).toHaveLength(1);
    await Promise.all(results.map(async response => {
      const body = await response.text();
      if (response.status === 200) expect(body).toBe(new TextDecoder().decode(receipt.bytes));
      else {
        expect(JSON.parse(body)).toMatchObject({ title: 'resource-limit', detail: 'Serving resource budget exceeded' });
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    }));
    expect((await call('/healthz')).status).toBe(200);
  });

  it('serves a multi-megabyte 24-frame provenance sidecar within MAX_PROVENANCE_BYTES', async () => {
    const pub = publication(primary, new Date(now + 60_000).toISOString(), 24);
    const payload = {
      version: 1,
      model: 'gfs',
      buildId: primary,
      cycle,
      frames: Array.from({ length: 24 }, (_, index) => ({
        hour: index + 1,
        pad: 'x'.repeat(64 * 1024)
      }))
    };
    const receipt = sidecar(pub, payload);
    expect(receipt.bytes.byteLength).toBeGreaterThan(1024 * 1024);
    bucket.install(pub);
    bucket.objects.set(receipt.key, receipt.bytes);
    const response = await call(`/v1/models/gfs/runs/${primary}/provenance`);
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(receipt.bytes.byteLength);
  });

  it('reports the current deployment marker without storage reads or caching, while supporting local runs', async () => {
    const local = await call('/healthz');
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual({ ok: true });
    for (const deploymentId of [`${'a'.repeat(40)}-12345-1`, `${'a'.repeat(40)}-12345-2`]) {
      const response = await app.fetch(new Request('https://api.example/healthz'), {
        BUCKET: bucket as unknown as R2Bucket, SAMPLE_RATE_LIMITER: limiter, AV_DEPLOYMENT_ID: deploymentId
      }, ctx);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, deploymentId });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.has('etag')).toBe(false);
    }
    expect(bucket.reads).toHaveLength(0);
    expect(cache.matches).toBe(0);
  });

  it('serves pinned Swagger assets with integrity and a CSP matching the inline initializer', async () => {
    const docs = await call('/docs');
    expect(docs.status).toBe(200);
    const html = await docs.text();
    expect(html.match(/swagger-ui-dist@5\.34\.1\/swagger-ui(?:-bundle\.js|\.css)/g)).toHaveLength(2);
    expect(html.match(/integrity="sha384-[^"]+" crossorigin="anonymous"/g)).toHaveLength(2);
    const init = html.match(/<script>([^<]+)<\/script>/)?.[1] ?? '';
    expect(init).toContain('validatorUrl:null');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(init)));
    expect(docs.headers.get('content-security-policy')).toContain(`'sha256-${btoa(String.fromCharCode(...digest))}'`);
  });

  it('routes metadata, palette suffixes, tilejson and generated OpenAPI', async () => {
    const latest = await call('/v1/models/gfs/latest?expand=manifest');
    expect(latest.status, await latest.clone().text()).toBe(200);
    expect(((await latest.json()) as { manifest: { buildId: string } }).manifest.buildId).toBe(primary);
    expect((await call('/v1/palettes/lift.json')).status).toBe(200);
    expect((await call('/v1/palettes/rain.svg')).headers.get('content-type')).toContain('image/svg+xml');
    const tilejson = await call(`/v1/models/gfs/runs/${primary}/layers/usable-lift-agl/f003/tilejson.json`);
    expect(tilejson.status).toBe(200);
    expect(((await tilejson.json()) as { tiles: string[] }).tiles[0]).toContain('/usable-lift-agl/f003/');
    const spec = await (await call('/openapi.json')).json() as { paths: Record<string, { get: { parameters: { name: string }[]; responses: Record<string, { content?: Record<string, { schema: { type?: string } }> }> } }> };
    for (const path of ['/v1/catalog', '/v1/models/{model}/latest', '/v1/models/{model}/runs/{buildId}/sample', '/v1/models/{model}/runs/{buildId}/provenance', '/tiles/{model}/{buildId}/{layer}/{frame}/{z}/{x}/{y}.webp']) expect(spec.paths[path].get).toBeDefined();
    expect(spec.paths['/v1/models/{model}/runs/{buildId}/sample'].get.parameters.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(['lat', 'lon', 'frame', 'layers']));
    expect(spec.paths['/v1/models/{model}/runs/{buildId}/sample'].get.responses['200'].content?.['application/json'].schema).toHaveProperty('properties.version.enum', [5]);
    expect(spec.paths['/tiles/{model}/{buildId}/{layer}/{frame}/{z}/{x}/{y}.webp'].get.responses['200'].content?.['image/webp']).toBeDefined();
    expect(spec.paths['/v1/models/{model}/runs/{buildId}/sample'].get.responses['429']).toBeDefined();
  });
  it('links verified provenance from latest and build metadata without changing stored manifests', async () => {
    const pub = publication(primary), receipt = sidecar(pub);
    bucket.install(pub);
    bucket.objects.set(receipt.key, receipt.bytes);
    const url = `https://api.example/v1/models/gfs/runs/${primary}/provenance`;
    const latest = await (await call('/v1/models/gfs/latest?expand=manifest')).json();
    expect(latest).toMatchObject({ manifest: { source: { provenanceUrl: url, provenanceSha256: receipt.sha256 } } });
    const manifestPath = `/v1/models/gfs/runs/${primary}`;
    cache.entries.set(`https://api.example${manifestPath}`, new Response(JSON.stringify(pub.manifest), { headers: { etag: `"manifest-${primary}"` } }));
    const full = await call(manifestPath, { headers: { 'if-none-match': `"manifest-${primary}"` } });
    expect(full.status).toBe(200);
    expect(await full.json()).toMatchObject({ source: { provenanceUrl: url } });
    const samplePath = `/v1/models/gfs/runs/${primary}/sample?lat=80&lon=0&frame=f003&layers=precip-rate`;
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
    const pub = publication(primary), receipt = sidecar(pub);
    bucket.install(pub);
    bucket.objects.set(receipt.key, receipt.bytes);
    const path = `/v1/models/gfs/runs/${primary}/provenance`;
    const first = await call(path);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('public, max-age=60, immutable');
    vi.setSystemTime(now + 10_000);
    const hit = await call(path, { headers: { 'if-none-match': first.headers.get('etag')! } });
    expect(hit.status).toBe(304);
    expect(hit.headers.get('cache-control')).toBe('public, max-age=50, immutable');
    expect(bucket.reads.filter(read => read.key === receipt.key)).toHaveLength(1);
    const cacheReads = cache.matches;
    vi.setSystemTime(now + 60_000);
    const expired = await call(path, { headers: { 'if-none-match': first.headers.get('etag')! } });
    expect(expired.status).toBe(404);
    expect(expired.headers.get('cache-control')).toBe('no-store');
    expect(cache.matches).toBe(cacheReads);
  });
  it('rechecks retained membership before serving cached provenance', async () => {
    const pub = publication(primary), receipt = sidecar(pub);
    bucket.install(pub);
    bucket.objects.set(receipt.key, receipt.bytes);
    const path = `/v1/models/gfs/runs/${primary}/provenance`;
    expect((await call(path)).status).toBe(200);
    const cacheReads = cache.matches;
    bucket.install(publication(secondary));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(now + 15_000);
    const refreshed = call(path);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await refreshed).status).toBe(404);
    expect(cache.matches).toBe(cacheReads);
  });
  it('keeps missing or corrupt provenance failures uncached', async () => {
    const pub = publication(primary), receipt = sidecar(pub);
    bucket.install(pub);
    const path = `/v1/models/gfs/runs/${primary}/provenance`;
    bucket.objects.delete(receipt.key);
    for (const corrupt of [false, true]) {
      if (corrupt) bucket.objects.set(receipt.key, new TextEncoder().encode('{"frames":[]}'));
      const result = await call(path);
      expect(result.status).toBe(503);
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect(await result.json()).toMatchObject({ title: corrupt ? 'publication-invalid' : 'publication-incomplete' });
      expect([...cache.entries.keys()].filter(url => !url.startsWith('https://coverage.av/'))).toEqual([]);
    }
    bucket.objects.set(receipt.key, receipt.bytes);
    expect((await call(path)).status).toBe(200);
  });
  it.each([
    { provenanceKey: 'private/other.json', provenanceSha256: hash },
    { provenanceKey: `builds/gfs/${primary}/provenance.json` },
    { provenanceSha256: hash },
    { provenanceKey: `builds/gfs/${primary}/provenance.json`, provenanceSha256: 'not-a-sha256' }
  ])('rejects invalid provenance references before cache or object access: %j', async source => {
    const pub = publication(primary);
    bucket.install(pub);
    bucket.objects.set(pub.retained.manifestKey, { ...pub.manifest, source: { ...source, frames: [] } });
    const result = await call(`/v1/models/gfs/runs/${primary}/provenance`);
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ title: 'publication-invalid' });
    expect(cache.matches).toBe(0);
    expect(bucket.reads.map(read => read.key)).toEqual(['catalog/gfs/latest.json', pub.retained.manifestKey]);
  });
  it('rejects hash-valid provenance with invalid JSON or mismatched identity', async () => {
    const pub = publication(primary);
    const receipt = sidecar(pub, { version: 1, model: 'gfs', buildId: 'another-build', cycle, frames: [] });
    bucket.install(pub);
    bucket.objects.set(receipt.key, receipt.bytes);
    expect((await call(`/v1/models/gfs/runs/${primary}/provenance`)).status).toBe(503);
    bucket = new MemoryBucket();
    const malformed = new TextEncoder().encode('not JSON');
    pub.manifest.source.provenanceSha256 = createHash('sha256').update(malformed).digest('hex');
    bucket.install(pub);
    bucket.objects.set(receipt.key, malformed);
    expect((await call(`/v1/models/gfs/runs/${primary}/provenance`)).status).toBe(503);
    expect([...cache.entries.keys()].filter(url => !url.startsWith('https://coverage.av/'))).toEqual([]);
  });
  it('refuses provenance that expires during its object read', async () => {
    const pub = publication(primary), receipt = sidecar(pub);
    bucket.install(pub);
    bucket.objects.set(receipt.key, receipt.bytes);
    bucket.expireDuringProvenance = true;
    const result = await call(`/v1/models/gfs/runs/${primary}/provenance`);
    expect(result.status).toBe(404);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect([...cache.entries.keys()].filter(url => !url.startsWith('https://coverage.av/'))).toEqual([]);
  });
  it('rejects alpha manifests without the mandatory provenance sidecar reference', async () => {
    const pub = publication(archived);
    bucket.install(pub);
    bucket.objects.set(pub.retained.manifestKey, { ...pub.manifest, source: { provider: 'NOAA', frames: [] } });
    expect((await call('/v1/models/gfs/latest?expand=manifest')).status).toBe(503);
    expect((await call(`/v1/models/gfs/runs/${archived}/provenance`)).status).toBe(503);
  });
  it('advertises transparent no-lift and validates the exact palette JSON and SVG bytes', async () => {
    const latest = await (await call('/v1/models/gfs/latest?expand=manifest')).json() as { manifest: { descriptors: { palettes: { id: string; noLiftColor?: string }[] } } };
    expect(latest.manifest.descriptors.palettes.find(palette => palette.id === 'lift')?.noLiftColor).toBe('#00000000');
    for (const extension of ['json', 'svg']) {
      const path = `/v1/palettes/lift.${extension}`;
      const result = await call(path, { headers: { 'if-none-match': '"palette-lift-v2"' } });
      expect(result.status).toBe(200);
      expect(result.headers.get('cache-control')).toMatch(/^public, max-age=\d+$/);
      const text = await result.text(), etag = `"${createHash('sha256').update(text).digest('hex')}"`;
      expect(result.headers.get('etag')).toBe(etag);
      if (extension === 'json') {
        expect(JSON.parse(text)).toMatchObject({ noLiftColor: '#00000000', interpolation: 'step' });
        const legacy = JSON.parse(text) as Record<string, unknown>;
        delete legacy.interpolation;
        const legacyEtag = `"${createHash('sha256').update(JSON.stringify(legacy)).digest('hex')}"`;
        expect(result.headers.get('etag')).not.toBe(legacyEtag);
      } else {
        expect(text).toContain('font-size="12"');
        expect(text).toContain('>0–300 m</text>');
        expect(text).toContain('>6400–6700+ m</text>');
        expect(text).toContain('no usable lift (transparent)');
      }
      expect((await call(path, { headers: { 'if-none-match': etag } })).status).toBe(304);
      const rain = await call(`/v1/palettes/rain.${extension}`, { headers: { 'if-none-match': '"palette-rain-v2"' } });
      expect(rain.status).toBe(200);
      const rainText = await rain.text();
      expect(rain.headers.get('etag')).toBe(`"${createHash('sha256').update(rainText).digest('hex')}"`);
      if (extension === 'json') expect(JSON.parse(rainText)).not.toHaveProperty('interpolation');
      else expect(rainText).toContain('&lt; 0.1 mm/h (transparent)');
    }
  });
  it('validates route parameter lengths and rejects unknown models and layers', async () => {
    expect((await call(`/v1/models/${'a'.repeat(129)}/latest`)).status).toBe(400);
    expect((await call(`/v1/models/gfs/runs/${'a'.repeat(129)}`)).status).toBe(400);
    expect((await call('/v1/models/unknown/latest')).status).toBe(404);
    expect((await call(`/v1/models/gfs/runs/${primary}/layers/unknown/f003/tilejson.json`)).status).toBe(404);
  });
  it('rejects noncanonical encoded paths, duplicate/unknown query and bad tile coordinates', async () => {
    for (const path of ['/v1/models/%67fs/latest', '/v1/models/gfs/latest?expand=manifest&expand=manifest', '/v1/models/gfs/latest?other=x', `/v1/models/gfs/runs/${primary}/sample?lat=0&lon=0&lat=1`, `/tiles/gfs/${primary}/usable-lift-agl/f003/01/0/0.webp`, `/tiles/gfs/${primary}/usable-lift-agl/f003/1/2/0.webp`]) {
      const result = await call(path);
      expect(result.status, path).toBe(400);
      expect(result.headers.get('cache-control')).toBe('no-store');
    }
  });
  it('refreshes a stale per-model pointer once on membership miss before blank or cache', async () => {
    const first = `/tiles/gfs/${primary}/usable-lift-agl/f003/1/0/0.webp`;
    expect((await call(first)).status).toBe(200);
    const newer = publication(secondary);
    bucket.install(publication(primary), newer);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(now + 1001);
    const before = bucket.reads.filter(r => r.key === 'catalog/gfs/latest.json').length;
    const promoted = call(`/tiles/gfs/${secondary}/usable-lift-agl/f003/1/0/0.webp`);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await promoted).status).toBe(200);
    expect(bucket.reads.filter(r => r.key === 'catalog/gfs/latest.json').length - before).toBe(1);
    const cacheReads = cache.matches;
    const missingPending = call('/tiles/gfs/unknown/usable-lift-agl/f003/1/0/0.webp');
    await vi.advanceTimersByTimeAsync(1_000);
    const missing = await missingPending;
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { title: string }).title).toBe('not-retained');
    expect(cache.matches).toBe(cacheReads);
    expect(bucket.reads.filter(r => r.key === 'catalog/gfs/latest.json').length - before).toBe(2);
  });
  it('caches pointers and refreshes after fifteen seconds', async () => {
    expect((await call('/v1/models/gfs/runs')).status).toBe(200);
    expect((await call('/v1/models/gfs/runs')).status).toBe(200);
    expect(bucket.reads.filter(r => r.key === 'catalog/gfs/latest.json')).toHaveLength(1);
    vi.setSystemTime(now + 15_000);
    expect((await call('/v1/models/gfs/runs')).status).toBe(200);
    expect(bucket.reads.filter(r => r.key === 'catalog/gfs/latest.json')).toHaveLength(2);
  });
  it('advertises only admitted production products and identifies a missing manifest', async () => {
    const catalog = await (await call('/v1/catalog')).json() as { models: { model: string; available: boolean }[] };
    expect(catalog.models.map(m => m.model)).toEqual(PRODUCTS.map(product => product.modelId));
    expect((await call('/v1/models/hrrr/latest')).status).toBe(404);
    bucket = new MemoryBucket();
    const broken = publication(bad);
    bucket.install(broken);
    bucket.objects.delete(broken.retained.manifestKey);
    const incomplete = await call('/v1/catalog');
    expect(incomplete.status).toBe(200);
    expect(await incomplete.json()).toMatchObject({ models: expect.arrayContaining([
      expect.objectContaining({ model: 'gfs', available: false, error: 'publication-incomplete' })
    ]) });
    bucket = new MemoryBucket();
    const unavailable = await call('/v1/catalog');
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({
      models: PRODUCTS.map(product => ({ model: product.modelId, available: false, error: 'publication-unavailable' }))
    });
  });
  it('validates resource and expiry before cached blank and reduces TTL on hits', async () => {
    const url = `/tiles/gfs/${primary}/usable-lift-agl/f003/1/0/0.webp`;
    const first = await call(url);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('image/webp');
    expect(first.headers.get('cache-control')).toBe('public, max-age=60, immutable');
    const webp = await first.arrayBuffer();
    expect(webp.byteLength).toBeGreaterThan(25);
    const bytes = new Uint8Array(webp);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe('WEBP');
    const dims = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0;
    expect((dims & 0x3fff) + 1).toBe(256);
    expect(((dims >>> 14) & 0x3fff) + 1).toBe(256);
    vi.setSystemTime(now + 10_000);
    expect((await call(url)).headers.get('cache-control')).toBe('public, max-age=50, immutable');
    expect((await call(`/tiles/gfs/${primary}/usable-lift-agl/f999/1/0/0.webp`)).status).toBe(404);
    const hits = cache.matches;
    vi.setSystemTime(now + 60_000);
    const expired = await call(url);
    expect(expired.status).toBe(404);
    expect(expired.headers.get('cache-control')).toBe('no-store');
    expect(cache.matches).toBe(hits);
  });
  it('preserves pinned tiles across rollback and rejects them after retention removal', async () => {
    const target = publication(secondary), previous = publication(primary);
    bucket.install(target, previous);
    const path = `/tiles/gfs/${primary}/usable-lift-agl/f003/1/0/0.webp`;
    const tile = await call(path);
    expect(tile.status).toBe(200);
    await tile.arrayBuffer();
    const pointer = bucket.objects.get('catalog/gfs/latest.json') as { latestBuildId: string };
    bucket.objects.set('catalog/gfs/latest.json', { ...pointer, latestBuildId: target.manifest.buildId });
    vi.setSystemTime(now + 16_000);
    expect(await (await call('/v1/models/gfs/latest')).json()).toMatchObject({ pointer: { latestBuildId: target.manifest.buildId } });
    const pinned = await call(path);
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get('x-av-response-cache')).toBe('hit');
    await pinned.arrayBuffer();
    const matches = cache.matches;
    bucket.install(target);
    vi.setSystemTime(now + 32_000);
    const removed = await call(path);
    expect(removed.status).toBe(404);
    expect(removed.headers.get('cache-control')).toBe('no-store');
    expect(cache.matches).toBe(matches);
    await removed.arrayBuffer();
  });
  it('rejects a retained v4 manifest before cache, blank tiles or sample ranges', async () => {
    const old = publication(bad);
    bucket.install(old, publication(primary));
    bucket.objects.set(old.retained.manifestKey, { ...old.manifest, version: 4 });
    for (const path of [`/tiles/gfs/${bad}/usable-lift-agl/f003/1/0/0.webp`, `/v1/models/gfs/runs/${bad}/sample?lat=0&lon=0&frame=all&layers=precip-rate`]) {
      const result = await call(path);
      expect(result.status).toBe(503);
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect(((await result.json()) as { title: string }).title).toBe('publication-invalid');
      expect([...cache.entries.keys()].some(url => url.startsWith('https://api.example'))).toBe(false);
    }
    expect(bucket.reads.filter(r => r.key.includes('/samples/'))).toHaveLength(0);
  });
  it('limits sample requests before any R2 reads and fails closed if limiter or client IP is unavailable', async () => {
    const path = `/v1/models/gfs/runs/${primary}/sample?lat=0&lon=0`;
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
    result = await app.fetch(new Request(`https://api.example${path}`, { headers: { 'x-forwarded-for': '192.0.2.7' } }), { BUCKET: bucket as unknown as R2Bucket, SAMPLE_RATE_LIMITER: limiter }, ctx);
    expect(result.status).toBe(503);
    result = await app.fetch(new Request(`https://api.example${path}`, { headers: { 'cf-connecting-ip': '192.0.2.1' } }), { BUCKET: bucket as unknown as R2Bucket, SAMPLE_RATE_LIMITER: undefined as never }, ctx);
    expect(result.status).toBe(503);
    expect(bucket.reads).toHaveLength(0);
  });
  it('allows a missing IP only with the explicit local flag and a working limiter', async () => {
    const path = `/v1/models/gfs/runs/${primary}/sample?lat=0&lon=0&layers=precip-rate`;
    const request = () => new Request(`http://localhost:8787${path}`);
    const bindings = { BUCKET: bucket as unknown as R2Bucket, SAMPLE_RATE_LIMITER: limiter };
    expect((await app.fetch(request(), bindings, ctx)).status).toBe(503);
    expect((await app.fetch(request(), { ...bindings, AV_LOCAL_DEVELOPMENT: 'false' }, ctx)).status).toBe(503);
    expect((await app.fetch(request(), { ...bindings, AV_LOCAL_DEVELOPMENT: 'true', SAMPLE_RATE_LIMITER: undefined as never }, ctx)).status).toBe(503);
    expect((await app.fetch(request(), { ...bindings, AV_LOCAL_DEVELOPMENT: 'true' }, ctx)).status).toBe(200);
    expect(limiter.limit).toHaveBeenCalledWith({ key: 'localhost' });
    limiter.limit.mockResolvedValue({ success: false });
    expect((await app.fetch(request(), { ...bindings, AV_LOCAL_DEVELOPMENT: 'true' }, ctx)).status).toBe(429);
  });
  it('rejects malformed client IPs even in local development', async () => {
    const path = `/v1/models/gfs/runs/${primary}/sample?lat=0&lon=0`;
    for (const ip of ['999.1.1.1', '1.2.3', '01.2.3.4', '1.2.3.4.5', 'abcd:ef', '::::', '2001:db8::1::2', '::ffff:999.1.1.1', 'garbage']) {
      for (const local of [undefined, 'true']) {
        const result = await app.fetch(new Request(`https://api.example${path}`, { headers: { 'cf-connecting-ip': ip } }), { BUCKET: bucket as unknown as R2Bucket, SAMPLE_RATE_LIMITER: limiter, AV_LOCAL_DEVELOPMENT: local }, ctx);
        expect(result.status, ip).toBe(503);
      }
    }
    expect(limiter.limit).not.toHaveBeenCalled();
    expect(bucket.reads).toHaveLength(0);
  });
  it('uses valid IPv4 and IPv6 addresses as limiter keys', async () => {
    const path = `/v1/models/gfs/runs/${primary}/sample?lat=0&lon=0&layers=precip-rate`;
    for (const ip of ['192.0.2.1', '2001:db8::1', '::1', '::ffff:192.0.2.1']) {
      expect((await call(path, { headers: { 'cf-connecting-ip': ip } })).status, ip).toBe(200);
      expect(limiter.limit).toHaveBeenLastCalledWith({ key: ip });
    }
  });
  it('rejects repeated uncached samples before further R2 reads', async () => {
    let count = 0;
    limiter.limit.mockImplementation(async () => ({ success: ++count <= 2 }));
    for (const lon of ['0', '0.01']) expect((await call(`/v1/models/gfs/runs/${primary}/sample?lat=0&lon=${lon}&layers=precip-rate`)).status).toBe(200);
    const readCount = bucket.reads.length;
    expect((await call(`/v1/models/gfs/runs/${primary}/sample?lat=0&lon=0.02&layers=precip-rate`)).status).toBe(429);
    expect(bucket.reads).toHaveLength(readCount);
  });
  it('reports an expected but absent archive as 503 and does not cache it', async () => {
    const result = await call(`/tiles/gfs/${primary}/usable-lift-agl/f003/0/0/0.webp`);
    expect(result.status).toBe(503);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect([...cache.entries.keys()].filter(url => !url.startsWith('https://coverage.av/'))).toEqual([]);
  });
  it('serves HEAD, ETags, CORS and structured method errors', async () => {
    const path = `/tiles/gfs/${primary}/usable-lift-agl/f003/1/0/0.webp`;
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
  it.each(['missing', 'short', 'expired'] as const)('does one uncached read for a %s pack and permits a healthy retry', async defect => {
    bucket.missingSamples = defect === 'missing';
    bucket.shortRange = defect === 'short';
    bucket.expireDuringRange = defect === 'expired';
    const path = `/v1/models/gfs/runs/${primary}/sample?lat=0&lon=0&frame=all&layers=precip-rate`;
    const result = await call(path);
    expect(result.status).toBe(defect === 'expired' ? 404 : 503);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(bucket.reads.filter(read => read.key.includes('/samples/'))).toHaveLength(1);
    expect([...cache.entries.keys()].filter(url => !url.startsWith('https://coverage.av/'))).toEqual([]);
    bucket.missingSamples = false; bucket.shortRange = false; bucket.expireDuringRange = false;
    vi.setSystemTime(now);
    expect((await call(path)).status).toBe(200);
    expect(bucket.reads.filter(read => read.key.includes('/samples/'))).toHaveLength(2);
  });

  it('cancels a sample body with mismatched object size before reading it and permits retry', async () => {
    const get = bucket.get.bind(bucket), cancel = vi.fn(), pull = vi.fn();
    let invalid = true;
    vi.spyOn(bucket, 'get').mockImplementation(async (key, options) => key.includes('/samples/') && invalid
      ? { size: 1, body: new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }) }
      : get(key, options));
    const path = `/v1/models/gfs/runs/${primary}/sample?lat=0&lon=0&frame=all&layers=precip-rate`;
    const result = await call(path);
    expect(result.status).toBe(503);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull).not.toHaveBeenCalled();
    expect([...cache.entries.keys()].filter(url => !url.startsWith('https://coverage.av/'))).toEqual([]);
    invalid = false;
    expect((await call(path)).status).toBe(200);
  });

  it('rejects oversized manifests before result selection or numeric reads', async () => {
    const oversized = publication(bad);
    bucket.install(oversized);
    bucket.objects.set(oversized.retained.manifestKey, new Uint8Array(MAX_MANIFEST_BYTES + 1));
    for (const query of ['lat=0&lon=0&frame=all', 'lat=0.125&lon=0.125&frame=f003&layers=precip-rate']) {
      const result = await call(`/v1/models/gfs/runs/${bad}/sample?${query}`);
      expect(result.status).toBe(503);
      expect(result.headers.get('cache-control')).toBe('no-store');
    }
    expect(bucket.reads.filter(read => read.key.includes('/samples/'))).toHaveLength(0);
    expect([...cache.entries.keys()].filter(url => !url.startsWith('https://coverage.av/'))).toEqual([]);
  });

  it.each(['storedCells', 'channelCount', 'bytes', 'key'] as const)('rejects inconsistent pack %s before numeric reads or response cache', async field => {
    const pub = publication(bad);
    const samples = pub.manifest.surfaces[0].samples;
    if (field === 'key') samples.shards[0].key = 'builds/another/sample.bin';
    else if (field === 'bytes') samples.shards[0].bytes++;
    else samples[field]++;
    bucket.install(pub);
    const result = await call(`/v1/models/gfs/runs/${bad}/sample?lat=0&lon=0&frame=all&layers=precip-rate`);
    expect(result.status).toBe(503);
    expect([...cache.entries.keys()].filter(url => !url.startsWith('https://coverage.av/'))).toEqual([]);
    expect(bucket.reads.filter(read => read.key.includes('/samples/'))).toHaveLength(0);
  });

  it('does zero numeric reads outside coverage and fails missing or short ranges visibly', async () => {
    let result = await call(`/v1/models/gfs/runs/${primary}/sample?lat=-50&lon=0&frame=all`);
    expect(result.status).toBe(200);
    expect(((await result.json()) as { frames: { layers: Record<string, { status: string }> }[] }).frames[0].layers['precip-rate'].status).toBe('outside-domain');
    expect(bucket.reads.filter(r => r.key.includes('/samples/'))).toHaveLength(0);
    bucket.missingSamples = true;
    result = await call(`/v1/models/gfs/runs/${primary}/sample?lat=0&lon=0&layers=precip-rate`);
    expect(result.status).toBe(503);
    expect(result.headers.get('cache-control')).toBe('no-store');
    bucket.missingSamples = false; bucket.shortRange = true;
    expect((await call(`/v1/models/gfs/runs/${primary}/sample?lat=0&lon=0&layers=precip-rate`)).status).toBe(503);
  });
  it('rejects oversized selection, malformed coordinates and invalid pointers', async () => {
    const tooMany = Array.from({ length: Math.floor(MAX_SAMPLE_VALUES / 3) + 1 }, (_, i) => `f${i}`).join(',');
    expect((await call(`/v1/models/gfs/runs/${primary}/sample?lat=0&lon=0&frame=${tooMany}`)).status).toBe(429);
    for (const query of ['lat=nan&lon=0', 'lat=91&lon=0', 'lat=0&lon=', 'lat=0&lon=0&layers=precip-rate,precip-rate']) {
      const result = await call(`/v1/models/gfs/runs/${primary}/sample?${query}`);
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
    const result = await call(`/v1/models/gfs/runs/${primary}/sample?lat=0&lon=0&layers=precip-rate`);
    expect(result.status).toBe(404);
    expect([...cache.entries.keys()].filter(url => !url.startsWith('https://coverage.av/'))).toEqual([]);
  });
  it('serves warm tile GET, HEAD and 304 responses without re-reading manifest.json from R2', async () => {
    const path = `/tiles/gfs/${primary}/usable-lift-agl/f003/1/0/0.webp`;
    const first = await call(path);
    expect(first.status).toBe(200);
    const manifestReadsAfterCold = bucket.reads.filter(r => r.key === `builds/gfs/${primary}/manifest.json`).length;
    expect(manifestReadsAfterCold).toBe(1);
    expect((await call(path)).status).toBe(200);
    expect((await call(path, { method: 'HEAD' })).status).toBe(200);
    expect((await call(path, { headers: { 'if-none-match': first.headers.get('etag')! } })).status).toBe(304);
    expect(bucket.reads.filter(r => r.key === `builds/gfs/${primary}/manifest.json`)).toHaveLength(1);
  });
  it('indexes every independently loaded manifest during concurrent cold requests', async () => {
    const path = `/tiles/gfs/${primary}/usable-lift-agl/f003/1/0/0.webp`;
    const responses = await Promise.all(Array.from({ length: 4 }, () => call(path)));
    expect(responses.map(result => result.status)).toEqual([200, 200, 200, 200]);
    const reads = bucket.reads.filter(read => read.key.startsWith('builds/') && read.key.endsWith('/manifest.json')).length;
    expect((await call(path)).status).toBe(200);
    expect(bucket.reads.filter(read => read.key.startsWith('builds/') && read.key.endsWith('/manifest.json'))).toHaveLength(reads);
    vi.setSystemTime(now + 60_000);
    const matches = cache.matches;
    expect((await call(path)).status).toBe(404);
    expect(cache.matches).toBe(matches);
  });

  it('rejects ambiguous artifact records without caching the invalid manifest', async () => {
    const pub = publication(primary);
    pub.manifest.artifacts.push({ ...pub.manifest.artifacts[0] });
    bucket.install(pub);
    const path = `/tiles/gfs/${primary}/usable-lift-agl/f003/1/0/0.webp`;
    const ambiguous = await call(path);
    expect(ambiguous.status).toBe(503);
    expect((await ambiguous.json() as { title: string }).title).toBe('publication-invalid');
    expect([...cache.entries.keys()].filter(url => !url.startsWith('https://coverage.av/'))).toEqual([]);
    pub.manifest.artifacts.pop();
    expect((await call(path)).status).toBe(200);
    expect(bucket.reads.filter(read => read.key.startsWith('builds/') && read.key.endsWith('/manifest.json'))).toHaveLength(2);
  });

  it('does not cache a cold manifest that expires while its body is read', async () => {
    const get = bucket.get.bind(bucket);
    const spy = vi.spyOn(bucket, 'get').mockImplementation(async (key, options) => {
      const object = await get(key, options);
      if (!key.endsWith('/manifest.json') || !object) return object;
      return { ...object, body: object.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
        vi.setSystemTime(now + 60_000);
        controller.enqueue(chunk);
      } })) };
    });
    const path = `/tiles/gfs/${primary}/usable-lift-agl/f003/1/0/0.webp`;
    expect((await call(path)).status).toBe(404);
    expect([...cache.entries.keys()].filter(url => !url.startsWith('https://coverage.av/'))).toEqual([]);
    spy.mockRestore();
    vi.setSystemTime(now);
    expect((await call(path)).status).toBe(200);
    expect(bucket.reads.filter(read => read.key.startsWith('builds/') && read.key.endsWith('/manifest.json'))).toHaveLength(2);
  });

  it('coalesces concurrent cold pointer and manifest loads into materialized data', async () => {
    const results = await Promise.all(Array.from({ length: 24 }, () => call('/v1/models/gfs/latest?expand=manifest')));
    expect(results.every(result => result.status === 200)).toBe(true);
    expect(bucket.reads.filter(read => read.key === 'catalog/gfs/latest.json')).toHaveLength(1);
    expect(bucket.reads.filter(read => read.key === `builds/gfs/${primary}/manifest.json`)).toHaveLength(1);
    expect((await results[0].json() as { manifest: { buildId: string } }).manifest.buildId).toBe(primary);
  });

  it('coalesces duplicate cold sample ranges and exposes request-scoped cost counters', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => call(`/v1/models/gfs/runs/${primary}/sample?lat=0&lon=0&frame=all&layers=precip-rate`)));
    expect(results.every(result => result.status === 200)).toBe(true);
    expect(bucket.reads.filter(read => read.key.includes('/samples/'))).toHaveLength(1);
    const totalReads = results.reduce((sum, result) => sum + Number(result.headers.get('x-av-r2-reads')), 0);
    expect(totalReads).toBe(bucket.reads.length);
    const warm = await call(`/v1/models/gfs/runs/${primary}/sample?lat=0&lon=0&frame=all&layers=precip-rate`);
    expect(warm.headers.get('x-av-r2-reads')).toBe('0');
    expect(Number(warm.headers.get('x-av-cache-hits'))).toBeGreaterThan(0);
  });

  it('bypasses response caching only through a deployment binding while retaining metadata caches', async () => {
    const path = `/v1/models/gfs/runs/${primary}/sample?lat=0&lon=0&frame=all&layers=precip-rate`;
    await call(path);
    const before = bucket.reads.filter(read => read.key.includes('/samples/')).length;
    const response = await app.fetch(new Request(`https://api.example${path}`, { headers: { 'cf-connecting-ip': '192.0.2.1' } }), { BUCKET: bucket as unknown as R2Bucket, SAMPLE_RATE_LIMITER: limiter, AV_RESPONSE_CACHE: 'off' }, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-av-response-cache')).toBe('bypass');
    expect(response.headers.get('x-av-r2-reads')).toBe('1');
    expect(bucket.reads.filter(read => read.key.includes('/samples/')).length).toBe(before + 1);
    expect((await call(path)).headers.get('x-av-response-cache')).toBe('hit');
  });

  it('bounds unknown-build refreshes and briefly caches unavailable publications', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(now);
    const pending = Promise.all(Array.from({ length: 40 }, (_, i) => call(`/v1/models/gfs/runs/unknown-${i}`)));
    await vi.advanceTimersByTimeAsync(1_000);
    const unknown = await pending;
    expect(unknown.filter(result => result.status === 404)).toHaveLength(32);
    expect(unknown.filter(result => result.status === 503)).toHaveLength(8);
    await Promise.all(unknown.map(async result => { if (result.status === 503) expect(await result.json()).toMatchObject({ title: 'resource-limit' }); else await result.body?.cancel(); }));
    expect(bucket.reads.filter(read => read.key === 'catalog/gfs/latest.json')).toHaveLength(2);
    vi.setSystemTime(now + 1001);
    const later = call('/v1/models/gfs/runs/unknown-41');
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await later).status).toBe(404);
    expect(bucket.reads.filter(read => read.key === 'catalog/gfs/latest.json')).toHaveLength(3);
    bucket = new MemoryBucket();
    for (let i = 0; i < 10; i++) expect((await call('/v1/models/gfs/latest')).status).toBe(503);
    expect(bucket.reads).toHaveLength(1);
    bucket.install(publication(secondary));
    vi.setSystemTime(Date.now() + 5_001);
    expect((await call('/v1/models/gfs/latest')).status).toBe(200);
  });

  it('rejects an oversized object before reading its body and rejects oversized URLs before storage', async () => {
    const read = vi.fn();
    const get = bucket.get.bind(bucket);
    vi.spyOn(bucket, 'get').mockImplementation(async (key, options) => key === 'catalog/gfs/latest.json'
      ? { size: 128 * 1024 + 1, body: new ReadableStream({ pull: read }, { highWaterMark: 0 }) }
      : get(key, options));
    expect((await call('/v1/models/gfs/latest')).status).toBe(503);
    expect(read).not.toHaveBeenCalled();
    const count = bucket.reads.length;
    expect((await call(`/v1/models/gfs/latest?expand=${'x'.repeat(17 * 1024)}`)).status).toBe(400);
    expect(bucket.reads).toHaveLength(count);
  });

  it('rejects inherited object property names on palette endpoints with 404', async () => {
    for (const bad of ['constructor.json', 'toString.json', 'valueOf.svg']) {
      const res = await call(`/v1/palettes/${bad}`);
      expect(res.status, bad).toBe(404);
    }
    expect((await call('/v1/palettes/__proto__.json')).status).toBe(400);
  });
  it('reports one structured event with a matched route and stable failure code', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const failure = new TypeError('R2 backend timeout');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(bucket, 'get').mockRejectedValueOnce(failure);
    const res = await call('/v1/models/gfs/latest');
    expect(res.status).toBe(503);
    expect(res.headers.get('server-timing')).toMatch(/worker;dur=\d+\.\d+, r2;dur=\d+\.\d+/);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      event: 'api-request', method: 'GET', route: '/v1/models/:model/latest', model: 'gfs',
      status: 503, problemCode: 'publication-unavailable', r2Reads: 1
    });
    expect(log.mock.calls[0][0]).not.toContain('R2 backend timeout');
    expect(errorLog).toHaveBeenCalledExactlyOnceWith('Worker request failed', failure);

    log.mockClear();
    const path = `/v1/models/gfs/runs/${primary}/sample?lat=0&lon=0&layers=precip-rate`;
    const request = (method: string) => app.fetch(new Request(`https://api.example${path}`, { method, headers: { 'cf-connecting-ip': '192.0.2.1' } }), {
      BUCKET: bucket as unknown as R2Bucket, SAMPLE_RATE_LIMITER: limiter, AV_REQUEST_METRICS: 'true'
    }, ctx);
    const valid = await request('GET');
    expect(valid.status).toBe(200); await valid.arrayBuffer();
    expect(valid.headers.get('server-timing')).toContain('admit;dur=');
    const early = await request('POST');
    expect(early.status).toBe(405); await early.arrayBuffer();
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      route: '/v1/models/:model/runs/:buildId/sample', model: 'gfs', buildId: primary, status: 200
    });
    expect(JSON.parse(log.mock.calls[1][0])).toMatchObject({ route: 'unmatched', status: 405, problemCode: 'method-not-allowed' });
    expect(log.mock.calls.flat().join(' ')).not.toContain('lat=0');
    await Promise.all(pending.splice(0));
  });

  it('records client cancellation without a publication failure', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = new AbortController();
    const signal = controller.signal;
    let release!: (value: null) => void, reading!: () => void;
    const read = new Promise<null>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { reading = resolve; });
    vi.spyOn(bucket, 'get').mockImplementationOnce(() => { reading(); return read; });
    const path = `/tiles/gfs/${primary}/precip-rate/f001/0/0/0.webp`;
    const pendingResponse = app.fetch(new Request(`https://api.example${path}`, { signal }), {
      BUCKET: bucket as unknown as R2Bucket, SAMPLE_RATE_LIMITER: limiter, AV_REQUEST_METRICS: 'true'
    }, ctx);
    await started;
    controller.abort(new DOMException('Map moved', 'AbortError'));
    try {
      const res = await pendingResponse;
      expect(res.status).toBe(499);
      expect(res.body).toBeNull();
      expect(log).toHaveBeenCalledTimes(1);
      const event = JSON.parse(log.mock.calls[0][0]);
      expect(event).toMatchObject({ status: 499, aborted: true });
      expect(event).not.toHaveProperty('problemCode');
      expect(errorLog).not.toHaveBeenCalled();
    } finally { release(null); await Promise.all(pending.splice(0)); }
  });
});
