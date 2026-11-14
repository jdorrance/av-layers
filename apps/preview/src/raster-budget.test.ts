import { expect, it } from 'vitest';
import type { Map } from 'maplibre-gl';
import { RASTER_TILE_SIZE } from '@av/contracts/format';
import { WIND_NUMERIC_BYTES } from '@av/client/wind';
import { canRetainRasterOverview, rasterSourceLimit, VIEWPORT_BYTES, WIND_CANVAS_BYTES, WIND_CANVAS_PIXELS, WIND_TRAIL_PIXELS } from './raster-budget';

const map = (count: number) => ({ coveringTiles: () => ({ length: count }) }) as unknown as Pick<Map, 'coveringTiles'>;

it('reserves Retina wind canvases and numeric cache within the viewport envelope and charges warm hidden cache honestly', () => {
  expect(WIND_CANVAS_PIXELS).toBe(8_388_608);
  expect(WIND_TRAIL_PIXELS).toBe(2_097_152);
  expect(WIND_CANVAS_BYTES).toBe(32 * 1024 * 1024);
  expect(WIND_NUMERIC_BYTES + WIND_CANVAS_BYTES).toBe(40 * 1024 * 1024);
  expect(VIEWPORT_BYTES).toBe(120 * 1024 * 1024);
  const raster = VIEWPORT_BYTES - WIND_NUMERIC_BYTES - WIND_CANVAS_BYTES;
  expect(raster).toBe(80 * 1024 * 1024);
  expect(rasterSourceLimit(map(24), 12)).toBe(4);
  expect(rasterSourceLimit(map(25), 12)).toBe(3);
  expect(rasterSourceLimit(map(64), 12)).toBe(2);
  const tile = RASTER_TILE_SIZE ** 2 * 4 * 2;
  const maximum = raster / tile - 16;
  expect(rasterSourceLimit(map(maximum), 12)).toBe(1);
  expect(rasterSourceLimit(map(maximum + 1), 12)).toBe(0);
  expect(canRetainRasterOverview(map((raster - 24 * 1024 * 1024) / tile - 16), 12)).toBe(true);
  expect(canRetainRasterOverview(map((raster - 24 * 1024 * 1024) / tile - 15), 12)).toBe(false);
  // Hidden wind with warm WindDataCache reclaims 32 MiB canvas reserve while keeping 8 MiB numeric cache charged.
  const warmHiddenMax = (VIEWPORT_BYTES - WIND_NUMERIC_BYTES) / tile - 16;
  expect(rasterSourceLimit(map(warmHiddenMax), 12, false, false, true)).toBe(1);
  expect(rasterSourceLimit(map(warmHiddenMax + 1), 12, false, false, true)).toBe(0);
  // Non-numeric or cleared wind reclaims the full 40 MiB reserve.
  expect(rasterSourceLimit(map(warmHiddenMax + 1), 12, false, false, false)).toBe(1);
  expect(canRetainRasterOverview(map((raster - 24 * 1024 * 1024) / tile - 15), 12, false)).toBe(true);
  expect(rasterSourceLimit({} as Pick<Map, 'coveringTiles'>, 12)).toBe(0);
});
