import z from 'zod';
import { THERMODYNAMIC_CONSTANTS } from '@av/thermodynamics/constants';
import { DEFAULT_SOARING_PARAMETERS } from '@av/soaring/parameters';
import { DEFAULT_HORIZON_DEG } from '@av/solar/parameters';

/** Current adapter outputs only. Isobaric pressure levels are a shared coordinate;
 * terrain-following model levels supply per-column pressures with an explicit mask.
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
  pressurePa: { id: 'pressurePa', quantity: 'air-pressure', units: 'Pa', dimensions: 'level-cell', verticalReference: 'terrain-following model levels', timeSupport: 'valid-time', missingness: 'explicit-cell-mask' },
  hgtM: { id: 'hgtM', quantity: 'geopotential-height', units: 'm', dimensions: 'level-cell', verticalReference: 'MSL at profile levels (isobaric or model levels)', timeSupport: 'valid-time', missingness: 'explicit-cell-mask' },
  tempK: { id: 'tempK', quantity: 'air-temperature', units: 'K', dimensions: 'level-cell', verticalReference: 'profile levels (isobaric or model levels)', timeSupport: 'valid-time', missingness: 'explicit-cell-mask' }
} as const;
export type NormalizedInputId = keyof typeof NORMALIZED_INPUTS;
for (const input of Object.values(NORMALIZED_INPUTS)) Object.freeze(input);
Object.freeze(NORMALIZED_INPUTS);

/** Descriptors publish the same defaults that the pure kernels consume. */
export const LIFT_METHOD_PARAMETERS = Object.freeze({
  ...THERMODYNAMIC_CONSTANTS,
  ...DEFAULT_SOARING_PARAMETERS,
  minimumSolarElevationDeg: DEFAULT_HORIZON_DEG
});
export const PRECIPITATION_METHOD_PARAMETERS = Object.freeze({
  minimumRateMmPerHour: 0,
  minimumSolarElevationDeg: DEFAULT_HORIZON_DEG
} as const);

const precipitationInputs = ['precipitationMmPerHour'] as const satisfies readonly NormalizedInputId[];
const liftCaveats = Object.freeze([
  'Dry parcel calculation; no moist parcel or cloud treatment.',
  'Evaluated only for cells in daylight across the trailing flux interval or valid time (solar elevation above minimumSolarElevationDeg); nighttime cells emit no-lift without column evaluation.',
  'Interval-mean surface fluxes are paired with the endpoint profile and PBL, and usable lift requires Lenschow updraft velocity to exceed sinkRateMps (and w* above minimumThermalVelocityMps).',
  'PBL may be missing unless the first resolved profile level is neutral or stable; that branch uses the smaller of its height and the PBL depth.',
  'A profile without a resolved crossing is capped at its highest usable level and flagged.',
  'MSL and model-AGL outputs share one column evaluation; model terrain is not a high-resolution terrain correction.'
] as const);

function defineLiftMethod<const Id extends string>(id: Id, pressureInput: 'pressureLevelsHpa' | 'pressurePa') {
  const inputs = ['terrainM', 'surfacePressurePa', 'temp2mK', 'specificHumidity2mKgKg', 'pblHeightM', 'sensibleHeatFluxWm2', 'latentHeatFluxWm2', pressureInput, 'hgtM', 'tempK'] as const satisfies readonly NormalizedInputId[];
  return Object.freeze({
    id,
    requiredInputs: Object.freeze(inputs),
    inputs: Object.freeze(Object.fromEntries(inputs.map(id => [id, NORMALIZED_INPUTS[id]]))),
    outputs: Object.freeze(['usable-lift-msl', 'usable-lift-agl'] as const),
    spatialSupport: 'column',
    parameters: LIFT_METHOD_PARAMETERS,
    caveats: liftCaveats
  } as const);
}
export const LIFT_METHOD = defineLiftMethod('dry-lenschow-pbl-1p2-v1', 'pressureLevelsHpa');
export const MODEL_LEVEL_LIFT_METHOD = defineLiftMethod('dry-lenschow-pbl-1p2-model-levels-v1', 'pressurePa');

export const PRECIPITATION_METHOD = Object.freeze({
  id: 'trailing-precipitation-rate-v1',
  requiredInputs: Object.freeze(precipitationInputs),
  inputs: Object.freeze(Object.fromEntries(precipitationInputs.map(id => [id, NORMALIZED_INPUTS[id]]))),
  outputs: Object.freeze(['precip-rate'] as const),
  spatialSupport: 'column',
  parameters: PRECIPITATION_METHOD_PARAMETERS,
  caveats: Object.freeze([
    'The adapter supplies liquid-water-equivalent rate for the declared trailing interval, including any accumulation differencing.',
    'Evaluated only for cells in daylight across the trailing interval or valid time (solar elevation above minimumSolarElevationDeg); nighttime cells are marked unavailable and skipped.',
    'Negative, non-finite or explicitly missing rates are unavailable; no temporal interpolation is implied.'
  ])
} as const);
export const METHODS = Object.freeze({ [LIFT_METHOD.id]: LIFT_METHOD, [MODEL_LEVEL_LIFT_METHOD.id]: MODEL_LEVEL_LIFT_METHOD, [PRECIPITATION_METHOD.id]: PRECIPITATION_METHOD });
export const LIFT_METHODS_BY_VERTICAL_COORDINATE = Object.freeze({
  isobaric: LIFT_METHOD,
  'model-levels': MODEL_LEVEL_LIFT_METHOD
} as const);
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
