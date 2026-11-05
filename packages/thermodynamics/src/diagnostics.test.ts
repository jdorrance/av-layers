import { expect, it } from 'vitest';
import {
  boltonLclHeightMetersAgl, dewPointFromMixingRatioC, dewPointFromSpecificHumidityC,
  geometricWFromOmegaMps, mixingRatioFromDewPointKgKg, omegaFromGeometricWPaS
} from './index.js';

it('uses the Bolton condensation temperature with a saturated zero-height limit', () => {
  expect(boltonLclHeightMetersAgl(24, 12)).toBeCloseTo(1497.3572468263962, 8);
  expect(boltonLclHeightMetersAgl(20, 20)).toBe(0);
  expect(boltonLclHeightMetersAgl(20, 21)).toBe(0);
  expect(boltonLclHeightMetersAgl(-274, -280)).toBeNaN();
});

it('round-trips moisture using the shared vapor-pressure constants', () => {
  for (const td of [-50, 0, 25]) {
    const r = mixingRatioFromDewPointKgKg(td, 925);
    expect(dewPointFromMixingRatioC(r, 925)).toBeCloseTo(td, 10);
    expect(dewPointFromSpecificHumidityC(r / (1 + r), 925)).toBeCloseTo(td, 10);
  }
  expect(mixingRatioFromDewPointKgKg(25, 1)).toBeNaN();
  expect(dewPointFromSpecificHumidityC(1, 1000)).toBeNaN();
  expect(dewPointFromSpecificHumidityC(0, 1000)).toBeNaN();
});

it('converts omega with dry density and an upward-positive sign', () => {
  const density = 85000 / (287.05 * 283.15);
  expect(geometricWFromOmegaMps(-0.5, 850, 10)).toBeCloseTo(0.5 / (density * 9.80665), 12);
  expect(geometricWFromOmegaMps(0, 850, 10)).toBe(0);
  expect(geometricWFromOmegaMps(1, 0, 10)).toBeNaN();
  expect(geometricWFromOmegaMps(1, 850, -273.15)).toBeNaN();
  expect(omegaFromGeometricWPaS(0.5 / (density * 9.80665), 850, 10)).toBeCloseTo(-0.5, 12);
  expect(geometricWFromOmegaMps(omegaFromGeometricWPaS(-2.5, 925, 22), 925, 22)).toBeCloseTo(-2.5, 12);
  expect(omegaFromGeometricWPaS(0, 850, 10)).toBe(0);
  expect(omegaFromGeometricWPaS(1, 0, 10)).toBeNaN();
});
