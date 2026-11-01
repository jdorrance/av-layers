import z from 'zod';

/** Current adapter outputs only. Pressure levels are a coordinate, not a sampled field.
 * Missing cell values have an explicit mask; a masked PBL value is permitted until
 * the first-level closure needs it. No vector field/basis is admitted yet.
 */
export const NORMALIZED_INPUTS = {
  terrainM: { id: 'terrainM', quantity: 'geopotential-height', units: 'm', dimensions: 'cell', verticalReference: 'MSL', timeSupport: 'static', missingness: 'explicit-cell-mask' },
  surfacePressurePa: { id: 'surfacePressurePa', quantity: 'air-pressure', units: 'Pa', dimensions: 'cell', verticalReference: 'surface', timeSupport: 'valid-time', missingness: 'explicit-cell-mask' },
  temp2mK: { id: 'temp2mK', quantity: 'air-temperature', units: 'K', dimensions: 'cell', verticalReference: '2 m model AGL', timeSupport: 'valid-time', missingness: 'explicit-cell-mask' },
  specificHumidity2mKgKg: { id: 'specificHumidity2mKgKg', quantity: 'specific-humidity', units: 'kg/kg', dimensions: 'cell', verticalReference: '2 m model AGL', timeSupport: 'valid-time', missingness: 'explicit-cell-mask' },
  pblHeightM: { id: 'pblHeightM', quantity: 'boundary-layer-depth', units: 'm', dimensions: 'cell', verticalReference: 'model AGL', timeSupport: 'valid-time', missingness: 'explicit-cell-mask' },
  sensibleHeatFluxWm2: { id: 'sensibleHeatFluxWm2', quantity: 'upward-sensible-heat-flux', units: 'W/m2', dimensions: 'cell', verticalReference: 'surface', timeSupport: 'interval-mean', missingness: 'explicit-cell-mask' },
  latentHeatFluxWm2: { id: 'latentHeatFluxWm2', quantity: 'upward-latent-heat-flux', units: 'W/m2', dimensions: 'cell', verticalReference: 'surface', timeSupport: 'interval-mean', missingness: 'explicit-cell-mask' },
  precipitationMmPerHour: { id: 'precipitationMmPerHour', quantity: 'liquid-water-equivalent-precipitation-rate', units: 'mm/h', dimensions: 'cell', verticalReference: 'surface', timeSupport: 'interval-mean', missingness: 'explicit-cell-mask' },
  pressureLevelsHpa: { id: 'pressureLevelsHpa', quantity: 'air-pressure-coordinate', units: 'hPa', dimensions: 'level', verticalReference: 'strictly decreasing isobaric levels', timeSupport: 'static', missingness: 'all-levels-required' },
  hgtM: { id: 'hgtM', quantity: 'geopotential-height', units: 'm', dimensions: 'level-cell', verticalReference: 'MSL at isobaric levels', timeSupport: 'valid-time', missingness: 'explicit-cell-mask' },
  tempK: { id: 'tempK', quantity: 'air-temperature', units: 'K', dimensions: 'level-cell', verticalReference: 'isobaric levels', timeSupport: 'valid-time', missingness: 'explicit-cell-mask' }
} as const;
export type NormalizedInputId = keyof typeof NORMALIZED_INPUTS;
for (const input of Object.values(NORMALIZED_INPUTS)) Object.freeze(input);
Object.freeze(NORMALIZED_INPUTS);

/** These exact values are consumed by the column kernel, never copied into it. */
export const LIFT_METHOD_PARAMETERS = Object.freeze({
  sinkRateMps: 1.2,
  lenschowScale: 4,
  lenschowShape: 0.8,
  lenschowPeakZeta: 0.3125,
  waterDryAirMolarMassRatio: 0.622,
  dryAirGasConstantJkgK: 287.05,
  dryAirHeatCapacityJkgK: 1004,
  latentHeatVaporizationJkg: 2501000,
  gravityMps2: 9.80665,
  kelvinOffset: 273.15,
  pascalsPerHectopascal: 100,
  dryLapseRateKperM: 0.0098,
  saturationRelativeTolerance: 1e-6,
  saturationVaporPressureScaleHpa: 6.112,
  saturationExponent: 17.67,
  saturationTemperatureOffsetC: 243.5,
  minimumSurfaceTemperatureC: -100,
  maximumSurfaceTemperatureC: 60,
  minimumSurfacePressureHpa: 100,
  maximumSurfacePressureHpa: 1100,
  minimumProfileTemperatureC: -120,
  maximumProfileTemperatureC: 60,
  maximumProfileGapM: 1000,
  crossingEpsilonMultiplier: 8,
  maximumBisectionIterations: 60
} as const);
export const PRECIPITATION_METHOD_PARAMETERS = Object.freeze({ minimumRateMmPerHour: 0 } as const);

const liftInputs = ['terrainM', 'surfacePressurePa', 'temp2mK', 'specificHumidity2mKgKg', 'pblHeightM', 'sensibleHeatFluxWm2', 'latentHeatFluxWm2', 'pressureLevelsHpa', 'hgtM', 'tempK'] as const satisfies readonly NormalizedInputId[];
const precipitationInputs = ['precipitationMmPerHour'] as const satisfies readonly NormalizedInputId[];
export const LIFT_METHOD = Object.freeze({
  id: 'dry-lenschow-pbl-1p2-v1',
  requiredInputs: Object.freeze(liftInputs),
  inputs: Object.freeze(Object.fromEntries(liftInputs.map(id => [id, NORMALIZED_INPUTS[id]]))),
  outputs: Object.freeze(['usable-lift-msl', 'usable-lift-agl'] as const),
  spatialSupport: 'column',
  parameters: LIFT_METHOD_PARAMETERS,
  caveats: Object.freeze([
    'Dry parcel calculation; no moist parcel or cloud treatment.',
    'Interval-mean surface fluxes are paired with the endpoint profile and PBL.',
    'PBL may be missing unless the first resolved profile level is neutral or stable; that branch uses the smaller of its height and the PBL depth.',
    'A profile without a resolved crossing is capped at its highest usable level and flagged.',
    'MSL and model-AGL outputs share one column evaluation; model terrain is not a high-resolution terrain correction.'
  ])
} as const);
export const PRECIPITATION_METHOD = Object.freeze({
  id: 'trailing-precipitation-rate-v1',
  requiredInputs: Object.freeze(precipitationInputs),
  inputs: Object.freeze(Object.fromEntries(precipitationInputs.map(id => [id, NORMALIZED_INPUTS[id]]))),
  outputs: Object.freeze(['precip-rate'] as const),
  spatialSupport: 'column',
  parameters: PRECIPITATION_METHOD_PARAMETERS,
  caveats: Object.freeze([
    'The adapter supplies liquid-water-equivalent rate for the declared trailing interval, including any accumulation differencing.',
    'Negative, non-finite or explicitly missing rates are unavailable; no temporal interpolation is implied.'
  ])
} as const);
export const METHODS = Object.freeze({ [LIFT_METHOD.id]: LIFT_METHOD, [PRECIPITATION_METHOD.id]: PRECIPITATION_METHOD });
export type MethodId = keyof typeof METHODS;
/** Wire snapshots describe their own inputs and parameters. Do not compare a
 * retained build with today's constants or require its old executable kernel.
 */
export const methodIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/);
const inputIdSchema = z.string().regex(/^[a-z][A-Za-z0-9_-]{0,63}$/);
const parameterKeySchema = z.string().regex(/^[a-z][A-Za-z0-9_]{0,63}$/);
export const normalizedInputSchema = z.object({
  id: inputIdSchema, quantity: z.string().min(1).max(80), units: z.string().min(1).max(24),
  dimensions: z.enum(['cell', 'level', 'level-cell']), verticalReference: z.string().min(1).max(80),
  timeSupport: z.enum(['static', 'valid-time', 'interval-mean']), missingness: z.enum(['explicit-cell-mask', 'all-levels-required'])
}).strict();

export const methodDescriptorSchema = z.object({
  id: methodIdSchema,
  requiredInputs: z.array(inputIdSchema).min(1).max(16),
  inputs: z.record(inputIdSchema, normalizedInputSchema),
  outputs: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).min(1).max(16),
  spatialSupport: z.literal('column'),
  parameters: z.record(parameterKeySchema, z.number().finite()),
  caveats: z.array(z.string().min(1).max(512)).min(1).max(8)
}).strict().superRefine((method, ctx) => {
  const required = new Set(method.requiredInputs), definitions = Object.entries(method.inputs);
  if (required.size !== method.requiredInputs.length || definitions.length !== required.size
      || definitions.some(([id, input]) => !required.has(id) || input.id !== id)) {
    ctx.addIssue({ code: 'custom', path: ['requiredInputs'], message: 'Method input dependencies are incomplete or duplicated' });
  }
  if (new Set(method.outputs).size !== method.outputs.length) ctx.addIssue({ code: 'custom', path: ['outputs'], message: 'Method outputs are duplicated' });
  if (Object.keys(method.parameters).length > 32) ctx.addIssue({ code: 'custom', path: ['parameters'], message: 'Method parameter budget exceeded' });
});
