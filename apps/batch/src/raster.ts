import { performance } from 'node:perf_hooks';
import { LAYERS, paletteBinIndex, PALETTES, prepareCoverageTester, type CoverageMask, type GeographicBounds, type LayerId } from '@av/contracts';
import { parseRefinementConfig, refinementCandidate, type RefinementGeometry } from '@av/contracts/refinement';
import { MAX_PREPARED_SAMPLES, prepareGridSampling, QUAD_OFFSETS, type GridField, type PreparedGridSampling, type Sample } from '@av/forecast';

export interface RasterPixels { rgba: Uint8Array; blank: boolean }
export interface RasterMetrics {
  geometryBytes: number; peakGeometryBytes: number; geometryHits: number; geometryMisses: number;
  prepareMs: number; rasterMs: number; tiles: number; blankTiles: number;
}
export interface RasterPatch {
  id: string;
  geometry: RefinementGeometry;
  descriptors: { bounds: GeographicBounds };
  layers: readonly LayerId[];
  mask: CoverageMask;
}
export type RasterPatchFields = Readonly<Record<string, GridField>>;

/** Each declared layer has a complete field, including unavailable/no-lift cells. */
export function validateRasterPatchFields(patches: readonly RasterPatch[], layer: LayerId, fields: RasterPatchFields = {}): void {
  const expected = patches.filter(patch => patch.layers.includes(layer));
  if (Object.keys(fields).length !== expected.length) throw new RangeError('Raster patch field IDs do not match the declared layer');
  for (const patch of expected) {
    const field = Object.hasOwn(fields, patch.id) ? fields[patch.id] : undefined, cells = patch.mask.grid.width * patch.mask.grid.height;
    if (!field || !(field.values instanceof Float32Array) || !(field.flags instanceof Uint8Array) || field.values.length !== cells || field.flags.length !== cells) throw new RangeError(`Missing or invalid raster patch field: ${patch.id}`);
  }
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

function axes(z: number, x: number, y: number) {
  const lats = new Float64Array(512), lons = new Float64Array(512);
  for (let i = 0; i < 256; i++) {
    lats[i * 2] = mercatorPoint(z, x, y, 0, i + 0.25).lat;
    lats[i * 2 + 1] = mercatorPoint(z, x, y, 0, i + 0.75).lat;
    lons[i * 2] = mercatorPoint(z, x, y, i + 0.25, 0).lon;
    lons[i * 2 + 1] = mercatorPoint(z, x, y, i + 0.75, 0).lon;
  }
  return { lats, lons };
}
const geometry = (mask: CoverageMask, z: number, x: number, y: number) => { const { lats, lons } = axes(z, x, y); return prepareGridSampling(mask, lats, lons); };

interface CompositeGeometry {
  byteLength: number;
  base: PreparedGridSampling;
  owners: Uint8Array;
  patches: { index: number; x: number; y: number; sampling: PreparedGridSampling }[];
}
type TileGeometry = PreparedGridSampling | CompositeGeometry;
function span(axis: Float64Array, low: number, high: number): [number, number] | null {
  let first = -1, end = 0;
  for (let i = 0; i < axis.length; i++) if (axis[i] >= low && axis[i] <= high) { if (first < 0) first = i; end = i + 1; }
  return first < 0 ? null : [first, end];
}
function compositeGeometry(mask: CoverageMask, patches: readonly RasterPatch[], covered: readonly ((lat: number, lon: number) => boolean)[], z: number, x: number, y: number): TileGeometry {
  const { lats, lons } = axes(z, x, y), base = prepareGridSampling(mask, lats, lons);
  const windows = patches.flatMap((patch, index) => {
    const [w, s, e, n] = patch.descriptors.bounds, xs = span(lons, w, e), ys = span(lats, s, n);
    return xs && ys ? [{ patch, index, xs, ys, left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }] : [];
  });
  if (!windows.length) return base;
  const owners = new Uint8Array(lats.length * lons.length), candidates = windows.map(window => window.patch);
  const baseCovered = covered[0];
  for (const window of windows) {
    for (let py = window.ys[0]; py < window.ys[1]; py++) for (let px = window.xs[0]; px < window.xs[1]; px++) {
      const lat = lats[py], lon = lons[px];
      if (baseCovered(lat, lon) && refinementCandidate(candidates, undefined, lat, lon) === window.patch && covered[window.index + 1](lat, lon)) {
        owners[py * lons.length + px] = window.index + 1;
        window.left = Math.min(window.left, px); window.right = Math.max(window.right, px);
        window.top = Math.min(window.top, py); window.bottom = Math.max(window.bottom, py);
      }
    }
  }
  const owned = windows.filter(window => window.left !== Infinity);
  if (!owned.length) return base;
  const cells = owned.reduce((sum, window) => sum + (window.right - window.left + 1) * (window.bottom - window.top + 1), 0);
  if (cells > MAX_PREPARED_SAMPLES) throw new RangeError('Composite raster geometry exceeds the prepared sample budget');
  const prepared = owned.map(({ index, left, right, top, bottom }) => ({ index, x: left, y: top, sampling: prepareGridSampling(patches[index].mask, lats.subarray(top, bottom + 1), lons.subarray(left, right + 1)) }));
  return { base, owners, patches: prepared, byteLength: base.byteLength + owners.byteLength + prepared.reduce((sum, item) => sum + item.sampling.byteLength, 0) };
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

function raster(field: GridField, prepared: TileGeometry, layer: LayerId, patches: readonly RasterPatch[] = [], patchFields: RasterPatchFields = {}): { rgba: Uint8Array; blank: boolean } {
  const rgba = new Uint8Array(256 * 256 * 4);
  const base = 'base' in prepared ? prepared.base : prepared;
  const baseInto = base.bind(field, layer), colors = palettes[LAYERS[layer].palette];
  let sampleInto = baseInto, composite = false;
  if ('base' in prepared) {
    const samplers: (undefined | { x: number; y: number; sample: ReturnType<PreparedGridSampling['bind']> })[] = [];
    for (const item of prepared.patches) if (patches[item.index].layers.includes(layer)) {
      samplers[item.index + 1] = { x: item.x, y: item.y, sample: item.sampling.bind(patchFields[patches[item.index].id], layer) };
      composite = true;
    }
    if (composite) sampleInto = (x, y, out) => {
      const owner = samplers[prepared.owners[y * base.width + x]];
      if (owner) owner.sample(x - owner.x, y - owner.y, out); else baseInto(x, y, out);
    };
  }
  const colorCount = colors.length / 4;
  if (!composite && !base.contributors.some(idx => paletteBinIndex(layer, field.values[idx], field.flags[idx], colorCount) >= 0)) {
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
}, patches: readonly RasterPatch[] = []) {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new RangeError('Invalid raster geometry budget');
  if (patches.length) {
    parseRefinementConfig({ type: 'FeatureCollection', features: patches.map(patch => ({ type: 'Feature', id: patch.id, properties: {}, geometry: patch.geometry })) });
    for (const patch of patches) if (!patch.layers.length || new Set(patch.layers).size !== patch.layers.length || patch.layers.some(layer => !Object.hasOwn(LAYERS, layer)) || patch.mask.maxZoom !== mask.maxZoom) throw new RangeError('Invalid raster patch layers or zoom');
  }
  const covered = patches.length ? [mask, ...patches.map(patch => patch.mask)].map(prepareCoverageTester) : [];
  const cache = new Map<string, TileGeometry>();
  function prepared(z: number, x: number, y: number) {
    const key = `${z}/${x}/${y}`, found = cache.get(key);
    if (found) { stats.geometryHits++; cache.delete(key); cache.set(key, found); return found; }
    stats.geometryMisses++;
    const started = performance.now(), result = patches.length ? compositeGeometry(mask, patches, covered, z, x, y) : geometry(mask, z, x, y);
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

  function renderRgba(field: GridField, layer: LayerId, z: number, x: number, y: number, patchFields?: RasterPatchFields) {
    if (patches.length || patchFields) validateRasterPatchFields(patches, layer, patchFields);
    const plan = prepared(z, x, y), started = performance.now(), result = raster(field, plan, layer, patches, patchFields);
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
