import { describe, expect, it, vi } from 'vitest';
import configuration from '../config/models.json' with { type: 'json' };
import windowSettings from './forecast-windows.js';
import { DEFAULT_MODEL, DEFAULT_PRODUCT, MAX_MODEL_WORKERS, defineProduct, getProduct, mapFrameCount, sourceIntervalHours } from './products.js';

const configured = configuration.models[0];
const base = getProduct(configured.modelId)!;
const raw = { ...configured, forecast: base.forecast, freshness: base.freshness,
  execution: { ...configured.execution, shards: base.execution.shards } };

async function withWindow(window: unknown, check: (products: typeof import('./products.js')) => void): Promise<void> {
  vi.resetModules();
  vi.doMock('./forecast-windows.js', () => ({ default: { ...windowSettings, gfs: window } }));
  try { check(await import('./products.js')); }
  finally { vi.doUnmock('./forecast-windows.js'); vi.resetModules(); }
}

describe('model configuration', () => {
  it('resolves each model window once for consumers and source adapters', () => {
    for (const settings of configuration.models) {
      const product = getProduct(settings.modelId)!, window = windowSettings[settings.modelId as keyof typeof windowSettings];
      expect(product.frameHours).toBe(product.forecast.hours);
      expect(product.frameHours.every((hour, index, hours) => Number.isSafeInteger(hour) && hour > 0 && (!index || hour > hours[index - 1]))).toBe(true);
      expect(product.mapEndHour).toBe(product.frameHours.at(-1));
      expect(product.forecast.mapEndHour).toBe(product.mapEndHour);
      expect(mapFrameCount(product)).toBe(product.frameHours.length);
      expect(product.execution.shards).toBe(Math.ceil(product.frameHours.length / window.framesPerShard));
      expect(product.freshness.minHorizonHours).toBe(window.minHorizonHours);
      expect(product.frameHours.at(-1)).toBeLessThanOrEqual(window.endHour);
      expect(product.frameHours.at(-1)! + window.tailStepHours).toBeGreaterThan(window.endHour);
    }
  });

  it.each([
    { window: { hourlyThrough: 2, endHour: 11, tailStepHours: 3, minHorizonHours: 7, framesPerShard: 2 }, hours: [1, 2, 5, 8, 11], shards: 3 },
    { window: { hourlyThrough: 4, endHour: 14, tailStepHours: 4, minHorizonHours: 6, framesPerShard: 1 }, hours: [1, 2, 3, 4, 8, 12], shards: 6 },
    { window: { hourlyThrough: 6, endHour: 6, tailStepHours: 3, minHorizonHours: 0, framesPerShard: 3 }, hours: [1, 2, 3, 4, 5, 6], shards: 2 }
  ])('propagates one tuned window through hours, maps, freshness and compute groups: $window', async ({ window, hours, shards }) => {
    await withWindow(window, products => {
      const product = products.getProduct('gfs')!;
      expect(product.frameHours).toEqual(hours);
      expect(product.forecast.hours).toBe(product.frameHours);
      expect(product.mapEndHour).toBe(hours.at(-1));
      expect(product.forecast.mapEndHour).toBe(product.mapEndHour);
      expect(products.mapFrameCount(product)).toBe(hours.length);
      expect(product.execution.shards).toBe(shards);
      expect(product.freshness.minHorizonHours).toBe(window.minHorizonHours);
      expect(product.execution.parallelism).toBe(getProduct('gfs')!.execution.parallelism);
      expect(product.execution.schedule).toEqual(getProduct('gfs')!.execution.schedule);
      expect([27, 123].map(hour => products.sourceIntervalHours(product, hour))).toEqual([1, 3]);
      for (const model of ['icon-eu', 'rrfs']) expect(products.getProduct(model)).toEqual(getProduct(model));
    });
  });

  it.each([
    { hourlyThrough: 0 }, { hourlyThrough: 257 }, { hourlyThrough: 2.5 },
    { endHour: windowSettings.gfs.hourlyThrough - 1 }, { endHour: Infinity }, { endHour: Number.MAX_SAFE_INTEGER + 1 },
    { endHour: 1_000, tailStepHours: 1 }, { tailStepHours: 0 }, { tailStepHours: NaN },
    { minHorizonHours: -1 }, { minHorizonHours: Number.MAX_SAFE_INTEGER }, { minHorizonHours: windowSettings.gfs.endHour },
    { hourlyThrough: 4, endHour: 14, tailStepHours: 4, minHorizonHours: 12 },
    { framesPerShard: 0 }, { framesPerShard: 257 }, { typo: 1 }
  ])('rejects an invalid or unbounded window before generating hours: %j', async invalid => {
    await expect(withWindow({ ...windowSettings.gfs, ...invalid }, () => {})).rejects.toThrow();
  });

  it.each([
    { forecast: { ...configured.forecast, hours: [1] } },
    { forecast: { ...configured.forecast, mapEndHour: 1 } },
    { execution: { ...configured.execution, shards: 1 } },
    { freshness: { ...configured.freshness, minHorizonHours: 0 } }
  ])('rejects a second configured owner for a derived window field: %j', async duplicate => {
    vi.resetModules();
    vi.doMock('../config/models.json', () => ({ default: { ...configuration,
      models: [{ ...configured, ...duplicate }, ...configuration.models.slice(1)] } }));
    try { await expect(import('./products.js')).rejects.toThrow('Forecast window owns'); }
    finally { vi.doUnmock('../config/models.json'); vi.resetModules(); }
  });
  it('keeps the map prefix and source intervals independent of sparse output hours', () => {
    const hours = [...Array.from({ length: 24 }, (_, i) => i + 1), ...Array.from({ length: 120 }, (_, i) => 27 + i * 3)];
    const product = defineProduct({ ...raw, forecast: { ...raw.forecast, hours, mapEndHour: 24, intervalHours: 1, intervalChange: { fromHour: 123, hours: 3 } } });
    expect(product.frameHours).toHaveLength(144);
    expect(product.frameHours.at(-1)).toBe(384);
    expect(mapFrameCount(product)).toBe(24);
    expect([24, 27, 120, 123, 384].map(hour => sourceIntervalHours(product, hour))).toEqual([1, 1, 1, 3, 3]);
    expect(sourceIntervalHours(product.forecast, 27)).toBe(1);
    expect(mapFrameCount({ frameHours: [3, 6, 9], mapEndHour: 6 })).toBe(2);
    expect(mapFrameCount({ frameHours: [3, 6, 9] })).toBe(3);
    expect(() => defineProduct({ ...raw, forecast: { ...raw.forecast, hours: [24, 27], mapEndHour: 23 } })).toThrow('Map window');
    expect(() => defineProduct({ ...raw, forecast: { ...raw.forecast, intervalChange: { fromHour: 3, hours: 4 } } })).toThrow('Source interval');
  });
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
