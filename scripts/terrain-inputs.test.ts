import { describe, expect, it } from 'vitest';
import { terrainCatalogInput, terrainInputForModel } from './terrain-inputs.js';

const ref = { key: `terrain/prepared/${'a'.repeat(64)}/manifest.json`, sha256: 'b'.repeat(64), bytes: 100, arrayBytes: 20 };

describe('global terrain catalog workflow input', () => {
  it('accepts one pinned catalog independently of model selection', () => {
    const catalog = { key: `terrain/catalogs/${'a'.repeat(64)}.json`, sha256: 'a'.repeat(64), bytes: 100 };
    expect(terrainCatalogInput(JSON.stringify(catalog))).toEqual(catalog);
  });

  it('rejects malformed, unpinned or oversized JSON before preparation', () => {
    for (const json of ['null', '[]', '{}', '{"key":"terrain/catalogs/latest.json"}', JSON.stringify(ref)]) {
      expect(() => terrainCatalogInput(json)).toThrow();
    }
    expect(() => terrainCatalogInput(' '.repeat(16 * 1024) + '{}')).toThrow(/byte budget/);
  });
});

describe('optional terrain workflow inputs', () => {
  it('selects one registered model without making terrain mandatory for others', () => {
    expect(terrainInputForModel(JSON.stringify({ gfs: ref }), 'gfs')).toEqual(ref);
    expect(terrainInputForModel(JSON.stringify({ gfs: ref }), 'icon-eu')).toBeUndefined();
    expect(terrainInputForModel('{}', 'gfs')).toBeUndefined();
  });
  it('rejects malformed or oversized mappings and validates unselected entries', () => {
    for (const json of ['null', '[]', '0', '{"constructor":{}}', '{"gfs":{}}']) expect(() => terrainInputForModel(json, 'icon-eu')).toThrow();
    expect(() => terrainInputForModel(' '.repeat(64 * 1024) + '{}', 'gfs')).toThrow(/byte budget/);
    expect(() => terrainInputForModel(JSON.stringify({ gfs: ref, 'icon-eu': { ...ref, key: '../bad' } }), 'gfs')).toThrow();
  });
});
