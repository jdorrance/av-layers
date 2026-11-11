import { expect, it } from 'vitest';
import type { CoverageMask, ProductDefinition, RegularLatLonGrid } from '@av/contracts';
import { buildIntervalDaylightTimestampsMs, resolveProductFrameHours } from './daylight.js';

const product: Pick<ProductDefinition, 'frameHours' | 'intervalHours' | 'capabilities'> = {
  frameHours: [2, 8, 14, 22], intervalHours: 1,
  capabilities: { verticalCoordinate: 'model-levels', maxVerticalLevels: 3, daylightFrames: 'regional-daylight' }
};
const grid: RegularLatLonGrid = { kind: 'regular-latlon', earthRadiusM: 6371229, width: 1, height: 1, lon0: 0, lat0: 0, dx: 1, dy: -1, wrapLongitude: true };
const mask: CoverageMask = {
  grid, output: Uint8Array.of(1), halo: Uint8Array.of(0), tiles: Uint8Array.of(1), maxZoom: 0
};

it('uses declared daylight policy independently of grid wrapping or model identity', () => {
  const cycle = '2026-06-21T00:00:00Z';
  expect(resolveProductFrameHours(product, mask, cycle)).toEqual([8, 14]);
  const allHours = { ...product, capabilities: { ...product.capabilities, daylightFrames: 'all-hours' as const } };
  expect(resolveProductFrameHours(allHours, mask, cycle)).toEqual(product.frameHours);
});

it('preserves complete no-lift forecasts during polar night', () => {
  const polarMask: CoverageMask = { ...mask, grid: { ...grid, lat0: 89 } };
  expect(resolveProductFrameHours(product, polarMask, '2026-12-21T00:00:00Z')).toEqual(product.frameHours);
});

it('rejects an invalid cycle or non-finite daylight interval end timestamp', () => {
  expect(() => resolveProductFrameHours(product, mask, 'invalid')).toThrow('Invalid forecast cycle');
  expect(() => buildIntervalDaylightTimestampsMs(0, NaN)).toThrow('Daylight interval requires a finite end timestamp');
  expect(() => buildIntervalDaylightTimestampsMs(NaN, Date.UTC(2026, 5, 21, 12))).not.toThrow();
});
