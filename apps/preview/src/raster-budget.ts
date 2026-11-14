import type { Map } from 'maplibre-gl';
import { RASTER_TILE_SIZE } from '@av/contracts/format';
import { WIND_NUMERIC_BYTES } from '@av/client/wind';

export const RASTER_CACHE_TILES = 16;
export const MAX_RASTER_SOURCES = 4;
export const WIND_TRAIL_PIXELS = 2 * 1024 * 1024;
export const WIND_CANVAS_PIXELS = 8 * 1024 * 1024;
export const WIND_CANVAS_BYTES = WIND_CANVAS_PIXELS * 4;
export const VIEWPORT_BYTES = 120 * 1024 * 1024;
const WIND_RESERVE_BYTES = WIND_NUMERIC_BYTES + WIND_CANVAS_BYTES;
const OVERVIEW_BYTES = 24 * 1024 * 1024;

const retainedBytes = (windActive: boolean, numericResident = windActive): number =>
  VIEWPORT_BYTES - (windActive ? WIND_RESERVE_BYTES : numericResident ? WIND_NUMERIC_BYTES : 0);

/** Admit a prepared window using covering tiles plus offscreen cache allowance, reclaiming freed canvas/wind memory. */
export function rasterSourceLimit(map: Pick<Map, 'coveringTiles'>, maxzoom: number, overview = false, windActive = true, numericResident = windActive): number {
  if (!map.coveringTiles) return 0;
  return Math.max(0, Math.min(MAX_RASTER_SOURCES - Number(overview), Math.floor((retainedBytes(windActive, numericResident) - (overview ? OVERVIEW_BYTES : 0)) / sourceBytes(map, maxzoom))));
}

export function canRetainRasterOverview(map: Pick<Map, 'coveringTiles'>, maxzoom: number, windActive = true, numericResident = windActive): boolean {
  return !!map.coveringTiles && sourceBytes(map, maxzoom) + OVERVIEW_BYTES <= retainedBytes(windActive, numericResident);
}

function sourceBytes(map: Pick<Map, 'coveringTiles'>, maxzoom: number): number {
  return (map.coveringTiles({ tileSize: RASTER_TILE_SIZE, minzoom: 0, maxzoom, roundZoom: true }).length + RASTER_CACHE_TILES) * RASTER_TILE_SIZE ** 2 * 4 * 2;
}
