import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { expectedTiles, LAYERS, paletteBinIndex, PALETTES, type CoverageMask, type LayerId } from '@av/contracts';
import { prepareGridSampling, QUAD_OFFSETS, type GridField, type PreparedGridSampling, type Sample } from '@av/forecast';
import { encodeWebp } from './webp.js';

const palettes = Object.fromEntries(Object.entries(PALETTES).map(([id, palette]) => {
  const colors = new Uint8Array(palette.colors.length * 4);
  for (let i = 0; i < palette.colors.length; i++) {
    const color: string = palette.colors[i];
    if (!/^#[\da-f]{6}([\da-f]{2})?$/i.test(color)) throw new Error(`Unsupported palette color ${color}`);
    colors.set([
      parseInt(color.slice(1, 3), 16),
      parseInt(color.slice(3, 5), 16),
      parseInt(color.slice(5, 7), 16),
      color.length === 9 ? parseInt(color.slice(7, 9), 16) : 255
    ], i * 4);
  }
  return [id, colors];
}));

export function mercatorPoint(z: number, x: number, y: number, px: number, py: number): { lat: number; lon: number } {
  const scale = 256 * 2 ** z;
  const lon = ((x * 256 + px) / scale) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y * 256 + py) / scale))) * 180 / Math.PI;
  return { lat, lon };
}

function geometry(mask: CoverageMask, z: number, x: number, y: number): PreparedGridSampling {
  const lats = new Float64Array(512), lons = new Float64Array(512);
  for (let i = 0; i < 256; i++) {
    lats[i * 2] = mercatorPoint(z, x, y, 0, i + 0.25).lat;
    lats[i * 2 + 1] = mercatorPoint(z, x, y, 0, i + 0.75).lat;
    lons[i * 2] = mercatorPoint(z, x, y, i + 0.25, 0).lon;
    lons[i * 2 + 1] = mercatorPoint(z, x, y, i + 0.75, 0).lon;
  }
  return prepareGridSampling(mask, lats, lons);
}

function samplePixel(
  sampleInto: (x: number, y: number, out: Sample) => void,
  sample: Sample,
  layer: LayerId,
  colors: Uint8Array,
  px: number,
  py: number,
  data: Uint8Array,
  offset: number
): boolean {
  let r = 0, g = 0, b = 0, alpha = 0;
  const colorCount = colors.length / 4;
  for (const [dx, dy] of QUAD_OFFSETS) {
    sampleInto(px * 2 + dx, py * 2 + dy, sample);
    const bin = paletteBinIndex(layer, sample.value, sample.status, colorCount);
    if (bin < 0) continue;
    const c = bin * 4, opacity = colors[c + 3];
    r += colors[c] * opacity; g += colors[c + 1] * opacity; b += colors[c + 2] * opacity; alpha += opacity;
  }
  if (!alpha) return false;
  data[offset] = Math.round(r / alpha);
  data[offset + 1] = Math.round(g / alpha);
  data[offset + 2] = Math.round(b / alpha);
  data[offset + 3] = Math.round(alpha / 4);
  return true;
}

function raster(field: GridField, prepared: PreparedGridSampling, layer: LayerId): { rgba: Uint8Array; blank: boolean } {
  const rgba = new Uint8Array(256 * 256 * 4), sample: Sample = { value: null, status: 3, support: 0, interpolated: false };
  const sampleInto = prepared.bind(field, layer), colors = palettes[LAYERS[layer].palette];
  let blank = true;
  for (let i = 0; i < 256 * 256; i++) {
    if (samplePixel(sampleInto, sample, layer, colors, i & 255, i >> 8, rgba, i * 4)) blank = false;
  }
  return { rgba, blank };
}

export interface RendererOptions {
  /** Hard limit for retained axes and coverage bits; fields are never cached. */
  geometryCacheBytes?: number;
  /** Bounded native encodes and ordered output buffers, not JS CPU workers. */
  encodeConcurrency?: number;
}

/** One immutable coverage mask per build session; reuse across all frames and layers. */
export function createRenderer(mask: CoverageMask, options: RendererOptions = {}) {
  const budget = options.geometryCacheBytes ?? 24 * 1024 * 1024, concurrency = options.encodeConcurrency ?? 8;
  if (!Number.isSafeInteger(budget) || budget < 0 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new RangeError('Invalid renderer resource limits');
  }
  const cache = new Map<string, PreparedGridSampling>();
  const tiles = Array.from({ length: mask.maxZoom + 1 }, (_, z) => expectedTiles(mask, z)).flat();
  const stats = {
    geometryBytes: 0, peakGeometryBytes: 0, geometryHits: 0, geometryMisses: 0,
    prepareMs: 0, rasterMs: 0, encodeWorkMs: 0, sqliteMs: 0, convertMs: 0, verifyMs: 0,
    tiles: 0, blankTiles: 0, peakPendingTiles: 0
  };
  const binary = process.env.PMTILES_BIN || fileURLToPath(new URL('../../../.tools/pmtiles', import.meta.url));
  let toolChecked = false, blankEncoded: Promise<Buffer> | undefined;

  function prepared(z: number, x: number, y: number) {
    const key = `${z}/${x}/${y}`, found = cache.get(key);
    if (found) { stats.geometryHits++; cache.delete(key); cache.set(key, found); return found; }
    stats.geometryMisses++;
    const started = performance.now(), result = geometry(mask, z, x, y);
    stats.prepareMs += performance.now() - started;
    if (result.byteLength <= budget) {
      for (const [oldest, entry] of cache) {
        if (stats.geometryBytes + result.byteLength <= budget) break;
        stats.geometryBytes -= entry.byteLength;
        cache.delete(oldest);
      }
      cache.set(key, result);
      stats.geometryBytes += result.byteLength;
      stats.peakGeometryBytes = Math.max(stats.peakGeometryBytes, stats.geometryBytes);
    }
    return result;
  }

  function renderRgba(field: GridField, layer: LayerId, z: number, x: number, y: number) {
    const plan = prepared(z, x, y), started = performance.now(), result = raster(field, plan, layer);
    stats.rasterMs += performance.now() - started; stats.tiles++;
    if (result.blank) stats.blankTiles++;
    return result;
  }

  async function encode(rgba: Uint8Array): Promise<Buffer> {
    const started = performance.now();
    try { return await encodeWebp(rgba, 256, 256); }
    finally { stats.encodeWorkMs += performance.now() - started; }
  }

  async function renderTile(field: GridField, layer: LayerId, z: number, x: number, y: number): Promise<Buffer> {
    const result = renderRgba(field, layer, z, x, y);
    if (!result.blank) return encode(result.rgba);
    blankEncoded ??= encode(result.rgba).catch(error => { blankEncoded = undefined; throw error; });
    return blankEncoded;
  }

  async function writeMbtiles(mbtiles: string, field: GridField, layer: LayerId): Promise<void> {
    const db = new DatabaseSync(mbtiles);
    type Encoded = { bytes: Buffer } | { error: unknown };
    const pending: Promise<Encoded>[] = [];
    let next = 0;
    const refill = () => {
      for (; pending.length < concurrency && next < tiles.length; next++) {
        const queued = tiles[next];
        pending.push(renderTile(field, layer, queued.z, queued.x, queued.y).then(bytes => ({ bytes }), error => ({ error })));
        stats.peakPendingTiles = Math.max(stats.peakPendingTiles, pending.length);
      }
    };
    try {
      db.exec('CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB); CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row); BEGIN');
      const metadata = db.prepare('INSERT INTO metadata VALUES (?, ?)');
      for (const [key, value] of Object.entries({ name: layer, format: 'webp', type: 'overlay', version: '1', minzoom: '0', maxzoom: String(mask.maxZoom), bounds: '-180,-85.051129,180,85.051129' })) {
        metadata.run(key, value);
      }
      const insert = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)');
      for (const tile of tiles) {
        refill();
        const result = await pending.shift()!;
        if ('error' in result) throw result.error;
        const started = performance.now();
        insert.run(tile.z, tile.x, 2 ** tile.z - 1 - tile.y, result.bytes);
        stats.sqliteMs += performance.now() - started;
      }
      db.exec('COMMIT');
    } finally {
      await Promise.all(pending);
      db.close();
    }
  }

  return {
    metrics: () => ({ ...stats }),
    renderTile,
    renderTileRgba: (field: GridField, layer: LayerId, z: number, x: number, y: number) => renderRgba(field, layer, z, x, y).rgba,
    async renderArchive(path: string, field: GridField, layer: LayerId): Promise<void> {
      if (!toolChecked) {
        const version = execFileSync(binary, ['version'], { encoding: 'utf8' });
        if (!/\b1\.31\.2\b/.test(version)) throw new Error(`Expected official pmtiles 1.31.2, got ${version.trim()}`);
        toolChecked = true;
      }
      const dir = await mkdtemp(join(tmpdir(), 'av-mbtiles-')), mbtiles = join(dir, 'frame.mbtiles');
      try {
        await writeMbtiles(mbtiles, field, layer);
        await mkdir(dirname(path), { recursive: true });
        let started = performance.now();
        execFileSync(binary, ['convert', '--no-deduplication', mbtiles, path], { stdio: 'pipe' });
        stats.convertMs += performance.now() - started;
        started = performance.now();
        execFileSync(binary, ['verify', path], { stdio: 'pipe' });
        stats.verifyMs += performance.now() - started;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  };
}

export function renderTileRgba(field: GridField, mask: CoverageMask, layer: LayerId, z: number, x: number, y: number): Uint8Array {
  return raster(field, geometry(mask, z, x, y), layer).rgba;
}
export function renderTile(field: GridField, mask: CoverageMask, layer: LayerId, z: number, x: number, y: number): Promise<Buffer> {
  return encodeWebp(renderTileRgba(field, mask, layer, z, x, y), 256, 256);
}
export function renderArchive(path: string, field: GridField, mask: CoverageMask, layer: LayerId): Promise<void> {
  return createRenderer(mask).renderArchive(path, field, layer);
}
