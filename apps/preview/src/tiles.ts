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

export function previewRasterSource(template: string, frame: string, maxNativeZoom: number): PreviewRasterSource {
  if (!Number.isInteger(maxNativeZoom) || maxNativeZoom < 0) throw new RangeError('maxNativeZoom must be a non-negative integer');
  return {
    type: 'raster',
    tiles: [frameTileUrl(template, frame)],
    tileSize: PREVIEW_TILE_SIZE,
    minzoom: 0,
    maxzoom: maxNativeZoom,
    attribution: 'NOAA GFS · derived usable lift/precip · provisional'
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

export function windyTileOptions(maxNativeZoom: number, opacity = DEFAULT_OPACITY): WindyTileOptions {
  if (!Number.isInteger(maxNativeZoom) || maxNativeZoom < 0) throw new RangeError('maxNativeZoom must be a non-negative integer');
  return {
    tileSize: PREVIEW_TILE_SIZE,
    detectRetina: false,
    minZoom: 0,
    maxZoom: 18,
    maxNativeZoom,
    minNativeZoom: 0,
    opacity: clampOpacity(opacity),
    attribution: 'NOAA GFS · derived usable lift/precip · provisional'
  };
}
