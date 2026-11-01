import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { packCells, prepareSamplePackLayout } from '@av/forecast';
import { createSamplePackBuilder } from './sample-pack.js';

it('writes channels without flat buffers and preserves cell order, wrap copies and exact output bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-sample-pack-'));
  try {
    const layout = prepareSamplePackLayout({ width: 5, height: 2, wrapLongitude: true }, Uint8Array.of(0b10010011, 1), Uint8Array.of(0b01000000, 2), 2);
    const fields = Array.from({ length: 3 }, (_, channel) => ({ values: Float32Array.from([NaN, -0, 0, 0.1, -12.75, Infinity, 7, 10000, 0.0001, 5], value => value + channel), flags: Uint8Array.from({ length: 10 }, (_, i) => i % 4) }));
    const flats = fields.map(field => Buffer.from(packCells(field)));
    const builder = createSamplePackBuilder(layout, fields.length);
    // Arrival order need not equal channel order.
    for (const channel of [2, 0, 1]) builder.writeChannel(channel, fields[channel]);
    const output = join(root, 'pack.bin');
    const result = await builder.finish(output);
    const chunks: Buffer[] = [];
    for (let slot = 0; slot < layout.blockSlots; slot++) {
      const block = layout.block(slot);
      if (!block) continue;
      for (let i = 0; i < block.width * block.height; i++) {
        const x = i % block.width, y = (i - x) / block.width;
        const index = (block.row + y) * 5 + (block.column + x) % 5;
        chunks.push(...flats.map(bytes => bytes.subarray(index * 5, index * 5 + 5)));
      }
    }
    const expected = Buffer.concat(chunks);
    expect(await readFile(output)).toEqual(expected);
    expect(result).toEqual({ bytes: expected.length, sha256: createHash('sha256').update(expected).digest('hex') });
    expect(() => builder.writeChannel(0, fields[0])).toThrow('closed');
    await expect(builder.finish(output)).rejects.toThrow('closed');
    const duplicate = createSamplePackBuilder(layout, fields.length);
    fields.forEach((field, channel) => duplicate.writeChannel(channel, field));
    await expect(duplicate.finish(output)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(output)).toEqual(expected);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects invalid shapes, budgets, duplicate/missing channels and closed builders before writing', async () => {
  const layout = prepareSamplePackLayout({ width: 2, height: 2, wrapLongitude: false }, Uint8Array.of(15), Uint8Array.of(0));
  const field = { values: new Float32Array(4), flags: new Uint8Array(4) };
  for (const count of [0, -1, 1.5, 257, NaN]) expect(() => createSamplePackBuilder(layout, count)).toThrow('channel count');
  expect(() => createSamplePackBuilder(layout, 1, 19)).toThrow('budget');
  const builder = createSamplePackBuilder(layout, 2, 40);
  expect(builder.byteLength).toBe(40);
  for (const channel of [-1, 2, 0.5, NaN]) expect(() => builder.writeChannel(channel, field)).toThrow('index');
  expect(() => builder.writeChannel(0, { ...field, flags: new Uint8Array(3) })).toThrow('shape');
  await expect(builder.finish('/unused/incomplete')).rejects.toThrow('Incomplete');
  builder.writeChannel(0, field);
  expect(() => builder.writeChannel(0, field)).toThrow('already');
  await expect(builder.finish('/unused/incomplete')).rejects.toThrow('Incomplete');
  builder.close();
  expect(() => builder.writeChannel(1, field)).toThrow('closed');
});
