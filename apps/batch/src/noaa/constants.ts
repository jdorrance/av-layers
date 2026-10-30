export const GFS_PRIMARY_LEVELS_HPA = Object.freeze([
  1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400,
]) as readonly number[];

export const GFS_SECONDARY_LEVELS_HPA = Object.freeze([
  875, 825, 775, 725, 675, 625,
]) as readonly number[];

export const GFS_PRESSURE_LEVELS_HPA = Object.freeze([
  1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 725, 700, 675, 650,
  625, 600, 550, 500, 450, 400,
]) as readonly number[];

export const GFS_FORECAST_HOURS = Object.freeze([3, 6, 9, 12, 15, 18, 21, 24]) as readonly number[];
export const GFS_CYCLE_HOURS_UTC = Object.freeze([0, 6, 12, 18]) as readonly number[];

export const GFS_PRODUCTS = Object.freeze({
  primary: 'pgrb2.0p25',
  secondary: 'pgrb2b.0p25',
} as const);

export const GFS_CONTRACT_GRID = Object.freeze({
  width: 1440,
  height: 721,
  lon0: -180,
  lat0: 90,
  dx: 0.25,
  dy: -0.25,
  wrapLongitude: true,
});

export const GFS_NATIVE_GRID = Object.freeze({
  ni: 1440,
  nj: 721,
  lon0: 0,
  lat0: 90,
  dlon: 0.25,
  dlat: -0.25,
  earthRadiusM: 6371229,
});

export const NOAA_GFS_BASE_URL = 'https://noaa-gfs-bdp-pds.s3.amazonaws.com';
export const GFS_DISCOVERY_LAG_HOURS = 4;
export const GFS_DISCOVERY_CANDIDATES = 6;
