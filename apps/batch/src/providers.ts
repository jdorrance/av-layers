import { getProduct } from '@av/contracts/models';
import type { ResolvableForecastProvider } from './provider.js';
import { createIndexedGribProvider } from './indexed-grib/provider.js';
import { createSplitGribProvider } from './split-grib/provider.js';
import { createWrfZarrProvider } from './wrf-zarr/provider.js';

const factories = { 'indexed-grib2': createIndexedGribProvider, 'split-grib2': createSplitGribProvider, 'wrf-zarr-v3': createWrfZarrProvider };
const providers = new Map<string, ResolvableForecastProvider>();

/** Bind a configured model to its source protocol; fixtures may inject providers directly. */
export function getForecastProvider(modelId: string): ResolvableForecastProvider {
  const model = getProduct(modelId);
  if (!model) throw new Error(`No forecast provider for ${modelId}`);
  const protocol = model.upstream.protocol;
  if (typeof protocol !== 'string' || !Object.hasOwn(factories, protocol)) throw new Error(`Unsupported source protocol ${String(protocol)}`);
  let provider = providers.get(modelId);
  if (!provider) { provider = factories[protocol as keyof typeof factories](model); providers.set(modelId, provider); }
  return provider;
}
