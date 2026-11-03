import { expect, it } from 'vitest';
import { isCovered, prepareCoverageTester, type CoverageMask } from './coverage.js';
import { prepareGridGeometry, type Grid } from './geometry.js';
import fixture from './fixtures/lambert.json';
import { GFS_GRID } from './products.js';

it('compiled coverage preserves exact direct ownership at grid edges, half-cell ties, bounds and wrap', () => {
  for (const grid of [GFS_GRID, { ...GFS_GRID, width: 3, height: 3, lon0: 10, lat0: 40, dx: 1, dy: -1, wrapLongitude: false }, fixture.grid] as Grid[]) {
    const mask: CoverageMask = { grid, output: new Uint8Array(Math.ceil(grid.width * grid.height / 8)).fill(0x55), halo: new Uint8Array(Math.ceil(grid.width * grid.height / 8)), tiles: Uint8Array.of(1), maxZoom: 0 };
    const geometry = prepareGridGeometry(grid), covered = prepareCoverageTester(mask);
    for (const y of [-0.500001, -0.5, -0.499999, 0, 0.5, 1, grid.height - 1, grid.height - 0.5]) {
      for (const x of [-0.500001, -0.5, -0.499999, 0, 0.5, 1, grid.width - 1, grid.width - 0.5]) {
        const point = geometry.gridToGeographic(x, y);
        if (point) expect(covered(point.lat, point.lon)).toBe(isCovered(mask, point.lat, point.lon));
      }
    }
    for (const [lat, lon] of [[NaN, 0], [0, Infinity], [90, 180], [90, -180], [91, 0]]) expect(covered(lat, lon)).toBe(isCovered(mask, lat, lon));
    const bounded = { ...mask, bounds: [-10, -5, 10, 5] as const };
    expect(prepareCoverageTester(bounded)(40, 11)).toBe(false);
  }
});
