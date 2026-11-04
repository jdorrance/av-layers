import { CELL_BYTES, MAX_SAMPLE_VALUES, SAMPLE_BLOCK_SIZE, type Grid } from '@av/contracts';
import type { Cell, SamplePlan } from './sampler.js';

export interface SamplePackBlock {
  /** Core origin in global grid coordinates. */
  readonly row: number;
  readonly column: number;
  /** Stored dimensions include the right/bottom halo, clipped at nonwrapping grid edges. */
  readonly width: number;
  readonly height: number;
  /** Offset in packed cells; multiply by channelCount * CELL_BYTES for bytes. */
  readonly cellOffset: number;
}

/** Headerless row-major blocks, row-major cells, then channels in manifest order. */
export interface SamplePackLayout {
  readonly grid: Pick<Grid, 'width' | 'height' | 'wrapLongitude'>;
  readonly cellCount: number;
  readonly storedCells: number;
  readonly blockSize: number;
  readonly blockSlots: number;
  readonly blockCount: number;
  readonly indexBytes: number;
  block(slot: number): SamplePackBlock | null;
  blockFor(gridIndex: number): SamplePackBlock | null;
}

/** Build a small static offset index from output|halo. Every block includes its right/bottom neighbors. */
export function prepareSamplePackLayout(grid: Pick<Grid, 'width' | 'height' | 'wrapLongitude'>, output: Uint8Array, halo: Uint8Array, blockSize: number = SAMPLE_BLOCK_SIZE): SamplePackLayout {
  const { width, height, wrapLongitude } = grid, cellCount = width * height;
  if (![width, height, blockSize].every(n => Number.isSafeInteger(n) && n > 0) || !Number.isSafeInteger(cellCount) || cellCount >= 0xffffffff) throw new RangeError('Invalid pack grid or block size');
  const byteCount = Math.ceil(cellCount / 8);
  if (output.length !== byteCount || halo.length !== byteCount) throw new RangeError('Pack coverage size differs from grid');
  const columns = Math.ceil(width / blockSize), rows = Math.ceil(height / blockSize);
  const offsets = new Uint32Array(columns * rows).fill(0xffffffff);
  for (let index = 0; index < cellCount; index++) {
    const bits = output[index >> 3] | halo[index >> 3];
    if (!bits) { index |= 7; continue; }
    if (bits & (1 << (index & 7))) {
      offsets[Math.floor(Math.floor(index / width) / blockSize) * columns + Math.floor((index % width) / blockSize)] = 0;
    }
  }
  const dimensions = (slot: number) => {
    const row = Math.floor(slot / columns) * blockSize, column = (slot % columns) * blockSize;
    const baseWidth = Math.min(blockSize, width - column);
    return { row, column, width: wrapLongitude ? baseWidth + 1 : Math.min(baseWidth + 1, width - column), height: Math.min(blockSize + 1, height - row) };
  };
  let storedCells = 0, blockCount = 0;
  for (let slot = 0; slot < offsets.length; slot++) if (offsets[slot] !== 0xffffffff) {
    offsets[slot] = storedCells;
    const block = dimensions(slot);
    storedCells += block.width * block.height;
    if (storedCells >= 0xffffffff) throw new RangeError('Pack cell offsets exceed uint32');
    blockCount++;
  }
  const block = (slot: number): SamplePackBlock | null => {
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= offsets.length) throw new RangeError('Pack block index out of range');
    return offsets[slot] === 0xffffffff ? null : { ...dimensions(slot), cellOffset: offsets[slot] };
  };
  return {
    grid: { width, height, wrapLongitude }, cellCount, storedCells, blockSize, blockSlots: offsets.length, blockCount, indexBytes: offsets.byteLength, block,
    blockFor(index) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= cellCount) throw new RangeError('Pack cell index out of range');
      return block(Math.floor(Math.floor(index / width) / blockSize) * columns + Math.floor((index % width) / blockSize));
    }
  };
}

export interface PackedSamplePlan {
  readonly byteRange: { offset: number; length: number };
  readonly channelCount: number;
  readonly channels: readonly number[];
  readonly contributorRanks: readonly number[];
}

/** The caller checks output coverage; the FIRST contributor owns the block, including at longitude wrap. */
export function planPackedSample(layout: SamplePackLayout, sample: SamplePlan, channelCount: number, channels: readonly number[]): PackedSamplePlan {
  const stride = channelCount * CELL_BYTES;
  if (!Number.isSafeInteger(channelCount) || channelCount <= 0 || !Number.isSafeInteger(stride) || !Number.isSafeInteger(stride * layout.storedCells)) throw new RangeError('Invalid pack channel count');
  if (!channels.length || new Set(channels).size !== channels.length || channels.some(channel => !Number.isSafeInteger(channel) || channel < 0 || channel >= channelCount)) throw new RangeError('Invalid selected pack channels');
  if (!sample.contributors.length) throw new RangeError('Sample has no contributors');
  const owner = layout.blockFor(sample.contributors[0].index);
  if (!owner) throw new RangeError('Sample owner block is outside pack coverage');
  const contributorRanks = sample.contributors.map(contributor => {
    const row = contributor.row - owner.row;
    const column = layout.grid.wrapLongitude ? (contributor.column - owner.column + layout.grid.width) % layout.grid.width : contributor.column - owner.column;
    if (row < 0 || row >= owner.height || column < 0 || column >= owner.width) throw new RangeError('Sample contributor is outside its owner block');
    return owner.cellOffset + row * owner.width + column;
  });
  const first = Math.min(...contributorRanks), last = Math.max(...contributorRanks);
  const firstChannel = Math.min(...channels), lastChannel = Math.max(...channels);
  return {
    byteRange: { offset: first * stride + firstChannel * CELL_BYTES, length: (last - first) * stride + (lastChannel - firstChannel + 1) * CELL_BYTES },
    channelCount, channels: [...channels], contributorRanks
  };
}

/** Decode one channel in the original contributor order; repeated wrap contributors remain repeated. */
export function packedCellsFromRange(plan: PackedSamplePlan, bytes: Uint8Array, channel: number): Cell[] {
  if (!plan.channels.includes(channel)) throw new RangeError('Channel was not requested by pack plan');
  if (bytes.byteLength !== plan.byteRange.length) throw new RangeError('Unexpected packed range byte count');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return plan.contributorRanks.map(rank => {
    const offset = (rank * plan.channelCount + channel) * CELL_BYTES - plan.byteRange.offset;
    if (offset < 0 || offset + CELL_BYTES > bytes.byteLength) throw new RangeError('Cell outside packed range');
    return { value: view.getFloat32(offset, true), flags: view.getUint8(offset + 4) };
  });
}

export const SAMPLE_SHARD_TARGET_BYTES = 64 * 1024 * 1024;

export interface ShardedSampleBlock {
  readonly slot: number;
  readonly row: number;
  readonly column: number;
  readonly width: number;
  readonly height: number;
  readonly shard: number;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface SampleShard {
  readonly firstBlock: number;
  readonly blockCount: number;
  readonly byteLength: number;
}

export interface ShardedSamplePackLayout {
  readonly grid: Pick<Grid, 'width' | 'height' | 'wrapLongitude'>;
  readonly channelCount: number;
  readonly blockCount: number;
  readonly storedCells: number;
  readonly byteLength: number;
  readonly indexBytes: number;
  readonly shards: readonly SampleShard[];
  block(ordinal: number): ShardedSampleBlock;
  blockFor(gridIndex: number): ShardedSampleBlock | null;
}

export function prepareShardedSamplePackLayout(
  grid: Pick<Grid, 'width' | 'height' | 'wrapLongitude'>,
  activeBlocks: Uint32Array,
  channelCount: number,
  shardTargetBytes = SAMPLE_SHARD_TARGET_BYTES
): ShardedSamplePackLayout {
  const { width, height, wrapLongitude } = grid, cellCount = width * height;
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 0x7fffffff)
      || !Number.isSafeInteger(cellCount) || cellCount >= 0xffffffff || typeof wrapLongitude !== 'boolean') throw new RangeError('Invalid pack grid');
  if (!Number.isSafeInteger(channelCount) || channelCount < 1 || channelCount > MAX_SAMPLE_VALUES) throw new RangeError('Invalid pack channel count');
  if (!Number.isSafeInteger(shardTargetBytes) || shardTargetBytes < 1 || shardTargetBytes > SAMPLE_SHARD_TARGET_BYTES) throw new RangeError('Invalid shard target');
  if (!(activeBlocks instanceof Uint32Array)) throw new RangeError('Invalid active blocks');
  const columns = Math.ceil(width / SAMPLE_BLOCK_SIZE), blockSlots = columns * Math.ceil(height / SAMPLE_BLOCK_SIZE);
  const slots = activeBlocks.slice(), offsets = new Uint32Array(slots.length);
  const stride = channelCount * CELL_BYTES;
  const dimensions = (slot: number) => {
    const row = Math.floor(slot / columns) * SAMPLE_BLOCK_SIZE, column = (slot % columns) * SAMPLE_BLOCK_SIZE;
    const coreWidth = Math.min(SAMPLE_BLOCK_SIZE, width - column);
    return { row, column, width: wrapLongitude ? coreWidth + 1 : Math.min(coreWidth + 1, width - column), height: Math.min(SAMPLE_BLOCK_SIZE + 1, height - row) };
  };
  const shards: SampleShard[] = [];
  let storedCells = 0, byteLength = 0, shardLength = 0, firstBlock = 0;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot >= blockSlots || (i > 0 && slot <= slots[i - 1])) throw new RangeError('Invalid active block order');
    const block = dimensions(slot), cells = block.width * block.height, bytes = cells * stride;
    if (bytes > shardTargetBytes) throw new RangeError('Block exceeds shard target');
    if (shardLength && shardLength + bytes > shardTargetBytes) {
      shards.push({ firstBlock, blockCount: i - firstBlock, byteLength: shardLength });
      firstBlock = i; shardLength = 0;
    }
    offsets[i] = shardLength;
    shardLength += bytes; storedCells += cells; byteLength += bytes;
    if (!Number.isSafeInteger(storedCells) || !Number.isSafeInteger(byteLength)) throw new RangeError('Pack offsets exceed safe integers');
  }
  if (shardLength) shards.push({ firstBlock, blockCount: slots.length - firstBlock, byteLength: shardLength });
  const block = (ordinal: number): ShardedSampleBlock => {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= slots.length) throw new RangeError('Pack block index out of range');
    const slot = slots[ordinal], dims = dimensions(slot);
    let lo = 0, hi = shards.length;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (shards[mid].firstBlock <= ordinal) lo = mid + 1; else hi = mid; }
    return { slot, ...dims, shard: lo - 1, byteOffset: offsets[ordinal], byteLength: dims.width * dims.height * stride };
  };
  return {
    grid: { width, height, wrapLongitude }, channelCount, blockCount: slots.length, storedCells, byteLength,
    indexBytes: slots.byteLength + offsets.byteLength, shards, block,
    blockFor(index) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= cellCount) throw new RangeError('Pack cell index out of range');
      const slot = Math.floor(Math.floor(index / width) / SAMPLE_BLOCK_SIZE) * columns + Math.floor((index % width) / SAMPLE_BLOCK_SIZE);
      let lo = 0, hi = slots.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (slots[mid] < slot) lo = mid + 1; else hi = mid;
      }
      return lo < slots.length && slots[lo] === slot ? block(lo) : null;
    }
  };
}

export interface ShardedPackedSamplePlan extends PackedSamplePlan {
  readonly shard: number;
}

export function planShardedPackedSample(layout: ShardedSamplePackLayout, sample: SamplePlan, channels: readonly number[]): ShardedPackedSamplePlan {
  const { width, height, wrapLongitude } = layout.grid, channelCount = layout.channelCount;
  if (!channels.length || new Set(channels).size !== channels.length || channels.some(channel => !Number.isSafeInteger(channel) || channel < 0 || channel >= channelCount)) throw new RangeError('Invalid selected pack channels');
  if (!sample.contributors.length || sample.contributors.length > 4) throw new RangeError('Invalid sample contributor count');
  const firstContributor = sample.contributors[0];
  for (const c of sample.contributors) {
    if (!Number.isSafeInteger(c.row) || c.row < 0 || c.row >= height || !Number.isSafeInteger(c.column) || c.column < 0 || c.column >= width
        || c.index !== c.row * width + c.column || !Number.isFinite(c.weight) || c.weight <= 0) throw new RangeError('Invalid sample contributor');
    const dx = wrapLongitude ? (c.column - firstContributor.column + width) % width : c.column - firstContributor.column;
    if (c.row - firstContributor.row < 0 || c.row - firstContributor.row > 1 || dx < 0 || dx > 1) throw new RangeError('Invalid sample neighborhood');
  }
  const owner = layout.blockFor(sample.contributors[0].index);
  if (!owner) throw new RangeError('Sample owner block is outside pack coverage');
  const stride = channelCount * CELL_BYTES;
  const contributorRanks = sample.contributors.map(c => {
    const row = c.row - owner.row, column = wrapLongitude ? (c.column - owner.column + width) % width : c.column - owner.column;
    if (row < 0 || row >= owner.height || column < 0 || column >= owner.width) throw new RangeError('Sample contributor is outside its owner block');
    return owner.byteOffset / stride + row * owner.width + column;
  });
  const first = Math.min(...contributorRanks), last = Math.max(...contributorRanks);
  const firstChannel = Math.min(...channels), lastChannel = Math.max(...channels);
  return {
    shard: owner.shard,
    byteRange: { offset: first * stride + firstChannel * CELL_BYTES, length: (last - first) * stride + (lastChannel - firstChannel + 1) * CELL_BYTES },
    channelCount, channels: [...channels], contributorRanks
  };
}
