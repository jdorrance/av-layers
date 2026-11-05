/** Native point channels and their physical method groups. */
export const NATIVE_LAYERS = {
  'thermal-velocity': ['Thermal velocity', 'thermal-velocity', 'm/s', 'model-AGL', 'soaring'],
  'thermal-top-msl': ['Thermal top', 'thermal-top', 'm MSL', 'MSL', 'soaring'],
  'pbl-height-agl': ['Boundary-layer height', 'boundary-layer-height', 'm AGL', 'model-AGL', 'soaring'],
  'sensible-heat-flux': ['Sensible heat flux', 'upward-sensible-heat-flux', 'W/m2', 'surface', 'soaring'],
  'latent-heat-flux': ['Latent heat flux', 'upward-latent-heat-flux', 'W/m2', 'surface', 'soaring'],
  'surface-lcl-msl': ['Surface LCL', 'lifting-condensation-level', 'm MSL', 'MSL', 'cloud'],
  'cape-jkg': ['CAPE', 'convective-available-potential-energy', 'J/kg', 'surface', 'surface'],
  'cloud-cover-total': ['Total cloud cover', 'cloud-cover-total', '%', 'surface', 'surface'],
  'cloud-cover-low': ['Low cloud cover', 'cloud-cover-low', '%', 'surface', 'surface'],
  'sfc-temp-c': ['Surface temperature', 'air-temperature', 'degC', 'surface', 'surface'],
  'sfc-dewpoint-c': ['Surface dewpoint', 'dew-point-temperature', 'degC', 'surface', 'surface'],
  'mslp-hpa': ['Mean sea-level pressure', 'air-pressure', 'hPa', 'MSL', 'surface'],
  'wind-10m-u': ['10 m eastward wind', 'eastward-wind', 'm/s', 'model-AGL', 'wind'],
  'wind-10m-v': ['10 m northward wind', 'northward-wind', 'm/s', 'model-AGL', 'wind'],
  'wind-gust-10m': ['10 m wind gust', 'wind-gust', 'm/s', 'model-AGL', 'wind'],
  'bl-mean-wind-u': ['Boundary-layer mean eastward wind', 'eastward-wind', 'm/s', 'model-AGL', 'wind'],
  'bl-mean-wind-v': ['Boundary-layer mean northward wind', 'northward-wind', 'm/s', 'model-AGL', 'wind'],
} as const;

export type NativeLayerId = keyof typeof NATIVE_LAYERS;
export type NativeMethodGroup = (typeof NATIVE_LAYERS)[NativeLayerId][4];
export const NATIVE_LAYER_IDS = Object.keys(NATIVE_LAYERS) as NativeLayerId[];
export const nativeMethodId = (group: NativeMethodGroup, coordinate: 'isobaric' | 'model-levels' = 'isobaric') =>
  `native-${group}${coordinate === 'model-levels' ? '-model-levels' : ''}-v1`;

export function nativeLayerTimeSupport(id: NativeLayerId): 'valid-time' | 'interval-mean' | 'interval-flux-endpoint-profile' {
  return id.endsWith('heat-flux') ? 'interval-mean' : id.startsWith('thermal-') ? 'interval-flux-endpoint-profile' : 'valid-time';
}
