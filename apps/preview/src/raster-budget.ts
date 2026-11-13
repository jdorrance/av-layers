import type { Map } from 'maplibre-gl';
import { RASTER_TILE_SIZE } from '@av/contracts/format';

export const RASTER_CACHE_TILES = 16;
export const MAX_RASTER_SOURCES = 4;
const RETAINED_RASTER_BYTES = 96 * 1024 * 1024;

/** Admit a prepared window using covering tiles plus offscreen cache allowance. */
export function rasterSourceLimit(map: Pick<Map, 'coveringTiles'>, maxzoom: number): number {
  if (!map.coveringTiles) return 2;
  const tiles = map.coveringTiles({ tileSize: RASTER_TILE_SIZE, minzoom: 0, maxzoom, roundZoom: true }).length;
  const bytes = (tiles + RASTER_CACHE_TILES) * RASTER_TILE_SIZE ** 2 * 4 * 2;
  return Math.max(1, Math.min(MAX_RASTER_SOURCES, Math.floor(RETAINED_RASTER_BYTES / bytes)));
}
