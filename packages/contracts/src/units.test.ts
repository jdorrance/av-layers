import { expect, it } from 'vitest';
import { displayedWindSpeed } from './units.ts';

it.each([['metric', 3.6], ['imperial', 2.2369362921]] as const)('keeps integer speed boundaries in %s', (units, factor) => {
  expect(displayedWindSpeed(0, units)).toBe(0);
  expect(displayedWindSpeed(9.999 / factor, units)).toBe(9);
  expect(displayedWindSpeed(10.001 / factor, units)).toBe(10);
});

it('rejects invalid speeds and conversion overflow', () => {
  for (const speed of [NaN, Infinity, -1, Number.MAX_VALUE]) expect(displayedWindSpeed(speed, 'metric')).toBeNull();
});
