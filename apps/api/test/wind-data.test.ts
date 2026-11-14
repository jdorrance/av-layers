import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { modelPointerSchema, storedModelPointerSchema, type ManifestV5 } from '@av/contracts';
import { WIND_FINE_CELL_BYTES, WIND_OVERVIEW_CELL_BYTES, WIND_OVERVIEW_TILE_SIZE } from '@av/contracts/wind-data';
import { OFFLINE_PRODUCT } from '@av/contracts/fixture-product';
import { createApp } from '../src/index';
import * as windData from '../src/wind-data';
import { windChunk, windFrame } from '../src/wind-data';
import { binaryRead } from '../src/resources';

type Local = { root: string; manifest: ManifestV5; dispose(): Promise<void> };
type Numeric = { reference: { bytes: number; sha256: string }; objects: Array<{ key: string; sha256: string; bytes: number }> };
let fixture: { copy(): Promise<Local>; dispose(): Promise<void> };
let local: Local;
let numeric: Numeric;
beforeAll(async () => {
  const fixturePath = '../../../scripts/fixtures/offline-preview.js', dataPath = '../../batch/src/wind-data.js';
  const fixtureModule = await import(fixturePath) as { offlinePreviewFixture(): Promise<typeof fixture> };
  const dataModule = await import(dataPath) as { localWindData(root: string, manifest: ManifestV5): Promise<Numeric> };
  fixture = await fixtureModule.offlinePreviewFixture(); local = await fixture.copy(); numeric = await dataModule.localWindData(local.root, local.manifest);
});
afterAll(async () => { await local.dispose(); await fixture.dispose(); });
const ctx = { waitUntil() {} }, signal = new AbortController().signal;

function entry() { return { buildId: local.manifest.buildId, manifestKey: `builds/gfs/${local.manifest.buildId}/manifest.json`, cycle: local.manifest.cycle, expiresAt: local.manifest.expiresAt, mapData: numeric.reference }; }
function bucket(corrupt?: string) {
  const reads: Array<{ key: string; length?: number }> = [];
  const get = async (key: string, options?: { range?: { offset: number; length: number } }) => {
    reads.push({ key, length: options?.range?.length });
    const ref = numeric.objects.find(object => object.key === key);
    if (!ref) return null;
    const file = await readFile(join(local.root, key)), range = options?.range;
    const bytes = Uint8Array.from(range ? file.subarray(range.offset, range.offset + range.length) : file);
    if (key.endsWith(corrupt ?? '\0')) bytes[0] ^= 1;
    return { size: file.length, ...(range ? { range } : {}), customMetadata: { sha256: ref.sha256 }, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
  };
  return { reads, get, bucket: { get } as unknown as R2Bucket };
}

it('keeps mapData in stored pointers and projects the public v5 pointer unchanged', () => {
  const old = { version: 1, model: 'gfs', latestBuildId: local.manifest.buildId, retained: [{ ...entry(), mapData: undefined }] };
  const newer = { ...old, retained: [entry()] };
  expect(storedModelPointerSchema.parse(old).retained[0].mapData).toBeUndefined();
  expect(storedModelPointerSchema.parse(newer).retained[0].mapData).toEqual(numeric.reference);
  expect(modelPointerSchema.parse(newer)).toEqual(modelPointerSchema.parse(old));
});

it('serves authenticated bounded chunks and rejects absent references and bad digests', async () => {
  const frame = local.manifest.frames[0].id, store = bucket();
  const result = await windFrame(store.bucket, local.manifest, entry(), frame, ctx, signal);
  expect(result.descriptor.frame).toBe(frame);
  expect(result.descriptor.version).toBe(3);
  expect((await windChunk(store.bucket, local.manifest, entry(), frame, 'fine', 0, ctx, signal)).length).toBe(64 * 64 * WIND_FINE_CELL_BYTES);
  expect((await windChunk(store.bucket, local.manifest, entry(), frame, 'wind', 0, ctx, signal)).length).toBeLessThanOrEqual(256 * 1024);
  expect(store.reads.filter(read => read.length).every(read => read.length! <= 256 * 1024)).toBe(true);
  await expect(windFrame(store.bucket, local.manifest, { ...entry(), mapData: undefined }, frame, ctx, signal)).rejects.toMatchObject({ status: 409 });
  await expect(windChunk(bucket('wind-0.bin').bucket, local.manifest, entry(), frame, 'wind', 0, ctx, signal)).rejects.toMatchObject({ status: 503 });
  await expect(windChunk(bucket('wind-0.idx').bucket, local.manifest, entry(), frame, 'wind', 0, ctx, signal)).rejects.toMatchObject({ status: 503 });
  await expect(windFrame(bucket('map-data.json').bucket, local.manifest, entry(), frame, ctx, signal)).rejects.toMatchObject({ status: 503 });
});

it('serves verified overview ranges and rejects unknown levels without reading payloads', async () => {
  const frame = local.manifest.frames[0].id, store = bucket();
  const result = await windFrame(store.bucket, local.manifest, entry(), frame, ctx, signal);
  expect(result.descriptor.overview?.[0].stride).toBe(2);
  const chunk = await windChunk(store.bucket, local.manifest, entry(), frame, 'overview-2', 0, ctx, signal);
  expect(chunk.length).toBe(WIND_OVERVIEW_TILE_SIZE ** 2 * WIND_OVERVIEW_CELL_BYTES);
  expect(store.reads.filter(read => read.length)).toEqual([expect.objectContaining({ key: expect.stringMatching(/overview-2-0\.bin$/), length: chunk.length })]);
  const reads = store.reads.length;
  for (const [kind, tile] of [['overview-3', 0], ['overview-2', 1_000_000], ['unknown', 0]] as const) {
    await expect(windChunk(store.bucket, local.manifest, entry(), frame, kind, tile, ctx, signal)).rejects.toMatchObject({ status: 404, code: 'unknown-resource' });
  }
  expect(store.reads).toHaveLength(reads);
  for (const suffix of ['overview-2-0.bin', 'overview-2-0.idx']) {
    await expect(windChunk(bucket(suffix).bucket, local.manifest, entry(), frame, 'overview-2', 0, ctx, signal)).rejects.toMatchObject({ status: 503, code: 'publication-invalid' });
  }
});

it('does not return a chunk after retained expiry', async () => {
  const original = local.manifest.expiresAt, retained = entry();
  try {
    retained.expiresAt = new Date(Date.now() - 1).toISOString();
    await expect(windChunk(bucket().bucket, local.manifest, retained, local.manifest.frames[0].id, 'fine', 0, ctx, signal)).rejects.toMatchObject({ status: 404 });
  } finally { local.manifest.expiresAt = original; }
});

it('rechecks expiry after a range finishes and refuses warm metadata after expiry', async () => {
  const now = Date.now(), retained = { ...entry(), expiresAt: new Date(now + 1000).toISOString() };
  const frame = local.manifest.frames[0].id, store = bucket();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  let expireOnRange = false;
  const shared = { get: async (...args: Parameters<typeof store.get>) => {
    const object = await store.get(...args);
    if (expireOnRange && args[1]?.range) clock.mockReturnValue(now + 1001);
    return object;
  } } as unknown as R2Bucket;
  try {
    await windFrame(shared, local.manifest, retained, frame, ctx, signal);
    expireOnRange = true;
    await expect(windChunk(shared, local.manifest, retained, frame, 'wind', 0, ctx, signal)).rejects.toMatchObject({ status: 404 });
    const reads = store.reads.length;
    await expect(windFrame(shared, local.manifest, retained, frame, ctx, signal)).rejects.toMatchObject({ status: 404 });
    expect(store.reads).toHaveLength(reads);
  } finally { clock.mockRestore(); }
});

it('coalesces cold reads and keeps cached and shared bytes private', async () => {
  const frame = local.manifest.frames[0].id, store = bucket();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const shared = { get: async (...args: Parameters<typeof store.get>) => { await gate; return store.get(...args); } } as unknown as R2Bucket;
  const pending = Array.from({ length: 24 }, () => windChunk(shared, local.manifest, entry(), frame, 'wind', 0, ctx, signal));
  release();
  const chunks = await Promise.all(pending);
  expect(store.reads).toHaveLength(4);
  expect(chunks.every(bytes => bytes[0] === chunks[0][0])).toBe(true);
  chunks[0][0] ^= 1;
  expect(chunks[0][0]).not.toBe(chunks[1][0]);
  const descriptor = await windFrame(shared, local.manifest, entry(), frame, ctx, signal);
  descriptor.bytes[0] ^= 1;
  expect((await windFrame(shared, local.manifest, entry(), frame, ctx, signal)).bytes[0]).not.toBe(descriptor.bytes[0]);
  await windChunk(shared, local.manifest, entry(), frame, 'wind', 0, ctx, signal);
  expect(store.reads).toHaveLength(5);
  await expect(windFrame(shared, local.manifest, { ...entry(), mapData: { ...numeric.reference, sha256: '0'.repeat(64) } }, frame, ctx, signal)).rejects.toMatchObject({ status: 503, code: 'publication-invalid' });
});

it('shares the binary read budget and drops canceled queued wind reads', async () => {
  const frame = local.manifest.frames[0].id, store = bucket();
  let release!: () => void, active = 0, peak = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let holding = false;
  const shared = { get: async (...args: Parameters<typeof store.get>) => {
    const object = await store.get(...args);
    if (!holding || !args[1]?.range || !object) return object;
    active++; peak = Math.max(peak, active);
    const body = object.body;
    return { ...object, body: new ReadableStream<Uint8Array>({
      async start(controller) { await gate; const reader = body.getReader(); try { for (;;) { const next = await reader.read(); if (next.done) break; controller.enqueue(next.value); } controller.close(); } finally { reader.releaseLock(); active--; } }
    }) };
  } } as unknown as R2Bucket;
  await windChunk(shared, local.manifest, entry(), frame, 'wind', 0, ctx, signal);
  await windChunk(shared, local.manifest, entry(), frame, 'fine', 0, ctx, signal);
  holding = true;
  const occupied = Array.from({ length: 7 }, (_, i) => binaryRead(shared, `other-${i}`, async () => {
    active++; peak = Math.max(peak, active);
    try { await gate; return Uint8Array.of(1); } finally { active--; }
  }, ctx));
  const canceled = new AbortController(), canceledOwner = new AbortController();
  const pending = Array.from({ length: 12 }, (_, i) => windChunk(shared, local.manifest, entry(), frame, 'wind', 0, ctx, i === 0 ? canceledOwner.signal : signal));
  const queueContext = { waitUntil: vi.fn() };
  const queued = windChunk(shared, local.manifest, entry(), frame, 'fine', 0, queueContext, canceled.signal);
  const results = Promise.allSettled([...occupied, ...pending, queued]);
  try {
    await vi.waitFor(() => expect(active).toBe(8));
    await vi.waitFor(() => expect(queueContext.waitUntil).toHaveBeenCalledOnce());
    canceled.abort(new Error('canceled queued chunk'));
    canceledOwner.abort(new Error('canceled waiter'));
    await expect(queued).rejects.toThrow('canceled queued chunk');
    await expect(pending[0]).rejects.toThrow('canceled waiter');
  } finally { release(); }
  const settled = await results;
  expect(settled.slice(0, 7).every(result => result.status === 'fulfilled')).toBe(true);
  expect(settled.slice(8, 19).every(result => result.status === 'fulfilled')).toBe(true);
  expect(peak).toBe(8);
  expect(store.reads.filter(read => read.length)).toHaveLength(3);
});

it('applies the owner deadline to stalled wind bodies and permits a retry', async () => {
  const frame = local.manifest.frames[0].id, store = bucket();
  let stall = false, started!: () => void;
  const bodyStarted = new Promise<void>(resolve => { started = resolve; });
  const cancel = vi.fn();
  const shared = { get: async (...args: Parameters<typeof store.get>) => {
    const object = await store.get(...args);
    if (!stall || !args[1]?.range || !object) return object;
    void object.body.cancel();
    return { ...object, body: new ReadableStream<Uint8Array>({ start() { started(); }, cancel }) };
  } } as unknown as R2Bucket;
  await windChunk(shared, local.manifest, entry(), frame, 'wind', 0, ctx, signal);
  stall = true;
  vi.useFakeTimers();
  try {
    const pending = windChunk(shared, local.manifest, entry(), frame, 'wind', 0, ctx, signal);
    const failure = expect(pending).rejects.toThrow('deadline');
    await bodyStarted;
    await vi.advanceTimersByTimeAsync(15_001);
    await failure;
    expect(cancel).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
  stall = false;
  expect((await windChunk(shared, local.manifest, entry(), frame, 'wind', 0, ctx, signal)).length).toBeGreaterThan(0);
});

it('rejects excess coalesced wind waiters during a burst', async () => {
  const frame = local.manifest.frames[0].id, store = bucket();
  let release!: () => void, holding = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const shared = { get: async (...args: Parameters<typeof store.get>) => {
    const object = await store.get(...args);
    if (!holding || !args[1]?.range || !object) return object;
    const body = object.body;
    return { ...object, body: new ReadableStream<Uint8Array>({ async start(controller) {
      await gate;
      const reader = body.getReader();
      try { for (;;) { const next = await reader.read(); if (next.done) break; controller.enqueue(next.value); } controller.close(); }
      finally { reader.releaseLock(); }
    } }) };
  } } as unknown as R2Bucket;
  await windChunk(shared, local.manifest, entry(), frame, 'wind', 0, ctx, signal);
  holding = true;
  const metrics = { r2Reads: 0, r2Bytes: 0, cacheHits: 0, coalesced: 0 }, context = { waitUntil() {}, metrics };
  const results = Promise.allSettled(Array.from({ length: 110 }, () => windChunk(shared, local.manifest, entry(), frame, 'wind', 0, context, signal)));
  try { await vi.waitFor(() => expect(metrics.coalesced).toBe(95)); }
  finally { release(); }
  const settled = await results;
  expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(96);
  const rejected = settled.filter(result => result.status === 'rejected');
  expect(rejected).toHaveLength(14);
  expect(rejected.every(result => result.status === 'rejected' && /waiters/.test(String(result.reason)))).toBe(true);
  expect(store.reads.filter(read => read.length)).toHaveLength(2);
});

it('retries failed digest verification and isolates different references', async () => {
  const frame = local.manifest.frames[0].id, store = bucket();
  let corrupt = true;
  const shared = { get: async (...args: Parameters<typeof store.get>) => {
    const object = await store.get(...args);
    if (!corrupt || !args[0].endsWith('map-data.json') || !object) return object;
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    bytes[0] ^= 1;
    return { ...object, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
  } } as unknown as R2Bucket;
  await expect(windFrame(shared, local.manifest, entry(), frame, ctx, signal)).rejects.toMatchObject({ status: 503, code: 'publication-invalid' });
  corrupt = false;
  await expect(windFrame(shared, local.manifest, entry(), frame, ctx, signal)).resolves.toHaveProperty('descriptor.frame', frame);
  expect(store.reads.filter(read => read.key.endsWith('map-data.json'))).toHaveLength(2);
  await expect(windFrame(shared, local.manifest, { ...entry(), mapData: { ...numeric.reference, bytes: numeric.reference.bytes + 1 } }, frame, ctx, signal)).rejects.toMatchObject({ status: 503, code: 'publication-invalid' });
});

it('does not cache a corrupt chunk or its verification error', async () => {
  const frame = local.manifest.frames[0].id, store = bucket();
  let corrupt = true;
  const shared = { get: async (...args: Parameters<typeof store.get>) => {
    const object = await store.get(...args);
    if (!corrupt || !args[1]?.range || !object) return object;
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    bytes[0] ^= 1;
    return { ...object, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
  } } as unknown as R2Bucket;
  await expect(windChunk(shared, local.manifest, entry(), frame, 'wind', 0, ctx, signal)).rejects.toMatchObject({ status: 503, code: 'publication-invalid' });
  corrupt = false;
  await expect(windChunk(shared, local.manifest, entry(), frame, 'wind', 0, ctx, signal)).resolves.toBeInstanceOf(Uint8Array);
  expect(store.reads.filter(read => read.length)).toHaveLength(2);
});

it('limits distinct numeric requests after a normal viewport load', async () => {
  const store = bucket(), model = local.manifest.model, frame = local.manifest.frames[0].id;
  const pointerKey = `catalog/${model}/latest.json`, manifestKey = entry().manifestKey;
  const pointer = { version: 1, model, latestBuildId: local.manifest.buildId, retained: [entry()] };
  const get = vi.fn(async (key: string, options?: { range?: { offset: number; length: number } }) => {
    if (key !== pointerKey && key !== manifestKey) return store.get(key, options);
    const bytes = new TextEncoder().encode(JSON.stringify(key === pointerKey ? pointer : local.manifest));
    return { size: bytes.length, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
  });
  const app = createApp({ products: { [model]: OFFLINE_PRODUCT } });
  const counts = new Map<string, number>();
  const numericLimiter = { limit: vi.fn(async ({ key }: { key: string }) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return { success: count <= 130 };
  }) };
  const env = { BUCKET: { get } as unknown as R2Bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) }, NUMERIC_RATE_LIMITER: numericLimiter, AV_RESPONSE_CACHE: 'off' };
  const path = `/v1/models/${model}/runs/${local.manifest.buildId}/data/${frame}`;
  const call = (suffix: string, ip = '192.0.2.1') => app.fetch(new Request(`https://api.test${path}${suffix}`, { headers: { 'cf-connecting-ip': ip } }), env, ctx);
  for (const suffix of ['', '/wind/0', '/fine/0', '/overview-2/0']) {
    const result = await call(suffix);
    expect(result.status, await result.clone().text()).toBe(200);
    await result.arrayBuffer();
  }
  const chunk = vi.spyOn(windData, 'windChunk').mockResolvedValue(Uint8Array.of(1));
  try {
    for (let tile = 1; tile <= 126; tile++) {
      const result = await call(`/wind/${tile}`);
      expect(result.status).toBe(200);
      await result.arrayBuffer();
    }
    const reads = get.mock.calls.length;
    const denied = await call('/wind/128');
    expect(denied.status).toBe(429);
    expect(await denied.json()).toEqual({ type: 'urn:windy-av:rate-limit-exceeded', title: 'rate-limit-exceeded', status: 429, detail: 'Numeric request rate exceeded' });
    expect(denied.headers.get('cache-control')).toBe('no-store');
    expect(get).toHaveBeenCalledTimes(reads);
    expect(chunk).toHaveBeenCalledTimes(126);
    expect((await call('', '192.0.2.2')).status).toBe(200);
    expect(numericLimiter.limit.mock.calls.every(([options]) => /^192\.0\.2\.[12]$/.test(options.key))).toBe(true);
  } finally { chunk.mockRestore(); }
});

it('fails numeric requests closed when the limiter or client IP is unavailable', async () => {
  const app = createApp(), path = '/v1/models/gfs/runs/build/data/f001';
  const limit = vi.fn(async () => ({ success: true }));
  const env = { BUCKET: bucket().bucket, SAMPLE_RATE_LIMITER: { limit }, NUMERIC_RATE_LIMITER: { limit } };
  const call = (headers: HeadersInit, bindings = env) => app.fetch(new Request(`https://api.test${path}`, { headers }), bindings, ctx);
  expect((await call({ 'x-forwarded-for': '192.0.2.1' })).status).toBe(503);
  expect((await call({ 'cf-connecting-ip': 'invalid' })).status).toBe(503);
  expect((await call({ 'cf-connecting-ip': '192.0.2.1' }, { ...env, NUMERIC_RATE_LIMITER: undefined as never })).status).toBe(503);
  expect(limit).not.toHaveBeenCalled();
  expect((await call({ 'cf-connecting-ip': '192.0.2.1' }, { ...env, NUMERIC_RATE_LIMITER: { limit: vi.fn(async () => { throw new Error('private'); }) } })).status).toBe(503);
});

it('sets edge cache revalidation on frame descriptors and validates multi-tile chunk spans', async () => {
  const store = bucket(), model = local.manifest.model, frame = local.manifest.frames[0].id;
  const pointerKey = `catalog/${model}/latest.json`, manifestKey = entry().manifestKey;
  const pointer = { version: 1, model, latestBuildId: local.manifest.buildId, retained: [entry()] };
  const get = async (key: string, options?: { range?: { offset: number; length: number } }) => {
    if (key !== pointerKey && key !== manifestKey) return store.get(key, options);
    const bytes = new TextEncoder().encode(JSON.stringify(key === pointerKey ? pointer : local.manifest));
    return { size: bytes.length, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) };
  };
  const app = createApp({ products: { [model]: OFFLINE_PRODUCT } });
  const env = { BUCKET: { get } as unknown as R2Bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) }, NUMERIC_RATE_LIMITER: { limit: async () => ({ success: true }) }, AV_RESPONSE_CACHE: 'off' };
  const base = `https://api.test/v1/models/${model}/runs/${local.manifest.buildId}/data/${frame}`;
  const frameRes = await app.fetch(new Request(base, { headers: { 'cf-connecting-ip': '192.0.2.10' } }), env, ctx);
  expect(frameRes.status).toBe(200);
  expect(frameRes.headers.get('cloudflare-cdn-cache-control')).toContain('must-revalidate');
  expect(frameRes.headers.get('etag')).toBeTruthy();
  const spanRes = await app.fetch(new Request(`${base}/wind/0-0`, { headers: { 'cf-connecting-ip': '192.0.2.10' } }), env, ctx);
  expect(spanRes.status).toBe(200);
  const badSpan = await app.fetch(new Request(`${base}/wind/2-1`, { headers: { 'cf-connecting-ip': '192.0.2.10' } }), env, ctx);
  expect(badSpan.status).toBe(400);
});
