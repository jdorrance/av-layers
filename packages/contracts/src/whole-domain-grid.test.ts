import { INDEXED_GRID, SPLIT_GRID } from '../../../tests/model-fixtures.js';
import { describe, expect, it } from 'vitest';
import { getBit } from './coverage.js';
import { geographicToGrid, gridToGeographic, snapGridCoordinate, type RegularLatLonGrid } from './geometry.js';

import { assertWholeDomainDonorsActive, planWholeDomainGrid, wholeDomainDonorSupport } from './whole-domain-grid.js';

const native = (grid: Partial<RegularLatLonGrid> & Pick<RegularLatLonGrid, 'width' | 'height' | 'lon0' | 'lat0' | 'dx' | 'dy' | 'wrapLongitude'>): RegularLatLonGrid =>
  ({ kind: 'regular-latlon', earthRadiusM: 6371229, ...grid });

const wrapGrid = native({ width: 8, height: 5, lon0: -180, lat0: 80, dx: 45, dy: -20, wrapLongitude: true });
const regionalGrid = native({ width: 5, height: 4, lon0: 10, lat0: 60, dx: 5, dy: -5, wrapLongitude: false });
const southwardGrid = native({ width: 4, height: 3, lon0: 0, lat0: -20, dx: 2.5, dy: 2.5, wrapLongitude: false });
const decimalGrid = native({ width: 4, height: 3, lon0: 0, lat0: 40, dx: 0.1, dy: -0.1, wrapLongitude: false });

const indices = (bits: Uint8Array, cells: number): number[] => {
  const result: number[] = [];
  for (let index = 0; index < cells; index++) if (getBit(bits, index)) result.push(index);
  return result;
};

function referenceDonors(grid: RegularLatLonGrid, fine: RegularLatLonGrid, target: number): number[] {
  const x = target % fine.width, y = (target - x) / fine.width;
  const geographic = gridToGeographic(fine, x, y)!;
  const located = geographicToGrid(grid, geographic.lat, geographic.lon)!;
  const nx = snapGridCoordinate(located.x), ny = snapGridCoordinate(located.y);
  const column = Math.floor(nx), row = Math.floor(ny), fx = nx - column, fy = ny - row;
  const result = new Set<number>();
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
    if ((dx && fx === 0) || (dy && fy === 0)) continue;
    const sourceColumn = dx === 0 ? column : (column + 1) % grid.width;
    const sourceRow = dy === 0 ? row : row + 1;
    if ((dy ? fy : 1 - fy) * (dx ? fx : 1 - fx) > 0) result.add(sourceRow * grid.width + sourceColumn);
  }
  return [...result].sort((a, b) => a - b);
}

function expectMatchesReference(grid: RegularLatLonGrid, k: number): ReturnType<typeof planWholeDomainGrid> {
  const plan = planWholeDomainGrid(grid, k);
  const cells = grid.width * grid.height;
  for (let target = 0; target < plan.fine.width * plan.fine.height; target++) {
    const actual = indices(wholeDomainDonorSupport(plan, Uint32Array.of(target)), cells);
    expect(actual, `target ${target}`).toEqual(referenceDonors(grid, plan.fine, target));
  }
  return plan;
}

describe('whole-domain fine grid', () => {
  it('derives configured wrap and regional dimensions with signed native spacing', () => {
    const gfs = planWholeDomainGrid(INDEXED_GRID, 10);
    expect(gfs.fine).toMatchObject({ width: 14400, height: 7201, dx: 0.025, dy: -0.025, lon0: -180, lat0: 90, wrapLongitude: true, earthRadiusM: INDEXED_GRID.earthRadiusM });
    const icon = planWholeDomainGrid(SPLIT_GRID, 5);
    expect(icon.fine).toMatchObject({ width: 6881, height: 3281, dx: 0.0125, dy: -0.0125, lon0: -23.5, lat0: 70.5, wrapLongitude: false });
    const positive = planWholeDomainGrid(southwardGrid, 4);
    expect(positive.fine).toMatchObject({ width: 13, height: 9, dx: 0.625, dy: 0.625 });
    expect(planWholeDomainGrid(wrapGrid, 1).fine).toMatchObject({ width: 8, height: 5 });
  });

  it('rejects invalid factors, underflowing spacing and index-space overflow', () => {
    for (const k of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => planWholeDomainGrid(wrapGrid, k)).toThrow('positive integer');
    }
    expect(() => planWholeDomainGrid(wrapGrid, Number.MAX_SAFE_INTEGER)).toThrow('index space');
    expect(() => planWholeDomainGrid(native({ ...wrapGrid, dx: Number.MIN_VALUE }), 2)).toThrow('underflows');
    const large = native({ width: 40000, height: 40000, lon0: 0, lat0: 40, dx: 0.001, dy: -0.001, wrapLongitude: true });
    expect(() => planWholeDomainGrid(large, 2)).toThrow('index space');
  });
});

describe('whole-domain native donor support', () => {
  it.each([1, 2, 3, 5])('matches the current geographic mapping at every wrap target for k=%i', k => {
    expectMatchesReference(wrapGrid, k);
  });

  it.each([1, 2, 3, 5])('matches the current geographic mapping at every regional target for k=%i', k => {
    expectMatchesReference(regionalGrid, k);
  });

  it.each([3, 7, 10])('matches every target across snapped decimal nodes for k=%i', k => {
    expectMatchesReference(decimalGrid, k);
  });

  it('matches positive signed rows and columns at every target', () => {
    expectMatchesReference(southwardGrid, 3);
  });

  it('assigns terminal south and east cells without leaving the native grid', () => {
    const regional = planWholeDomainGrid(regionalGrid, 5);
    const last = regional.fine.width * regional.fine.height - 1;
    expect(indices(wholeDomainDonorSupport(regional, Uint32Array.of(last)), regionalGrid.width * regionalGrid.height))
      .toEqual([(regionalGrid.height - 1) * regionalGrid.width + regionalGrid.width - 1]);
    const wrapping = planWholeDomainGrid(wrapGrid, 4);
    const row = (wrapGrid.height - 1) * wrapGrid.width;
    expect(indices(wholeDomainDonorSupport(wrapping, Uint32Array.of(wrapping.fine.width * wrapping.fine.height - 1)), wrapGrid.width * wrapGrid.height))
      .toEqual([row, row + wrapGrid.width - 1]);
  });

  it('keeps only the native node when both fractions are zero and both donors when either is positive', () => {
    const plan = planWholeDomainGrid(regionalGrid, 3);
    const cell = (x: number, y: number) => y * plan.fine.width + x;
    expect(referenceDonors(regionalGrid, plan.fine, cell(3, 3))).toEqual([regionalGrid.width + 1]);
    expect(indices(wholeDomainDonorSupport(plan, Uint32Array.of(cell(3, 3))), regionalGrid.width * regionalGrid.height)).toEqual([regionalGrid.width + 1]);
    expect(indices(wholeDomainDonorSupport(plan, Uint32Array.of(cell(4, 3))), regionalGrid.width * regionalGrid.height)).toEqual([regionalGrid.width + 1, regionalGrid.width + 2]);
    expect(indices(wholeDomainDonorSupport(plan, Uint32Array.of(cell(3, 4))), regionalGrid.width * regionalGrid.height)).toEqual([regionalGrid.width + 1, 2 * regionalGrid.width + 1]);
  });

  it('rejects targets outside the fine grid', () => {
    const plan = planWholeDomainGrid(regionalGrid, 2);
    expect(() => wholeDomainDonorSupport(plan, Uint32Array.of(plan.fine.width * plan.fine.height))).toThrow('outside the fine grid');
    expect(() => wholeDomainDonorSupport(plan, 5 as unknown as Iterable<number>)).toThrow('iterable');
    expect(indices(wholeDomainDonorSupport(plan, (function* () { yield plan.fine.width * 2; })()), regionalGrid.width * regionalGrid.height)).toEqual(referenceDonors(regionalGrid, plan.fine, plan.fine.width * 2));
  });
});

describe('whole-domain donor admission', () => {
  const plan = planWholeDomainGrid(wrapGrid, 3);
  const targets = Uint32Array.of(0, 7, plan.fine.width - 1, plan.fine.width * 4 + 2);
  const required = wholeDomainDonorSupport(plan, targets);
  const nativeLayerSupport = new Uint8Array(required.length);
  nativeLayerSupport[0] |= 1;
  nativeLayerSupport[nativeLayerSupport.length - 1] |= 1 << 7;
  const union = Uint8Array.from(required, (byte, index) => byte | nativeLayerSupport[index]);
  const unionIndices = indices(union, wrapGrid.width * wrapGrid.height);

  it('unions with native-layer needs and admits sorted active indices', () => {
    expect(assertWholeDomainDonorsActive(plan, union, Uint32Array.from(unionIndices))).toBeUndefined();
    for (const index of unionIndices) expect(getBit(required, index) || getBit(nativeLayerSupport, index)).toBe(true);
  });

  it('rejects a donor missing from normalized active indices', () => {
    const missing = unionIndices.find(index => getBit(required, index))!;
    const without = Uint32Array.from(unionIndices.filter(index => index !== missing));
    expect(() => assertWholeDomainDonorsActive(plan, union, without)).toThrow(`donor ${missing}`);
  });

  it('rejects unordered, duplicate, out-of-range or missing active lists', () => {
    expect(() => assertWholeDomainDonorsActive(plan, union, [0] as unknown as Uint32Array)).toThrow('active native indices');
    expect(() => assertWholeDomainDonorsActive(plan, union, Uint32Array.of(...[...unionIndices].reverse()))).toThrow('sorted unique');
    expect(() => assertWholeDomainDonorsActive(plan, union, Uint32Array.from([...unionIndices, unionIndices[0]]))).toThrow('sorted unique');
    expect(() => assertWholeDomainDonorsActive(plan, union, Uint32Array.of(wrapGrid.width * wrapGrid.height))).toThrow('sorted unique');
    expect(() => assertWholeDomainDonorsActive(plan, union.slice(1), Uint32Array.from(unionIndices))).toThrow('size differs');
  });
});
