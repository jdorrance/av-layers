/** Physical constants used by the dry-air kernels and published method descriptors. */
export const THERMODYNAMIC_CONSTANTS = Object.freeze({
  waterDryAirMolarMassRatio: 0.622,
  dryAirGasConstantJkgK: 287.05,
  dryAirHeatCapacityJkgK: 1004,
  latentHeatVaporizationJkg: 2501000,
  gravityMps2: 9.80665,
  kelvinOffset: 273.15,
  pascalsPerHectopascal: 100,
  dryLapseRateKperM: 0.0098,
  saturationVaporPressureScaleHpa: 6.112,
  saturationExponent: 17.67,
  saturationTemperatureOffsetC: 243.5
} as const);

export const ZERO_CELSIUS_K = THERMODYNAMIC_CONSTANTS.kelvinOffset;
export const GRAVITY_MPS2 = THERMODYNAMIC_CONSTANTS.gravityMps2;
export const DRY_AIR_GAS_CONSTANT = THERMODYNAMIC_CONSTANTS.dryAirGasConstantJkgK;
export const DRY_AIR_CP = THERMODYNAMIC_CONSTANTS.dryAirHeatCapacityJkgK;
export const WATER_DRY_AIR_MOLAR_MASS_RATIO = THERMODYNAMIC_CONSTANTS.waterDryAirMolarMassRatio;
export const PASCALS_PER_HECTOPASCAL = THERMODYNAMIC_CONSTANTS.pascalsPerHectopascal;
export const STANDARD_PRESSURE_HPA = 1000;
export const POISSON_EXPONENT_DRY_AIR = DRY_AIR_GAS_CONSTANT / DRY_AIR_CP;

/** Conventional rounded dry lapse rate; deliberately distinct from exact g/c_p. */
export const DRY_LAPSE_RATE_K_PER_M = THERMODYNAMIC_CONSTANTS.dryLapseRateKperM;
