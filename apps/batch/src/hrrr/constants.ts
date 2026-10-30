export const HRRR_MODEL = 'hrrr-conus' as const;
export const HRRR_BASE_URL = 'https://noaa-hrrr-bdp-pds.s3.amazonaws.com';
export const HRRR_PRODUCTS = Object.freeze({
  surface: 'wrfsfc',
  pressure: 'wrfprs',
});
export const HRRR_PRODUCT_NAMES = Object.freeze({
  surface: 'wrfsfc',
  pressure: 'wrfprs',
});
export const HRRR_MIN_FORECAST_HOUR = 1;
export const HRRR_MAX_DISCOVERY_HOUR = 48;
export const HRRR_CYCLE_LAG_HOURS = 1;
export const HRRR_CYCLE_CANDIDATES = 6;
export const HRRR_HUMIDITY_REPRESENTATION = 'dewpoint-2m' as const;
export const HRRR_FLUX_STATISTIC = 'instant' as const;
export const HRRR_INDEXING = 'hrrr-native-lambert-storage' as const;

export const HRRR_PRESSURE_LEVELS_HPA = Object.freeze([
  1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 725, 700, 675, 650,
  625, 600, 575, 550, 525, 500, 475, 450, 425, 400,
]) as readonly number[];

export const HRRR_NATIVE_GRID = Object.freeze({
  kind: 'lambert' as const,
  gridDefinitionTemplateNumber: 30,
  gridKey: '8c8b3013f8c77310',
  ni: 1799,
  nj: 1059,
  numberOfDataPoints: 1905141,
  scanningMode: 64,
  iScansNegatively: false,
  jScansPositively: true,
  jPointsAreConsecutive: false,
  alternativeRowScanning: false,
  resolutionAndComponentFlags: 8,
  uvRelativeToGrid: true,
  earthRadiusM: 6371229,
  latitudeOfFirstGridPoint: 21.138123,
  longitudeOfFirstGridPoint: 237.280472,
  laD: 38.5,
  loV: 262.5,
  dxM: 3000,
  dyM: 3000,
  projectionCentreFlag: 0,
  latin1: 38.5,
  latin2: 38.5,
  southPoleLatitude: 0,
  southPoleLongitude: 0,
});
