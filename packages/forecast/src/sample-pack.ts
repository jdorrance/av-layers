import { CELL_BYTES, SAMPLE_BLOCK_SIZE, type Grid } from '@av/contracts';
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
