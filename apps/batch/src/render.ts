import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { expectedTiles, PALETTES, paletteColor, STATUS_NO_LIFT, type CoverageMask, type LayerId } from '@av/contracts';
import { sampleGrid, type GridField } from '@av/forecast';
import { encodeWebp } from './webp.js';

const rgba = new Map<string, readonly [number, number, number, number]>();
for (const palette of Object.values(PALETTES)) for (const color of palette.colors as readonly string[]) {
  if (!/^#[\da-f]{6}([\da-f]{2})?$/i.test(color)) throw new Error(`Unsupported palette color ${color}`);
  rgba.set(color, [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16), color.length === 9 ? parseInt(color.slice(7, 9), 16) : 255]);
}

export function mercatorPoint(z: number, x: number, y: number, px: number, py: number): { lat: number; lon: number } {
  const scale = 256 * 2 ** z;
  const lon = ((x * 256 + px) / scale) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y * 256 + py) / scale))) * 180 / Math.PI;
  return { lat, lon };
}

export function renderTileRgba(field: GridField, mask: CoverageMask, layer: LayerId, z: number, x: number, y: number): Uint8Array {
  const data = new Uint8Array(256 * 256 * 4);
  const lats = new Float64Array(512), lons = new Float64Array(512);
  for (let i = 0; i < 256; i++) {
    lats[i * 2] = mercatorPoint(z, x, y, 0, i + 0.25).lat;
    lats[i * 2 + 1] = mercatorPoint(z, x, y, 0, i + 0.75).lat;
    lons[i * 2] = mercatorPoint(z, x, y, i + 0.25, 0).lon;
    lons[i * 2 + 1] = mercatorPoint(z, x, y, i + 0.75, 0).lon;
  }
  for (let py = 0; py < 256; py++) for (let px = 0; px < 256; px++) {
    let r = 0, g = 0, b = 0, alpha = 0;
    for (let dy = 0; dy < 2; dy++) {
      const lat = lats[py * 2 + dy]!;
      for (let dx = 0; dx < 2; dx++) {
        const sample = sampleGrid(mask.grid, field, lat, lons[px * 2 + dx]!, layer, mask);
        const color = paletteColor(layer, sample.status === STATUS_NO_LIFT ? 0 : sample.value, sample.status);
        if (color) {
          const [red, green, blue, opacity] = rgba.get(color)!;
          r += red * opacity; g += green * opacity; b += blue * opacity; alpha += opacity;
        }
      }
    }
    const offset = (py * 256 + px) * 4;
    if (alpha) { data[offset] = Math.round(r / alpha); data[offset + 1] = Math.round(g / alpha); data[offset + 2] = Math.round(b / alpha); data[offset + 3] = Math.round(alpha / 4); }
  }
  return data;
}

export function renderTile(field: GridField, mask: CoverageMask, layer: LayerId, z: number, x: number, y: number): Promise<Buffer> {
  return encodeWebp(renderTileRgba(field, mask, layer, z, x, y), 256, 256);
}

export async function renderArchive(path: string, field: GridField, mask: CoverageMask, layer: LayerId): Promise<void> {
  const binary = process.env.PMTILES_BIN || fileURLToPath(new URL('../../../.tools/pmtiles', import.meta.url));
  const version = execFileSync(binary, ['version'], { encoding: 'utf8' });
  if (!/\b1\.31\.2\b/.test(version)) throw new Error(`Expected official pmtiles 1.31.2, got ${version.trim()}`);
  const dir = await mkdtemp(join(tmpdir(), 'av-mbtiles-')), mbtiles = join(dir, 'frame.mbtiles');
  try {
    const db = new DatabaseSync(mbtiles);
    try {
      db.exec('CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB); CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row); BEGIN');
      const metadata = db.prepare('INSERT INTO metadata VALUES (?, ?)');
      for (const [key, value] of Object.entries({ name: layer, format: 'webp', type: 'overlay', version: '1', minzoom: '0', maxzoom: String(mask.maxZoom), bounds: '-180,-85.051129,180,85.051129' })) metadata.run(key, value);
      const insert = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)');
      for (let z = 0; z <= mask.maxZoom; z++) for (const tile of expectedTiles(mask, z)) insert.run(z, tile.x, 2 ** z - 1 - tile.y, await renderTile(field, mask, layer, z, tile.x, tile.y));
      db.exec('COMMIT');
    } finally { db.close(); }
    await mkdir(dirname(path), { recursive: true });
    execFileSync(binary, ['convert', '--no-deduplication', mbtiles, path], { stdio: 'pipe' });
    execFileSync(binary, ['verify', path], { stdio: 'pipe' });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
