import { GFS_PRODUCT, type ProductDefinition } from './index.js';

/** Explicit test/dev import only. Never added to the production product registry. */
export const OFFLINE_PRODUCT: ProductDefinition = {
  ...GFS_PRODUCT,
  id: 'offline-analytic-fixture-v1',
  source: { modelFamily: 'gfs', configurationId: 'synthetic-offline', domainId: 'synthetic-north-america' },
  label: 'SYNTHETIC offline fixture',
  attribution: 'Generated test values. Not weather data; do not use for flight decisions.',
  coverageDescription: 'Synthetic rectangular test grid; no land, terrain, or forecast claims.',
  bounds: [-130, 20, -60, 60],
  grid: { kind: 'regular-latlon', width: 8, height: 5, earthRadiusM: 6371229, lon0: -130, lat0: 60, dx: 10, dy: -10, wrapLongitude: false },
  coverageId: 'synthetic-offline-fixture', maxNativeZoom: 2,
  frameHours: [1, 2], intervalHours: 1,
  freshness: { maxCycleAgeHours: 24, minHorizonHours: 0 }
};
