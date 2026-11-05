import { INDEXED_PRODUCT, SPLIT_PRODUCT } from '../../../../tests/model-fixtures.js';
import { describe, expect, it } from 'vitest';
import { sameGrid } from '@av/contracts';
import { configuredRefinements } from './config.js';
import { inspectRefinements } from './cli.js';

describe('configured refinement plans', () => {
  it('reuses the same target geometry across sources covering the configured zone', () => {
    const global = configuredRefinements(INDEXED_PRODUCT), regional = configuredRefinements(SPLIT_PRODUCT);
    expect(global.length).toBeGreaterThan(0);
    expect(global.map(zone => zone.id)).toEqual(regional.map(zone => zone.id));
    expect(global.every((zone, index) => sameGrid(zone.grid, regional[index].grid))).toBe(true);
  });

  it('allows an empty selection and rejects unknown models before doing work', async () => {
    expect(configuredRefinements(INDEXED_PRODUCT, { type: 'FeatureCollection', features: [] })).toEqual([]);
    await expect(inspectRefinements(['--model', 'unknown'])).rejects.toThrow('registered --model');
    await expect(inspectRefinements([])).rejects.toThrow('registered --model');
  });
});
