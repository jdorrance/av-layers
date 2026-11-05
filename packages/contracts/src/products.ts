import z from 'zod';
import configuration from '../config/models.json' with { type: 'json' };
import { MAX_SAMPLE_VALUES } from './format.js';
import { defineProduct, parallelismSchema, type ModelDefinition } from './product.js';
export * from './product.js';

const config = z.object({
  defaultModel: z.string(), parallelism: parallelismSchema,
  models: z.array(z.unknown()).min(1).max(MAX_SAMPLE_VALUES)
}).strict().parse(configuration);

export const FORECAST_PARALLELISM = config.parallelism;
export const PRODUCTS: readonly ModelDefinition[] = Object.freeze(config.models.map(model => defineProduct(model, config.parallelism.workers)));
export const MODEL_IDS: readonly string[] = Object.freeze(PRODUCTS.map(product => product.modelId));
if (new Set(MODEL_IDS).size !== PRODUCTS.length || new Set(PRODUCTS.map(product => product.id)).size !== PRODUCTS.length) {
  throw new Error('Model and product IDs must be unique');
}
if (PRODUCTS.reduce((jobs, product) => jobs + product.execution.parallelism, 0) > FORECAST_PARALLELISM.jobs) {
  throw new Error('Combined model parallelism exceeds the forecast job budget');
}

export function getProduct(modelId: string): ModelDefinition | undefined {
  return PRODUCTS.find(product => product.modelId === modelId);
}

const defaultProduct = getProduct(config.defaultModel);
if (!defaultProduct) throw new Error(`Unknown default model ${config.defaultModel}`);
export const DEFAULT_PRODUCT = defaultProduct;
export const DEFAULT_MODEL = defaultProduct.modelId;
