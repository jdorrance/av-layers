import { describe, expect, it } from 'vitest';
import { defineProduct, getProduct, GFS_SETTINGS, GFS_PRODUCT, ICON_EU_PRODUCT, MODEL_IDS, PRODUCTS } from './products.js';

describe('production product registry', () => {
  it('requires unique public and recipe identities', () => {
    for (const ids of [PRODUCTS.map(p => p.modelId), PRODUCTS.map(p => p.id)]) {
      expect(new Set(ids).size).toBe(PRODUCTS.length);
    }
  });
  it('keeps public IDs separate from recipe and source identities', () => {
    expect(MODEL_IDS).toEqual(['gfs', 'icon-eu']);
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
    expect(ICON_EU_PRODUCT.maxNativeZoom).toBe(8);
    expect(ICON_EU_PRODUCT.capabilities).toEqual({
      verticalCoordinate: 'model-levels',
      maxVerticalLevels: 30,
      daylightFrames: 'regional-daylight'
    });
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
      upstream: { independentlyOwnedByAdapter: true }
    });
    expect(product.layers).toEqual(['usable-lift-agl']);
    expect(product.frameHours).toEqual([3, 6]);
    expect(product.capabilities.maxVerticalLevels).toBe(12);
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
