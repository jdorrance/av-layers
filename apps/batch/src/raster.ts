import { performance } from 'node:perf_hooks';
import { compilePaletteColor, LAYERS, paletteBinIndex, paletteInterpolation, PALETTES, prepareCoverageTester, samplePaletteColorInto, samplePaletteValueInto, STATUS_MASK, STATUS_NO_LIFT, type CoverageMask, type GeographicBounds, type LayerId, type PaletteColorMode, type PaletteColorTable } from '@av/contracts';
import { parseRefinementConfig, refinementCandidate, type RefinementGeometry } from '@av/contracts/refinement';
import { fieldOffset, MAX_PREPARED_SAMPLES, prepareGridAxis, prepareGridSampling, preparePointSampling, QUAD_OFFSETS, samplingCovered, validateSamplingField, type GridField, type PreparedGridAxis, type PreparedGridSampling, type Sample, type SamplingMask } from '@av/forecast';

export interface RasterPixels { rgba: Uint8Array; blank: boolean }
export interface RasterMetrics {
  geometryBytes: number; peakGeometryBytes: number; geometryHits: number; geometryMisses: number;
  prepareMs: number; rasterMs: number; tiles: number; blankTiles: number;
  mbtilesWriteWallMs?: number; pmtilesConvertWallMs?: number; pmtilesVerifyWallMs?: number; sqliteWorkMs?: number;
}
export interface RasterPatch<Mask extends SamplingMask = CoverageMask> {
  id: string;
  geometry: RefinementGeometry;
  descriptors: { bounds: GeographicBounds };
  layers: readonly LayerId[];
  mask: Mask;
}
export type RasterPatchFields = Readonly<Record<string, GridField>>;

/** Each declared layer has a complete field, including unavailable/no-lift cells. */
export function validateRasterPatchFields(patches: readonly RasterPatch<SamplingMask>[], layer: LayerId, fields: RasterPatchFields = {}): void {
  const expected = patches.filter(patch => patch.layers.includes(layer));
  if (Object.keys(fields).length !== expected.length) throw new RangeError('Raster patch field IDs do not match the declared layer');
  for (const patch of expected) {
    const field = Object.hasOwn(fields, patch.id) ? fields[patch.id] : undefined;
    if (!field) throw new RangeError(`Missing or invalid raster patch field: ${patch.id}`);
    try { validateSamplingField(patch.mask.grid, field, patch.mask); }
    catch { throw new RangeError(`Missing or invalid raster patch field: ${patch.id}`); }
  }
}

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
  const { lats, lons } = axes(z, x, y);
  return prepareGridSampling(mask, lats, lons);
}

interface CompositeGeometry {
  byteLength: number;
  base: PreparedGridSampling;
  owners: Uint8Array;
  offsets: Uint32Array;
  patches: { index: number; sampling: PreparedGridSampling }[];
}
type TileGeometry = PreparedGridSampling | CompositeGeometry;
function span(axis: Float64Array, low: number, high: number): [number, number] | null {
  let first = -1, end = 0;
  for (let i = 0; i < axis.length; i++) if (axis[i] >= low && axis[i] <= high) { if (first < 0) first = i; end = i + 1; }
  return first < 0 ? null : [first, end];
}
function compositeGeometry(mask: SamplingMask, patches: readonly RasterPatch<SamplingMask>[], covered: readonly ((lat: number, lon: number) => boolean)[], z: number, x: number, y: number): TileGeometry {
  const { lats, lons } = axes(z, x, y), base = prepareGridSampling(mask, lats, lons);
  const windows = patches.flatMap((patch, index) => {
    const [w, s, e, n] = patch.descriptors.bounds, xs = span(lons, w, e), ys = span(lats, s, n);
    return xs && ys ? [{ patch, index, xs, ys, count: 0 }] : [];
  });
  if (!windows.length) return base;
  const owners = new Uint8Array(lats.length * lons.length), candidates = windows.map(window => window.patch);
  const baseCovered = covered[0];
  for (const window of windows) {
    for (let py = window.ys[0]; py < window.ys[1]; py++) for (let px = window.xs[0]; px < window.xs[1]; px++) {
      const lat = lats[py], lon = lons[px];
      if (baseCovered(lat, lon) && refinementCandidate(candidates, undefined, lat, lon) === window.patch && covered[window.index + 1](lat, lon)) {
        owners[py * lons.length + px] = window.index + 1;
        window.count++;
      }
    }
  }
  const owned = windows.filter(window => window.count);
  if (!owned.length) return base;
  const sampleCount = lats.length * lons.length, offsets = new Uint32Array(sampleCount), prepared: CompositeGeometry['patches'] = [];
  let aggregate = 0;
  for (const window of owned) {
    aggregate += window.count;
    if (aggregate > MAX_PREPARED_SAMPLES) throw new RangeError('Composite raster geometry exceeds the prepared sample budget');
    const patchLats = new Float64Array(window.count), patchLons = new Float64Array(window.count);
    let offset = 0;
    for (let py = window.ys[0]; py < window.ys[1]; py++) for (let px = window.xs[0]; px < window.xs[1]; px++) {
      const index = py * lons.length + px;
      if (owners[index] !== window.index + 1) continue;
      offsets[index] = offset;
      patchLats[offset] = lats[py]; patchLons[offset] = lons[px]; offset++;
    }
    prepared.push({ index: window.index, sampling: preparePointSampling(patches[window.index].mask, patchLats, patchLons) });
  }
  return { base, owners, offsets, patches: prepared, byteLength: base.byteLength + owners.byteLength + offsets.byteLength + prepared.reduce((sum, item) => sum + item.sampling.byteLength, 0) };
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
      if (paletteBinIndex(layer, sample.value, sample.status, palette.colorCount) >= 0) {
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
    samplePaletteColorInto(palette, layer, sample.value, sample.status, color, 0);
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

function raster(field: GridField, mask: SamplingMask, prepared: TileGeometry, layer: LayerId, palette: PaletteColorTable, patches: readonly RasterPatch<SamplingMask>[] = [], patchFields: RasterPatchFields = {}): { rgba: Uint8Array; blank: boolean } {
  const rgba = new Uint8Array(256 * 256 * 4);
  const base = 'base' in prepared ? prepared.base : prepared;
  const baseInto = base.bind(field, layer);
  let sampleInto = baseInto, composite = false;
  if ('base' in prepared) {
    const samplers: (undefined | ReturnType<PreparedGridSampling['bind']>)[] = [];
    for (const item of prepared.patches) if (patches[item.index].layers.includes(layer)) {
      samplers[item.index + 1] = item.sampling.bind(patchFields[patches[item.index].id], layer);
      composite = true;
    }
    if (composite) sampleInto = (x, y, out) => {
      const index = y * base.width + x, owner = samplers[prepared.owners[index]];
      if (owner) owner(prepared.offsets[index], 0, out); else baseInto(x, y, out);
    };
  }
  const noLiftVisible = palette.noLift !== null && palette.noLift[3] !== 0 && LAYERS[layer].supportsNoLift;
  if (!composite && !base.contributors.some(idx => {
    let offset: number;
    try { offset = fieldOffset(field, idx, mask.grid.width); } catch { return false; }
    return paletteBinIndex(layer, field.values[offset], field.flags[offset], palette.colorCount) >= 0
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
}, patches: readonly RasterPatch<SamplingMask>[] = [], liftInterpolation?: PaletteColorMode) {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new RangeError('Invalid raster geometry budget');
  const palettes = liftInterpolation === undefined ? defaultPalettes : compilePalettes(liftInterpolation);
  if (patches.length) {
    parseRefinementConfig({ type: 'FeatureCollection', features: patches.map(patch => ({ type: 'Feature', id: patch.id, properties: {}, geometry: patch.geometry })) });
    for (const patch of patches) if (!patch.layers.length || new Set(patch.layers).size !== patch.layers.length || patch.layers.some(layer => !Object.hasOwn(LAYERS, layer)) || patch.mask.maxZoom !== mask.maxZoom) throw new RangeError('Invalid raster patch layers or zoom');
  }
  const covered = patches.length ? [mask, ...patches.map(patch => patch.mask)].map(item => 'coverage' in item ? (lat: number, lon: number) => samplingCovered(item, lat, lon) : prepareCoverageTester(item)) : [];
  type CachedGeometry = { kind: 'tile'; geometry: TileGeometry; byteLength: number; axes?: PreparedGridAxis[] } | { kind: 'latitude' | 'longitude'; axis: PreparedGridAxis; byteLength: number };
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
  function geometry(z: number, x: number, y: number): { geometry: TileGeometry; byteLength: number; axes?: PreparedGridAxis[] } {
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
    const result = patches.length
      ? (() => { const geometry = compositeGeometry(mask, patches, covered, z, x, y); return { geometry, byteLength: geometry.byteLength }; })()
      : geometry(z, x, y);
    stats.prepareMs += performance.now() - started;
    remember(key, { kind: 'tile', ...result });
    return result.geometry;
  }

  function renderRgba(field: GridField, layer: LayerId, z: number, x: number, y: number, patchFields?: RasterPatchFields) {
    if (patches.length || patchFields) validateRasterPatchFields(patches, layer, patchFields);
    const plan = prepared(z, x, y), started = performance.now(), result = raster(field, mask, plan, layer, palettes[LAYERS[layer].palette], patches, patchFields);
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
  return raster(field, mask, preparedTileGeometry(mask, z, x, y), layer, palettes[LAYERS[layer].palette]).rgba;
}
