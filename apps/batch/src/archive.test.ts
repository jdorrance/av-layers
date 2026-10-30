import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoverageMask } from '@av/contracts';
import { validateArchive } from './validate.js';
import { encodeWebp } from './webp.js';

const mask: CoverageMask = {
  grid: { width: 1, height: 1, lon0: 0, lat0: 0, dx: 1, dy: 1, wrapLongitude: false },
  output: new Uint8Array([1]), halo: new Uint8Array(1), tiles: new Uint8Array([1]), maxZoom: 0
};
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function archiveWithTile(bytes: Uint8Array): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'av-archive-'));
  temporary.push(root);
  const input = join(root, 'fixture.mbtiles'), output = join(root, 'fixture.pmtiles');
  const db = new DatabaseSync(input);
  try {
    db.exec('CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);');
    const metadata = db.prepare('INSERT INTO metadata VALUES (?, ?)');
    for (const [key, value] of Object.entries({ name: 'fixture', format: 'webp', minzoom: '0', maxzoom: '0' })) metadata.run(key, value);
    db.prepare('INSERT INTO tiles VALUES (0, 0, 0, ?)').run(bytes);
  } finally { db.close(); }
  execFileSync(fileURLToPath(new URL('../../../.tools/pmtiles', import.meta.url)), ['convert', input, output], { stdio: 'pipe' });
  return output;
}

function image(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = (i / 4) % 256;
    pixels[i + 1] = Math.floor(i / 1024) % 256;
    pixels[i + 2] = (pixels[i]! + pixels[i + 1]!) % 256;
    pixels[i + 3] = 255;
  }
  return pixels;
}

describe('archive image validation', () => {
  it.each(['header-only', 'truncated pixels', 'corrupt pixels'] as const)('rejects a %s tile in a valid PMTiles container', async defect => {
    const valid = await encodeWebp(image(256, 256), 256, 256);
    const corrupt = Buffer.from(valid);
    if (defect === 'corrupt pixels') corrupt.fill(0xff, 25);
    const bytes = defect === 'header-only' ? corrupt.subarray(0, 25)
      : defect === 'truncated pixels' ? corrupt.subarray(0, Math.floor(corrupt.length / 2)) : corrupt;
    const path = await archiveWithTile(bytes);
    await expect(validateArchive(path, mask)).rejects.toThrow('Missing or invalid active tile');
  });

  it('rejects a fully decodable tile with the wrong dimensions', async () => {
    const path = await archiveWithTile(await encodeWebp(image(32, 32), 32, 32));
    await expect(validateArchive(path, mask)).rejects.toThrow('Invalid tile dimensions');
  });

  it('accepts a fully decodable 256-pixel tile', async () => {
    const path = await archiveWithTile(await encodeWebp(image(256, 256), 256, 256));
    await expect(validateArchive(path, mask)).resolves.toBeUndefined();
  });
});
