import { zstdCompressSync } from 'node:zlib';
import { expect, it } from 'vitest';
import type { ArrayMetadata } from 'zarrita';
import { decodeShard as decode } from './shard.js';
import template from '../../../../scripts/fixtures/wrf-zarr/forecast.zarr/temp_k/zarr.json' with { type: 'json' };

// av-wrf's encode_3d_shard_bytes (numcodecs Zstd level 3), 2 × 65 × 67 with padded 64 × 64 chunks.
// Each level is 100*(k+1) + 10*floor(y/64) + floor(x/64), with two marked interior cells.
const producerShard = Buffer.from('KLUv/WAAf+UAAHgAAMhCcEJEAABIQwAASMEDAO4fcLDievs/74gotS/9YAB/9QcAUAAAykLAf0lDwH+B/KjxC2PxC5sBEiAYCAZE+P//+wFtv+23/bbf9tv+bb/tt/223/bb/m2/7bf9tt/22/1tv+23/bbf9m/7bb/tt/223/Zv+22/7bf9tt/2b/ttv+23/bbf7m/7bb/tt/22f9tv+22/7bf9tn/bb/ttv+23/bZ/22/7bb/tt/12Qt/2q021gfbfNtvnNkjbb/ttv+1v+21/22/7bb/tb/vbfttv+22/7W/7237bb/ttv91v+9t+22/7bX/bb/vbfttv+21/29/2237bb/ttf9vf9tt+22/77X7b3/bbfttv+9t+29/2237bb8v/l76xg3pTrQIotS/9YAB/3QAAQAAA3ELAf1JDBAD7fgBgPNgDCu97wOP9lCMCKLUv/WAAf80AAEAAAN5CwH9TQwQA738AYBwAGL9/wPGwIwIAAAAAAAAAACYAAAAAAAAAJgAAAAAAAAAIAQAAAAAAAC4BAAAAAAAAJQAAAAAAAABTAQAAAAAAACMAAAAAAAAA15n2yg==', 'base64');
const grid = { width: 67, height: 65 };
const target = (cells: number, levels = 2) => Array.from({ length: levels }, () => ({ values: new Float32Array(cells), missing: new Uint8Array(cells).fill(1) }));

function decodeShard(bytes: Uint8Array, grid: { width: number; height: number }, levels: number,
  active: Uint32Array, targets: ReturnType<typeof target>, signal?: AbortSignal) {
  const metadata = { ...template, shape: [1, levels, grid.height, grid.width],
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [1, levels, Math.ceil(grid.height / 64) * 64, Math.ceil(grid.width / 64) * 64] } },
    codecs: [{ ...template.codecs[0], configuration: { ...template.codecs[0].configuration, chunk_shape: [1, levels, 64, 64] } }]
  } as unknown as ArrayMetadata<'float32'>;
  return decode(bytes, metadata, 0, active, targets, signal);
}

function checksum(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function replaceIndex(mutate: (index: Buffer) => void): Buffer {
  const bytes = Buffer.from(producerShard), start = bytes.length - 68, index = bytes.subarray(start, -4);
  mutate(index); bytes.writeUInt32LE(checksum(index), bytes.length - 4);
  return bytes;
}

function oneChunk(raw: Buffer): Buffer {
  const compressed = zstdCompressSync(raw), index = Buffer.alloc(20);
  index.writeBigUInt64LE(BigInt(compressed.length), 8); index.writeUInt32LE(checksum(index.subarray(0, 16)), 16);
  return Buffer.concat([compressed, index]);
}

it('decodes producer bytes across padded edges and model levels into permuted sparse targets', async () => {
  const active = Uint32Array.of(64 * 67 + 66, 63 * 67 + 63, 1, 0, 64, 64 * 67), output = target(active.length);
  await decodeShard(producerShard, grid, 2, active, output);
  expect([...output[0].values]).toEqual([111, 777.75, 100, 100, 101, 110]);
  expect([...output[1].values]).toEqual([211, 200, -12.5, 200, 201, 210]);
  expect(output.map(level => [...level.missing])).toEqual([Array(6).fill(0), Array(6).fill(0)]);
});

it('only decompresses chunks containing requested cells and respects byte-view offsets', async () => {
  const bytes = Buffer.concat([Buffer.alloc(7), producerShard, Buffer.alloc(7)]).subarray(7, -7);
  // A malformed payload in an unused chunk proves sparse requests do not inflate it.
  bytes[38] ^= 255;
  const output = target(1);
  await decodeShard(bytes, grid, 2, Uint32Array.of(0), output);
  expect(output.map(level => level.values[0])).toEqual([100, 200]);
});

it('marks nonfinite values missing and overwrites reusable masks', async () => {
  const raw = Buffer.alloc(64 * 64 * 4);
  raw.writeFloatLE(NaN, 0); raw.writeFloatLE(Infinity, 4); raw.writeFloatLE(-12.5, 8);
  const output = target(3, 1);
  await decodeShard(oneChunk(raw), { width: 3, height: 1 }, 1, Uint32Array.of(2, 0, 1), output);
  expect([...output[0].missing]).toEqual([0, 1, 1]);
  expect(output[0].values[0]).toBe(-12.5);
});

it('rejects truncated or corrupt indexes before decoding', async () => {
  const active = Uint32Array.of(0), output = target(1), corrupt = Buffer.from(producerShard);
  corrupt[corrupt.length - 1] ^= 1;
  await expect(decodeShard(corrupt, grid, 2, active, output)).rejects.toThrow('CRC32C');
  await expect(decodeShard(producerShard.subarray(0, 60), grid, 2, active, output)).rejects.toThrow('Truncated');
});

it.each([
  ['empty sentinel', (index: Buffer) => index.writeBigUInt64LE(0xffffffffffffffffn, 0)],
  ['empty length', (index: Buffer) => index.writeBigUInt64LE(0n, 8)],
  ['overlap', (index: Buffer) => index.writeBigUInt64LE(0n, 16)],
  ['out of bounds', (index: Buffer) => index.writeBigUInt64LE(0xffffffffffffffffn, 8)],
  ['unaccounted body', (index: Buffer) => index.writeBigUInt64LE(index.readBigUInt64LE(56) - 1n, 56)]
] as const)('rejects %s with an otherwise valid index checksum', async (_name, mutate) => {
  await expect(decodeShard(replaceIndex(mutate), grid, 2, Uint32Array.of(0), target(1))).rejects.toThrow(/chunk range|Unaccounted/);
});

it('bounds decompression and rejects short chunks', async () => {
  const active = Uint32Array.of(0), output = target(1, 1), single = { width: 1, height: 1 };
  await expect(decodeShard(oneChunk(Buffer.alloc(64 * 64 * 4 + 1)), single, 1, active, output)).rejects.toThrow();
  await expect(decodeShard(oneChunk(Buffer.alloc(8)), single, 1, active, output)).rejects.toMatchObject({
    cause: expect.objectContaining({ message: expect.stringContaining('chunk size') })
  });
});

it('rejects unsupported dimensions, targets, and active cells and obeys cancellation', async () => {
  const active = Uint32Array.of(0), output = target(1);
  await expect(decodeShard(producerShard, { width: 1025, height: 1025 }, 2, active, output)).rejects.toThrow('dimensions');
  await expect(decodeShard(producerShard, grid, 41, active, output)).rejects.toThrow('dimensions');
  await expect(decodeShard(producerShard, grid, 2, active, target(2))).rejects.toThrow('target dimensions');
  await expect(decodeShard(producerShard, grid, 2, Uint32Array.of(grid.width * grid.height), output)).rejects.toThrow('outside grid');
  await expect(decodeShard(producerShard, grid, 2, active, output, AbortSignal.abort())).rejects.toThrow();
});
