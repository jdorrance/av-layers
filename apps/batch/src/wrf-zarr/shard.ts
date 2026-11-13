import { constants, zstdDecompressSync } from 'node:zlib';
import schema from '../../../../packages/contracts/schemas/wrf-zarr-v3.schema.json' with { type: 'json' };

const [CHUNK_HEIGHT, CHUNK_WIDTH] = schema.innerSpatialChunk;
const CHUNK_CELLS = CHUNK_HEIGHT * CHUNK_WIDTH;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0x82f63b78 : 0);
  return value >>> 0;
});

function shardIndex(bytes: Uint8Array, chunks: number): DataView {
  const indexStart = bytes.byteLength - chunks * 16 - 4;
  if (indexStart < 0) throw new Error('Truncated WRF Zarr shard index');
  const index = new DataView(bytes.buffer, bytes.byteOffset + indexStart, chunks * 16 + 4);
  let crc = 0xffffffff;
  for (let i = 0; i < chunks * 16; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ index.getUint8(i)) & 255];
  if (((crc ^ 0xffffffff) >>> 0) !== index.getUint32(chunks * 16, true)) throw new Error('WRF Zarr shard index CRC32C mismatch');
  let cursor = 0n;
  for (let chunk = 0; chunk < chunks; chunk++) {
    const offset = index.getBigUint64(chunk * 16, true), length = index.getBigUint64(chunk * 16 + 8, true);
    // av-wrf writes every spatial chunk contiguously, including padded edge chunks.
    if (offset !== cursor || length === 0n || offset + length > BigInt(indexStart)) throw new Error('Invalid WRF Zarr shard chunk range');
    cursor += length;
  }
  if (cursor !== BigInt(indexStart)) throw new Error('Unaccounted WRF Zarr shard bytes');
  return index;
}

/** Decode one admitted WRF shard into caller-owned sparse SI arrays, one spatial chunk at a time. */
export function decodeShard(bytes: Uint8Array, grid: { width: number; height: number }, levels: number,
  active: Uint32Array, targets: readonly { values: Float32Array; missing: Uint8Array }[], signal?: AbortSignal): void {
  signal?.throwIfAborted();
  const columns = Math.ceil(grid.width / CHUNK_WIDTH), rows = Math.ceil(grid.height / CHUNK_HEIGHT), chunks = columns * rows;
  if (!Number.isSafeInteger(grid.width) || grid.width < 1 || !Number.isSafeInteger(grid.height) || grid.height < 1 || chunks > 256
    || !Number.isInteger(levels) || levels < 1 || levels > schema.maxVerticalLevels) throw new Error('Unsupported WRF Zarr shard dimensions');
  if (targets.length !== levels || targets.some(target => target.values.length !== active.length || target.missing.length !== active.length)) {
    throw new Error('WRF Zarr target dimensions mismatch');
  }
  const index = shardIndex(bytes, chunks);
  const heads = new Int32Array(chunks).fill(-1), next = new Int32Array(active.length);
  for (let slot = 0; slot < active.length; slot++) {
    const cell = active[slot];
    if (cell >= grid.width * grid.height) throw new Error('WRF Zarr active index outside grid');
    const chunk = Math.floor(Math.floor(cell / grid.width) / CHUNK_HEIGHT) * columns + Math.floor((cell % grid.width) / CHUNK_WIDTH);
    next[slot] = heads[chunk]; heads[chunk] = slot;
  }
  const chunkBytes = levels * CHUNK_CELLS * 4;
  for (let chunk = 0; chunk < chunks; chunk++) {
    if (heads[chunk] < 0) continue;
    signal?.throwIfAborted();
    const offset = Number(index.getBigUint64(chunk * 16, true)), length = Number(index.getBigUint64(chunk * 16 + 8, true));
    const raw = zstdDecompressSync(bytes.subarray(offset, offset + length), {
      maxOutputLength: chunkBytes, params: { [constants.ZSTD_d_windowLogMax]: Math.ceil(Math.log2(chunkBytes)) }
    });
    if (raw.byteLength !== chunkBytes) throw new Error('WRF Zarr decompressed chunk size mismatch');
    for (let slot = heads[chunk]; slot >= 0; slot = next[slot]) {
      const cell = active[slot], inner = (Math.floor(cell / grid.width) % CHUNK_HEIGHT) * CHUNK_WIDTH + (cell % grid.width) % CHUNK_WIDTH;
      for (let level = 0; level < levels; level++) {
        const value = raw.readFloatLE((level * CHUNK_CELLS + inner) * 4), target = targets[level];
        target.values[slot] = value; target.missing[slot] = Number(!Number.isFinite(value));
      }
    }
  }
}
