import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ tile: undefined as ArrayBuffer | undefined, compression: 1, load: undefined as (() => Promise<ArrayBuffer>) | undefined }));
vi.mock('pmtiles', async importOriginal => {
  const actual = await importOriginal<typeof import('pmtiles')>();
  return { ...actual, PMTiles: class {
    async getHeader() { return { tileType: actual.TileType.Webp, tileCompression: actual.Compression.None, internalCompression: state.compression }; }
    async getZxy() { const tile = state.load ? await state.load() : state.tile; return tile ? { data: tile } : undefined; }
  } };
});

import { readTile } from '../src/pmtiles';
afterEach(() => { state.load = undefined; });

describe('PMTiles tile admission', () => {
  it('drops a disconnected queued tile and preserves a shared tile read', async () => {
    state.compression = 1;
    let release!: () => void, started = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    state.load = async () => { started++; await gate; return Uint8Array.of(1).buffer; };
    const bucket = {} as R2Bucket;
    const owner = new AbortController(), queued = new AbortController();
    const first = readTile(bucket, 'archive', 4, 0, 0, undefined, owner.signal);
    const joined = readTile(bucket, 'archive', 4, 0, 0);
    const active = Array.from({ length: 7 }, (_, index) => readTile(bucket, 'archive', 4, index + 1, 0));
    const waiting = readTile(bucket, 'archive', 4, 8, 0, undefined, queued.signal);
    const ownerCanceled = expect(first).rejects.toThrow('Owner disconnected');
    const queuedCanceled = expect(waiting).rejects.toThrow('Waiter disconnected');
    try {
      await vi.waitFor(() => expect(started).toBe(8));
      owner.abort(new Error('Owner disconnected'));
      queued.abort(new Error('Waiter disconnected'));
      await Promise.all([ownerCanceled, queuedCanceled]);
    } finally { release(); }
    await expect(joined).resolves.toEqual(Uint8Array.of(1).buffer);
    await Promise.all(active);
    expect(started).toBe(8);
  });

  it.each([false, true])('drains three viewport bursts inside eight reads, including owner failure=%s', async fail => {
    state.compression = 1;
    let active = 0, peak = 0, started = 0, finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    state.load = async () => {
      const index = started++; active++; peak = Math.max(peak, active);
      try { await gate; if (fail && index === 5) throw new Error('tile unavailable'); return Uint8Array.of(index).buffer; }
      finally { active--; }
    };
    const bucket = {} as R2Bucket, pending = Promise.allSettled(Array.from({ length: 48 }, (_, index) => readTile(bucket, 'archive', 6, index, 0)));
    try { await vi.waitFor(() => expect(active).toBe(8)); }
    finally { finish(); }
    const outcomes = await pending;
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(fail ? 47 : 48);
    expect(started).toBe(48); expect(peak).toBe(8); expect(active).toBe(0);
    if (fail) await expect(readTile(bucket, 'archive', 6, 5, 0)).resolves.toBeInstanceOf(ArrayBuffer);
  });
  it('rejects a missing tile in an otherwise readable archive', async () => {
    state.tile = undefined; state.compression = 1;
    await expect(readTile({} as R2Bucket, 'archive', 0, 0, 0)).rejects.toThrow('Expected tile missing');
  });
  it('returns addressed WebP bytes and rejects unsupported compression', async () => {
    state.tile = Uint8Array.of(1, 2, 3).buffer; state.compression = 1;
    expect(new Uint8Array(await readTile({} as R2Bucket, 'archive', 0, 0, 0))).toEqual(Uint8Array.of(1, 2, 3));
    state.compression = 3;
    await expect(readTile({} as R2Bucket, 'archive', 0, 0, 0)).rejects.toThrow('Unsupported PMTiles archive');
  });
});

it('bounds archive reads, decompression and retained directory bytes', async () => {
  const { R2Source, DirectoryCache, decompress } = await import('../src/pmtiles');
  const { Compression } = await import('pmtiles');
  const { gzipSync } = await import('node:zlib');
  const get = vi.fn();
  await expect(new R2Source({ get } as unknown as R2Bucket, 'archive').getBytes(0, 1024 * 1024 + 1)).rejects.toThrow('oversized');
  expect(get).not.toHaveBeenCalled();
  const bomb = gzipSync(new Uint8Array(1024 * 1024 + 1));
  await expect(decompress(bomb.buffer.slice(bomb.byteOffset, bomb.byteOffset + bomb.byteLength), Compression.Gzip)).rejects.toThrow('byte budget');
  const cache = new DirectoryCache(1024, 4);
  cache.cache.set('old', { lastUsed: 1, data: new ArrayBuffer(700) });
  cache.cache.set('new', { lastUsed: 2, data: new ArrayBuffer(700) });
  cache.prune(); expect([...cache.cache.keys()]).toEqual(['new']);
  cache.cache.set('oversized', { lastUsed: 3, data: new ArrayBuffer(2000) });
  cache.prune(); expect(cache.cache.size).toBe(0);
});

it.each([4, 20])('keeps maximum-sized archive reads inside the shared pool with %s MiB already held', async heldMiB => {
  const { R2Source } = await import('../src/pmtiles');
  const { reserveAllocation, inFlightAllocationBytes } = await import('../src/resources');
  const size = 1024 * 1024, release = reserveAllocation(heldMiB * size);
  let finish!: () => void, active = 0, peak = 0, peakBytes = 0;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const get = vi.fn(async (_key: string, options: { range: { offset: number; length: number } }) => {
    active++; peak = Math.max(peak, active);
    let closed = false;
    const close = () => { if (!closed) { closed = true; active--; } };
    return { size: 24 * size, etag: 'archive-etag', body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        peakBytes = Math.max(peakBytes, inFlightAllocationBytes());
        await gate;
        controller.enqueue(new Uint8Array(size).fill(options.range.offset / size)); controller.close(); close();
      }, cancel: close
    }, { highWaterMark: 0 }) };
  });
  const source = new R2Source({ get } as unknown as R2Bucket, 'archive');
  const pending = Promise.allSettled(Array.from({ length: 24 }, (_, index) => source.getBytes(index * size, size)));
  let outcomes: Awaited<typeof pending>;
  try {
    try { await vi.waitFor(() => expect(inFlightAllocationBytes()).toBe((heldMiB === 4 ? 20 : 32) * size)); }
    finally { finish(); }
    outcomes = await pending;
    expect(peak).toBe(8); expect(active).toBe(0); expect(peakBytes).toBeLessThanOrEqual(32 * size);
    if (heldMiB === 4) expect(outcomes.every(result => result.status === 'fulfilled')).toBe(true);
    else expect(outcomes.some(result => result.status === 'rejected' && String(result.reason).includes('byte budget'))).toBe(true);
    expect(inFlightAllocationBytes()).toBe(heldMiB * size);
  } finally { release(); }
  const failed = outcomes!.findIndex(result => result.status === 'rejected');
  if (failed >= 0) expect((await source.getBytes(failed * size, size)).data.byteLength).toBe(size);
  expect(inFlightAllocationBytes()).toBe(0);
});

it('shares archive ranges without binding their lifetime to the initiating waiter', async () => {
  const { R2Source } = await import('../src/pmtiles');
  const { inFlightAllocationBytes } = await import('../src/resources');
  let started!: () => void, finish!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const get = vi.fn(async () => ({ size: 3, etag: 'archive-etag', httpMetadata: { cacheControl: 'max-age=60' }, body: new ReadableStream<Uint8Array>({ async pull(controller) {
    started(); await gate; controller.enqueue(Uint8Array.of(1, 2, 3)); controller.close();
  } }, { highWaterMark: 0 }) }));
  const bucket = { get } as unknown as R2Bucket, abort = new AbortController();
  const metrics = { r2Reads: 0, r2Bytes: 0, cacheHits: 0, coalesced: 0 };
  const owners: Promise<unknown>[] = [], ctx = { metrics, waitUntil(promise: Promise<unknown>) { owners.push(promise); } };
  const first = new R2Source(bucket, 'archive', ctx, abort.signal).getBytes(0, 3);
  const second = new R2Source(bucket, 'archive', ctx).getBytes(0, 3);
  const third = new R2Source(bucket, 'archive', ctx).getBytes(0, 3);
  const cancelled = expect(first).rejects.toThrow('initiating waiter cancelled');
  await reading;
  abort.abort(new Error('initiating waiter cancelled'));
  await cancelled;
  expect(get).toHaveBeenCalledTimes(1);
  expect(inFlightAllocationBytes()).toBe(6);
  finish();
  const [a, b] = await Promise.all([second, third]);
  await Promise.all(owners);
  expect(a.data).toBe(b.data);
  expect(a).toMatchObject({ etag: 'archive-etag', cacheControl: 'max-age=60' });
  expect(new Uint8Array(a.data)).toEqual(Uint8Array.of(1, 2, 3));
  expect(metrics).toMatchObject({ r2Reads: 1, r2Bytes: 3, coalesced: 2 });
  expect(inFlightAllocationBytes()).toBe(0);
});

it('keeps archive identities, ranges and conditional etags separate and retries failures', async () => {
  const { R2Source } = await import('../src/pmtiles');
  const get = vi.fn(async (_key: string, options: { range: { offset: number; length: number }; onlyIf?: { etagMatches: string } }) => ({
    size: 100, etag: options.onlyIf?.etagMatches,
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(options.range.length)); controller.close(); } })
  }));
  const bucket = { get } as unknown as R2Bucket;
  const source = new R2Source(bucket, 'archive');
  await Promise.all([
    source.getBytes(0, 3, undefined, 'one'), source.getBytes(0, 3, undefined, 'two'),
    source.getBytes(1, 3), source.getBytes(0, 4), new R2Source(bucket, 'other').getBytes(0, 3)
  ]);
  expect(get).toHaveBeenCalledTimes(5);
  expect(get).toHaveBeenCalledWith('archive', { range: { offset: 0, length: 3 }, onlyIf: { etagMatches: 'one' } });
  get.mockRejectedValueOnce(new Error('range unavailable'));
  await expect(source.getBytes(8, 3)).rejects.toThrow('range unavailable');
  expect((await source.getBytes(8, 3)).data.byteLength).toBe(3);
});

it('rejects conditional archive reads when R2 reports an etag mismatch', async () => {
  const { R2Source } = await import('../src/pmtiles');
  const { EtagMismatch } = await import('pmtiles');
  const source = new R2Source({ get: async () => ({ etag: 'new' }) } as unknown as R2Bucket, 'archive');
  await expect(source.getBytes(0, 3, undefined, 'old')).rejects.toBeInstanceOf(EtagMismatch);
});
