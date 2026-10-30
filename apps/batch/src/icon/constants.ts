import type { Grid } from '@av/contracts';
import type { IconBounds } from './types.ts';

export const ICON_BASE = 'https://opendata.dwd.de/weather/nwp/v1/m/icon-eu/p/';
export const ICON_GRID_BASE = 'http://icon-downloads.mpimet.mpg.de/';

export const ICON_ARMENIA_BBOX: IconBounds = Object.freeze({
  west: 43.25,
  south: 38.5,
  east: 46.75,
  north: 41.5,
});

export const ICON_ARMENIA_EXPORT_GRID: Grid = Object.freeze({
  width: 57,
  height: 49,
  lon0: 43.25,
  lat0: 41.5,
  dx: 0.0625,
  dy: -0.0625,
  wrapLongitude: false,
});

export const ICON_LEVELS = Object.freeze(Array.from({ length: 30 }, (_, i) => 45 + i));
export const ICON_HALF_LEVELS = Object.freeze([...ICON_LEVELS, 75]);
export const ICON_LEVEL_NUMBERS_ASCENDING = Object.freeze([...ICON_LEVELS].reverse());

export const ICON_ARMENIA_FORECAST_HOURS = Object.freeze([3, 6, 9, 12, 15, 18, 21, 24]);
export const ICON_ARMENIA_INTERVAL_HOURS = 3;
export const ICON_ARMENIA_MAX_CELLS = 12_000;
export const ICON_ARMENIA_MAX_EXPORT_DISTANCE_DEG = 0.3;

export const ICON_SURFACE_FIELDS = Object.freeze(['T_2M', 'TD_2M', 'PS', 'MH']);
export const ICON_STAT_FIELDS = Object.freeze(['ASHFL_S', 'ALHFL_S', 'TOT_PREC']);
export const ICON_NATIVE_LEVEL_FIELDS = Object.freeze(['P', 'T']);
export const ICON_REQUIRED_FIELDS = Object.freeze([
  'CLAT',
  'CLON',
  'HSURF',
  'HHL',
  'T_2M',
  'TD_2M',
  'PS',
  'MH',
  'ASHFL_S',
  'ALHFL_S',
  'TOT_PREC',
  'P',
  'T',
]);

export const ICON_UNITS = Object.freeze({
  CLAT: 'degrees_north',
  CLON: 'degrees_east',
  HSURF: 'm',
  HHL: 'm',
  T_2M: 'K',
  TD_2M: 'K',
  PS: 'Pa',
  MH: 'm',
  ASHFL_S: 'W m**-2',
  ALHFL_S: 'W m**-2',
  TOT_PREC: 'kg m**-2',
  P: 'Pa',
  T: 'K',
});

export const ICON_SHORT_NAMES = Object.freeze({
  CLAT: 'CLAT',
  CLON: 'CLON',
  HSURF: 'HSURF',
  HHL: 'HHL',
  T_2M: '2t',
  TD_2M: '2d',
  PS: 'sp',
  MH: 'mld',
  ASHFL_S: 'avg_ishf',
  ALHFL_S: 'avg_slhtf',
  TOT_PREC: 'tp',
  P: 'pres',
  T: 't',
});

export const ICON_ATTRIBUTION = Object.freeze({
  data: {
    provider: 'DWD',
    product: 'ICON-EU',
    access: ICON_BASE,
    attribution: 'DWD, CC BY 4.0',
  },
  reuse: {
    repository: '/Users/johndorrance/projects/flying/windgrams',
    revision: '32fdd75db7a4a1a302ae901b969b0f6625712368',
    paths: [
      'packages/providers/src/internal/icon-native.ts',
      'packages/providers/src/internal/icon-decode.py',
    ],
    publicLicense: null,
    licenseStatus: 'no-public-license-found',
    notMIT: true,
    attribution:
      'Narrowly reused for the native ICON Armenian patch under the windgrams source revision above; no public license was found in windgrams, so this reuse is recorded as attribution only and not as MIT.',
  },
});
