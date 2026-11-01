import { LAYERS, MODEL_IDS, normalizeLon, paletteBinLabel, type LayerId, type Manifest } from './index.ts';
import type { PaletteSummary, PinnedBuild, FrameSample, FrameSampleLayer, GeoPoint } from './client-types.ts';

export function noLiftLabel(color: string): string {
  return color.toLowerCase() === '#00000000' ? 'no usable lift (transparent)' : 'no usable lift';
}

export function paletteNoteText(palette: PaletteSummary): string | null {
  if (!palette.provisional && palette.transparentBelow === undefined) return null;
  if (palette.transparentBelow === undefined) return 'Provisional palette.';
  return `Transparent below ${palette.transparentBelow} ${palette.units}; provisional palette.`;
}

export function activePalettes(palettes: readonly PaletteSummary[], layerId: LayerId | string | null, descriptors: Manifest['descriptors']['layers'] = LAYERS as unknown as Manifest['descriptors']['layers']): readonly PaletteSummary[] {
  if (!layerId || !Object.hasOwn(descriptors, layerId)) return palettes;
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
  return `Coverage ${build.coverage.id}: ${build.manifest.descriptors.coverageDescription}`;
}

export function buildDiagnosticRows(build: PinnedBuild): Array<[string, string]> {
  const manifest = build.manifest;
  const grid = manifest.grid;
  const source = manifest.source as Record<string, unknown>;
  const model = typeof source.model === 'string' ? source.model : build.model.toUpperCase();
  const native = typeof source.nativeResolutionDeg === 'number' ? `${source.nativeResolutionDeg}° native columns` : 'native model columns';
  const validTimes = manifest.frames.map(f => Date.parse(f.validTime)).filter(Number.isFinite);
  const horizonEnd = validTimes.length > 0 ? new Date(Math.max(...validTimes)).toISOString() : manifest.cycle;
  const rows: Array<[string, string]> = [
    ['Build', manifest.buildId],
    ['Cycle', manifest.cycle],
    ['Horizon', `${manifest.frames[0]?.validTime ?? manifest.cycle} → ${horizonEnd}`],
    ['Method', `${manifest.method.id} · ${manifest.method.hash.slice(0, 12)}…`],
    ['Source', `${model} · ${native}`],
    ['Display', `z0–${build.maxNativeZoom} · 256 px raster · overzoomed above z${build.maxNativeZoom}`],
    ['Grid', grid.kind === 'regular-latlon' ? `${grid.width} × ${grid.height} · ${grid.dx}° × ${Math.abs(grid.dy)}° regular latitude/longitude` : `${grid.width} × ${grid.height} · ${Math.abs(grid.dxM)} × ${Math.abs(grid.dyM)} m Lambert conformal`],
    ['Coverage', manifest.descriptors.coverageDescription],
    ['Recipe', `${manifest.recipe.id} · ${manifest.recipe.hash.slice(0, 12)}…`],
    ...manifest.layers.map(layer => {
      const descriptor = manifest.descriptors.layers[layer];
      return [descriptor.label, `${descriptor.units} · ${descriptor.verticalReference} · ${descriptor.timeSupport} · ${descriptor.methodId}`] as [string, string];
    }),
    ['Expires', manifest.expiresAt]
  ];
  if (typeof source.provenanceUrl === 'string') {
    rows.push(['Provenance', source.provenanceUrl]);
  } else if (typeof source.provenanceKey === 'string') {
    rows.push(['Provenance', `${source.provenanceKey}${typeof source.provenanceSha256 === 'string' ? ` (${source.provenanceSha256.slice(0, 12)}…)` : ''}`]);
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
  if (support & 4) flags.push('parcel');
  if (support & 8) flags.push('top');
  if (support & 16) flags.push('PBL');
  return flags.join('+') || '—';
}

export function formatSeriesSummary(
  payload: { frames: readonly FrameSample[]; method: unknown; coverage: unknown; expiresAt: string },
  layers: readonly string[],
  point: GeoPoint
): string {
  const method = payload.method as { id?: unknown } | null;
  const coverage = payload.coverage as { id?: unknown } | null;
  return `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)} · ${payload.frames.length} frames × ${layers.length} layers · method ${String(method?.id ?? 'unknown')} · coverage ${String(coverage?.id ?? 'unknown')} · expires ${payload.expiresAt}`;
}

/** Pure presentation models shared by the two independent host controllers. */
export function paletteLegend(palette: PaletteSummary): { title: string; rows: { color: string; label: string }[]; note: string | null } {
  const rows = palette.colors.map((color, index) => ({ color, label: paletteBinLabel(palette.edges, palette.colors.length, index) }));
  if (palette.noLiftColor) rows.push({ color: palette.noLiftColor, label: noLiftLabel(palette.noLiftColor) });
  return { title: `${palette.id} · ${palette.units}`, rows, note: paletteNoteText(palette) };
}

export function seriesTable(payload: { frames: readonly FrameSample[] }, layers: readonly string[], descriptors: Manifest['descriptors']['layers'] = {}): { headings: string[]; rows: string[][] } {
  const label = (layer: string) => descriptors[layer] ? `${descriptors[layer].label} (${descriptors[layer].units})` : layer;
  return {
    headings: ['Frame', 'Valid', ...layers.map(label), ...layers.map(layer => `${label(layer)} status/support`)],
    rows: payload.frames.map(frame => [frame.id, frame.validTime, ...layers.map(layer => formatSampleStatus(frame.layers[layer])), ...layers.map(layer => {
      const value = frame.layers[layer];
      return `${value.status} / ${formatSupportFlags(value.support)}${value.interpolated ? ' / interpolated' : ''}`;
    })])
  };
}

export function sampleRequestText(build: PinnedBuild, point: GeoPoint): string {
  return `Requesting ${build.manifest.frames.length} frames × ${build.manifest.layers.length} layers at ${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}…`;
}

export const PREVIEW_TILE_SIZE = 256;
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
}

export function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OPACITY;
  return Math.min(1, Math.max(0, value));
}

export function frameTileUrl(template: string, frame: string): string {
  if (!template.includes('{frame}')) throw new RangeError('tile template is missing {frame}');
  if (!template.includes('{z}') || !template.includes('{x}') || !template.includes('{y}')) {
    throw new RangeError('tile template is missing {z}/{x}/{y}');
  }
  return template.split('{frame}').join(encodeURIComponent(frame));
}

export function previewRasterSource(template: string, frame: string, maxNativeZoom: number, attribution: string): PreviewRasterSource {
  if (!Number.isInteger(maxNativeZoom) || maxNativeZoom < 0) throw new RangeError('maxNativeZoom must be a non-negative integer');
  return {
    type: 'raster',
    tiles: [frameTileUrl(template, frame)],
    tileSize: PREVIEW_TILE_SIZE,
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
    tileSize: PREVIEW_TILE_SIZE,
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
  for (const model of MODEL_IDS) {
    const option = new OptionCtor(model.toUpperCase(), model);
    option.disabled = false;
    select.add(option);
  }
}
