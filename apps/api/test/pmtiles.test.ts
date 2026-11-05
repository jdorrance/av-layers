import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ tile: undefined as ArrayBuffer | undefined, compression: 1 }));
vi.mock('pmtiles', async importOriginal => {
  const actual = await importOriginal<typeof import('pmtiles')>();
  return { ...actual, PMTiles: class {
    async getHeader() { return { tileType: actual.TileType.Webp, tileCompression: actual.Compression.None, internalCompression: state.compression }; }
    async getZxy() { return state.tile ? { data: state.tile } : undefined; }
  } };
});

import { readTile } from '../src/pmtiles';

describe('PMTiles tile admission', () => {
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
