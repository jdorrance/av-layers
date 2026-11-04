import { describe, expect, it } from 'vitest';
import { setBit, sparseCoverageFromDense, sparseCoverageLookup, STATUS_NO_LIFT, STATUS_UNAVAILABLE, SUPPORT_PROFILE_TOP, type CoverageMask } from '@av/contracts';
import { prepareGridSampling, preparePointSampling, sampleGrid, type PackedGridField, type SparseSamplingMask } from './sampler.js';

function fixture() {
  const grid = { kind: 'regular-latlon' as const, earthRadiusM: 6371229, width: 20, height: 4, lon0: -180, lat0: 3, dx: 18, dy: -1, wrapLongitude: true };
  const mask: CoverageMask = { grid, output: new Uint8Array(10), halo: new Uint8Array(10), tiles: Uint8Array.of(1), maxZoom: 0 };
  for (const [x, y] of [[0, 1], [19, 1], [16, 2], [17, 2]]) setBit(mask.output, y * grid.width + x);
  for (const [x, y] of [[0, 1], [19, 1], [16, 2], [17, 2]]) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const row = y + dy, column = (x + dx + grid.width) % grid.width, index = row * grid.width + column;
    if (!(mask.output[index >> 3] & (1 << (index & 7)))) setBit(mask.halo, index);
  }
  const coverage = sparseCoverageFromDense({ ...grid, gridHash: 'a'.repeat(64), output: mask.output, halo: mask.halo });
  const dense = { values: Float32Array.from({ length: 80 }, (_, i) => i * 0.13), flags: new Uint8Array(80) };
  dense.flags[19 + 20] = STATUS_UNAVAILABLE; dense.flags[16 + 40] = STATUS_NO_LIFT | SUPPORT_PROFILE_TOP;
  const packed: PackedGridField = { values: new Float32Array(coverage.offsets[coverage.blockIds.length]), flags: new Uint8Array(coverage.offsets[coverage.blockIds.length]), coverage };
  for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
    const cell = sparseCoverageLookup(coverage, x, y);
    if (cell) { packed.values[cell.offset] = dense.values[y * grid.width + x]; packed.flags[cell.offset] = dense.flags[y * grid.width + x]; }
  }
  const sparse: SparseSamplingMask = { grid, tiles: mask.tiles, maxZoom: 0, coverage };
  return { grid, mask, sparse, dense, packed };
}

describe('packed sampling', () => {
  it('matches dense scalar and prepared sampling at wrap, block and output/halo boundaries', () => {
    const { grid, mask, sparse, dense, packed } = fixture();
    const lats = Float64Array.of(2, 2, 2.25, 1.5, 1, 1.5, 3, 2);
    const lons = Float64Array.of(-180, 162, 171, 126, 108, 135, 0, -90);
    for (const layer of ['usable-lift-msl', 'usable-lift-agl'] as const) {
      const a = preparePointSampling(mask, lats, lons).bind(dense, layer), b = preparePointSampling(sparse, lats, lons).bind(packed, layer);
      for (let i = 0; i < lats.length; i++) {
        const expected = sampleGrid(grid, dense, lats[i], lons[i], layer, mask);
        const actual = { value: null as number | null, status: 3, support: 0, interpolated: false }, baseline = { ...actual };
        a(i, 0, baseline); b(i, 0, actual);
        expect(actual).toEqual(baseline); expect(actual).toEqual(expected);
        expect(sampleGrid(grid, packed, lats[i], lons[i], layer, sparse)).toEqual(expected);
      }
      const regular = prepareGridSampling(mask, lats, lons).bind(dense, layer), sparseRegular = prepareGridSampling(sparse, lats, lons).bind(packed, layer);
      for (let y = 0; y < lats.length; y++) for (let x = 0; x < lons.length; x++) {
        const expected = { value: null as number | null, status: 3, support: 0, interpolated: false }, actual = { ...expected };
        regular(x, y, expected); sparseRegular(x, y, actual); expect(actual).toEqual(expected);
      }
    }
  });

  it('rejects mismatched packed layouts and inactive positive contributors', () => {
    const { grid, sparse, packed } = fixture();
    expect(() => sampleGrid(grid, { ...packed, flags: new Uint8Array(1) }, 2, -180, 'usable-lift-msl', sparse)).toThrow('Packed field');
    expect(() => sampleGrid(grid, { ...packed, coverage: { ...packed.coverage } }, 2, -180, 'usable-lift-msl', sparse)).toThrow('Packed field');
    const uncovered = { ...packed.coverage, halo: new Uint8Array(packed.coverage.halo.length) };
    const incompatible = { ...packed, coverage: uncovered };
    expect(() => sampleGrid(grid, incompatible, 2.25, -175.5, 'usable-lift-msl', { ...sparse, coverage: uncovered })).toThrow('outside active coverage');
  });
});
