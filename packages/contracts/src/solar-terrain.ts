import z from 'zod';

export const MAX_SOLAR_ASSET_BYTES = 4 * 1024 * 1024;

/** Immutable sunlight tile and relief format consumed by Windgrams. */
export const SOLAR_TERRAIN_FORMAT = Object.freeze({
  schemaVersion: 1, algorithmVersion: 1, tileSize: 256, minZoom: 11, maxZoom: 14,
  horizonZoom: 12, horizonCells: 64, horizonBorder: 1, horizonStepDeg: 0.3,
  azimuthsDeg: Object.freeze(Array.from({ length: 18 }, (_, index) => index * 20)),
  reliefVersion: 1, reliefZoom: 11, reliefMaxSide: 1200, reliefOffsetM: 500, reliefScale: 10
} as const);
const finite = z.number().finite(), nullable = finite.nullable(), integer = z.number().int(), nonnegative = integer.nonnegative();
const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/), generation = z.string().regex(/^[a-f0-9]{12}$/);
export const solarSiteSchema = z.object({ slug, latitude: finite.min(-85.0511287798066).max(85.0511287798066), longitude: finite.min(-180).max(180) });
export type SolarSite = z.infer<typeof solarSiteSchema>;
const bounds = z.object({ south: finite.min(-90).max(90), west: finite, north: finite.min(-90).max(90), east: finite })
  .refine(value => value.south <= value.north && value.west <= value.east && value.east - value.west <= 360, 'Invalid solar terrain bounds');
export type TerrainBounds = z.infer<typeof bounds>;
const area = bounds.and(z.object({ name: z.string().min(1).max(256) }));
export type SolarArea = z.infer<typeof area>;
export const solarTerrainSourceSchema = z.object({ id: z.string().min(1).max(256), name: z.string().min(1).max(256), resolutionM: finite.positive(), licence: z.string().min(1).max(1024), url: z.url().max(2048) });
export type TerrainSource = z.infer<typeof solarTerrainSourceSchema>;
const sources = z.object({ surface: solarTerrainSourceSchema, horizon: solarTerrainSourceSchema });
export type TerrainSources = z.infer<typeof sources>;
export const solarReliefMetaSchema = z.object({
  version: z.literal(SOLAR_TERRAIN_FORMAT.reliefVersion), path: z.string().regex(/^[a-f0-9]{12}\/relief-v1\.bin\.gz$/), zoom: nonnegative.max(SOLAR_TERRAIN_FORMAT.reliefZoom),
  x0: integer, y0: nonnegative, width: integer.positive().max(SOLAR_TERRAIN_FORMAT.reliefMaxSide), height: integer.positive().max(SOLAR_TERRAIN_FORMAT.reliefMaxSide),
  offsetM: z.literal(SOLAR_TERRAIN_FORMAT.reliefOffsetM), scale: z.literal(SOLAR_TERRAIN_FORMAT.reliefScale), minM: nullable, maxM: nullable,
  encoding: z.string().min(1).max(512), bytes: integer.positive().max(MAX_SOLAR_ASSET_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/)
});
export type ReliefMeta = z.infer<typeof solarReliefMetaSchema>;
export const solarTerrainIndexSchema = z.object({
  schemaVersion: z.literal(SOLAR_TERRAIN_FORMAT.schemaVersion), slug, generatedAt: z.iso.datetime(), generation,
  inputs: z.object({ latitude: solarSiteSchema.shape.latitude, longitude: solarSiteSchema.shape.longitude, radiusKm: finite.positive().optional(), area: area.optional(),
    maxDistanceKm: finite.positive(), algorithmVersion: z.literal(SOLAR_TERRAIN_FORMAT.algorithmVersion),
    sources: z.object({ surface: z.string(), horizon: z.string() }) }),
  sources, bounds, referenceElevationM: nullable,
  tiles: z.object({ path: z.string().regex(/^[a-f0-9]{12}\/\{z\}\/\{x\}\/\{y\}\.bin\.gz$/),
    size: z.literal(SOLAR_TERRAIN_FORMAT.tileSize), minZoom: z.literal(SOLAR_TERRAIN_FORMAT.minZoom), maxZoom: z.literal(SOLAR_TERRAIN_FORMAT.maxZoom),
    ranges: z.record(z.string().regex(/^(11|12|13|14)$/), z.tuple([integer, nonnegative, integer, nonnegative])), count: nonnegative, bytes: nonnegative,
    objects: z.array(z.object({ z: integer.min(SOLAR_TERRAIN_FORMAT.minZoom).max(SOLAR_TERRAIN_FORMAT.maxZoom),
      columns: z.array(z.object({ x: integer, rows: z.array(z.tuple([nonnegative, integer.positive().max(MAX_SOLAR_ASSET_BYTES), z.string().regex(/^[a-f0-9]{64}$/)])).min(1).max(256) })).min(1).max(256) })).max(4) }),
  encoding: z.object({ planes: z.tuple([z.literal('nx'), z.literal('ny'), z.literal('nz'), z.literal('svf')]), normal: z.string().min(1).max(512),
    horizonCells: z.literal(SOLAR_TERRAIN_FORMAT.horizonCells), horizonBorder: z.literal(SOLAR_TERRAIN_FORMAT.horizonBorder),
    azimuthsDeg: z.array(finite).length(SOLAR_TERRAIN_FORMAT.azimuthsDeg.length).refine(values => values.every((value, index) => value === SOLAR_TERRAIN_FORMAT.azimuthsDeg[index])),
    horizonStepDeg: z.literal(SOLAR_TERRAIN_FORMAT.horizonStepDeg), delta: z.literal('row'), compression: z.literal('gzip') }),
  launch: z.object({ elevationM: nullable, slopeDeg: nullable, aspectDeg: nullable, skyViewFactor: nullable,
    horizonDeg: z.array(nullable).length(SOLAR_TERRAIN_FORMAT.azimuthsDeg.length) }).nullable(), relief: solarReliefMetaSchema
}).superRefine((value, ctx) => {
  // Published bounds are rounded to six decimal places by the terrain builder.
  const longitude = value.inputs.longitude + 360 * Math.round(((value.bounds.west + value.bounds.east) / 2 - value.inputs.longitude) / 360);
  if (value.bounds.south >= value.bounds.north || value.bounds.west >= value.bounds.east
    || value.inputs.latitude < value.bounds.south - 1e-6 || value.inputs.latitude > value.bounds.north + 1e-6
    || longitude < value.bounds.west - 1e-6 || longitude > value.bounds.east + 1e-6) ctx.addIssue({ code: 'custom', message: 'Solar site is outside the published bounds' });
  let count = 0, bytes = 0, previousZoom = -1;
  for (const group of value.tiles.objects) {
    if (group.z <= previousZoom) ctx.addIssue({ code: 'custom', message: 'Unordered solar tile zooms' });
    previousZoom = group.z;
    let previousX = -Infinity;
    for (const column of group.columns) {
      if (column.x <= previousX) ctx.addIssue({ code: 'custom', message: 'Unordered solar tile columns' });
      previousX = column.x;
      let previousY = -1;
      for (const [y, length] of column.rows) {
        if (y <= previousY || y >= 2 ** group.z) ctx.addIssue({ code: 'custom', message: 'Unordered or invalid solar tile rows' });
        previousY = y; count++; bytes += length;
        const range = value.tiles.ranges[group.z];
        if (!range || column.x < range[0] || y < range[1] || column.x > range[2] || y > range[3]) ctx.addIssue({ code: 'custom', message: 'Solar tile outside declared range' });
      }
    }
  }
  if (count !== value.tiles.count || bytes !== value.tiles.bytes) ctx.addIssue({ code: 'custom', message: 'Solar tile inventory totals mismatch' });
  if (value.tiles.path !== `${value.generation}/{z}/{x}/{y}.bin.gz` || value.relief.path !== `${value.generation}/relief-v1.bin.gz`
    || value.sources.surface.id !== value.inputs.sources.surface || value.sources.horizon.id !== value.inputs.sources.horizon
    || (value.inputs.area === undefined) === (value.inputs.radiusKm === undefined)
    || Object.values(value.tiles.ranges).some(([x0, y0, x1, y1]) => x0 > x1 || y0 > y1)) {
    ctx.addIssue({ code: 'custom', message: 'Solar terrain identity or extent mismatch' });
  }
});
export type SolarTerrainIndex = z.infer<typeof solarTerrainIndexSchema>;

/** North-up pixel-edge registration; metres MSL, NaN gaps, positive degree spacing. */
export interface ElevationGrid { values: Float32Array; width: number; height: number; west: number; north: number; dLon: number; dLat: number }
/** Half-open pixels at SOLAR_TERRAIN_FORMAT.maxZoom; longitude bounds may be unwrapped. */
export interface TerrainDomain { x0: number; y0: number; x1: number; y1: number; bounds: TerrainBounds }
export interface SolarDomainOptions { radiusKm?: number; area?: SolarArea }
export interface SolarTerrainOptions extends SolarDomainOptions { coarse: ElevationGrid; sources: TerrainSources; maxDistanceKm?: number; log?: (message: string) => void }
export interface TerrainTile { z: number; x: number; y: number; body: Uint8Array }
export interface ReliefProduct { body: Uint8Array; meta: ReliefMeta }
export interface SolarTerrainProduct { index: SolarTerrainIndex; relief: ReliefProduct }
export interface SolarTerrainBuild {
  domain: TerrainDomain; blocks: TerrainDomain[]; generation: string;
  addBlock(block: TerrainDomain, fine: ElevationGrid): TerrainTile[];
  finish(options?: { generatedAt?: string }): SolarTerrainProduct;
}
