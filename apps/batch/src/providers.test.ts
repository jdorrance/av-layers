import { describe, expect, it } from 'vitest';
import { PRODUCTS } from '@av/contracts';
import { getForecastProvider } from './providers.js';

describe('production provider registry', () => {
  it.each(PRODUCTS)('binds $modelId to its source identity and vertical capacity', product => {
    const provider = getForecastProvider(product.modelId);
    expect(provider.id).toBe(product.source.configurationId);
    expect(provider.maxLevels).toBe(product.capabilities.maxVerticalLevels);
  });

  it.each(['unknown', 'constructor', 'toString'])('rejects unregistered model %s', modelId => {
    expect(() => getForecastProvider(modelId)).toThrow(`No forecast provider for ${modelId}`);
  });
});
