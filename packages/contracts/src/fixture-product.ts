import { DEFAULT_PRODUCT } from './products.js';
import { renderedLayers, type ProductDefinition } from './index.js';

/** Explicit test/dev import only. Never added to the production product registry. */
export const OFFLINE_PRODUCT: ProductDefinition = {
  ...DEFAULT_PRODUCT,
  id: 'offline-analytic-fixture-v2',
  source: { modelFamily: 'synthetic', configurationId: 'synthetic-offline', domainId: 'synthetic-north-america' },
  label: 'SYNTHETIC offline fixture',
  attribution: 'Generated test values. Not weather data; do not use for flight decisions.',
  coverageDescription: 'Synthetic rectangular test grid; no land, terrain, or forecast claims.',
  bounds: [-130, 20, -60, 60],
  grid: { kind: 'regular-latlon', width: 8, height: 5, earthRadiusM: 6371229, lon0: -130, lat0: 60, dx: 10, dy: -10, wrapLongitude: false },
  coverageId: 'synthetic-offline-fixture', maxNativeZoom: 2,
  frameHours: [1, 2], intervalHours: 1, terrainSubdivisionFactor: 2,
  layers: [...renderedLayers(DEFAULT_PRODUCT.layers), 'sfc-temp-c'],
  capabilities: { verticalCoordinate: 'isobaric', maxVerticalLevels: 3, daylightFrames: 'all-hours' },
  freshness: { maxCycleAgeHours: 24, minHorizonHours: 0 }
};
