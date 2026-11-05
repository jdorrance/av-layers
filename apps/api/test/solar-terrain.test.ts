import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/index';
import solar from './fixtures/solar.json';
import { MAX_MANIFEST_BYTES } from '@av/contracts';
import { serveSolarIndex } from '../src/solar-terrain';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse('2026-11-05T00:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function fixture() {
  const index = structuredClone(solar.index), prefix = `terrain/solar/${index.slug}`, objects = new Map<string, Uint8Array>();
  const bytes = encode(index);
  objects.set(`${prefix}/index.json`, bytes); objects.set(`${prefix}/${index.generation}/index.json`, bytes);
  for (const file of solar.files) objects.set(`${prefix}/${file.path}`, Uint8Array.from(Buffer.from(file.body, 'base64')));
  const tiles = solar.files.filter(file => file.path !== index.relief.path).map(file => {
    const [, z, x, y] = file.path.match(/^([^/]+)\/(\d+)\/(-?\d+)\/(\d+)\.bin\.gz$/)!.slice(1);
    return { z: Number(z), x: Number(x), y: Number(y), body: objects.get(`${prefix}/${file.path}`)! };
  });
  const get = vi.fn(async (key: string) => {
    const bytes = objects.get(key);
    return bytes ? { size: bytes.length, customMetadata: { sha256: sha(bytes) }, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } : null;
  });
  const app = createApp(), bucket = { get } as unknown as R2Bucket;
  const request = (path: string, init?: RequestInit) => app.fetch(new Request(`https://api.test/v1/terrain/solar/${index.slug}/${path}`, init),
    { BUCKET: bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) }, AV_RESPONSE_CACHE: 'off' }, { waitUntil() {} });
  return { index, tiles, objects, get, request, prefix, bytes, bucket };
}

it('revalidates launch indexes and serves exact immutable gzip bytes with content digests', async () => {
  const f = fixture(), index = await f.request('index.json');
  expect(index.status).toBe(200);
  expect(index.headers.get('cache-control')).toContain('max-age=0');
  expect(index.headers.get('cache-control')).toContain('must-revalidate');
  expect(index.headers.get('etag')).toBe(`"${sha(f.bytes)}"`);
  await index.arrayBuffer();
  const tile = f.tiles[0]!, path = `${f.index.generation}/${tile.z}/${tile.x}/${tile.y}.bin.gz`;
  const response = await f.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-encoding')).toBeNull();
  expect(response.headers.get('cache-control')).toContain('immutable');
  expect(response.headers.get('etag')).toBe(`"${sha(tile.body)}"`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(bytes).toEqual(new Uint8Array(tile.body));
  expect(gunzipSync(bytes).length).toBe(340_552);
  const unchanged = await f.request(path, { headers: { 'if-none-match': `"${sha(tile.body)}"` } });
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe('');
  const head = await f.request(f.index.relief.path, { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(head.headers.get('content-length')).toBe(String(f.index.relief.bytes));
  expect(await head.text()).toBe('');
});

it('keeps previous generation assets available after a mutable index changes', async () => {
  const f = fixture(), tile = f.tiles[0]!;
  await (await f.request('index.json')).arrayBuffer();
  const updated = structuredClone(f.index), generation = 'b'.repeat(12);
  updated.generation = generation; updated.tiles.path = `${generation}/{z}/{x}/{y}.bin.gz`; updated.relief.path = `${generation}/relief-v1.bin.gz`;
  f.objects.set(`${f.prefix}/index.json`, encode(updated));
  const cached = await f.request('index.json', { headers: { 'if-none-match': `"${sha(f.bytes)}"` } });
  expect(cached.status).toBe(304);
  expect(f.get.mock.calls).toHaveLength(1);
  vi.setSystemTime(Date.now() + 15_001);
  const index = await f.request('index.json');
  expect((await index.json() as { generation: string }).generation).toBe(generation);
  const previous = await f.request(`${f.index.generation}/${tile.z}/${tile.x}/${tile.y}.bin.gz`);
  expect(previous.status).toBe(200);
  expect(new Uint8Array(await previous.arrayBuffer())).toEqual(new Uint8Array(tile.body));
});

it('rejects malformed coordinates before loading generation metadata', async () => {
  const f = fixture();
  const invalid = await f.request(`${f.index.generation}/NaN/0/0.bin.gz`);
  expect(invalid.status).toBe(400); await invalid.arrayBuffer();
  expect(f.get).not.toHaveBeenCalled();
});

it('fails closed on malformed, oversized, tampered and mismatched indexes', async () => {
  for (const kind of ['json', 'size', 'digest', 'slug', 'generation'] as const) {
    const f = fixture(), key = `${f.prefix}/${f.index.generation}/index.json`;
    if (kind === 'json') f.objects.set(key, new TextEncoder().encode('{'));
    if (kind === 'size') f.objects.set(key, new Uint8Array(MAX_MANIFEST_BYTES + 1));
    if (kind === 'slug' || kind === 'generation') f.objects.set(key, encode({ ...f.index, [kind]: 'wrong' }));
    if (kind === 'digest') {
      const original = f.get.getMockImplementation()!;
      f.get.mockImplementation(async key => { const object = await original(key); return object ? { ...object, customMetadata: { sha256: '0'.repeat(64) } } : null; });
    }
    const result = await f.request(`${f.index.generation}/index.json`);
    expect(result.status, kind).toBe(503); expect(result.headers.get('cache-control')).toBe('no-store'); await result.arrayBuffer();
  }
});

it('cancels one metadata waiter while a coalesced survivor completes', async () => {
  const f = fixture(), original = f.get.getMockImplementation()!;
  let ready!: () => void;
  const held = new Promise<void>(resolve => { ready = resolve; });
  f.get.mockImplementation(async key => { await held; return original(key); });
  const abort = new AbortController(), ctx = { waitUntil() {}, responseCacheEnabled: false };
  const first = serveSolarIndex(new Request('https://api.test/solar', { signal: abort.signal }), f.bucket, f.index.slug, undefined, ctx);
  const rejected = expect(first).rejects.toThrow('cancelled');
  const survivor = serveSolarIndex(new Request('https://api.test/solar'), f.bucket, f.index.slug, undefined, ctx);
  abort.abort(new Error('cancelled')); await rejected; ready();
  const response = await survivor;
  expect(response.status).toBe(200); await response.arrayBuffer();
  expect(f.get).toHaveBeenCalledTimes(1);
});

it('rejects unknown tiles before asset I/O and fails closed on missing or corrupt bytes', async () => {
  const f = fixture(), tile = f.tiles[0]!, path = `${f.index.generation}/${tile.z}/${tile.x}/${tile.y}.bin.gz`;
  const outside = await f.request(`${f.index.generation}/14/0/0.bin.gz`);
  expect(outside.status).toBe(404);
  await outside.arrayBuffer();
  expect(f.get.mock.calls).toHaveLength(1);
  f.objects.set(`${f.prefix}/${path}`, new Uint8Array(tile.body.length));
  const corrupt = await f.request(path);
  expect(corrupt.status).toBe(503);
  expect(corrupt.headers.get('cache-control')).toBe('no-store');
  await corrupt.arrayBuffer();
  f.objects.delete(`${f.prefix}/${path}`);
  const missing = await f.request(path);
  expect(missing.status).toBe(503);
  await missing.arrayBuffer();
  expect((await f.request(`${f.index.generation}/14/-0/0.bin.gz`)).status).toBe(400);
});

it('keeps cold index loads at four while queued launches drain', async () => {
  const f = fixture(), original = f.get.getMockImplementation()!;
  let active = 0, peak = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.get.mockImplementation(async key => { active++; peak = Math.max(peak, active); await held; active--; return original(key); });
  const requests = Array.from({ length: 5 }, (_, index) => {
    const slug = `site-${index}`, value = { ...f.index, slug };
    f.objects.set(`terrain/solar/${slug}/index.json`, encode(value));
    return serveSolarIndex(new Request(`https://api.test/${slug}`), f.bucket, slug, undefined, { waitUntil() {}, responseCacheEnabled: false });
  });
  expect(f.get).toHaveBeenCalledTimes(4); release();
  const responses = await Promise.all(requests);
  expect(responses.every(response => response.status === 200)).toBe(true);
  await Promise.all(responses.map(response => response.arrayBuffer()));
  expect(peak).toBe(4); expect(f.get).toHaveBeenCalledTimes(5);
});
