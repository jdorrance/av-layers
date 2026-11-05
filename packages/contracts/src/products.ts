import gfs from '../config/gfs.json' with { type: 'json' };
import iconEu from '../config/icon-eu.json' with { type: 'json' };
import forecast from '../config/forecast.json' with { type: 'json' };
import { regularLatLonGridSchema, type RegularLatLonGrid } from './geometry.js';
import { defineProduct, forecastConfigSchema, type ProductDefinition } from './product.js';
export * from './product.js';

export const FORECAST_CONFIG_PATH = 'packages/contracts/config/forecast.json';
const tuning = forecastConfigSchema.parse(forecast);
export const FORECAST_PARALLELISM = tuning.parallelism;

function settings<T extends { modelId: string; coverage: object }>(source: T) {
  const configured = Object.hasOwn(tuning.models, source.modelId) ? tuning.models[source.modelId] : undefined;
  if (!configured) throw new Error(`Missing forecast settings for ${source.modelId}`);
  const { zoom, workers = tuning.parallelism.workers, ...execution } = configured;
  return { ...source, coverage: { ...source.coverage, maxNativeZoom: zoom }, execution: { ...execution, workers } };
}

/** Shared source facts consumed by adapters and the offline mask generator. */
export const GFS_SETTINGS = settings(gfs);
export const ICON_EU_SETTINGS = settings(iconEu);
export const GFS_PRODUCT = defineProduct(GFS_SETTINGS);
export const ICON_EU_PRODUCT = defineProduct(ICON_EU_SETTINGS);
export const GFS_GRID: RegularLatLonGrid = Object.freeze(regularLatLonGridSchema.parse(GFS_PRODUCT.grid));
export const ICON_EU_GRID: RegularLatLonGrid = Object.freeze(regularLatLonGridSchema.parse(ICON_EU_PRODUCT.grid));

/** Only production products belong here; fixtures are imported explicitly by tests/dev. */
export const PRODUCTS: readonly ProductDefinition[] = Object.freeze([GFS_PRODUCT, ICON_EU_PRODUCT]);
export const MODEL_IDS: readonly string[] = Object.freeze(PRODUCTS.map(product => product.modelId));
for (const modelId of Object.keys(tuning.models)) {
  if (!MODEL_IDS.includes(modelId)) throw new Error(`Forecast settings reference unregistered model ${modelId}`);
}
export function getProduct(modelId: string): ProductDefinition | undefined {
  return PRODUCTS.find(product => product.modelId === modelId);
}
