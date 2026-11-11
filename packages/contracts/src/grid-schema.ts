import z from 'zod';
import { validGridCellCount, validLambertProjection, MAX_GRID_DIMENSION } from './geometry.js';

const finite = z.number().finite();
const step = finite.refine(value => value !== 0, 'Grid spacing must be nonzero');
const latitude = finite.min(-90).max(90);
const interiorLatitude = finite.gt(-90).lt(90);
const common = {
  width: z.number().int().positive().max(MAX_GRID_DIMENSION),
  height: z.number().int().positive().max(MAX_GRID_DIMENSION),
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
  if (!validGridCellCount(grid)) {
    ctx.addIssue({ code: 'custom', message: 'Grid cell indices exceed uint32' });
  }
  if (grid.kind === 'lambert-conformal' && !validLambertProjection(grid)) {
    ctx.addIssue({ code: 'custom', message: 'Degenerate Lambert standard parallels or origin' });
  }
});
export type RegularLatLonGrid = z.infer<typeof regularLatLonGridSchema>;
export type LambertConformalGrid = z.infer<typeof lambertConformalGridSchema>;
export type Grid = z.infer<typeof gridSchema>;

/** Compare declared geometry, independent of JSON property insertion order. */
export function sameGrid(left: Grid, right: Grid): boolean {
  const a = gridSchema.safeParse(left), b = gridSchema.safeParse(right);
  return a.success && b.success && JSON.stringify(a.data) === JSON.stringify(b.data);
}
