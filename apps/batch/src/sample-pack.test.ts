import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { packCells, prepareSamplePackLayout } from '@av/forecast';
import { createSamplePackBuilder, mergeSamplePacks } from './sample-pack.js';

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

it('merges uneven channel groups byte-for-byte with the full builder, including wrap and block copies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-merge-pack-'));
  try {
    const layout = prepareSamplePackLayout({ width: 5, height: 2, wrapLongitude: true }, Uint8Array.of(0b10010011, 1), Uint8Array.of(0b01000000, 2), 2);
    const fields = Array.from({ length: 4 }, (_, channel) => ({
      values: Float32Array.from([NaN, -0, 0, 0.1, -12.75, Infinity, 7, 10000, 0.0001, channel]),
      flags: Uint8Array.from({ length: 10 }, (_, cell) => (cell + channel) % 4)
    }));
    const full = createSamplePackBuilder(layout, fields.length);
    fields.forEach((field, channel) => full.writeChannel(channel, field));
    const expectedPath = join(root, 'full.bin'), expected = await full.finish(expectedPath);
    const inputs = [];
    let channel = 0;
    for (const channelCount of [2, 1, 1]) {
      const partial = createSamplePackBuilder(layout, channelCount), path = join(root, `partial-${channel}.bin`);
      for (let i = 0; i < channelCount; i++) partial.writeChannel(i, fields[channel++]);
      inputs.push({ path, channelCount, ...(await partial.finish(path)) });
    }
    const output = join(root, 'merged', 'pack.bin');
    expect(await mergeSamplePacks(layout, inputs, output, expected.bytes)).toEqual(expected);
    expect(await readFile(output)).toEqual(await readFile(expectedPath));
    await expect(mergeSamplePacks(layout, inputs, output)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(output)).toEqual(await readFile(expectedPath));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('preserves noncanonical NaN payloads, signed zero and flags without floating-point decoding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-merge-bits-'));
  try {
    const layout = prepareSamplePackLayout({ width: 2, height: 1, wrapLongitude: false }, Uint8Array.of(3), Uint8Array.of(0));
    const parts = [Buffer.from('4523a17f0a0000008000', 'hex'), Buffer.from('4523c1ff020000803f04', 'hex')];
    const inputs = [];
    for (const [index, bytes] of parts.entries()) {
      const path = join(root, `${index}.bin`);
      await writeFile(path, bytes);
      inputs.push({ path, channelCount: 1, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    const output = join(root, 'merged.bin');
    await mergeSamplePacks(layout, inputs, output);
    expect((await readFile(output)).toString('hex')).toBe('4523a17f0a4523c1ff0200000080000000803f04');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects missing, wrong-length and corrupt partial packs without creating the output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-merge-invalid-'));
  try {
    const layout = prepareSamplePackLayout({ width: 2, height: 1, wrapLongitude: false }, Uint8Array.of(3), Uint8Array.of(0));
    const bytes = Buffer.alloc(10), path = join(root, 'valid.bin');
    await writeFile(path, bytes);
    const valid = { path, channelCount: 1, sha256: createHash('sha256').update(bytes).digest('hex') };
    const shortPath = join(root, 'short.bin'), longPath = join(root, 'long.bin');
    await writeFile(shortPath, Buffer.alloc(9));
    await writeFile(longPath, Buffer.alloc(11));
    const cases = [
      { input: { ...valid, path: join(root, 'missing.bin') }, error: 'ENOENT' },
      { input: { ...valid, path: shortPath }, error: 'changed length' },
      { input: { ...valid, path: longPath }, error: 'changed length' },
      { input: { ...valid, sha256: '0'.repeat(64) }, error: 'hash mismatch' }
    ];
    for (const [index, { input, error }] of cases.entries()) {
      const output = join(root, `rejected-${index}.bin`);
      await expect(mergeSamplePacks(layout, [valid, input], output)).rejects.toThrow(error);
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('admits the complete merge before opening files and rejects invalid channel totals and byte overflow', async () => {
  const layout = prepareSamplePackLayout({ width: 2, height: 1, wrapLongitude: false }, Uint8Array.of(3), Uint8Array.of(0));
  const input = { path: '/unused/input.bin', channelCount: 1, sha256: 'a'.repeat(64) };
  for (const channelCount of [0, -1, 0.5, NaN, 257]) {
    await expect(mergeSamplePacks(layout, [{ ...input, channelCount }], '/unused/output.bin')).rejects.toThrow('channel count');
  }
  await expect(mergeSamplePacks(layout, [], '/unused/output.bin')).rejects.toThrow('channel count');
  await expect(mergeSamplePacks(layout, [{ ...input, channelCount: 256 }, input], '/unused/output.bin')).rejects.toThrow('channel count');
  await expect(mergeSamplePacks(layout, [input, input], '/unused/output.bin', 19)).rejects.toThrow('budget');
  await expect(mergeSamplePacks({ ...layout, storedCells: Number.MAX_SAFE_INTEGER }, [input], '/unused/output.bin')).rejects.toThrow('budget');
  await expect(mergeSamplePacks(layout, [{ ...input, sha256: 'invalid' }], '/unused/output.bin')).rejects.toThrow('hash');
});

it('honors cancellation before reading or creating files', async () => {
  const layout = prepareSamplePackLayout({ width: 2, height: 1, wrapLongitude: false }, Uint8Array.of(3), Uint8Array.of(0));
  const controller = new AbortController();
  controller.abort(new Error('merge cancelled'));
  await expect(mergeSamplePacks(layout, [{ path: '/unused/input.bin', channelCount: 1, sha256: 'a'.repeat(64) }], '/unused/output.bin', 10, controller.signal)).rejects.toThrow('merge cancelled');
});
