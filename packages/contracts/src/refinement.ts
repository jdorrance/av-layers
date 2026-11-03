import z from 'zod';
import { MAX_GRID_CELLS } from './coverage.js';
import { gridSchema, prepareGridGeometry, withinGeographicBounds, type GeographicBounds, type Grid, type LambertConformalGrid } from './geometry.js';

/** Shared projected spacing; geometry and source support determine each bounded grid. */
export const REFINEMENT_SPACING_M = 1000;
const MAX_COORDINATES = 1024;
const EPSILON = 1e-12;
const position = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-80).max(80)]);
const ring = z.array(position).min(4).max(256);
const polygon = z.array(ring).min(1).max(16);
const geometrySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('Polygon'), coordinates: polygon }),
  z.strictObject({ type: z.literal('MultiPolygon'), coordinates: z.array(polygon).min(1).max(16) })
]);
type Position = z.infer<typeof position>;
type Polygon = z.infer<typeof polygon>;
export type RefinementGeometry = z.infer<typeof geometrySchema>;
const polygons = (geometry: RefinementGeometry): Polygon[] => geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
const equal = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];
const cross = (a: Position, b: Position, c: Position) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSegment = (a: Position, b: Position, p: Position) => Math.abs(cross(a, b, p)) <= EPSILON && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
function intersects(a: Position, b: Position, c: Position, d: Position): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return ((abC > EPSILON && abD < -EPSILON || abC < -EPSILON && abD > EPSILON)
    && (cdA > EPSILON && cdB < -EPSILON || cdA < -EPSILON && cdB > EPSILON))
    || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
function ringsIntersect(a: Position[], b: Position[]): boolean {
  for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) {
    if (intersects(a[i - 1], a[i], b[j - 1], b[j])) return true;
  }
  return false;
}
/** Ring boundaries belong to the ring; hole boundaries are excluded by inPolygon. */
function inRing(ring: Position[], point: Position): boolean {
  let inside = false;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i];
    if (onSegment(a, b, point)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function inPolygon(polygon: Polygon, point: Position): boolean {
  if (!inRing(polygon[0], point)) return false;
  for (let i = 1; i < polygon.length; i++) if (inRing(polygon[i], point)) return false;
  return true;
}
function overlaps(a: Polygon, b: Polygon): boolean {
  return a.some(ringA => b.some(ringB => ringsIntersect(ringA, ringB))) || inPolygon(a, b[0][0]) || inPolygon(b, a[0][0]);
}
function geometriesOverlap(a: RefinementGeometry, b: RefinementGeometry): boolean {
  const other = polygons(b);
  return polygons(a).some(part => other.some(candidate => overlaps(part, candidate)));
}
function coordinateCount(geometry: RefinementGeometry): number {
  let count = 0;
  for (const part of polygons(geometry)) for (const ring of part) count += ring.length;
  return count;
}
function ringArea(points: Position[]): number {
  let area = 0;
  for (let i = 1; i + 1 < points.length; i++) area += cross(points[0], points[i], points[i + 1]);
  return Math.abs(area) / 2;
}
function geometryBounds(geometry: RefinementGeometry): GeographicBounds {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const polygon of polygons(geometry)) for (const [lon, lat] of polygon[0]) {
    west = Math.min(west, lon); east = Math.max(east, lon); south = Math.min(south, lat); north = Math.max(north, lat);
  }
  return [west, south, east, north];
}
function validateRing(ring: Position[]): void {
  if (!equal(ring[0], ring[ring.length - 1])) throw new Error('Refinement rings must be closed');
  for (let i = 1; i < ring.length; i++) {
    if (equal(ring[i - 1], ring[i])) throw new Error('Refinement rings have repeated adjacent vertices');
    if (Math.abs(ring[i][0] - ring[i - 1][0]) > 180) throw new Error('Dateline-crossing refinement edges are unsupported; split the polygon');
    for (let j = i + 2; j < ring.length; j++) {
      if (i === 1 && j === ring.length - 1) continue;
      if (intersects(ring[i - 1], ring[i], ring[j - 1], ring[j])) throw new Error('Refinement rings must not self-intersect or touch');
    }
  }
  if (ringArea(ring) <= EPSILON / 2) throw new Error('Refinement rings must enclose a nonzero area');
}
function validatePolygon(part: Polygon): void {
  for (const ring of part) validateRing(ring);
  for (let i = 1; i < part.length; i++) {
    if (!inRing(part[0], part[i][0]) || ringsIntersect(part[0], part[i])) throw new Error('Refinement holes must lie strictly inside their outer ring');
    for (let j = 1; j < i; j++) {
      if (ringsIntersect(part[i], part[j]) || inRing(part[i], part[j][0]) || inRing(part[j], part[i][0])) throw new Error('Refinement holes must not overlap or touch');
    }
  }
}
function validateGeometry(geometry: RefinementGeometry): void {
  const bounds = geometryBounds(geometry);
  if (bounds[2] - bounds[0] > 20 || bounds[3] - bounds[1] > 20) throw new Error('Refinement zones must span at most 20 degrees per axis; split larger or dateline-crossing areas');
  const parts = polygons(geometry);
  for (const part of parts) validatePolygon(part);
  for (let i = 0; i < parts.length; i++) for (let j = 0; j < i; j++) {
    if (overlaps(parts[i], parts[j])) throw new Error('Refinement polygon components must not overlap or touch');
  }
}

export const refinementConfigSchema = z.strictObject({
  type: z.literal('FeatureCollection'),
  features: z.array(z.strictObject({
    type: z.literal('Feature'), id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    properties: z.strictObject({}), geometry: geometrySchema
  })).max(16)
}).superRefine((config, context) => {
  try {
    const coordinates = config.features.reduce((sum, feature) => sum + coordinateCount(feature.geometry), 0);
    if (coordinates > MAX_COORDINATES) throw new Error('Refinement coordinate budget exceeded');
    const ids = new Set<string>();
    for (const feature of config.features) {
      if (ids.has(feature.id)) throw new Error('Refinement IDs must be unique');
      ids.add(feature.id); validateGeometry(feature.geometry);
    }
    for (let i = 0; i < config.features.length; i++) for (let j = 0; j < i; j++) {
      if (geometriesOverlap(config.features[i].geometry, config.features[j].geometry)) throw new Error('Refinement zones must not overlap or touch');
    }
  } catch (error) { context.addIssue({ code: 'custom', message: (error as Error).message }); }
});
export type RefinementConfig = z.infer<typeof refinementConfigSchema>;
export function parseRefinementConfig(raw: unknown): RefinementConfig { return refinementConfigSchema.parse(raw); }

export interface RefinementPlan {
  id: string;
  geometry: RefinementGeometry;
  /** Polygon ownership clipped to admitted source coverage; never includes its computational halo. */
  bounds: GeographicBounds;
  /** Native grid-center extent: remapping must reject contributors outside this support. */
  sourceBounds: GeographicBounds;
  grid: LambertConformalGrid;
}

/** Exact lon/lat polygon ownership, including outer boundaries and excluding holes. */
export function containsRefinement(plan: Pick<RefinementPlan, 'geometry' | 'bounds'>, lat: number, lon: number): boolean {
  return withinGeographicBounds(lat, lon, plan.bounds) && polygons(plan.geometry).some(part => inPolygon(part, [lon, lat]));
}
const intersection = (a: GeographicBounds, b: GeographicBounds): GeographicBounds | null => {
  const result: GeographicBounds = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return result[0] < result[2] && result[1] < result[3] ? result : null;
};
function clipRing(ring: Position[], bounds: GeographicBounds): Position[] {
  let points = ring.slice(0, -1);
  const edges = [[0, bounds[0], 1], [0, bounds[2], -1], [1, bounds[1], 1], [1, bounds[3], -1]] as const;
  for (const [axis, limit, sign] of edges) {
    const input = points; points = [];
    if (!input.length) return [];
    let previous = input[input.length - 1], previousInside = (previous[axis] - limit) * sign >= 0;
    for (const point of input) {
      const inside = (point[axis] - limit) * sign >= 0;
      if (inside !== previousInside) {
        const t = (limit - previous[axis]) / (point[axis] - previous[axis]);
        const intersection: Position = [previous[0] + t * (point[0] - previous[0]), previous[1] + t * (point[1] - previous[1])];
        intersection[axis] = limit;
        points.push(intersection);
      }
      if (inside) points.push(point);
      previous = point; previousInside = inside;
    }
  }
  return points;
}
/** Bound clipped outer rings with positive area; holes keep a conservative envelope. */
function clippedBounds(geometry: RefinementGeometry, bounds: GeographicBounds): GeographicBounds | null {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const part of polygons(geometry)) {
    const outer = clipRing(part[0], bounds);
    const holeArea = part.slice(1).reduce((sum, hole) => sum + ringArea(clipRing(hole, bounds)), 0);
    if (ringArea(outer) - holeArea <= EPSILON) continue;
    for (const point of outer) {
      if (!inRing(part[0], point)) continue;
      west = Math.min(west, point[0]); east = Math.max(east, point[0]);
      south = Math.min(south, point[1]); north = Math.max(north, point[1]);
    }
  }
  return west < east && south < north ? [west, south, east, north] : null;
}
function targetGrid(bounds: GeographicBounds, earthRadiusM: number, haloCells: number): LambertConformalGrid {
  const [west, south, east, north] = bounds, centerLat = (south + north) / 2, centerLon = (west + east) / 2;
  // A tangent cone at zero latitude is singular; a nearby cone also covers equatorial zones.
  const parallel = Math.abs(centerLat) < 1 ? (centerLat < 0 ? -1 : 1) : centerLat;
  const seed: LambertConformalGrid = { kind: 'lambert-conformal', width: 1, height: 1, earthRadiusM,
    centralMeridianDeg: centerLon, latitudeOfOriginDeg: centerLat, standardParallel1Deg: parallel, standardParallel2Deg: parallel,
    x0M: 0, y0M: 0, dxM: 1, dyM: 1, wrapLongitude: false };
  const geometry = prepareGridGeometry(seed);
  // For the admitted local longitude span, extrema occur at corners or the central meridian.
  const points = [south, north].flatMap(lat => [west, centerLon, east].map(lon => geometry.geographicToGrid(lat, lon)!));
  const spacing = REFINEMENT_SPACING_M;
  const minX = Math.floor(Math.min(...points.map(p => p.x)) / spacing) - haloCells;
  const maxX = Math.ceil(Math.max(...points.map(p => p.x)) / spacing) + haloCells;
  const minY = Math.floor(Math.min(...points.map(p => p.y)) / spacing) - haloCells;
  const maxY = Math.ceil(Math.max(...points.map(p => p.y)) / spacing) + haloCells;
  return gridSchema.parse({ ...seed, width: maxX - minX + 1, height: maxY - minY + 1, x0M: minX * spacing, y0M: maxY * spacing, dxM: spacing, dyM: -spacing }) as LambertConformalGrid;
}

/** Plan bounded targets without allocating weather or mask arrays. Omit polygons wholly outside the source. */
export function planRefinements(raw: unknown, options: { sourceGrid: Grid; bounds: GeographicBounds; haloCells: number; maxCells?: number }): RefinementPlan[] {
  const config = parseRefinementConfig(raw);
  const source = gridSchema.parse(options.sourceGrid), { haloCells } = options, maxCells = options.maxCells ?? MAX_GRID_CELLS;
  if (source.kind !== 'regular-latlon') throw new Error('Refinement planning currently requires a regular-latlon source grid');
  if (!Number.isSafeInteger(haloCells) || haloCells < 1 || haloCells > 64 || !Number.isSafeInteger(maxCells) || maxCells < 1 || maxCells > MAX_GRID_CELLS) throw new Error('Invalid refinement halo or cell budget');
  const bounds = options.bounds;
  if (bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] < -180 || bounds[2] > 180 || bounds[0] >= bounds[2] || bounds[1] < -90 || bounds[3] > 90 || bounds[1] >= bounds[3]) throw new Error('Refinement source bounds must be nonwrapping geographic bounds');
  const finalLon = source.lon0 + (source.width - 1) * source.dx, finalLat = source.lat0 + (source.height - 1) * source.dy;
  if (Math.min(source.lat0, finalLat) < -90 || Math.max(source.lat0, finalLat) > 90
      || (source.wrapLongitude ? Math.abs(Math.abs(source.width * source.dx) - 360) > 1e-8 : Math.min(source.lon0, finalLon) < -180 || Math.max(source.lon0, finalLon) > 180)) {
    throw new Error('Refinement source grid requires valid latitudes and either a complete longitude wrap or a noncrossing longitude extent');
  }
  const sourceBounds: GeographicBounds = [source.wrapLongitude ? -180 : Math.min(source.lon0, finalLon), Math.min(source.lat0, finalLat), source.wrapLongitude ? 180 : Math.max(source.lon0, finalLon), Math.max(source.lat0, finalLat)];
  const admitted = intersection(bounds, sourceBounds);
  if (!admitted) return [];
  let totalCells = 0;
  const plans: RefinementPlan[] = [];
  for (const feature of [...config.features].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const bounds = clippedBounds(feature.geometry, admitted);
    if (!bounds) continue;
    const grid = targetGrid(bounds, source.earthRadiusM, haloCells), cells = grid.width * grid.height;
    totalCells += cells;
    if (totalCells > maxCells) throw new Error(`Refinement cell budget exceeded: ${totalCells} > ${maxCells}`);
    plans.push({ id: feature.id, geometry: feature.geometry, bounds, sourceBounds, grid });
  }
  return plans;
}
