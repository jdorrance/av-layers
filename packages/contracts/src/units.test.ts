import { expect, it } from 'vitest';
import { CALM_BARB_KNOTS, displayedWindSpeed, quantizedBarbSpeed } from './units.ts';

it.each([['metric', 3.6], ['imperial', 2.2369362921]] as const)('keeps integer speed boundaries in %s', (units, factor) => {
  expect(displayedWindSpeed(0, units)).toBe(0);
  expect(displayedWindSpeed(9.999 / factor, units)).toBe(9);
  expect(displayedWindSpeed(10.001 / factor, units)).toBe(10);
});

it('quantizes WMO/ICAO knot speeds with a 2.5 kt calm threshold', () => {
  expect(CALM_BARB_KNOTS).toBe(2.5);
  for (const calm of [0, 0.1, 0.4, 1, 2.49]) expect(quantizedBarbSpeed(calm)).toBe(0);
  for (const half of [2.5, 5, 7.49]) expect(quantizedBarbSpeed(half)).toBe(5);
  for (const full of [7.5, 10, 12.49]) expect(quantizedBarbSpeed(full)).toBe(10);
  expect(quantizedBarbSpeed(20)).toBe(20);
  expect(quantizedBarbSpeed(50)).toBe(50);
  expect(quantizedBarbSpeed(NaN)).toBe(0);
});

it('rejects invalid speeds and conversion overflow', () => {
  for (const speed of [NaN, Infinity, -1, Number.MAX_VALUE]) expect(displayedWindSpeed(speed, 'metric')).toBeNull();
});
