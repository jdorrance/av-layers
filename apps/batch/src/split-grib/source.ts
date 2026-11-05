import z from 'zod';
import { regularLatLonGridSchema, type ModelDefinition } from '@av/contracts';

const field = z.object({ field: z.string().min(1), kind: z.enum(['time-invariant', 'single-level', 'model-level']),
  parameter: z.tuple([z.number().int(), z.number().int()]),
  surface: z.union([z.tuple([z.number().int()]), z.tuple([z.number().int(), z.number().nullable()]), z.tuple([z.number().int(), z.number().nullable(), z.number().int()])]),
  statistic: z.number().int().optional() }).strict();
const flux = field.extend({ scale: z.union([z.literal(1), z.literal(-1)]) });
const upstreamSchema = z.object({ protocol: z.literal('split-grib2'), provider: z.string().min(1), centre: z.number().int().nonnegative(),
  urlTemplate: z.string().url(), modelLevels: z.array(z.number().int().positive()).min(1).max(256),
  discoveryLagHours: z.number().nonnegative(), discoveryCandidates: z.number().int().min(1).max(24),
  fields: z.object({ staticTerrain: field, halfLevelHeight: field, surfacePressure: field, temperature2m: field,
    specificHumidity2m: field, sensibleHeatFlux: flux, latentHeatFlux: flux, temperature: field, pressure: field }).strict()
}).strict();

export function splitSource(model: ModelDefinition) {
  if (model.capabilities.verticalCoordinate !== 'model-levels' || model.layers.includes('precip-rate')) throw new Error('Split GRIB input requires model-level lift fields');
  const upstream = upstreamSchema.parse(model.upstream), grid = regularLatLonGridSchema.parse(model.grid);
  const modelLevels = [...new Set(upstream.modelLevels)].sort((a, b) => b - a);
  if (modelLevels.length !== model.capabilities.maxVerticalLevels) throw new Error('Selected model levels differ from the declared source budget');
  const halfLevels = [...new Set(modelLevels.flatMap(level => [level, level + 1]))].sort((a, b) => a - b);
  const specs = Object.fromEntries(Object.values(upstream.fields).map(value => [value.field, { field: value.field, kind: value.kind,
    discipline: 0, parameterCategory: value.parameter[0], parameterNumber: value.parameter[1], templateNumber: value.statistic === undefined ? 0 : 8,
    firstFixedSurfaceType: value.surface[0], firstFixedSurfaceValue: value.surface[1] ?? null, secondFixedSurfaceType: value.surface[2] ?? 255,
    statisticalProcessCode: value.statistic ?? null }]));
  const fields = Object.fromEntries(Object.entries(upstream.fields).map(([role, spec]) => [role, spec.field])) as Record<keyof typeof upstream.fields, string>;
  return { model, upstream, grid, modelLevels, halfLevels, specs, fields };
}
export type SplitSource = ReturnType<typeof splitSource>;
export const MAX_SPLIT_OBJECT_BYTES = 8 * 1024 * 1024;
