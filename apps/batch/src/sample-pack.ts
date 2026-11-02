import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CELL_BYTES, MAX_SAMPLE_VALUES } from '@av/contracts';
import type { GridField, SamplePackLayout } from '@av/forecast';
import { BUILD_BUDGETS } from './capacity.js';
import { readLocalFile } from './local-file.js';

function packByteLength(layout: SamplePackLayout, channelCount: number, maxBytes: number): number {
  if (!Number.isSafeInteger(channelCount) || channelCount < 1 || channelCount > MAX_SAMPLE_VALUES) throw new RangeError('Invalid pack channel count');
  const totalBytes = layout.storedCells * channelCount * CELL_BYTES;
  if (!Number.isSafeInteger(layout.storedCells) || layout.storedCells < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) throw new RangeError('Sample pack exceeds byte budget');
  return totalBytes;
}

/** Incrementally write channels into one admitted final pack. No full-grid channel copies are retained. */
export function createSamplePackBuilder(layout: SamplePackLayout, channelCount: number, maxBytes = BUILD_BUDGETS.samplePackBytes) {
  const stride = channelCount * CELL_BYTES, totalBytes = packByteLength(layout, channelCount, maxBytes);
  let packed: Buffer | undefined = Buffer.alloc(totalBytes);
  const written = new Uint8Array(channelCount);
  let completed = 0;
  return {
    byteLength: totalBytes,
    writeChannel(channel: number, field: GridField): void {
      if (!packed) throw new Error('Sample pack builder is closed');
      if (!Number.isSafeInteger(channel) || channel < 0 || channel >= channelCount) throw new RangeError('Invalid pack channel index');
      if (written[channel]) throw new Error(`Pack channel ${channel} was already written`);
      if (!(field.values instanceof Float32Array) || !(field.flags instanceof Uint8Array) || field.values.length !== layout.cellCount || field.flags.length !== layout.cellCount) throw new RangeError('Invalid sample field shape');
      const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
      for (let slot = 0; slot < layout.blockSlots; slot++) {
        const block = layout.block(slot);
        if (!block) continue;
        for (let i = 0; i < block.width * block.height; i++) {
          const x = i % block.width, y = (i - x) / block.width;
          const column = layout.grid.wrapLongitude ? (block.column + x) % layout.grid.width : block.column + x;
          const index = (block.row + y) * layout.grid.width + column;
          const offset = (block.cellOffset + i) * stride + channel * CELL_BYTES;
          view.setFloat32(offset, field.values[index], true);
          view.setUint8(offset + 4, field.flags[index]);
        }
      }
      written[channel] = 1;
      completed++;
    },
    async finish(output: string): Promise<{ sha256: string; bytes: number }> {
      if (!packed) throw new Error('Sample pack builder is closed');
      if (completed !== channelCount) throw new Error(`Incomplete sample pack: ${completed}/${channelCount} channels`);
      const bytes = packed;
      packed = undefined;
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, bytes, { flag: 'wx' });
      return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength };
    },
    close(): void { packed = undefined; }
  };
}

/** Merge ordered channel groups without decoding values; only the final pack and one input are retained. */
export async function mergeSamplePacks(
  layout: SamplePackLayout,
  inputs: readonly { path: string; channelCount: number; sha256: string }[],
  output: string,
  maxBytes = BUILD_BUDGETS.samplePackBytes,
  signal?: AbortSignal
): Promise<{ sha256: string; bytes: number }> {
  signal?.throwIfAborted();
  if (!inputs.length || inputs.length > MAX_SAMPLE_VALUES) throw new RangeError('Invalid pack channel count');
  let channelCount = 0;
  for (const input of inputs) {
    packByteLength(layout, input.channelCount, maxBytes);
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error('Invalid sample pack hash');
    channelCount += input.channelCount;
  }
  const totalBytes = packByteLength(layout, channelCount, maxBytes), stride = channelCount * CELL_BYTES;
  if (!totalBytes) throw new RangeError('Cannot merge empty sample packs');
  const packed = Buffer.alloc(totalBytes);
  let channelOffset = 0;
  for (const input of inputs) {
    signal?.throwIfAborted();
    const inputStride = input.channelCount * CELL_BYTES;
    const bytes = await readLocalFile(input.path, maxBytes, layout.storedCells * inputStride);
    signal?.throwIfAborted();
    if (createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw new Error(`Sample pack hash mismatch: ${input.path}`);
    for (let cell = 0; cell < layout.storedCells; cell++) {
      bytes.copy(packed, cell * stride + channelOffset, cell * inputStride, (cell + 1) * inputStride);
    }
    channelOffset += inputStride;
  }
  signal?.throwIfAborted();
  const sha256 = createHash('sha256').update(packed).digest('hex');
  await mkdir(dirname(output), { recursive: true });
  signal?.throwIfAborted();
  await writeFile(output, packed, { flag: 'wx' });
  return { sha256, bytes: totalBytes };
}
