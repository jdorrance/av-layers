import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CELL_BYTES } from '@av/contracts';
import type { SamplePackBlock, SamplePackLayout } from '@av/forecast';

function copyBlockChannel(
  source: Uint8Array,
  packed: Uint8Array,
  block: SamplePackBlock,
  cellOffset: number,
  channel: number,
  stride: number,
  width: number,
  wrapLongitude: boolean
): void {
  const total = block.width * block.height;
  for (let i = 0; i < total; i++) {
    const x = i % block.width, y = (i - x) / block.width;
    const column = wrapLongitude ? (block.column + x) % width : block.column + x;
    const from = ((block.row + y) * width + column) * CELL_BYTES;
    const to = (cellOffset + i) * stride + channel * CELL_BYTES;
    packed.set(source.subarray(from, from + CELL_BYTES), to);
  }
}

/** Transpose flat channels into cell-major spatial blocks in caller channel order. */
export async function writeSamplePack(
  output: string,
  inputs: readonly (string | Uint8Array)[],
  layout: SamplePackLayout,
  bufferBytes = 8 * 1024 * 1024
): Promise<{ sha256: string; bytes: number; bufferBytes: number }> {
  if (!inputs.length) throw new RangeError('Pack requires at least one channel');
  const stringInputs = inputs.filter((item): item is string => typeof item === 'string');
  if (new Set(stringInputs).size !== stringInputs.length) throw new RangeError('Pack channels must have distinct input files');
  const stride = inputs.length * CELL_BYTES, totalBytes = layout.storedCells * stride;
  if (!Number.isSafeInteger(totalBytes)) throw new RangeError('Pack size exceeds safe offsets');
  const { width, height, wrapLongitude } = layout.grid;
  const stripeRows = Math.min(layout.blockSize + 1, height), sourceBytes = stripeRows * width * CELL_BYTES;
  const maxBlockCells = (wrapLongitude ? Math.min(layout.blockSize, width) + 1 : Math.min(layout.blockSize + 1, width)) * stripeRows;
  if (!Number.isSafeInteger(bufferBytes) || bufferBytes < sourceBytes + maxBlockCells * stride) {
    throw new RangeError('Pack buffer budget cannot hold one source stripe and block');
  }
  const blockColumns = Math.ceil(width / layout.blockSize);
  const batchSize = Math.min(blockColumns, Math.floor((bufferBytes - sourceBytes) / (maxBlockCells * stride)));
  const expectedChannelBytes = layout.cellCount * CELL_BYTES;
  const channels = await Promise.all(inputs.map(async item => {
    const bytes = typeof item === 'string' ? await readFile(item) : item;
    if (bytes.byteLength !== expectedChannelBytes) throw new Error(`Invalid flat sample size: ${typeof item === 'string' ? item : 'channel'}`);
    return bytes;
  }));
  const packed = Buffer.alloc(totalBytes);
  for (let slot = 0; slot < layout.blockSlots; slot++) {
    const block = layout.block(slot);
    if (!block) continue;
    for (let channel = 0; channel < channels.length; channel++) {
      copyBlockChannel(channels[channel], packed, block, block.cellOffset, channel, stride, width, wrapLongitude);
    }
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, packed, { flag: 'wx' });
  return {
    sha256: createHash('sha256').update(packed).digest('hex'),
    bytes: packed.byteLength,
    bufferBytes: sourceBytes + batchSize * maxBlockCells * stride
  };
}
