import { expect, it } from 'vitest';
import { displayedWindSpeed } from './wind-speed';

it.each([
  ['metric', 3.6],
  ['imperial', 2.2369362921]
] as const)('truncates wind speed around integer thresholds in %s units', (units, factor) => {
  expect(displayedWindSpeed(9.7 / factor, 0, units)).toBe(9);
  expect(displayedWindSpeed(9.999 / factor, 0, units)).toBe(9);
  expect(displayedWindSpeed(10.001 / factor, 0, units)).toBe(10);
  expect(displayedWindSpeed(6.006 / factor, 8.008 / factor, units)).toBe(10);
});

it('rejects nonfinite wind components', () => {
  expect(displayedWindSpeed(NaN, 0, 'metric')).toBeNull();
  expect(displayedWindSpeed(0, Infinity, 'imperial')).toBeNull();
});
