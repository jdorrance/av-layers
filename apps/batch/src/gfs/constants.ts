import { GFS_GRID, GFS_SETTINGS } from '@av/contracts';

export { GFS_GRID };
export const GFS_PRIMARY_LEVELS_HPA: readonly number[] = Object.freeze(GFS_SETTINGS.upstream.primaryPressureLevelsHpa);
export const GFS_SECONDARY_LEVELS_HPA: readonly number[] = Object.freeze(GFS_SETTINGS.upstream.secondaryPressureLevelsHpa);
export const GFS_PRESSURE_LEVELS_HPA: readonly number[] = Object.freeze([...new Set([...GFS_PRIMARY_LEVELS_HPA, ...GFS_SECONDARY_LEVELS_HPA])].sort((a, b) => b - a));
export const GFS_FORECAST_HOURS: readonly number[] = Object.freeze(GFS_SETTINGS.forecast.hours);
export const GFS_CYCLE_HOURS_UTC: readonly number[] = Object.freeze(GFS_SETTINGS.forecast.cycleHoursUtc);
export const GFS_INTERVAL_HOURS = GFS_SETTINGS.forecast.intervalHours;
export const GFS_STATISTICS_RESET_HOURS = GFS_SETTINGS.forecast.statisticsResetHours;
export const GFS_PRODUCTS = Object.freeze(GFS_SETTINGS.upstream.products);
export type GfsProductName = typeof GFS_PRODUCTS[keyof typeof GFS_PRODUCTS];

/** NOAA orders the same cells from 0° longitude; the public grid starts at -180°. */
export const GFS_NATIVE_GRID = Object.freeze({
  ni: GFS_GRID.width, nj: GFS_GRID.height,
  lon0: GFS_SETTINGS.upstream.nativeLongitudeOrigin, lat0: GFS_GRID.lat0,
  dlon: GFS_GRID.dx, dlat: GFS_GRID.dy, earthRadiusM: GFS_GRID.earthRadiusM
});
export const NOAA_GFS_BASE_URL = GFS_SETTINGS.upstream.baseUrl;
export const GFS_DISCOVERY_LAG_HOURS = GFS_SETTINGS.upstream.discoveryLagHours;
export const GFS_DISCOVERY_CANDIDATES = GFS_SETTINGS.upstream.discoveryCandidates;
