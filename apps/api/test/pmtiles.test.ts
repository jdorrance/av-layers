import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ tile: undefined as ArrayBuffer | undefined, compression: 1 }));
vi.mock('pmtiles', async importOriginal => {
  const actual = await importOriginal<typeof import('pmtiles')>();
  return { ...actual, PMTiles: class {
    async getHeader() { return { tileType: actual.TileType.Png, tileCompression: actual.Compression.None, internalCompression: state.compression }; }
    async getZxy() { return state.tile ? { data: state.tile } : undefined; }
  } };
});

import { readTile } from '../src/pmtiles';

describe('PMTiles tile admission', () => {
  it('rejects a missing tile in an otherwise readable archive', async () => {
    state.tile = undefined; state.compression = 1;
    await expect(readTile({} as R2Bucket, 'archive', 0, 0, 0)).rejects.toThrow('Expected tile missing');
  });
  it('returns addressed PNG bytes and rejects unsupported compression', async () => {
    state.tile = Uint8Array.of(1, 2, 3).buffer; state.compression = 1;
    expect(new Uint8Array(await readTile({} as R2Bucket, 'archive', 0, 0, 0))).toEqual(Uint8Array.of(1, 2, 3));
    state.compression = 3;
    await expect(readTile({} as R2Bucket, 'archive', 0, 0, 0)).rejects.toThrow('Unsupported PMTiles archive');
  });
});
