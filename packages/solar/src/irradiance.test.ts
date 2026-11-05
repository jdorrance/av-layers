import { expect, it } from 'vitest';
import { airMass, azimuthWeights, clearSky, litFraction, onSurface, withClouds } from './irradiance.ts';
import parity from './irradiance-parity.json';

it('preserves Windgrams irradiance across night, low sun, altitude, cloud and slope controls', () => {
  for (const row of parity) {
    const clear = clearSky(row.sun, row.altitudeM), sky = withClouds(clear, row.sun.elevationDeg, row.cloudFraction);
    for (const field of ['dni', 'dhi', 'ghi'] as const) {
      expect(clear[field]).toBeCloseTo(row.clear[field], 10);
      expect(sky[field]).toBeCloseTo(row.sky[field], 10);
    }
    expect(onSurface(sky, [0.5, 0.5, Math.SQRT1_2], 0, 0, 1, 1, 1)).toBeCloseTo(row.flat, 10);
    expect(onSurface(sky, [0.5, 0.5, Math.SQRT1_2], -0.5, -0.5, Math.SQRT1_2, 0.7, 0.4)).toBeCloseTo(row.slope, 10);
  }
});

it('wraps azimuth interpolation and softens the horizon crossing', () => {
  expect(azimuthWeights(-1, 18)).toEqual(azimuthWeights(359, 18));
  expect(azimuthWeights(360, 18)).toEqual({ i0: 0, i1: 1, w: 0 });
  expect(azimuthWeights(90, 18)).toEqual({ i0: 4, i1: 5, w: 0.5 });
  expect([-1, -0.5, 0, 0.5, 1].map(elevation => litFraction(elevation, 0))).toEqual([0, 0, 0.5, 1, 1]);
  expect(airMass(90)).toBe(Infinity);
  expect(airMass(0)).toBeCloseTo(1, 3);
});
