import { describe, expect, it } from 'vitest';
import fixture from './fixtures/lambert.json';
import { earthVectorToGrid, geographicToGrid, gridSchema, gridVectorToEarth, prepareGridGeometry, withinGeographicBounds, type LambertConformalGrid } from './geometry.js';
import { GFS_GRID, isCovered, type CoverageMask } from './index.js';

const grid = gridSchema.parse(fixture.grid) as LambertConformalGrid;

describe('native spherical grid geometry', () => {
  it('matches independent PROJ secant LCC controls in both directions', () => {
    const geometry = prepareGridGeometry(grid);
    for (const point of fixture.controlPoints) {
      const projected = geometry.geographicToGrid(point.lat, point.lon)!;
      expect(projected.x * grid.dxM + grid.x0M).toBeCloseTo(point.xM, 6);
      expect(projected.y * grid.dyM + grid.y0M).toBeCloseTo(point.yM, 6);
      const inverse = geometry.gridToGeographic((point.xM - grid.x0M) / grid.dxM, (point.yM - grid.y0M) / grid.dyM)!;
      expect(inverse.lat).toBeCloseTo(point.lat, 10);
      expect(inverse.lon).toBeCloseTo(point.lon, 10);
    }
  });

  it('handles southern and tangent cones against independently generated controls', () => {
    // PROJ 9.6.0: same command with parallels -30,-60, origin -40, meridian 140.
    const south = prepareGridGeometry({ ...grid, centralMeridianDeg: 140, latitudeOfOriginDeg: -40, standardParallel1Deg: -30, standardParallel2Deg: -60, x0M: 0, y0M: 0, dxM: 1, dyM: -1 });
    const p = south.geographicToGrid(-45, 150)!;
    expect(p.x).toBeCloseTo(757366.5627555274, 6);
    expect(p.y).toBeCloseTo(585230.9026221951, 6);
    expect(south.gridToGeographic(p.x, p.y)!.lat).toBeCloseTo(-45, 10);
    expect(south.gridToGeographic(p.x, p.y)!.lon).toBeCloseTo(150, 10);
    // PROJ 9.6.0: parallels 40,40; origin 40; meridian -100; sphere 6371229.
    const tangent = prepareGridGeometry({ ...grid, standardParallel1Deg: 40, standardParallel2Deg: 40, x0M: 0, y0M: 0, dxM: -1, dyM: 1 });
    const t = tangent.geographicToGrid(45, -90)!;
    expect(t.x).toBeCloseTo(-787721.8109120375, 6);
    expect(t.y).toBeCloseTo(600947.9564130091, 6);
    expect(tangent.gridToGeographic(t.x, t.y)!.lat).toBeCloseTo(45, 10);
  });

  it('keeps grid-vector rotation separate from storage direction and validates metric scale', () => {
    const metrics = prepareGridGeometry(grid).rotationAndMetrics(45, -90)!;
    // Independent `proj -V`: convergence 7.15566847 degrees, scale 0.96571753.
    const theta = 7.15566847 * Math.PI / 180;
    expect(metrics.cos).toBeCloseTo(Math.cos(theta), 8);
    expect(metrics.sin).toBeCloseTo(Math.sin(theta), 8);
    expect(metrics.mapScale).toBeCloseTo(0.96571753, 8);
    expect(gridVectorToEarth(1, 0, metrics).north).toBeCloseTo(-Math.sin(theta), 8);
    expect(gridVectorToEarth(0, 1, metrics).east).toBeCloseTo(Math.sin(theta), 8);
    const earth = gridVectorToEarth(12, -7, metrics), back = earthVectorToGrid(earth.east, earth.north, metrics);
    expect(back.u).toBeCloseTo(12, 12);
    expect(back.v).toBeCloseTo(-7, 12);
    const reversed = prepareGridGeometry({ ...grid, dxM: -grid.dxM, dyM: -grid.dyM }).rotationAndMetrics(45, -90)!;
    expect(reversed).toEqual(metrics);
    for (const lat of [30, 60]) expect(prepareGridGeometry(grid).rotationAndMetrics(lat, -100)!.mapScale).toBeCloseTo(1, 12);
    const spherical = prepareGridGeometry(GFS_GRID).rotationAndMetrics(60, 0)!;
    expect(spherical.metersPerColumn / spherical.metersPerRow).toBeCloseTo(0.5, 12);
    expect(prepareGridGeometry(GFS_GRID).rotationAndMetrics(90, 0)).toBeNull();
  });

  it('requires an explicit admitted geometry and rejects singular/oversized inputs', () => {
    for (const invalid of [
      { ...grid, kind: undefined }, { ...grid, wrapLongitude: true }, { ...grid, dxM: 0 },
      { ...grid, earthRadiusM: 0 }, { ...grid, standardParallel1Deg: 90 },
      { ...grid, standardParallel1Deg: 30, standardParallel2Deg: -30 },
      { ...grid, width: 100000, height: 100000 }
    ]) expect(gridSchema.safeParse(invalid).success).toBe(false);
    const geometry = prepareGridGeometry(grid);
    expect(geometry.geographicToGrid(90, 0)).toBeNull();
    expect(geometry.geographicToGrid(NaN, 0)).toBeNull();
    expect(geometry.gridToGeographic(Infinity, 1)).toBeNull();
  });

  it('preserves periodic regular-grid nodes and removes global latitude policy from coverage', () => {
    expect(geographicToGrid(GFS_GRID, 10.125, 179.875)).toEqual({ x: 1439.5, y: 319.5 });
    expect(geographicToGrid(GFS_GRID, 90, 180)).toEqual({ x: 0, y: -0 });
    const mask: CoverageMask = { grid: { ...GFS_GRID, width: 2, height: 2, lon0: 0, lat0: 71, dx: 1, dy: -1, wrapLongitude: false }, output: Uint8Array.of(15), halo: Uint8Array.of(0), tiles: Uint8Array.of(1), maxZoom: 0 };
    expect(isCovered(mask, 70.5, 0.5)).toBe(true);
    expect(isCovered({ ...mask, bounds: [-180, -55, 180, 65] }, 70.5, 0.5)).toBe(false);
    expect(withinGeographicBounds(0, 179, [170, -10, -170, 10])).toBe(true);
    expect(withinGeographicBounds(0, -179, [170, -10, -170, 10])).toBe(true);
    expect(withinGeographicBounds(0, 0, [170, -10, -170, 10])).toBe(false);
    expect(withinGeographicBounds(0, 180, [-180, -10, -170, 10])).toBe(true);
  });
});
