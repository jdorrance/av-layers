import z from 'zod';
import { MAX_GRID_CELLS, regularLatLonGridSchema, type ModelDefinition } from '@av/contracts';
import { AUX_SURFACE_UNITS, AUX_LEVEL_UNITS } from '@av/forecast/inputs';

const field = z.object({ field: z.string().min(1), kind: z.enum(['time-invariant', 'single-level', 'model-level']),
  parameter: z.tuple([z.number().int(), z.number().int()]),
  surface: z.union([z.tuple([z.number().int()]), z.tuple([z.number().int(), z.number().nullable()]),
    z.tuple([z.number().int(), z.number().nullable(), z.number().int()]), z.tuple([z.number().int(), z.number().nullable(), z.number().int(), z.number().nullable()])]),
  statistic: z.number().int().optional() }).strict();
const flux = field.extend({ scale: z.union([z.literal(1), z.literal(-1)]) });
const auxiliary = field.omit({ statistic: true }).extend({ unit: z.string().min(1), scale: z.number().finite().positive().default(1) });
const auxSurfaceSchema = z.partialRecord(z.enum(Object.keys(AUX_SURFACE_UNITS) as [keyof typeof AUX_SURFACE_UNITS, ...Array<keyof typeof AUX_SURFACE_UNITS>]),
  auxiliary.extend({ kind: z.literal('single-level'), statistic: z.literal(2).optional() }));
const auxLevelsSchema = z.partialRecord(z.enum(Object.keys(AUX_LEVEL_UNITS) as [keyof typeof AUX_LEVEL_UNITS, ...Array<keyof typeof AUX_LEVEL_UNITS>]), auxiliary.extend({ kind: z.literal('model-level') }));
const upstreamSchema = z.object({ protocol: z.literal('split-grib2'), provider: z.string().min(1), centre: z.number().int().nonnegative(),
  urlTemplate: z.string().url(), modelLevels: z.array(z.number().int().positive()).min(1).max(256),
  nativeGrid: z.object({ number: z.number().int().nonnegative().max(65535), uuid: z.string().regex(/^[a-f0-9]{32}$/),
    pointCount: z.number().int().positive().max(MAX_GRID_CELLS),
    latitude: field.extend({ kind: z.literal('time-invariant') }), longitude: field.extend({ kind: z.literal('time-invariant') }) }).strict().optional(),
  discoveryLagHours: z.number().nonnegative(), discoveryCandidates: z.number().int().min(1).max(24),
  auxSurface: auxSurfaceSchema.optional(), auxLevels: auxLevelsSchema.optional(),
  fields: z.object({ staticTerrain: field, halfLevelHeight: field, surfacePressure: field, temperature2m: field,
    specificHumidity2m: field, sensibleHeatFlux: flux, latentHeatFlux: flux, temperature: field, pressure: field,
    precipitation: field.extend({ kind: z.literal('single-level'), statistic: z.literal(1) }).optional() }).strict()
}).strict();

export function splitSource(model: ModelDefinition) {
  if (model.capabilities.verticalCoordinate !== 'model-levels') throw new Error('Split GRIB input requires model-level fields');
  const upstream = upstreamSchema.parse(model.upstream), grid = regularLatLonGridSchema.parse(model.grid);
  if (model.layers.includes('precip-rate') && !upstream.fields.precipitation) throw new Error('Split GRIB precipitation requires its accumulation descriptor');
  const modelLevels = [...new Set(upstream.modelLevels)].sort((a, b) => b - a);
  if (modelLevels.length !== model.capabilities.maxVerticalLevels) throw new Error('Selected model levels differ from the declared source budget');
  const halfLevels = [...new Set(modelLevels.flatMap(level => [level, level + 1]))].sort((a, b) => a - b);
  for (const [configured, units] of [[upstream.auxSurface, AUX_SURFACE_UNITS], [upstream.auxLevels, AUX_LEVEL_UNITS]] as const) {
    for (const [name, spec] of Object.entries(configured ?? {})) {
      if (spec.unit !== units[name as keyof typeof units]) throw new Error(`Invalid auxiliary Split GRIB units ${name}`);
      if ('statistic' in spec && spec.statistic !== undefined && name !== 'gust10mMps') throw new Error('Split GRIB interval maximum is supported for wind gusts');
    }
  }
  for (const [fields, u, v] of [[upstream.auxSurface, 'u10mMps', 'v10mMps'], [upstream.auxLevels, 'uWindMps', 'vWindMps']] as const) {
    if (Object.hasOwn(fields ?? {}, u) !== Object.hasOwn(fields ?? {}, v)) throw new Error('Auxiliary Split GRIB wind components must be configured together');
  }
  const coreFields = Object.values(upstream.fields).filter(value => value !== undefined);
  const configuredFields = [...coreFields, ...Object.values(upstream.auxSurface ?? {}), ...Object.values(upstream.auxLevels ?? {}),
    ...(upstream.nativeGrid ? [upstream.nativeGrid.latitude, upstream.nativeGrid.longitude] : [])];
  if (new Set(configuredFields.map(spec => spec.field)).size !== configuredFields.length) throw new Error('Duplicate Split GRIB source field');
  const specs = Object.fromEntries(configuredFields.map(value => [value.field, { field: value.field, kind: value.kind,
    discipline: 0, parameterCategory: value.parameter[0], parameterNumber: value.parameter[1], templateNumber: 'statistic' in value && value.statistic !== undefined ? 8 : 0,
    firstFixedSurfaceType: value.surface[0], firstFixedSurfaceValue: value.surface[1] ?? null, secondFixedSurfaceType: value.surface[2] ?? 255,
    secondFixedSurfaceValue: value.surface.length === 4 ? value.surface[3] : undefined,
    normalization: 'unit' in value ? { units: value.unit, scale: value.scale } : undefined,
    statisticalProcessCode: 'statistic' in value ? value.statistic ?? null : null }]));
  const fields = Object.fromEntries(Object.entries(upstream.fields).filter(([, spec]) => spec !== undefined).map(([role, spec]) => [role, spec!.field])) as Record<Exclude<keyof typeof upstream.fields, 'precipitation'>, string> & { precipitation?: string };
  return { model, upstream, grid, modelLevels, halfLevels, specs, fields };
}
export type SplitSource = ReturnType<typeof splitSource>;
export const MAX_SPLIT_OBJECT_BYTES = 8 * 1024 * 1024;
