import { PRODUCTS, RASTER_TILE_SIZE, SUPPORT_PARCEL_CROSSING, SUPPORT_PROFILE_TOP, SUPPORT_PBL_CLOSURE, normalizeLon, paletteBinLabel, type LayerId, type Manifest } from './index.ts';
import type { PaletteSummary, PinnedBuild, FrameSample, FrameSampleLayer, GeoPoint } from './client-types.ts';
import { compilePaletteColor, samplePaletteValueInto } from './palette-color.ts';

export function noLiftLabel(color: string): string {
  return color.toLowerCase() === '#00000000' ? 'no usable lift (transparent)' : 'no usable lift';
}

export function paletteNoteText(palette: PaletteSummary): string | null {
  if (!palette.provisional && palette.transparentBelow === undefined) return null;
  if (palette.transparentBelow === undefined) return 'Provisional palette.';
  return `Transparent below ${palette.transparentBelow} ${palette.units}; provisional palette.`;
}

export function activePalettes(palettes: readonly PaletteSummary[], layerId: string | null, descriptors: Manifest['descriptors']['layers']): readonly PaletteSummary[] {
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
  const manifest = build.manifest;
  const ids = manifest.version === 5 ? manifest.surfaces.map(surface => surface.coverage.id).join(', ') : manifest.coverage.id;
  return `Coverage ${ids}: ${manifest.descriptors.coverageDescription}`;
}

export function layerMaxZoom(manifest: PinnedBuild['manifest'], layer: LayerId): number {
  if (manifest.version !== 5) return manifest.coverage.maxZoom;
  const surface = manifest.surfaces.find(surface => surface.layers.includes(layer));
  if (!surface) throw new Error(`No surface owns ${layer}`);
  return surface.coverage.maxZoom;
}

function gridSpacing(grid: Manifest['grid']): string {
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
  if (manifest.version === 5) {
    for (const surface of manifest.surfaces) {
      rows.push([`Surface ${surface.id}`, `${surface.grid.width} × ${surface.grid.height} · ${gridSpacing(surface.grid)} · ${surface.layers.join(', ')} · z0–${surface.coverage.maxZoom}`]);
    }
  } else {
    rows.push(
      ['Display', `z0–${manifest.coverage.maxZoom} · ${RASTER_TILE_SIZE} px raster · overzoomed above z${manifest.coverage.maxZoom}`],
      ['Grid', manifest.grid.kind === 'regular-latlon' ? `${manifest.grid.width} × ${manifest.grid.height} · ${gridSpacing(manifest.grid)} regular latitude/longitude` : `${manifest.grid.width} × ${manifest.grid.height} · ${gridSpacing(manifest.grid)} Lambert conformal`]
    );
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
  for (const patch of manifest.version === 5 ? [] : manifest.patches ?? []) {
    rows.push([`Refinement ${patch.id}`, `${patch.grid.width} × ${patch.grid.height} · ${patch.method.id}`]);
    for (const layer of patch.layers) {
      const descriptor = patch.descriptors.layers[layer];
      rows.push([`${patch.id} · ${descriptor.label}`, `${descriptor.units} · ${descriptor.verticalReference} · ${descriptor.methodId}`]);
    }
  }
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
  return flags.join('+') || '—';
}

export function formatSeriesSummary(
  payload: { frames: readonly FrameSample[]; method: unknown; coverage?: unknown; surfaces?: readonly { id: string }[]; expiresAt: string },
  layers: readonly string[],
  point: GeoPoint
): string {
  const method = payload.method as { id?: unknown } | null;
  const coverage = payload.coverage as { id?: unknown } | null;
  const patches = [...new Set(payload.frames.flatMap(frame => layers.flatMap(layer => { const value = frame.layers[layer]; return value && 'patchId' in value && value.patchId ? [value.patchId] : []; })))];
  return `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)} · ${payload.frames.length} frames × ${layers.length} layers · ${patches.length ? 'base method' : 'method'} ${String(method?.id ?? 'unknown')}${patches.length ? ` · refinement ${patches.join(', ')}` : ''} · coverage ${payload.surfaces?.map(surface => surface.id).join(', ') ?? String(coverage?.id ?? 'unknown')} · expires ${payload.expiresAt}`;
}

/** Pure presentation models shared by the two independent host controllers. */
export function paletteLegend(palette: PaletteSummary): {
  title: string;
  rows: { color: string; label: string }[];
  gradient?: { background: string; minimum: string; maximum: string };
  note: string | null;
} {
  const rows: { color: string; label: string }[] = [];
  let gradient: { background: string; minimum: string; maximum: string } | undefined;
  if (palette.interpolation === 'linear-rgb' && palette.colors.length > 1) {
    const compiled = compilePaletteColor(palette, 'linear-rgb'), color = new Uint8Array(4);
    const first = compiled.edges[0], last = compiled.edges[compiled.colorCount - 1];
    const stops: string[] = [];
    for (let interval = 0; interval < compiled.colorCount - 1; interval++) {
      for (let step = 0; step < 16; step++) {
        const fraction = step / 16;
        const value = compiled.edges[interval] + fraction * (compiled.edges[interval + 1] - compiled.edges[interval]);
        samplePaletteValueInto(compiled, value, color);
        stops.push(`rgba(${color[0]},${color[1]},${color[2]},${color[3] / 255}) ${100 * (value - first) / (last - first)}%`);
      }
    }
    samplePaletteValueInto(compiled, last, color);
    stops.push(`rgba(${color[0]},${color[1]},${color[2]},${color[3] / 255}) 100%`);
    gradient = {
      background: `linear-gradient(90deg,${stops.join(',')})`,
      minimum: `${first} ${palette.units}`,
      maximum: `≥ ${last} ${palette.units}`
    };
  } else {
    rows.push(...palette.colors.map((color, index) => ({ color, label: paletteBinLabel(palette.edges, palette.colors.length, index) })));
  }
  if (palette.noLiftColor) rows.push({ color: palette.noLiftColor, label: noLiftLabel(palette.noLiftColor) });
  return { title: `${palette.id} · ${palette.units}`, rows, ...(gradient ? { gradient } : {}), note: paletteNoteText(palette) };
}

export function seriesTable(payload: { frames: readonly FrameSample[] }, layers: readonly string[], descriptors: Manifest['descriptors']['layers'] = {}, patches: Manifest['patches'] = []): { headings: string[]; rows: string[][] } {
  const descriptor = (layer: string, patchId?: string) => patchId ? patches.find(patch => patch.id === patchId)?.descriptors.layers[layer] : descriptors[layer];
  const label = (layer: string) => {
    const value = payload.frames[0]?.layers[layer];
    const spec = descriptor(layer, value && 'patchId' in value ? value.patchId : undefined);
    return spec ? `${spec.label} (${spec.units})` : layer;
  };
  return {
    headings: ['Frame', 'Valid', ...layers.map(label), ...layers.map(layer => `${label(layer)} status/support`)],
    rows: payload.frames.map(frame => [frame.id, frame.validTime, ...layers.map(layer => formatSampleStatus(frame.layers[layer])), ...layers.map(layer => {
      const value = frame.layers[layer];
      const patchId = 'patchId' in value ? value.patchId : undefined;
      const spec = descriptor(layer, patchId);
      return `${value.status} / ${formatSupportFlags(value.support)}${value.interpolated ? ' / interpolated' : ''}${patchId && spec ? ` / ${patchId} · ${spec.verticalReference} · ${spec.methodId}` : ''}${'surfaceId' in value ? ` / ${value.surfaceId}` : ''}`;
    })])
  };
}

export function sampleRequestText(build: PinnedBuild, point: GeoPoint): string {
  return `Requesting ${build.manifest.frames.length} frames × ${build.manifest.layers.length} layers at ${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}…`;
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
  for (const product of PRODUCTS) {
    const option = new OptionCtor(product.label, product.modelId);
    option.disabled = false;
    select.add(option);
  }
}
