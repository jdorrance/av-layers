/** Explicit product comparisons; unknown forcing windows stay visible in related diagnostics. */
import type { ParameterMapping } from './core.js';

export const COMPARISON_MAPPINGS: readonly ParameterMapping[] = [
  { id: 'usable-lift-msl', leftParameter: 'usable-lift-msl', rightParameter: 'usable-lift-msl', comparability: 'related', timePolicy: 'valid-time',
    note: 'Usable dry thermal top at approximately 1.2 m/s. Terrain reconstruction and XC forcing windows differ or are undisclosed.' },
  { id: 'usable-lift-agl', leftParameter: 'usable-lift-agl', rightParameter: 'usable-lift-agl', comparability: 'related', timePolicy: 'valid-time', referencePolicy: 'provider-ground',
    note: 'Each provider reports clearance above its own ground. Ground source and XC forcing windows differ or are undisclosed.' },
  { id: 'thermal-top-msl', leftParameter: 'thermal-top-msl', rightParameter: 'thermal-top-msl', comparability: 'related', timePolicy: 'valid-time',
    note: 'Native convective top versus XC boundary-layer top; closure and forcing windows differ or are undisclosed.' },
  { id: 'sfc-temp-c', leftParameter: 'sfc-temp-c', rightParameter: 'sfc-temp-c', comparability: 'related',
    note: 'Native surface temperature and XC point/profile surface temperature have different spatial reconstruction.' },
  { id: 'bl-mean-wind-speed', leftParameter: 'derived-bl-mean-wind-speed', rightParameter: 'xc-bl-mean-wind-speed', comparability: 'related', referencePolicy: 'provider-ground',
    note: 'Magnitude of our sampled boundary-layer mean wind vector versus XC displayed mean wind speed. Ground, layer-top definitions and spatial sampling differ.' },
  { id: 'cloud-cover-total', leftParameter: 'cloud-cover-total', rightParameter: 'cloud-cover-total', comparability: 'related',
    note: 'Native total cloud cover versus XC total or maximum-profile cloud cover; vertical aggregation differs.' },
  { id: 'cloud-base-msl', leftParameter: 'surface-lcl-msl', rightParameter: 'xc-cloud-base-msl', comparability: 'related',
    note: 'Surface LCL versus conditional cumulus cloud base. XC absence of cloud remains unavailable for this numeric comparison.' },
  { id: 'cape-jkg', leftParameter: 'cape-jkg', rightParameter: 'cape-jkg', comparability: 'related',
    note: 'CAPE parcel selection differs by model and is unspecified in XC metadata.' },
  { id: 'precip-rate', leftParameter: 'precip-rate', rightParameter: 'xc-precipitation', comparability: 'unmapped',
    note: 'XC precipitation is displayed in mm over an unspecified period. Conversion to our mm/h requires its accumulation window.' }
];
