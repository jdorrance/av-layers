import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareSamplePackLayout } from '@av/forecast';
import { writeSamplePack } from './sample-pack.js';

it('transposes channels in caller order, preserves raw bytes, and hashes the exact output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-sample-pack-'));
  try {
    const layout = prepareSamplePackLayout({ width: 5, height: 2, wrapLongitude: true }, Uint8Array.of(0b10010011, 1), Uint8Array.of(0b01000000, 2), 2);
    const flats = Array.from({ length: 3 }, (_, channel) => Buffer.from(Array.from({ length: 50 }, (_, i) => (i * 17 + channel * 83) % 256)));
    const inputs = flats.map((_, i) => join(root, `${i}.bin`));
    for (let i = 0; i < inputs.length; i++) await writeFile(inputs[i], flats[i]);
    const output = join(root, 'pack.bin');
    const result = await writeSamplePack(output, inputs, layout);
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
    await expect(writeSamplePack(output, inputs, layout)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(output)).toEqual(expected);
    await writeFile(inputs[0], Buffer.alloc(1));
    await expect(writeSamplePack(join(root, 'bad.bin'), inputs, layout)).rejects.toThrow('Invalid flat sample size');
    await expect(readFile(join(root, 'bad.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
