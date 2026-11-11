import { RASTER_TILE_SIZE } from '@av/contracts/format';
import { normalizeLon, type Grid } from '@av/contracts/geometry';
import { renderedLayers, SUPPORT_PARCEL_CROSSING, SUPPORT_PROFILE_TOP, SUPPORT_PBL_CLOSURE, SUPPORT_CUMULUS,
  SUPPORT_OVERDEVELOPED, SUPPORT_CLOUD_CAPPED, type LayerId } from '@av/contracts/layers';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import { renderedFrames, type ManifestV5 } from '@av/contracts/publication';
import type { PaletteSummary, PinnedBuild, FrameSample, FrameSampleLayer, GeoPoint } from './client-types.ts';
import { deriveSoaringViews, FEET_PER_MINUTE_TO_MPS, KNOTS_PER_MPS } from '@av/soaring';

export type UnitSystem = 'metric' | 'imperial';
export { pointSeriesSelection } from './client-point.ts';

export function formatAltitude(meters: number | null, unitSystem: UnitSystem): string {
  return meters === null || !Number.isFinite(meters) ? '—' : `${Math.round(unitSystem === 'imperial' ? meters / 0.3048 : meters)} ${unitSystem === 'imperial' ? 'ft' : 'm'}`;
}

/** Recover fine terrain only from two valid values with the same sampled surface. */
export function deriveTerrainM(frame: FrameSample, build: PinnedBuild): number | null {
  const msl = frame.layers['usable-lift-msl'], agl = frame.layers['usable-lift-agl'];
  if (!msl || !agl || msl.status !== 'valid' || agl.status !== 'valid' || msl.value === null || agl.value === null || msl.interpolated || agl.interpolated || msl.support !== agl.support) return null;
  if (msl.surfaceId === agl.surfaceId &&
    build.manifest.surfaces.find(surface => surface.id === msl.surfaceId)?.kind === 'fine' && build.manifest.descriptors.layers['usable-lift-agl'].verticalReference === 'terrain-AGL') return msl.value - agl.value;
  return null;
}

/** Map values retain their own statuses, flags and source surface. */
export function pointMapLift(frame: FrameSample | undefined, build: PinnedBuild) {
  const msl: FrameSampleLayer | undefined = frame?.layers['usable-lift-msl'];
  const agl: FrameSampleLayer | undefined = frame?.layers['usable-lift-agl'];
  return {
    msl, agl,
    mslM: msl?.status === 'valid' ? msl.value : null,
    aglM: agl?.status === 'valid' ? agl.value : null,
    terrainM: frame ? deriveTerrainM(frame, build) : null
  };
}

export function formatMapLiftCell(cell: FrameSampleLayer | undefined, units: UnitSystem): string {
  switch (cell?.status) {
    case 'valid': return formatAltitude(cell.value, units);
    case 'no-usable-lift': return 'no usable lift';
    case 'outside-domain': return 'outside coverage';
    default: return 'unavailable';
  }
}

function liftSupport(cell: FrameSampleLayer | undefined): number {
  return cell?.status === 'valid' || cell?.status === 'no-usable-lift' ? cell.support : 0;
}

function cloudRegime(support: number): string | null {
  return support & SUPPORT_OVERDEVELOPED ? 'OD' : support & SUPPORT_CUMULUS ? 'Cu' : null;
}

export function formatPointMapLift(lift: ReturnType<typeof pointMapLift>, units: UnitSystem): string {
  const support = liftSupport(lift.agl) | liftSupport(lift.msl);
  const regime = cloudRegime(support);
  return [
    `MSL ${formatMapLiftCell(lift.msl, units)}`, `AGL ${formatMapLiftCell(lift.agl, units)}`,
    `Surface elevation ${lift.terrainM === null ? 'unknown' : formatAltitude(lift.terrainM, units)}`,
    ...(regime ? [`Map ${regime}`] : []), ...(support & SUPPORT_CLOUD_CAPPED ? ['Map cloud capped'] : [])
  ].join(' · ');
}

export function pointFrameView(frame: FrameSample, build: PinnedBuild, units: UnitSystem) {
  const read = (layer: LayerId) => frame.layers[layer]?.status === 'valid' ? frame.layers[layer].value : null;
  const lift = pointMapLift(frame, build), lclM = read('surface-lcl-msl'), thermalTopM = read('thermal-top-msl');
  const wind = deriveSoaringViews({ wind10mU: read('wind-10m-u'), wind10mV: read('wind-10m-v'), blMeanWindU: read('bl-mean-wind-u'), blMeanWindV: read('bl-mean-wind-v') });
  const windText = (speed: number | null, direction: number | null) => speed === null ? '—' : `${(units === 'imperial' ? speed * KNOTS_PER_MPS : speed).toFixed(1)} ${units === 'imperial' ? 'kt' : 'm/s'}${direction === null ? '' : ` ${Math.round(direction)}°`}`;
  const thermal = read('thermal-velocity'), cloud = read('cloud-cover-total');
  const nativeSupport = liftSupport(frame.layers['thermal-velocity']) | liftSupport(frame.layers['thermal-top-msl']);
  const regime = cloudRegime(nativeSupport);
  const thermalText = thermal === null ? '—' : units === 'imperial' ? `${Math.round(thermal / FEET_PER_MINUTE_TO_MPS)} ft/min` : `${thermal.toFixed(1)} m/s`;
  const summary = [
    formatPointMapLift(lift, units),
    `w* ${thermalText}`, `LCL ${formatAltitude(lclM, units)}`,
    `Native top ${formatAltitude(thermalTopM, units)}`, `Cloud ${cloud === null ? 'unknown' : `${Math.round(cloud)}%`}`,
    `10 m ${windText(wind.wind10mSpeedMps, wind.wind10mDirDeg)}`, `BL ${windText(wind.blMeanWindSpeedMps, wind.blMeanWindDirDeg)}`,
    regime ? `Native ${regime}` : 'Native cloud regime unknown', ...(nativeSupport & SUPPORT_CLOUD_CAPPED ? ['Native cloud capped'] : [])
  ].join(' · ');
  return { id: frame.id, validTime: frame.validTime, terrainM: lift.terrainM, mslM: lift.mslM, aglM: lift.aglM, lclM, thermalTopM, summary };
}

export function activePalettes(palettes: readonly PaletteSummary[], layerId: string | null, descriptors: ManifestV5['descriptors']['layers']): readonly PaletteSummary[] {
  if (!layerId || !Object.hasOwn(descriptors, layerId)) return palettes;
  if (descriptors[layerId].delivery === 'samples-only') return [];
  const targetId = descriptors[layerId].palette;
  const matched = palettes.filter(palette => palette.id === targetId);
  return matched.length > 0 ? matched : palettes;
}

export function normalizePoint(lat: number, lon: number): GeoPoint {
  return { lat, lon: normalizeLon(lon) };
}

export function samePoint(a: GeoPoint | null | undefined, b: GeoPoint | null | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(a.lat - b.lat) <= 1e-9 && Math.abs(a.lon - b.lon) <= 1e-9;
}

export function coverageSummaryText(build: PinnedBuild): string {
  const manifest = build.manifest;
  const ids = manifest.surfaces.map(surface => surface.coverage.id).join(', ');
  return `Coverage ${ids}: ${manifest.descriptors.coverageDescription}`;
}

function layerSurface(manifest: ManifestV5, layer: LayerId) {
  const surface = manifest.surfaces.find(surface => surface.layers.includes(layer));
  if (!surface) throw new Error(`No surface owns ${layer}`);
  return surface;
}

export function layerMaxZoom(manifest: ManifestV5, layer: LayerId): number {
  return layerSurface(manifest, layer).coverage.maxZoom;
}

function gridSpacing(grid: Grid): string {
  return grid.kind === 'regular-latlon' ? `${grid.dx}° × ${Math.abs(grid.dy)}°` : `${Math.abs(grid.dxM)} × ${Math.abs(grid.dyM)} m`;
}

export function buildDiagnosticRows(build: PinnedBuild): Array<[string, string]> {
  const manifest = build.manifest;
  const source = manifest.source as Record<string, unknown>;
  const model = typeof source.model === 'string' ? source.model : build.manifest.model.toUpperCase();
  const native = typeof source.nativeResolutionDeg === 'number' ? `${source.nativeResolutionDeg}° native columns` : 'native model columns';
  const validTimes = manifest.frames.map(f => Date.parse(f.validTime)).filter(Number.isFinite);
  const horizonStart = validTimes.length > 0 ? new Date(Math.min(...validTimes)).toISOString() : manifest.cycle;
  const horizonEnd = validTimes.length > 0 ? new Date(Math.max(...validTimes)).toISOString() : manifest.cycle;
  const rows: Array<[string, string]> = [
    ['Build', manifest.buildId],
    ['Cycle', manifest.cycle],
    ['Horizon', `${horizonStart} → ${horizonEnd}`],
    ['Method', `${manifest.method.id} · ${manifest.method.hash.slice(0, 12)}…`],
    ['Source', `${model} · ${native}`]
  ];
  for (const surface of manifest.surfaces) {
    const elevation = surface.terrain ? ` · ${surface.terrain.surface} · ${surface.terrain.verticalDatum}` : '';
    rows.push([`Surface ${surface.id}`, `${surface.grid.width} × ${surface.grid.height} · ${gridSpacing(surface.grid)} · ${surface.layers.join(', ')} · z0–${surface.coverage.maxZoom}${elevation}`]);
  }
  rows.push(
    ['Coverage', manifest.descriptors.coverageDescription],
    ['Recipe', `${manifest.recipe.id} · ${manifest.recipe.hash.slice(0, 12)}…`],
    ...manifest.layers.map(layer => {
      const descriptor = manifest.descriptors.layers[layer];
      return [descriptor.label, `${descriptor.units} · ${descriptor.verticalReference} · ${descriptor.timeSupport} · ${descriptor.methodId}`] as [string, string];
    }),
    ['Expires', manifest.expiresAt]
  );
  if (typeof source.provenanceUrl === 'string') {
    rows.push(['Source data', source.provenanceUrl]);
  } else if (typeof source.provenanceKey === 'string') {
    rows.push(['Source data', `${source.provenanceKey}${typeof source.provenanceSha256 === 'string' ? ` (${source.provenanceSha256.slice(0, 12)}…)` : ''}`]);
  }
  return rows;
}

export function formatSampleStatus(sample: FrameSampleLayer): string {
  if (sample.status === 'valid') return sample.value === null ? '—' : String(sample.value);
  if (sample.status === 'no-usable-lift') return 'no lift';
  if (sample.status === 'unavailable') return 'unavailable';
  return 'outside coverage';
}

export function formatSupportFlags(support: number): string {
  const flags: string[] = [];
  if (support & SUPPORT_PARCEL_CROSSING) flags.push('parcel');
  if (support & SUPPORT_PROFILE_TOP) flags.push('top');
  if (support & SUPPORT_PBL_CLOSURE) flags.push('PBL');
  if (support & SUPPORT_CUMULUS) flags.push('Cu');
  if (support & SUPPORT_OVERDEVELOPED) flags.push('OD');
  if (support & SUPPORT_CLOUD_CAPPED) flags.push('capped');
  return flags.join('+') || '—';
}

export function seriesTable(payload: { frames: readonly FrameSample[] }, layers: readonly string[], descriptors: ManifestV5['descriptors']['layers'] = {}): { headings: string[]; rows: string[][] } {
  const label = (layer: string) => {
    const spec = descriptors[layer];
    return spec ? `${spec.label} (${spec.units})` : layer;
  };
  return {
    headings: ['Frame', 'Valid', ...layers.map(label), ...layers.map(layer => `${label(layer)} status/support`)],
    rows: payload.frames.map(frame => [frame.id, frame.validTime, ...layers.map(layer => formatSampleStatus(frame.layers[layer])), ...layers.map(layer => {
      const value = frame.layers[layer];
      return `${value.status} / ${formatSupportFlags(value.support)}${value.interpolated ? ' / interpolated' : ''} / ${value.surfaceId}`;
    })])
  };
}

export const DEFAULT_OPACITY = 0.5;
export const OVERLAY_SOURCE_ID = 'av-overlay';
export const OVERLAY_LAYER_ID = 'av-overlay-raster';

export interface PreviewRasterSource {
  type: 'raster';
  tiles: string[];
  tileSize: number;
  minzoom: number;
  maxzoom: number;
  attribution: string;
}

export interface PreviewRasterLayer {
  id: string;
  type: 'raster';
  source: string;
  paint: Record<string, number>;
}

export interface WindyTileOptions {
  tileSize: number;
  detectRetina: boolean;
  minZoom: number;
  maxZoom: number;
  maxNativeZoom: number;
  opacity: number;
  attribution: string;
  minNativeZoom: number;
  zIndex?: number;
}

export function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OPACITY;
  return Math.min(1, Math.max(0, value));
}

export function frameTileUrl(template: string | undefined, frame: string): string {
  if (!template) throw new RangeError('Layer has no tile template');
  if (!template.includes('{frame}')) throw new RangeError('tile template is missing {frame}');
  if (!template.includes('{z}') || !template.includes('{x}') || !template.includes('{y}')) {
    throw new RangeError('tile template is missing {z}/{x}/{y}');
  }
  return template.split('{frame}').join(encodeURIComponent(frame));
}

export interface ViewportTile { z: number; x: number; y: number }

/** Enumerate at most 64 visible XYZ tiles for one world-width viewport. */
export function viewportTiles(bounds: { west: number; south: number; east: number; north: number }, zoom: number): ViewportTile[] {
  if (!Object.values(bounds).every(Number.isFinite) || !Number.isInteger(zoom) || zoom < 0 || zoom > 30 || bounds.north <= bounds.south) return [];
  const n = 2 ** zoom, east = bounds.east < bounds.west ? bounds.east + 360 : bounds.east;
  if (east <= bounds.west) return [];
  const x0 = Math.floor((bounds.west + 180) / 360 * n), x1 = Math.min(Math.ceil((east + 180) / 360 * n) - 1, x0 + n - 1);
  const yAt = (latitude: number) => Math.max(0, Math.min(n - 1, Math.floor((1 - Math.asinh(Math.tan(Math.max(-85.05112878, Math.min(85.05112878, latitude)) * Math.PI / 180)) / Math.PI) * n / 2)));
  const tiles: ViewportTile[] = [], y1 = yAt(bounds.south);
  for (let y = yAt(bounds.north); y <= y1 && tiles.length < 64; y++) {
    for (let x = x0; x <= x1 && tiles.length < 64; x++) tiles.push({ z: zoom, x, y });
  }
  return tiles;
}

/** Plan bounded tile warming in forecast-step, layer-toggle, then pan order. */
export function planViewportPrefetch(options: {
  build: PinnedBuild;
  activeLayer: LayerId;
  activeFrame: string;
  viewportTiles: readonly ViewportTile[];
}): string[] {
  const { build, activeLayer, activeFrame } = options, manifest = build.manifest;
  const frames = renderedFrames(manifest);
  const frameIndex = frames.findIndex(frame => frame.id === activeFrame);
  const rendered = renderedLayers(manifest.layers, manifest.descriptors.layers);
  if (frameIndex < 0 || !rendered.includes(activeLayer) || !build.templates[activeLayer]) return [];
  const urls = new Set<string>();
  const [west, south, east, north] = manifest.descriptors.bounds;
  function normalize(tile: ViewportTile, layer: LayerId): ViewportTile | undefined {
    if (![tile.z, tile.x, tile.y].every(Number.isSafeInteger) || tile.z < 0 || tile.z > 30) return;
    const { grid, coverage } = layerSurface(manifest, layer);
    const z = Math.min(tile.z, coverage.maxZoom), scale = 2 ** (tile.z - z), width = 2 ** z;
    let x = Math.floor(tile.x / scale);
    const y = Math.floor(tile.y / scale);
    if (grid.wrapLongitude) x = ((x % width) + width) % width;
    if (x < 0 || x >= width || y < 0 || y >= width) return;
    return { z, x, y };
  }
  const viewport = options.viewportTiles.slice(0, 64).flatMap(tile => { const valid = normalize(tile, activeLayer); return valid ? [valid] : []; });
  function add(layer: LayerId, frame: string | undefined, tile: ViewportTile): void {
    if (!frame || urls.size >= 64 || !build.templates[layer] || !rendered.includes(layer)) return;
    const valid = normalize(tile, layer);
    if (!valid) return;
    const { z, x, y } = valid, width = 2 ** z;
    const tileWest = x / width * 360 - 180, tileEast = (x + 1) / width * 360 - 180;
    const latitude = (row: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / width))) * 180 / Math.PI;
    const overlapsLongitude = west <= east ? tileEast > west && tileWest < east : tileEast > west || tileWest < east;
    if (!overlapsLongitude || latitude(y) <= south || latitude(y + 1) >= north) return;
    const template = frameTileUrl(build.templates[layer], frame);
    urls.add(template.replaceAll('{z}', String(z)).replaceAll('{x}', String(x)).replaceAll('{y}', String(y)));
  }
  const frame = (offset: number) => frames[frameIndex + offset]?.id;
  for (const offset of [1, -1]) for (const tile of viewport) add(activeLayer, frame(offset), tile);
  const sibling = activeLayer === 'usable-lift-agl' ? 'usable-lift-msl' : activeLayer === 'usable-lift-msl' ? 'usable-lift-agl' : undefined;
  if (sibling) for (const tile of viewport) add(sibling, activeFrame, tile);
  for (const tile of viewport) add(activeLayer, frame(2), tile);
  const visible = new Set(viewport.map(tile => `${tile.z}/${tile.x}/${tile.y}`));
  for (const tile of viewport) {
    for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
      const neighbor = normalize({ z: tile.z, x: tile.x + dx, y: tile.y + dy }, activeLayer);
      if (neighbor && !visible.has(`${neighbor.z}/${neighbor.x}/${neighbor.y}`)) add(activeLayer, activeFrame, neighbor);
    }
  }
  return [...urls];
}

export function previewRasterSource(template: string | undefined, frame: string, maxNativeZoom: number, attribution: string): PreviewRasterSource {
  if (!Number.isInteger(maxNativeZoom) || maxNativeZoom < 0) throw new RangeError('maxNativeZoom must be a non-negative integer');
  return {
    type: 'raster',
    tiles: [frameTileUrl(template, frame)],
    tileSize: RASTER_TILE_SIZE,
    minzoom: 0,
    maxzoom: maxNativeZoom,
    attribution
  };
}

export function previewRasterLayer(opacity = DEFAULT_OPACITY): PreviewRasterLayer {
  return {
    id: OVERLAY_LAYER_ID,
    type: 'raster',
    source: OVERLAY_SOURCE_ID,
    paint: {
      'raster-opacity': clampOpacity(opacity),
      'raster-fade-duration': 0
    }
  };
}

export function windyTileOptions(maxNativeZoom: number, opacity = DEFAULT_OPACITY, attribution: string): WindyTileOptions {
  if (!Number.isInteger(maxNativeZoom) || maxNativeZoom < 0) throw new RangeError('maxNativeZoom must be a non-negative integer');
  return {
    tileSize: RASTER_TILE_SIZE,
    detectRetina: false,
    minZoom: 0,
    maxZoom: 18,
    maxNativeZoom,
    minNativeZoom: 0,
    opacity: clampOpacity(opacity),
    attribution
  };
}

export function populateModelOptions(select: { add(option: unknown): void }): void {
  const OptionCtor = (globalThis as { Option?: new (text: string, value: string) => { disabled: boolean } }).Option;
  if (!OptionCtor) throw new Error('Global Option constructor is not available');
  for (const { label, modelId } of MODEL_OPTIONS) {
    const option = new OptionCtor(label, modelId);
    option.disabled = false;
    select.add(option);
  }
}
