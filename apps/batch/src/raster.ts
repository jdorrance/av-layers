import { performance } from 'node:perf_hooks';
import { LAYERS, paletteBinIndex, PALETTES, type CoverageMask, type LayerId } from '@av/contracts';
import { prepareGridSampling, QUAD_OFFSETS, type GridField, type PreparedGridSampling, type Sample } from '@av/forecast';

export interface RasterPixels { rgba: Uint8Array; blank: boolean }
export interface RasterMetrics {
  geometryBytes: number; peakGeometryBytes: number; geometryHits: number; geometryMisses: number;
  prepareMs: number; rasterMs: number; tiles: number; blankTiles: number;
}

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
  const rgba = new Uint8Array(256 * 256 * 4);
  const sampleInto = prepared.bind(field, layer), colors = palettes[LAYERS[layer].palette];
  const colorCount = colors.length / 4;
  if (!prepared.contributors.some(idx => paletteBinIndex(layer, field.values[idx], field.flags[idx], colorCount) >= 0)) {
    return { rgba, blank: true };
  }
  const sample: Sample = { value: null, status: 3, support: 0, interpolated: false };
  let blank = true;
  for (let i = 0; i < 256 * 256; i++) {
    if (samplePixel(sampleInto, sample, layer, colors, i & 255, i >> 8, rgba, i * 4)) blank = false;
  }
  return { rgba, blank };
}

/** Pure quarter-pixel rasterization: no codec, archive, filesystem or worker dependency. */
export function createRasterizer(mask: CoverageMask, budget = 24 * 1024 * 1024, stats: RasterMetrics = {
  geometryBytes: 0, peakGeometryBytes: 0, geometryHits: 0, geometryMisses: 0,
  prepareMs: 0, rasterMs: 0, tiles: 0, blankTiles: 0
}) {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new RangeError('Invalid raster geometry budget');
  const cache = new Map<string, PreparedGridSampling>();
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

  return {
    metrics: () => ({ ...stats }),
    renderTilePixels: renderRgba,
    clearGeometry() { cache.clear(); stats.geometryBytes = 0; }
  };
}

export function renderTileRgba(field: GridField, mask: CoverageMask, layer: LayerId, z: number, x: number, y: number): Uint8Array {
  return raster(field, geometry(mask, z, x, y), layer).rgba;
}
