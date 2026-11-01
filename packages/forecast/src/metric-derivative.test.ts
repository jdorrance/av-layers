import { describe, expect, it } from 'vitest';
import { getBit, gridVectorToEarth, prepareGridGeometry, setBit, type Grid, type LambertConformalGrid, type RegularLatLonGrid } from '@av/contracts';
import { COLUMN_SUPPORT, planFieldSupport, type SupportOffset } from './support.js';

const width = 7, height = 7, center = 3 * width + 3;
const cross: readonly SupportOffset[] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
const signs = [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const;
const targets = (indices: number[]) => {
  const bits = new Uint8Array(Math.ceil(width * height / 8));
  for (const i of indices) setBit(bits, i);
  return bits;
};

/** Test-only scalar gradient, not a forecast product or a vector-divergence
 * implementation. A scalar's derivatives transform as an orthonormal vector.
 * A conformal projected derivative is multiplied by local map scale; signed
 * storage steps must be restored separately from positive metric magnitudes.
 */
function gradient(grid: Grid, values: Float64Array, index: number, missing = new Uint8Array(width * height)) {
  const support = planFieldSupport(grid, targets([index]), COLUMN_SUPPORT, cross);
  if (getBit(support.unavailableOutput, index)) return null;
  const neighbors = [index - 1, index + 1, index - width, index + width];
  if (neighbors.some(i => missing[i] || !Number.isFinite(values[i]))) return null;
  const geometry = prepareGridGeometry(grid);
  const point = geometry.gridToGeographic(index % width, Math.floor(index / width));
  if (!point) return null;
  const metrics = geometry.rotationAndMetrics(point.lat, point.lon);
  if (!metrics) return null;
  const sx = Math.sign(grid.kind === 'lambert-conformal' ? grid.dxM : grid.dx);
  const sy = Math.sign(grid.kind === 'lambert-conformal' ? grid.dyM : grid.dy);
  return gridVectorToEarth(
    (values[index + 1] - values[index - 1]) / (2 * sx * metrics.metersPerColumn),
    (values[index + width] - values[index - width]) / (2 * sy * metrics.metersPerRow),
    metrics
  );
}

function projectedFixture(sx: number, sy: number) {
  const dxM = sx * 1000, dyM = sy * 1700;
  // Independent PROJ 9.6.0 point at longitude -90, latitude 45, from the
  // checked-in contracts/fixtures/lambert.json control set. Do not obtain the
  // field or expected result by projecting coordinates with the code tested.
  const grid: LambertConformalGrid = {
    kind: 'lambert-conformal', width, height, earthRadiusM: 6371229,
    centralMeridianDeg: -100, latitudeOfOriginDeg: 40,
    standardParallel1Deg: 30, standardParallel2Deg: 60,
    x0M: 757366.5627555264 - 3 * dxM, y0M: 585230.9026221943 - 3 * dyM,
    dxM, dyM, wrapLongitude: false
  };
  // f(X,Y) = 0.0002 X - 0.0003 Y has exact projected partials (a,b).
  const values = Float64Array.from({ length: width * height }, (_, i) =>
    0.0002 * (grid.x0M + (i % width) * dxM) - 0.0003 * (grid.y0M + Math.floor(i / width) * dyM));
  return { grid, values };
}

describe('test-only physical derivatives on native grids', () => {
  it.each(signs)('uses independent LCC scale/convergence with signed steps (%i,%i)', (sx, sy) => {
    const { grid, values } = projectedFixture(sx, sy);
    const actual = gradient(grid, values, center)!;
    // Independent `proj -V` at (45,-90): k=0.96571753, convergence=7.15566847°.
    // Analytic ground gradient is k R(convergence) (a,b). These expectations
    // use those external controls, not rotationAndMetrics from the test subject.
    // Tolerance reflects the eight decimal places reported by PROJ's controls.
    expect(actual.east).toBeCloseTo(0.0001555506391137634, 11);
    expect(actual.north).toBeCloseTo(-0.00031151780667998554, 11);
    const zero = gradient(grid, new Float64Array(width * height).fill(42), center)!;
    expect(zero.east).toBeCloseTo(0, 14);
    expect(zero.north).toBeCloseTo(0, 14);
  });

  it.each(signs)('uses spherical latitude metrics with signed degree steps (%i,%i)', (sx, sy) => {
    const dx = sx * 0.5, dy = sy * 0.25, radius = 6371229;
    const grid: RegularLatLonGrid = {
      kind: 'regular-latlon', width, height, earthRadiusM: radius,
      lon0: -90 - 3 * dx, lat0: 60 - 3 * dy, dx, dy, wrapLongitude: false
    };
    // Exact spherical identity: ds_east=R cos(phi) d(lambda), ds_north=R d(phi).
    // f=R[2(lambda-lambda0)+3(phi-phi0)] therefore has ground gradient
    // (2/cos(60°),3)=(4,3) at the center, independently of storage direction.
    const values = Float64Array.from({ length: width * height }, (_, i) =>
      radius * Math.PI / 180 * (2 * ((i % width) - 3) * dx + 3 * (Math.floor(i / width) - 3) * dy));
    expect(gradient(grid, values, center)!.east).toBeCloseTo(4, 12);
    expect(gradient(grid, values, center)!.north).toBeCloseTo(3, 12);
    const zero = gradient(grid, new Float64Array(width * height).fill(42), center)!;
    expect(zero.east).toBeCloseTo(0, 14);
    expect(zero.north).toBeCloseTo(0, 14);
  });

  it.each(signs)('keeps physical derivatives unavailable at missing support and regional edges (%i,%i)', (sx, sy) => {
    const { grid, values } = projectedFixture(sx, sy);
    for (const neighbor of [center - 1, center + 1, center - width, center + width]) {
      const missing = new Uint8Array(width * height); missing[neighbor] = 1;
      expect(gradient(grid, values, center, missing)).toBeNull();
      const nonfinite = new Float64Array(values); nonfinite[neighbor] = NaN;
      expect(gradient(grid, nonfinite, center)).toBeNull();
    }
    // Every edge/corner requires off-domain support. Do not flatten rows,
    // clamp a neighbor, wrap a regional grid, or turn missing support into zero.
    for (const index of [0, 3, 6, 3 * width, 3 * width + 6, 6 * width, 6 * width + 3, 48]) {
      expect(gradient(grid, values, index)).toBeNull();
      expect(gradient(grid, new Float64Array(width * height).fill(42), index)).toBeNull();
    }
    const unrelatedMissing = new Uint8Array(width * height); unrelatedMissing[0] = 1;
    expect(gradient(grid, values, center, unrelatedMissing)!.east).toBeCloseTo(0.0001555506391137634, 11);
  });

  it('preserves metric-aware results across independently populated support chunks', () => {
    const { grid, values } = projectedFixture(-1, 1);
    for (const chunk of [[center - 1, center], [center, center + 1]]) {
      const support = planFieldSupport(grid, targets(chunk), COLUMN_SUPPORT, cross);
      const selected = new Float64Array(width * height).fill(NaN);
      for (let i = 0; i < selected.length; i++) if (getBit(support.input, i)) selected[i] = values[i];
      for (const index of chunk) expect(gradient(grid, selected, index)).toEqual(gradient(grid, values, index));
      expect(gradient(grid, selected, center)!.east).toBeCloseTo(0.0001555506391137634, 11);
      expect(gradient(grid, selected, center)!.north).toBeCloseTo(-0.00031151780667998554, 11);
      selected[center + width] = NaN;
      expect(gradient(grid, selected, center)).toBeNull();
    }
  });
});
