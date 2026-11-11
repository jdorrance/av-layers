import type { LambertConformalGrid } from '@av/contracts/geometry';

export const ARMENIA_LAMBERT = {
  kind: 'lambert-conformal', width: 180, height: 150, earthRadiusM: 6_370_000,
  centralMeridianDeg: 44.5, latitudeOfOriginDeg: 40.2, standardParallel1Deg: 39, standardParallel2Deg: 41.4,
  x0M: -270_000, y0M: -225_000, dxM: 3_000, dyM: 3_000, wrapLongitude: false
} satisfies LambertConformalGrid;

export const NEW_ZEALAND_LAMBERT = {
  kind: 'lambert-conformal', width: 400, height: 520, earthRadiusM: 6_370_000,
  centralMeridianDeg: 172.5, latitudeOfOriginDeg: -41.2, standardParallel1Deg: -44, standardParallel2Deg: -38,
  x0M: -600_000, y0M: -780_000, dxM: 3_000, dyM: 3_000, wrapLongitude: false
} satisfies LambertConformalGrid;
