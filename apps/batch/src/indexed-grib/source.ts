import z from 'zod';
import { gridSchema, normalizeLon, prepareGridGeometry, type ModelDefinition } from '@av/contracts';
import { AUX_SURFACE_UNITS, AUX_LEVEL_UNITS } from '@av/forecast/inputs';

const levels = z.array(z.number().int().positive()).min(1).max(256);
const field = z.tuple([z.string().min(1), z.string().min(1)]);
const flux = z.tuple([z.string().min(1), z.string().min(1), z.union([z.literal(1), z.literal(-1)])]);
const auxiliary = z.object({ variable: z.string().min(1), unit: z.string().min(1), scale: z.number().finite().positive().default(1) }).strict();
const auxSurfaceSchema = z.partialRecord(z.enum(Object.keys(AUX_SURFACE_UNITS) as [keyof typeof AUX_SURFACE_UNITS, ...Array<keyof typeof AUX_SURFACE_UNITS>]),
  auxiliary.extend({ level: z.string().min(1), product: z.string().min(1).optional(), surface: z.tuple([z.number().int(), z.number().nullable()]).optional() }));
const auxLevelsSchema = z.partialRecord(z.enum(Object.keys(AUX_LEVEL_UNITS) as [keyof typeof AUX_LEVEL_UNITS, ...Array<keyof typeof AUX_LEVEL_UNITS>]),
  auxiliary.extend({ conversion: z.literal('geometric-w-to-omega').optional() }));
const upstreamSchema = z.object({
  protocol: z.literal('indexed-grib2'), provider: z.string().min(1), centre: z.number().int().nonnegative(),
  urlTemplate: z.string().url(), nativeLongitudeOrigin: z.number().finite().optional(),
  products: z.record(z.string().min(1), z.string().min(1)), surfaceProduct: z.string().min(1),
  pressureLevelsHpa: z.record(z.string().min(1), levels),
  discoveryLagHours: z.number().nonnegative(), discoveryCandidates: z.number().int().min(1).max(24),
  parameters: z.record(z.string(), z.tuple([z.number().int(), z.number().int(), z.string().min(1)])),
  auxSurface: auxSurfaceSchema.optional(), auxLevels: auxLevelsSchema.optional(),
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
  for (const [configured, units] of [[upstream.auxSurface, AUX_SURFACE_UNITS], [upstream.auxLevels, AUX_LEVEL_UNITS]] as const) {
    for (const [name, spec] of Object.entries(configured ?? {})) {
      if (!upstream.parameters[spec.variable] || spec.unit !== units[name as keyof typeof units]) throw new Error(`Invalid auxiliary GRIB units or parameter ${name}`);
      if ('conversion' in spec && spec.conversion !== undefined && (name !== 'omegaPaS' || upstream.parameters[spec.variable]![2] !== 'm/s')) throw new Error('Geometric vertical velocity conversion requires an omega output and m/s input');
      if ('product' in spec && spec.product !== undefined && !Object.hasOwn(upstream.products, spec.product as string)) throw new Error(`Unknown auxiliary GRIB product ${String(spec.product)}`);
    }
  }
  for (const [fields, u, v] of [[upstream.auxSurface, 'u10mMps', 'v10mMps'], [upstream.auxLevels, 'uWindMps', 'vWindMps']] as const) {
    if (Object.hasOwn(fields ?? {}, u) !== Object.hasOwn(fields ?? {}, v)) throw new Error('Auxiliary GRIB wind components must be configured together');
  }
  const fields = { ...upstream.fields, sensibleHeatFlux: upstream.fields.sensibleHeatFlux.slice(0, 2) as [string, string], latentHeatFlux: upstream.fields.latentHeatFlux.slice(0, 2) as [string, string] };
  const fluxScales = { sensibleHeatFlux: upstream.fields.sensibleHeatFlux[2], latentHeatFlux: upstream.fields.latentHeatFlux[2] };
  return { model, upstream, grid, geometry: prepareGridGeometry(grid), columnOffset, pressureLevels, levelProducts, fields, fluxScales };
}
export type IndexedSource = ReturnType<typeof indexedSource>;
