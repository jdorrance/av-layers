import { Crc32cJs } from '@aws-sdk/checksums/crc';
import { Array as ZarrArray, type ArrayMetadata, type Readable } from 'zarrita';
import schema from '../../../../packages/contracts/schemas/wrf-zarr-v3.schema.json' with { type: 'json' };
import { decodingMetadata } from './codec.js';

const [CHUNK_HEIGHT, CHUNK_WIDTH] = schema.innerSpatialChunk;
const CHUNK_CELLS = CHUNK_HEIGHT * CHUNK_WIDTH;
async function validateIndex(bytes: Uint8Array, chunks: number): Promise<number> {
  const indexStart = bytes.byteLength - chunks * 16 - 4;
  if (indexStart < 0) throw new Error('Truncated WRF Zarr shard index');
  const index = new DataView(bytes.buffer, bytes.byteOffset + indexStart, chunks * 16 + 4);
  const crc = new Crc32cJs();
  crc.update(bytes.subarray(indexStart, -4));
  const checksum = await crc.digest();
  if (new DataView(checksum.buffer, checksum.byteOffset, 4).getUint32(0) !== index.getUint32(chunks * 16, true)) throw new Error('WRF Zarr shard index CRC32C mismatch');
  let cursor = 0n;
  for (let chunk = 0; chunk < chunks; chunk++) {
    const offset = index.getBigUint64(chunk * 16, true), length = index.getBigUint64(chunk * 16 + 8, true);
    // av-wrf writes every spatial chunk contiguously, including padded edge chunks.
    if (offset !== cursor || length === 0n || offset + length > BigInt(indexStart)) throw new Error('Invalid WRF Zarr shard chunk range');
    cursor += length;
  }
  if (cursor !== BigInt(indexStart)) throw new Error('Unaccounted WRF Zarr shard bytes');
  return indexStart;
}

/** Decode one admitted WRF shard into caller-owned sparse SI arrays, one spatial chunk at a time. */
export async function decodeShard(bytes: Uint8Array, metadata: ArrayMetadata<'float32'>, timeIndex: number,
  active: Uint32Array, targets: readonly { values: Float32Array; missing: Uint8Array }[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const grid = { width: metadata.shape.at(-1)!, height: metadata.shape.at(-2)! }, levels = metadata.shape.length === 4 ? metadata.shape[1]! : 1;
  const columns = Math.ceil(grid.width / CHUNK_WIDTH), rows = Math.ceil(grid.height / CHUNK_HEIGHT), chunks = columns * rows;
  if (!Number.isSafeInteger(grid.width) || grid.width < 1 || !Number.isSafeInteger(grid.height) || grid.height < 1 || chunks > 256
    || !Number.isInteger(levels) || levels < 1 || levels > schema.maxVerticalLevels) throw new Error('Unsupported WRF Zarr shard dimensions');
  if (targets.length !== levels || targets.some(target => target.values.length !== active.length || target.missing.length !== active.length)) {
    throw new Error('WRF Zarr target dimensions mismatch');
  }
  const indexStart = await validateIndex(bytes, chunks);
  signal?.throwIfAborted();
  const store: Readable = {
    get() { throw new Error('WRF shard requires bounded ranges'); },
    getRange(_key, range) {
      signal?.throwIfAborted();
      const offset = 'suffixLength' in range ? bytes.length - range.suffixLength : range.offset;
      const length = 'suffixLength' in range ? range.suffixLength : range.length;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1
          || offset + length > ('suffixLength' in range ? bytes.length : indexStart)) throw new Error('Invalid WRF Zarr chunk range');
      // Uint8Array.slice copies unaligned index views; Buffer.slice would retain their offsets.
      return new Uint8Array(bytes.buffer, bytes.byteOffset + offset, length);
    }
  };
  const array = new ZarrArray(store, '/', decodingMetadata(metadata));
  const heads = new Int32Array(chunks).fill(-1), next = new Int32Array(active.length);
  for (let slot = 0; slot < active.length; slot++) {
    const cell = active[slot];
    if (cell >= grid.width * grid.height) throw new Error('WRF Zarr active index outside grid');
    const chunk = Math.floor(Math.floor(cell / grid.width) / CHUNK_HEIGHT) * columns + Math.floor((cell % grid.width) / CHUNK_WIDTH);
    next[slot] = heads[chunk]; heads[chunk] = slot;
  }
  for (let chunk = 0; chunk < chunks; chunk++) {
    if (heads[chunk] < 0) continue;
    signal?.throwIfAborted();
    const spatial = [Math.floor(chunk / columns), chunk % columns];
    const coordinates = metadata.shape.length === 2 ? spatial : metadata.shape.length === 3 ? [timeIndex, ...spatial] : [timeIndex, 0, ...spatial];
    const { data } = await array.getChunk(coordinates);
    signal?.throwIfAborted();
    for (let slot = heads[chunk]; slot >= 0; slot = next[slot]) {
      const cell = active[slot], inner = (Math.floor(cell / grid.width) % CHUNK_HEIGHT) * CHUNK_WIDTH + (cell % grid.width) % CHUNK_WIDTH;
      for (let level = 0; level < levels; level++) {
        const value = data[level * CHUNK_CELLS + inner], target = targets[level];
        target.values[slot] = value; target.missing[slot] = Number(!Number.isFinite(value));
      }
    }
  }
}
