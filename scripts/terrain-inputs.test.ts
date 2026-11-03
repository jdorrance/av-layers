import { describe, expect, it } from 'vitest';
import { terrainInputForModel } from './terrain-inputs.js';

const ref = { key: `terrain/prepared/${'a'.repeat(64)}/manifest.json`, sha256: 'b'.repeat(64), bytes: 100, arrayBytes: 20 };

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
