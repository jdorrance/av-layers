import { describe, expect, it } from 'vitest';
import { getBit, setBit, isCovered, isTileCovered, expectedTiles, paletteColor, modelPointerSchema, type CoverageMask } from './index.js';

describe('contracts', () => {
  it('uses LSB-first bitsets and output, not halo, for coverage with sampler-matched half-cell tie-breaking', () => {
    const bits = new Uint8Array(2); setBit(bits, 0); setBit(bits, 9);
    expect([...bits]).toEqual([1, 2]); expect(getBit(bits, 9)).toBe(true); setBit(bits, 9, false); expect(getBit(bits, 9)).toBe(false); expect(() => setBit(bits, 16)).toThrow();
    const mask: CoverageMask = { grid: { width: 2, height: 2, lon0: -180, lat0: 0, dx: 180, dy: -1, wrapLongitude: true }, output: Uint8Array.of(1), halo: Uint8Array.of(2), tiles: Uint8Array.of(5), maxZoom: 1 };
    expect(isCovered(mask, 0, 180)).toBe(true); expect(isCovered(mask, 0, 0)).toBe(false); expect(isCovered(mask, 66, -180)).toBe(false);
    expect(isCovered(mask, 0, -90)).toBe(true); expect(isCovered(mask, -0.5, -180)).toBe(true);
    const haloLeft: CoverageMask = { ...mask, output: Uint8Array.of(2), halo: Uint8Array.of(1) };
    expect(isCovered(haloLeft, 0, -90)).toBe(false);
    expect(isTileCovered(mask, 0, 0, 0)).toBe(true); expect(isTileCovered(mask, 1, 1, 0)).toBe(true); expect(expectedTiles(mask, 1)).toEqual([{ z: 1, x: 1, y: 0 }]);
  });
  it('returns specified palette endpoints, no-lift and rain transparency', () => {
    expect(paletteColor('usable-lift-msl', null, 1)).toBe('#55184d'); expect(paletteColor('usable-lift-msl', 300, 0)).toBe('#b93b88');
    expect(paletteColor('usable-lift-agl', 7000, 0)).toBe('#003333'); expect(paletteColor('precip-rate', 0.099, 0)).toBeNull(); expect(paletteColor('precip-rate', 50, 0)).toBe('#963f9c');
  });
  it('requires latest membership and caps retained builds', () => {
    const item = { buildId: 'one', manifestKey: 'key', cycle: '2026-10-30T00:00:00Z', expiresAt: '2026-11-06T00:00:00Z' };
    expect(modelPointerSchema.safeParse({ version: 1, model: 'gfs', latestBuildId: 'one', retained: [item] }).success).toBe(true);
    expect(modelPointerSchema.safeParse({ version: 1, model: 'gfs', latestBuildId: 'other', retained: [item] }).success).toBe(false);
    expect(modelPointerSchema.safeParse({ version: 1, model: 'gfs', latestBuildId: 'one', retained: Array(129).fill(item) }).success).toBe(false);
  });
});
