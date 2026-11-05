import { describe, expect, it } from 'vitest';
import forecast from '../config/forecast.json' with { type: 'json' };
import { defineProduct, forecastConfigSchema, FORECAST_PARALLELISM, getProduct, GFS_SETTINGS, GFS_PRODUCT, ICON_EU_PRODUCT, MAX_MODEL_WORKERS, MODEL_IDS, PRODUCTS } from './products.js';

describe('production product registry', () => {
  it('requires unique public and recipe identities', () => {
    for (const ids of [PRODUCTS.map(p => p.modelId), PRODUCTS.map(p => p.id)]) {
      expect(new Set(ids).size).toBe(PRODUCTS.length);
    }
  });
  it('keeps public IDs separate from recipe and source identities', () => {
    expect(MODEL_IDS).toEqual(PRODUCTS.map(product => product.modelId));
    expect(getProduct('gfs')).toBe(GFS_PRODUCT);
    expect(getProduct('icon-eu')).toBe(ICON_EU_PRODUCT);
    expect(GFS_PRODUCT.id).toBe('gfs-soaring');
    expect(GFS_PRODUCT.source).toEqual({ modelFamily: 'gfs', configurationId: 'noaa-gfs-0p25', domainId: 'global' });
    expect(GFS_PRODUCT.capabilities).toEqual({
      verticalCoordinate: 'isobaric',
      maxVerticalLevels: 21,
      daylightFrames: 'all-hours'
    });
    expect(ICON_EU_PRODUCT.id).toBe('icon-eu-soaring');
    expect(ICON_EU_PRODUCT.source).toEqual({ modelFamily: 'icon', configurationId: 'dwd-icon-eu-regular-0p0625', domainId: 'europe' });
    expect(ICON_EU_PRODUCT.layers).toEqual(['usable-lift-msl', 'usable-lift-agl']);
    expect(ICON_EU_PRODUCT.capabilities).toEqual({
      verticalCoordinate: 'model-levels',
      maxVerticalLevels: 30,
      daylightFrames: 'regional-daylight'
    });
  });
  it('resolves each registered model from the forecast settings', () => {
    const configured = forecastConfigSchema.parse(forecast);
    expect(FORECAST_PARALLELISM).toEqual(configured.parallelism);
    expect(Object.keys(configured.models).sort()).toEqual([...MODEL_IDS].sort());
    for (const product of PRODUCTS) {
      const { zoom, workers = configured.parallelism.workers, ...execution } = configured.models[product.modelId];
      expect(product.maxNativeZoom).toBe(zoom);
      expect(product.execution).toEqual({ ...execution, workers });
      expect(Object.isFrozen(product.execution)).toBe(true);
      expect(Object.isFrozen(product.execution.schedule)).toBe(true);
    }
  });
  it.each(['constructor', '__proto__', 'toString', 'fixture-regular-domain', 'unknown'])('rejects unregistered public ID %s', model => {
    expect(getProduct(model)).toBeUndefined();
  });
});

describe('declarative product settings', () => {
  it('admits a new regional product without extending an existing-model type union', () => {
    const product = defineProduct({
      ...GFS_SETTINGS, modelId: 'regional-test', id: 'regional-test-lift',
      configPath: 'packages/contracts/config/regional-test.json',
      coverageDir: 'coverage/regional-test',
      source: { modelFamily: 'third-model', configurationId: 'third-source', domainId: 'regional-test' },
      layers: ['usable-lift-agl'],
      capabilities: { verticalCoordinate: 'model-levels', maxVerticalLevels: 12, daylightFrames: 'regional-daylight' },
      forecast: { hours: [3, 6], intervalHours: 3 },
      execution: { shards: 2, parallelism: 1, workers: 0, schedule: ['37 8,20 * * *'] },
      upstream: { independentlyOwnedByAdapter: true }
    });
    expect(product.layers).toEqual(['usable-lift-agl']);
    expect(product.frameHours).toEqual([3, 6]);
    expect(product.capabilities.maxVerticalLevels).toBe(12);
    expect(product.execution).toEqual({ shards: 2, parallelism: 1, workers: 0, schedule: ['37 8,20 * * *'] });
    expect(Object.isFrozen(product.capabilities)).toBe(true);
    expect(Object.isFrozen(product.layers)).toBe(true);
    expect(getProduct(product.modelId)).toBeUndefined();
  });

  it.each([
    { layers: ['invented-layer'] },
    { layers: ['usable-lift-agl', 'usable-lift-agl'] },
    { capabilities: { verticalCoordinate: 'hybrid-guess', maxVerticalLevels: 12, daylightFrames: 'all-hours' } },
    { capabilities: { verticalCoordinate: 'isobaric', maxVerticalLevels: 12 } },
    { forecast: { hours: [3, 1], intervalHours: 1 } },
    { forecast: { hours: [1, 3], intervalHours: 2 } },
    { coverageDir: '../../outside' }
  ])('rejects unsupported or ambiguous configuration %j', invalid => {
    expect(() => defineProduct({ ...GFS_SETTINGS, ...invalid })).toThrow();
  });
});

describe('forecast configuration', () => {
  const settings = { parallelism: { jobs: 2, workers: 1 }, models: {
    regional: { zoom: 2, shards: 24, parallelism: 2, schedule: ['0 */3 * * *'], workers: 0 }
  } };
  it('admits independent hourly groups, concurrency, zoom and timing', () => {
    expect(forecastConfigSchema.parse(settings)).toEqual(settings);
  });
  it('requires enough job slots for independently scheduled models', () => {
    expect(() => forecastConfigSchema.parse({ parallelism: { jobs: 1, workers: 0 },
      models: { first: settings.models.regional, second: settings.models.regional } })).toThrow('at least one slot per model');
  });
  it.each([
    { jobs: 0, workers: 1 }, { jobs: 257, workers: 1 },
    { jobs: 1, workers: -1 }, { jobs: 1, workers: MAX_MODEL_WORKERS + 1 }
  ])('rejects invalid global parallelism %j', parallelism => {
    expect(() => forecastConfigSchema.parse({ ...settings, parallelism })).toThrow();
  });
  it.each([
    { zoom: -1 }, { zoom: 11 }, { shards: 0 }, { shards: 257 },
    { parallelism: 0 }, { schedule: ['invalid'] },
    { schedule: ['99 99 * * *'] }, { schedule: ['*/0 * * * *'] },
    { schedule: ['0/99999999999999999999999999999999999 * * * *'] },
    { schedule: ['0 5-3 * * *'] }, { schedule: ['0 0 * * 7'] },
    { schedule: ['0 * * * *', '0 * * * *'] }, { typo: 1 }
  ])('rejects invalid model settings %j', invalid => {
    expect(() => forecastConfigSchema.parse({ ...settings, models: { regional: { ...settings.models.regional, ...invalid } } })).toThrow();
  });
  it.each(['0 4-8/2 * * 1-5', '20/15 * * * *', '0 */3 1,15 * *', '0 0 1 1 *'])(
    'admits numeric cron operators %s', schedule => {
      expect(forecastConfigSchema.parse({ ...settings, models: { regional: { ...settings.models.regional, schedule: [schedule] } } }).models.regional.schedule).toEqual([schedule]);
    }
  );
});
