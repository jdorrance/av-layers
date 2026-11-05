import z from 'zod';
import { gridSchema, normalizeLon, prepareGridGeometry, type ModelDefinition } from '@av/contracts';

const levels = z.array(z.number().int().positive()).min(1).max(256);
const field = z.tuple([z.string().min(1), z.string().min(1)]);
const flux = z.tuple([z.string().min(1), z.string().min(1), z.union([z.literal(1), z.literal(-1)])]);
const upstreamSchema = z.object({
  protocol: z.literal('indexed-grib2'), provider: z.string().min(1), centre: z.number().int().nonnegative(),
  urlTemplate: z.string().url(), nativeLongitudeOrigin: z.number().finite().optional(),
  products: z.record(z.string().min(1), z.string().min(1)), surfaceProduct: z.string().min(1),
  pressureLevelsHpa: z.record(z.string().min(1), levels),
  discoveryLagHours: z.number().nonnegative(), discoveryCandidates: z.number().int().min(1).max(24),
  parameters: z.record(z.string(), z.tuple([z.number().int(), z.number().int(), z.string().min(1)])),
  fields: z.object({ terrain: field, surfacePressure: field, temp2m: field, spfh2m: field,
    sensibleHeatFlux: flux, latentHeatFlux: flux, precipitation: field,
    height: z.tuple([z.string().min(1)]), temperature: z.tuple([z.string().min(1)]) }).strict()
}).strict();

export function indexedSource(model: ModelDefinition) {
  if (model.capabilities.verticalCoordinate !== 'isobaric' || model.forecast.statisticsResetHours === null) throw new Error('Indexed GRIB input requires isobaric levels and a statistical reset interval');
  const upstream = upstreamSchema.parse(model.upstream), grid = gridSchema.parse(model.grid);
  let columnOffset = 0;
  if (grid.kind === 'regular-latlon') {
    if (upstream.nativeLongitudeOrigin === undefined) throw new Error('Regular indexed GRIB input requires a native longitude origin');
    const offset = normalizeLon(grid.lon0 - upstream.nativeLongitudeOrigin) / grid.dx;
    columnOffset = Math.round(offset);
    if (Math.abs(offset - columnOffset) > 1e-7 || (!grid.wrapLongitude && columnOffset !== 0)) throw new Error('Native longitude origin must align with the configured grid columns');
  } else if (upstream.nativeLongitudeOrigin !== undefined) throw new Error('Projected indexed GRIB input uses the configured first cell');
  if (!Object.hasOwn(upstream.products, upstream.surfaceProduct) || !Object.keys(upstream.products).length) throw new Error('Missing surface source product');
  const levelProducts = new Map<number, string>();
  for (const [product, values] of Object.entries(upstream.pressureLevelsHpa)) {
    if (!Object.hasOwn(upstream.products, product)) throw new Error(`Unknown pressure product ${product}`);
    for (const level of values) {
      if (levelProducts.has(level)) throw new Error(`Ambiguous pressure level ${level}`);
      levelProducts.set(level, product);
    }
  }
  const pressureLevels = [...levelProducts.keys()].sort((a, b) => b - a);
  if (pressureLevels.length !== model.capabilities.maxVerticalLevels) throw new Error('Selected pressure levels differ from the declared source budget');
  for (const [variable] of Object.values(upstream.fields)) if (!upstream.parameters[variable]) throw new Error(`Missing GRIB parameter ${variable}`);
  const fields = { ...upstream.fields, sensibleHeatFlux: upstream.fields.sensibleHeatFlux.slice(0, 2) as [string, string], latentHeatFlux: upstream.fields.latentHeatFlux.slice(0, 2) as [string, string] };
  const fluxScales = { sensibleHeatFlux: upstream.fields.sensibleHeatFlux[2], latentHeatFlux: upstream.fields.latentHeatFlux[2] };
  return { model, upstream, grid, geometry: prepareGridGeometry(grid), columnOffset, pressureLevels, levelProducts, fields, fluxScales };
}
export type IndexedSource = ReturnType<typeof indexedSource>;
