import z from 'zod';
import { gridSchema, type Grid } from './geometry.js';
import { MAX_NATIVE_ZOOM, MAX_SAMPLE_VALUES, MAX_FORECAST_SHARDS } from './format.js';
import { NATIVE_LAYER_IDS } from './native-layers.js';

export const LAYER_IDS = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate', ...NATIVE_LAYER_IDS] as const;
export type LayerId = typeof LAYER_IDS[number];
const capabilitiesSchema = z.object({
  verticalCoordinate: z.enum(['isobaric', 'model-levels']),
  maxVerticalLevels: z.number().int().positive().max(256),
  daylightFrames: z.enum(['all-hours', 'regional-daylight'])
}).strict().readonly();
export type ProductCapabilities = z.infer<typeof capabilitiesSchema>;
export type VerticalCoordinateKind = ProductCapabilities['verticalCoordinate'];
export type DaylightFramePolicy = ProductCapabilities['daylightFrames'];

export const MAX_MODEL_WORKERS = 3;
const workerLimit = z.number().int().min(0).max(MAX_MODEL_WORKERS);
const jobLimit = z.number().int().positive().max(MAX_FORECAST_SHARDS);
const cronRanges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const;
function cronTerm(term: string, min: number, max: number) {
  const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(term);
  if (!match || (match[1] === '*' && match[2] !== undefined)) return;
  const start = match[1] === '*' ? min : Number(match[1]);
  const step = match[3] === undefined ? 1 : Number(match[3]);
  let end = start;
  if (match[2] !== undefined) end = Number(match[2]);
  else if (match[1] === '*' || match[3] !== undefined) end = max;
  if (start >= min && end <= max && start <= end && Number.isSafeInteger(step) && step > 0) return { start, end, step };
}

function validSchedule(value: string): boolean {
  const fields = value.split(' ');
  return fields.length === cronRanges.length && cronRanges.every(([min, max], index) =>
    fields[index]!.split(',').every(term => cronTerm(term, min, max) !== undefined));
}

function cronFieldCount(field: string, min: number, max: number): number {
  const values = new Set<number>();
  for (const term of field.split(',')) {
    const range = cronTerm(term, min, max);
    if (!range) throw new RangeError('Invalid forecast schedule');
    for (let value = range.start; value <= range.end; value += range.step) values.add(value);
  }
  return values.size;
}

/** Bound scheduled UTC starts per day assuming every cron date filter matches. */
export function forecastStartsPerDay(schedules: readonly string[]): number {
  return schedules.reduce((starts, schedule) => {
    const [minutes, hours] = schedule.split(' ');
    if (!minutes || !hours) throw new RangeError('Invalid forecast schedule');
    return starts + cronFieldCount(minutes, ...cronRanges[0]) * cronFieldCount(hours, ...cronRanges[1]);
  }, 0);
}
const schedules = z.array(z.string().refine(validSchedule, 'Expected a numeric five-field cron schedule')).refine(
  values => new Set(values).size === values.length, 'Model schedules must be unique'
).readonly();
const modelExecutionSchema = z.object({
  shards: jobLimit, parallelism: jobLimit, workers: workerLimit, schedule: schedules
}).strict();
export type ModelExecution = Readonly<z.infer<typeof modelExecutionSchema>>;
export const MODEL_CONFIG_PATH = 'packages/contracts/config/models.json';
export const parallelismSchema = z.object({ jobs: jobLimit, workers: workerLimit }).strict().readonly();

export interface ProductDefinition {
  /** Public catalog/URL identity, independent of the upstream family and domain. */
  readonly modelId: string;
  readonly id: string;
  readonly coverageDir: string;
  readonly source: { readonly modelFamily: string; readonly configurationId: string; readonly domainId: string };
  readonly label: string;
  readonly attribution: string;
  readonly bounds: readonly [number, number, number, number];
  readonly coverageDescription: string;
  readonly freshness: { readonly maxCycleAgeHours: number; readonly minHorizonHours: number };
  readonly grid: Grid;
  readonly coverageId: string;
  readonly maxNativeZoom: number;
  readonly supportHaloCells: number;
  readonly terrainSubdivisionFactor?: number;
  readonly frameHours: readonly number[];
  readonly mapEndHour?: number;
  readonly intervalChange?: { readonly fromHour: number; readonly hours: number };
  readonly intervalHours: number;
  readonly layers: readonly LayerId[];
  readonly capabilities: ProductCapabilities;
  readonly execution: ModelExecution;
}

export interface ModelDefinition extends ProductDefinition {
  readonly upstream: Readonly<Record<string, unknown>>;
  readonly forecast: { readonly hours: readonly number[]; readonly intervalHours: number; readonly intervalChange?: ProductDefinition['intervalChange']; readonly mapEndHour?: number;
    readonly cycleHoursUtc: readonly number[]; readonly statisticsResetHours: number | null };
}

// The shared portion of source JSON. Adapter-specific upstream settings stay in
// that adapter; adding a model never extends a union of existing config types.
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const productConfigSchema = z.object({
  modelId: identifier.refine(id => id !== 'all', 'Model ID is reserved for workflow selection'), id: identifier,
  coverageDir: z.string().regex(/^coverage(?:\/[a-z0-9-]+)*$/),
  source: z.object({ modelFamily: identifier, configurationId: identifier, domainId: identifier }).readonly(),
  label: z.string().min(1), attribution: z.string().min(1),
  layers: z.array(z.enum(LAYER_IDS)).min(1).max(LAYER_IDS.length).refine(
    layers => new Set(layers).size === layers.length, 'Product requires unique scalar layers'
  ).readonly(),
  capabilities: capabilitiesSchema,
  execution: modelExecutionSchema.extend({
    zoom: z.number().int().min(0).max(MAX_NATIVE_ZOOM), workers: workerLimit.optional() }).strict(),
  grid: gridSchema.readonly(),
  forecast: z.object({
    hours: z.array(z.number().int().positive()).min(1).max(MAX_SAMPLE_VALUES).refine(
      hours => hours.every((hour, i) => i === 0 || hour > hours[i - 1]),
      'Product requires strictly ascending frame hours'
    ).readonly(),
    intervalHours: z.number().finite().positive(),
    intervalChange: z.object({ fromHour: z.number().int().positive(), hours: z.number().int().positive() }).strict().optional(),
    mapEndHour: z.number().int().positive().optional(),
    cycleHoursUtc: z.array(z.number().int().min(0).max(23)).min(1).refine(hours => new Set(hours).size === hours.length).readonly(),
    statisticsResetHours: z.number().finite().positive().nullable()
  }).refine(forecast => forecast.intervalHours <= forecast.hours[0], 'Interval exceeds first forecast hour')
    .refine(forecast => forecast.mapEndHour === undefined || forecast.hours.some(hour => hour <= forecast.mapEndHour!), 'Map window requires a forecast prefix')
    .refine(forecast => !forecast.intervalChange || forecast.intervalChange.hours <= forecast.intervalChange.fromHour, 'Source interval exceeds transition hour'),
  freshness: z.object({ maxCycleAgeHours: z.number().positive(), minHorizonHours: z.number().nonnegative() }).readonly(),
  terrainSubdivisionFactor: z.number().int().positive().max(64).optional(),
  coverage: z.object({
    id: identifier, description: z.string().min(1),
    west: z.number().min(-180).max(180), south: z.number().min(-90).max(90),
    east: z.number().min(-180).max(180), north: z.number().min(-90).max(90),
    interpolationHaloCells: z.number().int().nonnegative()
  }).refine(coverage => coverage.west < coverage.east && coverage.south < coverage.north, 'Invalid coverage bounds'),
  upstream: z.record(z.string(), z.unknown()).readonly()
});

/** Validate declarative product settings without importing any source adapter. */
export function defineProduct(raw: unknown, workers = 0): ModelDefinition {
  const config = productConfigSchema.parse(raw);
  const { zoom, ...execution } = config.execution;
  return Object.freeze({
    modelId: config.modelId, id: config.id,
    coverageDir: config.coverageDir, source: config.source, label: config.label,
    attribution: config.attribution,
    bounds: Object.freeze([config.coverage.west, config.coverage.south, config.coverage.east, config.coverage.north] as const),
    coverageDescription: config.coverage.description, freshness: config.freshness,
    grid: config.grid, coverageId: config.coverage.id,
    maxNativeZoom: zoom,
    supportHaloCells: config.coverage.interpolationHaloCells,
    ...(config.terrainSubdivisionFactor === undefined ? {} : { terrainSubdivisionFactor: config.terrainSubdivisionFactor }),
    frameHours: config.forecast.hours, intervalHours: config.forecast.intervalHours,
    ...(config.forecast.mapEndHour === undefined ? {} : { mapEndHour: config.forecast.mapEndHour }),
    ...(config.forecast.intervalChange ? { intervalChange: config.forecast.intervalChange } : {}),
    layers: config.layers, capabilities: config.capabilities,
    execution: Object.freeze({ ...execution, workers: workerLimit.parse(execution.workers ?? workers) }),
    forecast: config.forecast, upstream: config.upstream
  });
}

/** Source support is independent of the selected output schedule. */
export function sourceIntervalHours(product: Pick<ProductDefinition, 'intervalHours' | 'intervalChange'>, hour: number): number {
  return product.intervalChange && hour >= product.intervalChange.fromHour ? product.intervalChange.hours : product.intervalHours;
}

/** Map rasters and fine samples use the selected forecast prefix. */
export function mapFrameCount(product: Pick<ProductDefinition, 'frameHours' | 'mapEndHour'>): number {
  const end = product.mapEndHour;
  if (end === undefined) return product.frameHours.length;
  const index = product.frameHours.findIndex(hour => hour > end);
  return index < 0 ? product.frameHours.length : index;
}
