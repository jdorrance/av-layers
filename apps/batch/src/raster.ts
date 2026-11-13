import { performance } from 'node:perf_hooks';
import { compilePaletteColor, LAYERS, layerPalette, paletteBinIndex, paletteInterpolation, PALETTES, samplePaletteColorInto, samplePaletteValueInto, STATUS_MASK, STATUS_NO_LIFT, STATUS_VALID, type LayerId, type PaletteColorMode, type PaletteColorTable } from '@av/contracts';
import { fieldOffset, prepareGridAxis, prepareGridSampling, QUAD_OFFSETS, type GridField, type PreparedGridAxis, type PreparedGridSampling, type Sample, type SamplingMask } from '@av/forecast';

export interface RasterPixels { rgba: Uint8Array; blank: boolean }
export interface RasterMetrics {
  geometryBytes: number; peakGeometryBytes: number; geometryHits: number; geometryMisses: number;
  prepareMs: number; rasterMs: number; tiles: number; blankTiles: number;
  mbtilesWriteWallMs?: number; pmtilesConvertWallMs?: number; pmtilesVerifyWallMs?: number; sqliteWorkMs?: number;
}
/** Publish the same sampling rule that rasterization uses for this build. */
export const RASTER_SAMPLING = { useStoredMslNoLift: true } as const;

function compilePalettes(liftInterpolation?: PaletteColorMode): Record<string, PaletteColorTable> {
  return Object.fromEntries(Object.entries(PALETTES).map(([id, palette]) => [
    id, compilePaletteColor(palette, id === 'lift' ? liftInterpolation ?? paletteInterpolation(palette) : paletteInterpolation(palette))
  ]));
}
const defaultPalettes = compilePalettes();

export function mercatorPoint(z: number, x: number, y: number, px: number, py: number): { lat: number; lon: number } {
  const scale = 256 * 2 ** z;
  const lon = ((x * 256 + px) / scale) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y * 256 + py) / scale))) * 180 / Math.PI;
  return { lat, lon };
}

function latitudeCoordinates(z: number, y: number): Float64Array {
  const lats = new Float64Array(512);
  for (let i = 0; i < 256; i++) {
    lats[i * 2] = mercatorPoint(z, 0, y, 0, i + 0.25).lat;
    lats[i * 2 + 1] = mercatorPoint(z, 0, y, 0, i + 0.75).lat;
  }
  return lats;
}
function longitudeCoordinates(z: number, x: number): Float64Array {
  const lons = new Float64Array(512);
  for (let i = 0; i < 256; i++) {
    lons[i * 2] = mercatorPoint(z, x, 0, i + 0.25, 0).lon;
    lons[i * 2 + 1] = mercatorPoint(z, x, 0, i + 0.75, 0).lon;
  }
  return lons;
}
const NO_COORDINATES = new Float64Array(0);

function preparedTileGeometry(mask: SamplingMask, z: number, x: number, y: number): PreparedGridSampling {
  return prepareGridSampling(mask, latitudeCoordinates(z, y), longitudeCoordinates(z, x));
}

// No-lift MSL stores terrain height; colouring it leaves the forecast status unchanged.
function colorStatus(layer: LayerId, status: number): number {
  return layer === 'usable-lift-msl' && (status & STATUS_MASK) === STATUS_NO_LIFT ? STATUS_VALID : status;
}

function samplePixel(
  sampleInto: (x: number, y: number, out: Sample) => void,
  sample: Sample,
  layer: LayerId,
  palette: PaletteColorTable,
  color: Uint8Array,
  px: number,
  py: number,
  data: Uint8Array,
  offset: number
): boolean {
  if (palette.mode === 'linear-rgb' && palette.noLift?.[3] === 0) {
    let valueSum = 0, validCount = 0;
    for (const [dx, dy] of QUAD_OFFSETS) {
      sampleInto(px * 2 + dx, py * 2 + dy, sample);
      if (paletteBinIndex(layer, sample.value, colorStatus(layer, sample.status), palette.colorCount) >= 0) {
        valueSum += sample.value as number;
        validCount++;
      }
    }
    if (!validCount) return false;
    samplePaletteValueInto(palette, valueSum / validCount, color, 0);
    const opacity = color[3];
    if (!opacity) return false;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = Math.round((opacity * validCount) / 4);
    return true;
  }
  let r = 0, g = 0, b = 0, alpha = 0;
  for (const [dx, dy] of QUAD_OFFSETS) {
    sampleInto(px * 2 + dx, py * 2 + dy, sample);
    samplePaletteColorInto(palette, layer, sample.value, colorStatus(layer, sample.status), color, 0);
    const opacity = color[3];
    if (!opacity) continue;
    r += color[0] * opacity; g += color[1] * opacity; b += color[2] * opacity; alpha += opacity;
  }
  if (!alpha) return false;
  data[offset] = Math.round(r / alpha);
  data[offset + 1] = Math.round(g / alpha);
  data[offset + 2] = Math.round(b / alpha);
  data[offset + 3] = Math.round(alpha / 4);
  return true;
}

function raster(field: GridField, mask: SamplingMask, prepared: PreparedGridSampling, layer: LayerId, palette: PaletteColorTable): RasterPixels {
  const rgba = new Uint8Array(256 * 256 * 4);
  const sampleInto = prepared.bind(field, layer, RASTER_SAMPLING.useStoredMslNoLift, layer === 'usable-lift-msl');
  const noLiftVisible = palette.noLift !== null && palette.noLift[3] !== 0 && LAYERS[layer].supportsNoLift;
  if (!prepared.contributors.some(idx => {
    let offset: number;
    try { offset = fieldOffset(field, idx, mask.grid.width); } catch { return false; }
    return paletteBinIndex(layer, field.values[offset], colorStatus(layer, field.flags[offset]), palette.colorCount) >= 0
      || noLiftVisible && (field.flags[offset] & STATUS_MASK) === STATUS_NO_LIFT;
  })) {
    return { rgba, blank: true };
  }
  const sample: Sample = { value: null, status: 3, support: 0, interpolated: false }, color = new Uint8Array(4);
  let blank = true;
  for (let i = 0; i < 256 * 256; i++) {
    if (samplePixel(sampleInto, sample, layer, palette, color, i & 255, i >> 8, rgba, i * 4)) blank = false;
  }
  return { rgba, blank };
}

/** Pure quarter-pixel rasterization: no codec, archive, filesystem or worker dependency. */
export function createRasterizer(mask: SamplingMask, budget = 24 * 1024 * 1024, stats: RasterMetrics = {
  geometryBytes: 0, peakGeometryBytes: 0, geometryHits: 0, geometryMisses: 0,
  prepareMs: 0, rasterMs: 0, tiles: 0, blankTiles: 0
}, liftInterpolation?: PaletteColorMode) {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new RangeError('Invalid raster geometry budget');
  const palettes = liftInterpolation === undefined ? defaultPalettes : compilePalettes(liftInterpolation);
  type CachedGeometry = { kind: 'tile'; geometry: PreparedGridSampling; byteLength: number; axes?: PreparedGridAxis[] } |
    { kind: 'latitude' | 'longitude'; axis: PreparedGridAxis; byteLength: number };
  const cache = new Map<string, CachedGeometry>();
  const axisReferences = new Map<PreparedGridAxis, number>();
  const entryAxes = (entry: CachedGeometry) => entry.kind === 'tile' ? entry.axes ?? [] : [entry.axis];
  function remember(key: string, entry: CachedGeometry): void {
    const axes = entryAxes(entry);
    if (entry.byteLength + axes.reduce((sum, axis) => sum + axis.byteLength, 0) > budget) return;
    const addedBytes = () => entry.byteLength + axes.reduce((sum, axis) => sum + (axisReferences.has(axis) ? 0 : axis.byteLength), 0);
    for (const [oldest, cached] of cache) {
      if (stats.geometryBytes + addedBytes() <= budget) break;
      stats.geometryBytes -= cached.byteLength;
      for (const axis of entryAxes(cached)) {
        const remaining = axisReferences.get(axis)! - 1;
        if (remaining) axisReferences.set(axis, remaining);
        else { axisReferences.delete(axis); stats.geometryBytes -= axis.byteLength; }
      }
      cache.delete(oldest);
    }
    cache.set(key, entry);
    stats.geometryBytes += entry.byteLength;
    for (const axis of axes) {
      if (!axisReferences.has(axis)) stats.geometryBytes += axis.byteLength;
      axisReferences.set(axis, (axisReferences.get(axis) ?? 0) + 1);
    }
    stats.peakGeometryBytes = Math.max(stats.peakGeometryBytes, stats.geometryBytes);
  }
  function preparedAxis(kind: 'latitude' | 'longitude', z: number, coordinate: number): PreparedGridAxis {
    const key = `${kind}/${z}/${coordinate}`, found = cache.get(key);
    if (found) { cache.delete(key); cache.set(key, found); return (found as Extract<CachedGeometry, { kind: 'latitude' | 'longitude' }>).axis; }
    const axis = prepareGridAxis(mask, kind === 'latitude' ? latitudeCoordinates(z, coordinate) : longitudeCoordinates(z, coordinate), kind === 'latitude' ? 'row' : 'column');
    remember(key, { kind, axis, byteLength: 0 });
    return axis;
  }
  function geometry(z: number, x: number, y: number): { geometry: PreparedGridSampling; byteLength: number; axes?: PreparedGridAxis[] } {
    if (mask.grid.kind !== 'regular-latlon') {
      const geometry = preparedTileGeometry(mask, z, x, y);
      return { geometry, byteLength: geometry.byteLength };
    }
    const rows = preparedAxis('latitude', z, y), columns = preparedAxis('longitude', z, x);
    const geometry = prepareGridSampling(mask, NO_COORDINATES, NO_COORDINATES, { rows, columns });
    return { geometry, byteLength: geometry.byteLength - rows.byteLength - columns.byteLength, axes: [rows, columns] };
  }
  function prepared(z: number, x: number, y: number) {
    const key = `tile/${z}/${x}/${y}`, found = cache.get(key);
    if (found) { stats.geometryHits++; cache.delete(key); cache.set(key, found); return (found as Extract<CachedGeometry, { kind: 'tile' }>).geometry; }
    stats.geometryMisses++;
    const started = performance.now();
    const result = geometry(z, x, y);
    stats.prepareMs += performance.now() - started;
    remember(key, { kind: 'tile', ...result });
    return result.geometry;
  }

  function renderRgba(field: GridField, layer: LayerId, z: number, x: number, y: number): RasterPixels {
    const plan = prepared(z, x, y), started = performance.now(), result = raster(field, mask, plan, layer, palettes[layerPalette(layer)]);
    stats.rasterMs += performance.now() - started; stats.tiles++;
    if (result.blank) stats.blankTiles++;
    return result;
  }

  return {
    metrics: () => ({ ...stats }),
    renderTilePixels: renderRgba,
    clearGeometry() { cache.clear(); axisReferences.clear(); stats.geometryBytes = 0; }
  };
}

export function renderTileRgba(field: GridField, mask: SamplingMask, layer: LayerId, z: number, x: number, y: number, liftInterpolation?: PaletteColorMode): Uint8Array {
  const palettes = liftInterpolation === undefined ? defaultPalettes : compilePalettes(liftInterpolation);
  return raster(field, mask, preparedTileGeometry(mask, z, x, y), layer, palettes[layerPalette(layer)]).rgba;
}
