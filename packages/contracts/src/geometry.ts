import z from 'zod';

const finite = z.number().finite();
const step = finite.refine(value => value !== 0, 'Grid spacing must be nonzero');
const latitude = finite.min(-90).max(90);
const interiorLatitude = finite.gt(-90).lt(90);
const common = {
  width: z.number().int().positive().max(0x7fffffff),
  height: z.number().int().positive().max(0x7fffffff),
  earthRadiusM: finite.positive()
};

export const regularLatLonGridSchema = z.object({
  kind: z.literal('regular-latlon'), ...common,
  lon0: finite, lat0: latitude, dx: step, dy: step, wrapLongitude: z.boolean()
});
export const lambertConformalGridSchema = z.object({
  kind: z.literal('lambert-conformal'), ...common,
  centralMeridianDeg: finite.min(-180).max(180),
  latitudeOfOriginDeg: interiorLatitude,
  standardParallel1Deg: interiorLatitude,
  standardParallel2Deg: interiorLatitude,
  /** Coordinates of the first mass-grid cell relative to the projection origin. */
  x0M: finite, y0M: finite, dxM: step, dyM: step,
  wrapLongitude: z.literal(false)
});
export const gridSchema = z.discriminatedUnion('kind', [regularLatLonGridSchema, lambertConformalGridSchema]).superRefine((grid, ctx) => {
  if (!Number.isSafeInteger(grid.width * grid.height) || grid.width * grid.height >= 0xffffffff) {
    ctx.addIssue({ code: 'custom', message: 'Grid cell indices exceed uint32' });
  }
  if (grid.kind === 'lambert-conformal') {
    const { n, f, rho0 } = lambertConstants(grid);
    if (!Number.isFinite(n) || Math.abs(n) < 1e-10 || !Number.isFinite(f) || !Number.isFinite(rho0)) {
      ctx.addIssue({ code: 'custom', message: 'Degenerate Lambert standard parallels or origin' });
    }
  }
});
export type RegularLatLonGrid = z.infer<typeof regularLatLonGridSchema>;
export type LambertConformalGrid = z.infer<typeof lambertConformalGridSchema>;
export type Grid = z.infer<typeof gridSchema>;

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
  const grid = gridSchema.parse(raw);
  if (grid.kind === 'regular-latlon') {
    return {
      geographicToGrid(lat, lon) {
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) return null;
        let x = snapGridCoordinate((lon - grid.lon0) / grid.dx);
        const y = snapGridCoordinate((lat - grid.lat0) / grid.dy);
        if (grid.wrapLongitude) x = snapGridCoordinate(((x % grid.width) + grid.width) % grid.width);
        return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
      },
      gridToGeographic(x, y) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const lat = grid.lat0 + y * grid.dy, lon = grid.lon0 + x * grid.dx;
        if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon)) return null;
        return { lat, lon: wrapDegrees(lon) };
      },
      rotationAndMetrics(lat, lon) {
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) >= 90) return null;
        return { cos: 1, sin: 0, mapScale: null, metersPerColumn: Math.abs(grid.dx) * RAD * grid.earthRadiusM * Math.cos(lat * RAD), metersPerRow: Math.abs(grid.dy) * RAD * grid.earthRadiusM };
      }
    };
  }
  const { n, f, rho0 } = lambertConstants(grid), sign = Math.sign(n);
  const project = (lat: number, lon: number) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) >= 90) return null;
    const theta = n * wrapRadians((lon - grid.centralMeridianDeg) * RAD);
    const rho = grid.earthRadiusM * f / Math.tan(Math.PI / 4 + lat * RAD / 2) ** n;
    if (!Number.isFinite(rho)) return null;
    return { theta, rho, x: rho * Math.sin(theta), y: rho0 - rho * Math.cos(theta) };
  };
  return {
    geographicToGrid(lat, lon) {
      const point = project(lat, lon);
      if (!point) return null;
      const x = snapGridCoordinate((point.x - grid.x0M) / grid.dxM), y = snapGridCoordinate((point.y - grid.y0M) / grid.dyM);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    },
    gridToGeographic(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const px = grid.x0M + x * grid.dxM, py = grid.y0M + y * grid.dyM;
      const rho = sign * Math.hypot(px, rho0 - py);
      if (!Number.isFinite(rho) || rho === 0) return null;
      const theta = Math.atan2(sign * px, sign * (rho0 - py));
      if (Math.abs(theta / n) > Math.PI + 1e-12) return null;
      const lat = (2 * Math.atan((grid.earthRadiusM * f / rho) ** (1 / n)) - Math.PI / 2) / RAD;
      const lon = wrapDegrees(grid.centralMeridianDeg + theta / n / RAD);
      return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    },
    rotationAndMetrics(lat, lon) {
      const point = project(lat, lon);
      if (!point) return null;
      const mapScale = Math.abs(n * point.rho) / (grid.earthRadiusM * Math.cos(lat * RAD));
      if (!Number.isFinite(mapScale) || mapScale <= 0) return null;
      return { cos: Math.cos(point.theta), sin: Math.sin(point.theta), mapScale, metersPerColumn: Math.abs(grid.dxM) / mapScale, metersPerRow: Math.abs(grid.dyM) / mapScale };
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
