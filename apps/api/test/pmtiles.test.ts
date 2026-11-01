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
