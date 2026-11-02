import { describe, expect, it } from 'vitest';
import { getProduct, GFS_PRODUCT, MODEL_IDS } from './products.js';

describe('production product registry', () => {
  it('keeps public IDs separate from recipe and source identities', () => {
    expect(MODEL_IDS).toEqual(['gfs']);
    expect(getProduct('gfs')).toBe(GFS_PRODUCT);
    expect(GFS_PRODUCT.id).toBe('gfs-soaring');
    expect(GFS_PRODUCT.source).toEqual({ modelFamily: 'gfs', configurationId: 'noaa-gfs-0p25', domainId: 'global' });
  });
  it.each(['constructor', '__proto__', 'toString', 'fixture-regular-domain', 'unknown'])('rejects unregistered public ID %s', model => {
    expect(getProduct(model)).toBeUndefined();
  });
});
