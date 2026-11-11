import type { Grid, LambertConformalGrid } from './grid-schema.js';
export type { Grid, LambertConformalGrid, RegularLatLonGrid } from './grid-schema.js';

export const MAX_GRID_DIMENSION = 0x7fffffff;
export const LAMBERT_GRID_FIELDS = ['kind', 'width', 'height', 'earthRadiusM', 'centralMeridianDeg', 'latitudeOfOriginDeg',
  'standardParallel1Deg', 'standardParallel2Deg', 'x0M', 'y0M', 'dxM', 'dyM', 'wrapLongitude'] as const satisfies readonly (keyof LambertConformalGrid)[];

export type GeographicBounds = readonly [west: number, south: number, east: number, north: number];
export interface GridPoint { x: number; y: number }
export interface GeographicPoint { lat: number; lon: number }
const RAD = Math.PI / 180;
const wrapRadians = (value: number) => ((value + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const wrapDegrees = (value: number) => ((value + 180) % 360 + 360) % 360 - 180;
export const snapGridCoordinate = (value: number): number => Math.abs(value - Math.round(value)) <= 1e-10 ? Math.round(value) : value;

/** Bounds are a coarse geographic admission filter. west > east crosses the dateline. */
export function withinGeographicBounds(lat: number, lon: number, bounds?: GeographicBounds): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  if (!bounds) return true;
  const [west, south, east, north] = bounds;
  if (![west, south, east, north].every(Number.isFinite) || south < -90 || north > 90 || south > north || west < -180 || west > 180 || east < -180 || east > 180) return false;
  const insideLongitude = (value: number) => west <= east ? value >= west && value <= east : value >= west || value <= east;
  return lat >= south && lat <= north && (insideLongitude(lon) || (Math.abs(lon) === 180 && insideLongitude(-lon)));
}

function lambertConstants(grid: LambertConformalGrid) {
  const p1 = grid.standardParallel1Deg * RAD, p2 = grid.standardParallel2Deg * RAD;
  const t1 = Math.tan(Math.PI / 4 + p1 / 2), t2 = Math.tan(Math.PI / 4 + p2 / 2);
  const n = Math.abs(p1 - p2) < 1e-14 ? Math.sin(p1) : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(t2 / t1);
  const f = Math.cos(p1) * t1 ** n / n;
  const rho0 = grid.earthRadiusM * f / Math.tan(Math.PI / 4 + grid.latitudeOfOriginDeg * RAD / 2) ** n;
  return { n, f, rho0 };
}

export function validGridCellCount(grid: Pick<Grid, 'width' | 'height'>): boolean {
  const cells = grid.width * grid.height;
  return Number.isSafeInteger(cells) && cells < 0xffffffff;
}

export function validLambertProjection(grid: LambertConformalGrid): boolean {
  const { n, f, rho0 } = lambertConstants(grid);
  return Number.isFinite(n) && Math.abs(n) >= 1e-10 && Number.isFinite(f) && Number.isFinite(rho0);
}

export function isValidGridGeometry(grid: Grid): boolean {
  if (!grid || ![grid.width, grid.height].every(size => Number.isSafeInteger(size) && size > 0 && size <= MAX_GRID_DIMENSION)
      || !validGridCellCount(grid) || !Number.isFinite(grid.earthRadiusM) || grid.earthRadiusM <= 0) return false;
  const finiteStep = (step: number) => Number.isFinite(step) && step !== 0;
  if (grid.kind === 'regular-latlon') {
    return Number.isFinite(grid.lon0) && Number.isFinite(grid.lat0) && Math.abs(grid.lat0) <= 90
      && finiteStep(grid.dx) && finiteStep(grid.dy) && typeof grid.wrapLongitude === 'boolean';
  }
  return grid.kind === 'lambert-conformal' && grid.wrapLongitude === false
    && Number.isFinite(grid.centralMeridianDeg) && Math.abs(grid.centralMeridianDeg) <= 180
    && [grid.latitudeOfOriginDeg, grid.standardParallel1Deg, grid.standardParallel2Deg].every(angle => Number.isFinite(angle) && Math.abs(angle) < 90)
    && Number.isFinite(grid.x0M) && Number.isFinite(grid.y0M) && finiteStep(grid.dxM) && finiteStep(grid.dyM)
    && validLambertProjection(grid);
}

export interface GridGeometry {
  geographicToGrid(lat: number, lon: number): GridPoint | null;
  gridToGeographic(x: number, y: number): GeographicPoint | null;
  /** Grid vectors use positive projected axes, independent of signed storage row/column spacing. */
  rotationAndMetrics(lat: number, lon: number): GridMetrics | null;
}
export interface GridMetrics {
  /** Earth east = cos*u + sin*v; earth north = -sin*u + cos*v. */
  cos: number;
  sin: number;
  /** Projected distance / ground distance; absent for degree-based latitude/longitude. */
  mapScale: number | null;
  metersPerColumn: number;
  metersPerRow: number;
}

/** Compile one validated spherical geometry. No source fields, shared mutable state or caches. */
export function prepareGridGeometry(raw: Grid): GridGeometry {
  if (!isValidGridGeometry(raw)) throw new RangeError('Invalid grid geometry');
  if (raw.kind === 'regular-latlon') {
    const { lon0, lat0, dx, dy, width, earthRadiusM, wrapLongitude } = raw;
    return {
      geographicToGrid(lat, lon) {
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) return null;
        let x = snapGridCoordinate((lon - lon0) / dx);
        const y = snapGridCoordinate((lat - lat0) / dy);
        if (wrapLongitude) x = snapGridCoordinate(((x % width) + width) % width);
        return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
      },
      gridToGeographic(x, y) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const lat = lat0 + y * dy, lon = lon0 + x * dx;
        if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon)) return null;
        return { lat, lon: wrapDegrees(lon) };
      },
      rotationAndMetrics(lat, lon) {
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) >= 90) return null;
        return { cos: 1, sin: 0, mapScale: null, metersPerColumn: Math.abs(dx) * RAD * earthRadiusM * Math.cos(lat * RAD), metersPerRow: Math.abs(dy) * RAD * earthRadiusM };
      }
    };
  }
  const { centralMeridianDeg, x0M, y0M, dxM, dyM, earthRadiusM } = raw;
  const { n, f, rho0 } = lambertConstants(raw), sign = Math.sign(n);
  const project = (lat: number, lon: number) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) >= 90) return null;
    const theta = n * wrapRadians((lon - centralMeridianDeg) * RAD);
    const rho = earthRadiusM * f / Math.tan(Math.PI / 4 + lat * RAD / 2) ** n;
    if (!Number.isFinite(rho)) return null;
    return { theta, rho, x: rho * Math.sin(theta), y: rho0 - rho * Math.cos(theta) };
  };
  return {
    geographicToGrid(lat, lon) {
      const point = project(lat, lon);
      if (!point) return null;
      const x = snapGridCoordinate((point.x - x0M) / dxM), y = snapGridCoordinate((point.y - y0M) / dyM);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    },
    gridToGeographic(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const px = x0M + x * dxM, py = y0M + y * dyM;
      const rho = sign * Math.hypot(px, rho0 - py);
      if (!Number.isFinite(rho) || rho === 0) return null;
      const theta = Math.atan2(sign * px, sign * (rho0 - py));
      if (Math.abs(theta / n) > Math.PI + 1e-12) return null;
      const lat = (2 * Math.atan((earthRadiusM * f / rho) ** (1 / n)) - Math.PI / 2) / RAD;
      const lon = wrapDegrees(centralMeridianDeg + theta / n / RAD);
      return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    },
    rotationAndMetrics(lat, lon) {
      const point = project(lat, lon);
      if (!point) return null;
      const mapScale = Math.abs(n * point.rho) / (earthRadiusM * Math.cos(lat * RAD));
      if (!Number.isFinite(mapScale) || mapScale <= 0) return null;
      return { cos: Math.cos(point.theta), sin: Math.sin(point.theta), mapScale, metersPerColumn: Math.abs(dxM) / mapScale, metersPerRow: Math.abs(dyM) / mapScale };
    }
  };
}

export function geographicToGrid(grid: Grid, lat: number, lon: number): GridPoint | null {
  return prepareGridGeometry(grid).geographicToGrid(lat, lon);
}
export function gridToGeographic(grid: Grid, x: number, y: number): GeographicPoint | null {
  return prepareGridGeometry(grid).gridToGeographic(x, y);
}
export function gridVectorToEarth(u: number, v: number, rotation: Pick<GridMetrics, 'cos' | 'sin'>): { east: number; north: number } {
  return { east: rotation.cos * u + rotation.sin * v, north: -rotation.sin * u + rotation.cos * v };
}
export function earthVectorToGrid(east: number, north: number, rotation: Pick<GridMetrics, 'cos' | 'sin'>): { u: number; v: number } {
  return { u: rotation.cos * east - rotation.sin * north, v: rotation.sin * east + rotation.cos * north };
}

export function normalizeLon(lon: number): number {
  if (!Number.isFinite(lon)) return lon;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 && lon > 0 ? 180 : Object.is(wrapped, -0) ? 0 : wrapped;
}
