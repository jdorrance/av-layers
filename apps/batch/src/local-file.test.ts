import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { readLocalFile } from './local-file.js';

it('bounds allocation using the opened file and enforces an exact reserved length', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-local-file-')), path = join(root, 'artifact');
  try {
    await writeFile(path, Uint8Array.of(1, 2, 3));
    await expect(readLocalFile(path, 3, 3)).resolves.toEqual(Buffer.from([1, 2, 3]));
    await expect(readLocalFile(path, 2)).rejects.toThrow('byte budget');
    await truncate(path, 4);
    await expect(readLocalFile(path, 8, 3)).rejects.toThrow('changed length');
    await expect(readLocalFile(path, NaN)).rejects.toThrow('byte budget');
  } finally { await rm(root, { recursive: true, force: true }); }
});
