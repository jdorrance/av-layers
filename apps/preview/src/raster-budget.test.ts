import { expect, it } from 'vitest';
import type { Map } from 'maplibre-gl';
import { RASTER_TILE_SIZE } from '@av/contracts/format';
import { WIND_NUMERIC_BYTES } from '@av/client/wind';
import { canRetainRasterOverview, rasterSourceLimit, VIEWPORT_BYTES, WIND_CANVAS_BYTES } from './raster-budget';

const map = (count: number) => ({ coveringTiles: () => ({ length: count }) }) as unknown as Pick<Map, 'coveringTiles'>;

it('reserves wind within the viewport envelope and bounds raster admission', () => {
  expect(WIND_NUMERIC_BYTES + WIND_CANVAS_BYTES).toBe(16 * 1024 * 1024);
  expect(VIEWPORT_BYTES).toBe(96 * 1024 * 1024);
  const raster = VIEWPORT_BYTES - WIND_NUMERIC_BYTES - WIND_CANVAS_BYTES;
  expect(rasterSourceLimit(map(24), 12)).toBe(4);
  expect(rasterSourceLimit(map(25), 12)).toBe(3);
  expect(rasterSourceLimit(map(64), 12)).toBe(2);
  const tile = RASTER_TILE_SIZE ** 2 * 4 * 2;
  const maximum = raster / tile - 16;
  expect(rasterSourceLimit(map(maximum), 12)).toBe(1);
  expect(rasterSourceLimit(map(maximum + 1), 12)).toBe(0);
  expect(canRetainRasterOverview(map((raster - 24 * 1024 * 1024) / tile - 16), 12)).toBe(true);
  expect(canRetainRasterOverview(map((raster - 24 * 1024 * 1024) / tile - 15), 12)).toBe(false);
  expect(rasterSourceLimit({} as Pick<Map, 'coveringTiles'>, 12)).toBe(0);
});
