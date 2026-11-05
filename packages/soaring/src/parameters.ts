/** Dry-column validation and Lenschow defaults shared with method descriptors. */
export const DEFAULT_SOARING_PARAMETERS = Object.freeze({
  sinkRateMps: 1.2,
  minimumThermalVelocityMps: 0,
  lenschowScale: 4,
  lenschowShape: 0.8,
  lenschowPeakZeta: 0.3125,
  saturationRelativeTolerance: 1e-6,
  minimumSurfaceTemperatureC: -100,
  maximumSurfaceTemperatureC: 60,
  minimumSurfacePressureHpa: 100,
  maximumSurfacePressureHpa: 1100,
  minimumProfileTemperatureC: -120,
  maximumProfileTemperatureC: 60,
  maximumProfileGapM: 1000,
  crossingFloat32UnitRoundoff: 2 ** -24,
  crossingEpsilonMultiplier: 8,
  maximumBisectionIterations: 60
} as const);

/** Native Windgrams V2 closures; source moments belong to one normalized frame. */
export const NATIVE_DIAGNOSTIC_PARAMETERS = Object.freeze({
  minimumLevelAglM: 20,
  minimumThermalLevels: 3,
  shallowLatentHeatCoefficient: 245268e-9,
  shallowTemperaturePerFlux: 0.012,
  maximumShallowTemperatureC: 1.5,
  mixedLayerPoissonExponent: 0.2854,
  nearSaturationSpreadC: 0.5,
  overdevelopmentRelativeHumidityPercent: 85,
  minimumShearMps: 0.2,
  cloudCapSinkRateMps: 1,
  sourceWindHeightAglM: 10,
  boundaryLayerWindAnchorAglM: 0
} as const);
