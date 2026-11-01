import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CELL_BYTES, MAX_SAMPLE_VALUES } from '@av/contracts';
import type { GridField, SamplePackLayout } from '@av/forecast';
import { BUILD_BUDGETS } from './capacity.js';

/** Incrementally write channels into one admitted final pack. No full-grid channel copies are retained. */
export function createSamplePackBuilder(layout: SamplePackLayout, channelCount: number, maxBytes = BUILD_BUDGETS.samplePackBytes) {
  const stride = channelCount * CELL_BYTES, totalBytes = layout.storedCells * stride;
  if (!Number.isSafeInteger(channelCount) || channelCount < 1 || channelCount > MAX_SAMPLE_VALUES) throw new RangeError('Invalid pack channel count');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > maxBytes) throw new RangeError('Sample pack exceeds byte budget');
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
