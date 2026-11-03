import { ICON_EU_GRID, ICON_EU_PRODUCT, ICON_EU_SETTINGS } from '@av/contracts';

export { ICON_EU_GRID, ICON_EU_PRODUCT, ICON_EU_SETTINGS };

export const ICON_EU_BASE_URL = ICON_EU_SETTINGS.upstream.baseUrl;
export const ICON_EU_GRID_TOKEN = ICON_EU_SETTINGS.upstream.gridToken;
export const ICON_EU_NATIVE_SCANNING_MODE = ICON_EU_SETTINGS.upstream.nativeScanningMode;

/**
 * Lowest 30 ICON-EU terrain-following model levels (45..74), ordered bottom-up (74 -> 45)
 * so level index 0 is closest to the surface and height increases monotonically with index.
 */
export const ICON_EU_MODEL_LEVELS: readonly number[] = Object.freeze(
  [...ICON_EU_SETTINGS.upstream.modelLevels].sort((a, b) => b - a)
);

/**
 * Half-level interfaces (45..75) bounding the 30 full model levels (45..74).
 * Level 75 coincides with model terrain (HSURF).
 */
export const ICON_EU_HALF_LEVELS: readonly number[] = Object.freeze(
  [...ICON_EU_SETTINGS.upstream.halfLevels].sort((a, b) => a - b)
);

export const ICON_EU_FORECAST_HOURS: readonly number[] = Object.freeze(
  ICON_EU_SETTINGS.forecast.hours
);
export const ICON_EU_INTERVAL_HOURS = ICON_EU_SETTINGS.forecast.intervalHours;
export const ICON_EU_CYCLE_HOURS_UTC: readonly number[] = Object.freeze(
  ICON_EU_SETTINGS.forecast.cycleHoursUtc
);
export const ICON_EU_FIELDS = Object.freeze(ICON_EU_SETTINGS.upstream.fields);
export const ICON_EU_DISCOVERY_LAG_HOURS = ICON_EU_SETTINGS.upstream.discoveryLagHours;
export const ICON_EU_DISCOVERY_CANDIDATES = ICON_EU_SETTINGS.upstream.discoveryCandidates;

/** Maximum compressed download or expanded single-field GRIB object. */
export const MAX_ICON_OBJECT_BYTES = 8 * 1024 * 1024;
