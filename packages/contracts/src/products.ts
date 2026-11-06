import z from 'zod';
import configuration from '../config/models.json' with { type: 'json' };
import windowSettings from './forecast-windows.js';
import { MAX_SAMPLE_VALUES } from './format.js';
import { defineProduct, parallelismSchema, type ModelDefinition } from './product.js';
export * from './product.js';

const windowSchema = z.strictObject({
  hourlyThrough: z.number().int().positive().max(MAX_SAMPLE_VALUES),
  endHour: z.number().int().positive(), tailStepHours: z.number().int().positive(),
  minHorizonHours: z.number().int().nonnegative(),
  framesPerShard: z.number().int().positive().max(MAX_SAMPLE_VALUES)
}).transform((window, ctx) => {
  if (window.endHour < window.hourlyThrough) {
    ctx.addIssue({ code: 'custom', message: 'Forecast window ends before its hourly prefix' });
    return z.NEVER;
  }
  const tailCount = Math.floor((window.endHour - window.hourlyThrough) / window.tailStepHours);
  const frameCount = window.hourlyThrough + tailCount;
  const mapEndHour = window.hourlyThrough + tailCount * window.tailStepHours;
  if (frameCount > MAX_SAMPLE_VALUES || window.minHorizonHours >= mapEndHour) {
    ctx.addIssue({ code: 'custom', message: 'Forecast window exceeds the frame budget or lacks its useful horizon' });
    return z.NEVER;
  }
  const hours = Array.from({ length: frameCount }, (_, index) => index < window.hourlyThrough
    ? index + 1 : window.hourlyThrough + (index - window.hourlyThrough + 1) * window.tailStepHours);
  return { hours, mapEndHour, minHorizonHours: window.minHorizonHours, shards: Math.ceil(frameCount / window.framesPerShard) };
});
const windows = z.record(z.string(), windowSchema).parse(windowSettings);
const settings = z.record(z.string(), z.unknown());
const registryModelSchema = z.object({ modelId: z.string(), forecast: settings, execution: settings, freshness: settings }).passthrough();

function resolveWindow(raw: unknown): unknown {
  const model = registryModelSchema.parse(raw);
  if (!Object.hasOwn(windows, model.modelId)) return raw;
  const window = windows[model.modelId]!;
  if ('hours' in model.forecast || 'mapEndHour' in model.forecast || 'shards' in model.execution || 'minHorizonHours' in model.freshness) {
    throw new Error('Forecast window owns configured hours, mapEndHour, shards and minHorizonHours');
  }
  return { ...model, forecast: { ...model.forecast, hours: window.hours, mapEndHour: window.mapEndHour },
    execution: { ...model.execution, shards: window.shards }, freshness: { ...model.freshness, minHorizonHours: window.minHorizonHours } };
}

const config = z.object({
  defaultModel: z.string(), parallelism: parallelismSchema,
  models: z.array(z.unknown()).min(1).max(MAX_SAMPLE_VALUES)
}).strict().parse(configuration);

export const FORECAST_PARALLELISM = config.parallelism;
export const PRODUCTS: readonly ModelDefinition[] = Object.freeze(config.models.map(model => defineProduct(resolveWindow(model), config.parallelism.workers)));
export const MODEL_IDS: readonly string[] = Object.freeze(PRODUCTS.map(product => product.modelId));
if (new Set(MODEL_IDS).size !== PRODUCTS.length || new Set(PRODUCTS.map(product => product.id)).size !== PRODUCTS.length) {
  throw new Error('Model and product IDs must be unique');
}
const schedules = new Set(PRODUCTS.flatMap(product => product.execution.schedule));
if (PRODUCTS.some(product => product.execution.parallelism > FORECAST_PARALLELISM.jobs) ||
    [...schedules].some(schedule => PRODUCTS.filter(product => product.execution.schedule.includes(schedule))
      .reduce((jobs, product) => jobs + product.execution.parallelism, 0) > FORECAST_PARALLELISM.jobs)) {
  throw new Error('Forecast trigger parallelism exceeds the job budget');
}

export function getProduct(modelId: string): ModelDefinition | undefined {
  return PRODUCTS.find(product => product.modelId === modelId);
}

const defaultProduct = getProduct(config.defaultModel);
if (!defaultProduct) throw new Error(`Unknown default model ${config.defaultModel}`);
export const DEFAULT_PRODUCT = defaultProduct;
export const DEFAULT_MODEL = defaultProduct.modelId;
