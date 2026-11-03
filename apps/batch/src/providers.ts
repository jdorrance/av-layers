import { getProduct } from '@av/contracts';
import type { ResolvableForecastProvider } from './provider.js';
import { gfsProvider } from './gfs/provider.js';
import { iconEuProvider } from './icon/provider.js';

const PROVIDERS_BY_CONFIG_ID: Readonly<Record<string, ResolvableForecastProvider>> = Object.freeze({
  [gfsProvider.id]: gfsProvider,
  [iconEuProvider.id]: iconEuProvider
});

/** Explicit production binding; test providers are passed directly to buildForecast. */
export function getForecastProvider(modelId: string): ResolvableForecastProvider {
  const product = getProduct(modelId);
  const provider = product ? PROVIDERS_BY_CONFIG_ID[product.source.configurationId] : undefined;
  if (!product || !provider) throw new Error(`No forecast provider for ${modelId}`);
  return provider;
}
