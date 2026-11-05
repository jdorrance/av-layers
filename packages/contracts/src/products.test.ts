import { describe, expect, it, vi } from 'vitest';
import configuration from '../config/models.json' with { type: 'json' };
import { DEFAULT_MODEL, DEFAULT_PRODUCT, MAX_MODEL_WORKERS, defineProduct, getProduct } from './products.js';

const raw = configuration.models[0];

describe('model configuration', () => {
  it('resolves the configured default and rejects prototype names', () => {
    expect(DEFAULT_MODEL).toBe(configuration.defaultModel);
    expect(getProduct(DEFAULT_MODEL)).toBe(DEFAULT_PRODUCT);
    for (const id of ['constructor', '__proto__', 'unknown']) expect(getProduct(id)).toBeUndefined();
  });

  it('bounds each manual model and each shared cron cohort by the job budget', async () => {
    const first = { ...raw, modelId: 'first', id: 'first-product', execution: { ...raw.execution, parallelism: 2, schedule: ['17 5 * * *'] } };
    const second = { ...raw, modelId: 'second', id: 'second-product', execution: { ...raw.execution, parallelism: 2, schedule: ['23 6 * * *'] } };
    try {
      for (const [models, admitted] of [
        [[first, second], true],
        [[first, { ...second, execution: { ...second.execution, parallelism: 1, schedule: first.execution.schedule } }], false],
        [[{ ...first, execution: { ...first.execution, parallelism: 3, schedule: [] } }], false]
      ] as const) {
        vi.resetModules();
        vi.doMock('../config/models.json', () => ({ default: { defaultModel: first.modelId, parallelism: { jobs: 2, workers: 1 }, models } }));
        const loaded = import('./products.js');
        if (admitted) expect((await loaded).MODEL_IDS).toEqual(models.map(model => model.modelId));
        else await expect(loaded).rejects.toThrow('Forecast trigger parallelism exceeds the job budget');
      }
    } finally { vi.doUnmock('../config/models.json'); vi.resetModules(); }
  });

  it('admits a regional source with independent timing, shards, zoom and worker defaults', () => {
    const settings = { ...raw, modelId: 'regional-test', id: 'regional-test-lift',
      coverageDir: 'coverage/regional-test',
      source: { modelFamily: 'regional-test', configurationId: 'regional-source', domainId: 'regional-area' },
      layers: ['usable-lift-agl'],
      forecast: { ...raw.forecast, hours: [3, 6], intervalHours: 3, cycleHoursUtc: [1, 8, 19] },
      execution: { zoom: 2, shards: 24, parallelism: 2, schedule: ['37 8,20 * * *'] },
      upstream: { protocol: 'regional-source' }
    };
    const product = defineProduct(settings, 1);
    expect(product.layers).toEqual(['usable-lift-agl']);
    expect(product.frameHours).toEqual([3, 6]);
    expect(product.forecast.cycleHoursUtc).toEqual([1, 8, 19]);
    expect(product.maxNativeZoom).toBe(2);
    expect(product.execution).toEqual({ shards: 24, parallelism: 2, workers: 1, schedule: ['37 8,20 * * *'] });
    expect(defineProduct({ ...settings, execution: { ...settings.execution, workers: 0 } }, 1).execution.workers).toBe(0);
  });

  it.each([
    { modelId: 'all' },
    { layers: ['invented-layer'] }, { layers: ['usable-lift-agl', 'usable-lift-agl'] },
    { capabilities: { ...raw.capabilities, verticalCoordinate: 'hybrid-guess' } },
    { forecast: { ...raw.forecast, hours: [3, 1] } },
    { forecast: { ...raw.forecast, hours: [1, 3], intervalHours: 2 } },
    { forecast: { ...raw.forecast, cycleHoursUtc: [0, 24] } },
    { coverageDir: '../../outside' }
  ])('rejects unsupported or ambiguous configuration %j', invalid => {
    expect(() => defineProduct({ ...raw, ...invalid })).toThrow();
  });

  it.each([
    { zoom: -1 }, { zoom: 11 }, { shards: 0 }, { shards: 257 }, { parallelism: 0 },
    { workers: -1 }, { workers: MAX_MODEL_WORKERS + 1 }, { schedule: ['invalid'] },
    { schedule: ['99 99 * * *'] }, { schedule: ['*/0 * * * *'] },
    { schedule: ['0 5-3 * * *'] }, { schedule: ['0 * * * *', '0 * * * *'] }, { typo: 1 }
  ])('rejects invalid execution settings %j', invalid => {
    expect(() => defineProduct({ ...raw, execution: { ...raw.execution, ...invalid } })).toThrow();
  });
});
