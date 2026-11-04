import { describe, expect, it } from 'vitest';
import { setBit, sparseCoverageFromDense, sparseCoverageLookup, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, SUPPORT_PARCEL_CROSSING, SUPPORT_PBL_CLOSURE, SUPPORT_PROFILE_TOP, type CoverageMask } from '@av/contracts';
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
  it.each([false, true])('rechecks colliding quads after a missing contributor (%s) and reads live fields', missing => {
    const grid = { kind: 'regular-latlon' as const, earthRadiusM: 6371229, width: 514, height: 2, lon0: -180, lat0: 1, dx: 0.5, dy: -1, wrapLongitude: false };
    const mask: CoverageMask = { grid, output: new Uint8Array(129), halo: new Uint8Array(129), tiles: Uint8Array.of(1), maxZoom: 0 };
    for (const index of [0, 512]) setBit(mask.output, index);
    for (const index of [1, 514, 515, 1026, 1027, ...(missing ? [] : [513])]) setBit(mask.halo, index);
    const coverage = sparseCoverageFromDense({ ...grid, gridHash: 'b'.repeat(64), output: mask.output, halo: mask.halo });
    const sparse: SparseSamplingMask = { grid, tiles: mask.tiles, maxZoom: 0, coverage };
    const latitudes = Float64Array.of(0.75, 0.75), longitudes = Float64Array.of(-179.875, 76.125);
    for (const prepare of [prepareGridSampling, preparePointSampling]) {
      const packed: PackedGridField = { coverage, values: new Float32Array(coverage.offsets.at(-1)!), flags: new Uint8Array(coverage.offsets.at(-1)!) };
      for (let y = 0; y < 2; y++) for (let x = 0; x < 514; x++) {
        const cell = sparseCoverageLookup(coverage, x, y);
        if (cell) packed.values[cell.offset] = y * 514 + x + 100;
      }
      const sample = prepare(sparse, latitudes, longitudes).bind(packed, 'usable-lift-msl');
      const out = { value: null as number | null, status: 3, support: 0, interpolated: false };
      sample(0, 0, out);
      expect(out).toEqual(sampleGrid(grid, packed, latitudes[0], longitudes[0], 'usable-lift-msl', sparse));
      if (missing) expect(() => sample(1, 0, out)).toThrow('outside active coverage');
      else {
        sample(1, 0, out);
        expect(out).toEqual(sampleGrid(grid, packed, latitudes[1], longitudes[1], 'usable-lift-msl', sparse));
      }
      packed.values[0] = 999; packed.flags[1] = STATUS_NO_LIFT;
      sample(0, 0, out);
      expect(out).toEqual(sampleGrid(grid, packed, latitudes[0], longitudes[0], 'usable-lift-msl', sparse));
    }
  });

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

  it('matches dense prepared and scalar sampling exactly across status and support flags', () => {
    const { grid, mask, sparse, dense, packed } = fixture();
    dense.flags.fill(0);
    dense.flags[0 + 20] = STATUS_NO_LIFT | SUPPORT_PROFILE_TOP;
    dense.flags[19 + 20] = STATUS_UNAVAILABLE | SUPPORT_PBL_CLOSURE;
    dense.flags[16 + 40] = STATUS_OUTSIDE;
    dense.flags[17 + 40] = SUPPORT_PARCEL_CROSSING;
    for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
      const cell = sparseCoverageLookup(packed.coverage, x, y);
      if (cell) packed.flags[cell.offset] = dense.flags[y * grid.width + x];
    }
    const lats = Float64Array.of(2, 2, 2, 1, 2.25, 1.5, 2, 1);
    const lons = Float64Array.of(-90, -180, 162, 108, 171, 126, 0, -175.5);
    const a = preparePointSampling(mask, lats, lons).bind(dense, 'usable-lift-msl'), b = preparePointSampling(sparse, lats, lons).bind(packed, 'usable-lift-msl');
    for (let i = 0; i < lats.length; i++) {
      const expected = sampleGrid(grid, dense, lats[i], lons[i], 'usable-lift-msl', mask);
      const actual = { value: null as number | null, status: 3, support: 0, interpolated: false }, baseline = { ...actual };
      a(i, 0, baseline); b(i, 0, actual);
      expect(actual).toEqual(baseline);
      expect(actual).toEqual(expected);
      expect(sampleGrid(grid, packed, lats[i], lons[i], 'usable-lift-msl', sparse)).toEqual(expected);
    }
    const regular = prepareGridSampling(mask, lats, lons).bind(dense, 'usable-lift-msl'), sparseRegular = prepareGridSampling(sparse, lats, lons).bind(packed, 'usable-lift-msl');
    for (let y = 0; y < lats.length; y++) for (let x = 0; x < lons.length; x++) {
      const expected = { value: null as number | null, status: 3, support: 0, interpolated: false }, actual = { ...expected };
      regular(x, y, expected); sparseRegular(x, y, actual);
      expect(actual).toEqual(expected);
      expect(sampleGrid(grid, packed, lats[y], lons[x], 'usable-lift-msl', sparse)).toEqual(sampleGrid(grid, dense, lats[y], lons[x], 'usable-lift-msl', mask));
    }
  });

  it('rejects mismatched packed layouts and inactive positive contributors', () => {
    const { grid, sparse, packed } = fixture();
    expect(() => sampleGrid(grid, { ...packed, flags: new Uint8Array(1) }, 2, -180, 'usable-lift-msl', sparse)).toThrow('Packed field');
    expect(() => sampleGrid(grid, { ...packed, coverage: { ...packed.coverage } }, 2, -180, 'usable-lift-msl', sparse)).toThrow('Packed field');
    const uncovered = { ...packed.coverage, halo: new Uint8Array(packed.coverage.halo.length) };
    const incompatible = { ...packed, coverage: uncovered };
    const mask = { ...sparse, coverage: uncovered };
    expect(() => sampleGrid(grid, incompatible, 2.25, -175.5, 'usable-lift-msl', mask)).toThrow('outside active coverage');
    const latitudes = Float64Array.of(2.25), longitudes = Float64Array.of(-175.5);
    for (const prepare of [prepareGridSampling, preparePointSampling]) {
      const sample = prepare(mask, latitudes, longitudes).bind(incompatible, 'usable-lift-msl');
      expect(() => sample(0, 0, { value: null, status: STATUS_OUTSIDE, support: 0, interpolated: false })).toThrow('outside active coverage');
    }
  });
});
