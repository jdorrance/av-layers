import type { Map } from 'maplibre-gl';
import { RASTER_TILE_SIZE } from '@av/contracts/format';
import { WIND_NUMERIC_BYTES } from '@av/client/wind';

export const RASTER_CACHE_TILES = 16;
export const MAX_RASTER_SOURCES = 4;
export const WIND_CANVAS_BYTES = 8 * 1024 * 1024;
// Forecast rasters, numeric fields and wind canvases share the existing logical envelope.
export const VIEWPORT_BYTES = 96 * 1024 * 1024;
const RETAINED_RASTER_BYTES = VIEWPORT_BYTES - WIND_NUMERIC_BYTES - WIND_CANVAS_BYTES;
const OVERVIEW_BYTES = 24 * 1024 * 1024;

/** Admit a prepared window using covering tiles plus offscreen cache allowance. */
export function rasterSourceLimit(map: Pick<Map, 'coveringTiles'>, maxzoom: number, overview = false): number {
  if (!map.coveringTiles) return 0;
  const bytes = sourceBytes(map, maxzoom);
  return Math.max(0, Math.min(MAX_RASTER_SOURCES - Number(overview), Math.floor((RETAINED_RASTER_BYTES - (overview ? OVERVIEW_BYTES : 0)) / bytes)));
}

export function canRetainRasterOverview(map: Pick<Map, 'coveringTiles'>, maxzoom: number): boolean {
  return !!map.coveringTiles && sourceBytes(map, maxzoom) + OVERVIEW_BYTES <= RETAINED_RASTER_BYTES;
}

function sourceBytes(map: Pick<Map, 'coveringTiles'>, maxzoom: number): number {
  const tiles = map.coveringTiles({ tileSize: RASTER_TILE_SIZE, minzoom: 0, maxzoom, roundZoom: true }).length;
  return (tiles + RASTER_CACHE_TILES) * RASTER_TILE_SIZE ** 2 * 4 * 2;
}
