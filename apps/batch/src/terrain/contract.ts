import { createHash } from 'node:crypto';
import z from 'zod';
import type { ObjectStorage } from '../storage.js';

export type TerrainStorage = Pick<ObjectStorage, 'get' | 'head' | 'put'>;

export const ASSET_MAX_BYTES = 32 * 1024 * 1024;
export const CATALOG_MAX_BYTES = 16 * 1024 * 1024;
export const TERRAIN_SOURCE = Object.freeze({
  id: 'copernicus-glo90-2021', release: '2021', units: 'm',
  verticalDatum: 'EGM2008', surface: 'DSM', horizontalCrs: 'EPSG:4326'
} as const);
export const TERRAIN_PACKING = Object.freeze({ method: 'cog-lossless-v1', blockSize: 512 } as const);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const terrainAssetSchema = z.strictObject({
  key: z.string().max(256).regex(/^terrain\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/).refine(value => !value.split('/').some(part => part === '.' || part === '..')),
  sha256: digest, bytes: z.number().int().positive().max(ASSET_MAX_BYTES)
});
export type TerrainAsset = z.infer<typeof terrainAssetSchema>;

/** Geographic coordinates name sample centres; file pixel registration is decoded at ingestion. */
export const terrainGeometrySchema = z.strictObject({
  width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096),
  lon0: z.number().finite().min(-180).max(180), lat0: z.number().finite().min(-90).max(90),
  dx: z.number().finite().positive().max(1), dy: z.number().finite().negative().min(-1)
}).superRefine((grid, ctx) => {
  if (grid.lon0 + (grid.width - 1) * grid.dx > 180 + 1e-9 || grid.lat0 + (grid.height - 1) * grid.dy < -90 - 1e-9) ctx.addIssue({ code: 'custom', message: 'Terrain geometry exceeds geographic coordinates' });
});
export type TerrainGeometry = z.infer<typeof terrainGeometrySchema>;
export const terrainTileSourceSchema = z.strictObject({
  id: z.string().regex(/^Copernicus_DSM_COG_30_[NS]\d{2}_00_[EW]\d{3}_00_DEM$/),
  south: z.number().int().min(-90).max(89), west: z.number().int().min(-180).max(179)
}).superRefine((tile, ctx) => {
  const expected = `Copernicus_DSM_COG_30_${tile.south < 0 ? 'S' : 'N'}${Math.abs(tile.south).toString().padStart(2, '0')}_00_${tile.west < 0 ? 'W' : 'E'}${Math.abs(tile.west).toString().padStart(3, '0')}_00_DEM`;
  if (tile.id !== expected) ctx.addIssue({ code: 'custom', message: 'Terrain tile name does not match its geocell' });
});
export type TerrainTileSource = z.infer<typeof terrainTileSourceSchema>;
const sourceSchema = z.strictObject({
  id: z.literal(TERRAIN_SOURCE.id), release: z.literal(TERRAIN_SOURCE.release),
  units: z.literal(TERRAIN_SOURCE.units), verticalDatum: z.literal(TERRAIN_SOURCE.verticalDatum),
  surface: z.literal(TERRAIN_SOURCE.surface), horizontalCrs: z.literal(TERRAIN_SOURCE.horizontalCrs)
});
function sortedTiles(tiles: readonly TerrainTileSource[]): boolean {
  return tiles.every((tile, index) => index === 0 || tiles[index - 1].id < tile.id);
}
export const terrainInventorySchema = z.strictObject({
  version: z.literal(1), source: sourceSchema, sha256: digest,
  tiles: z.array(terrainTileSourceSchema).min(1).max(64_800).refine(sortedTiles, 'Terrain inventory must be sorted and unique')
});
export type TerrainInventory = z.infer<typeof terrainInventorySchema>;
export const terrainTileSchema = terrainTileSourceSchema.safeExtend({
  asset: terrainAssetSchema, sourceSha256: digest,
  geometry: terrainGeometrySchema, nodata: z.number().finite().nullable()
}).superRefine((tile, ctx) => {
  const g = tile.geometry, epsilon = 1e-8;
  if (g.lon0 < tile.west - epsilon || g.lon0 > tile.west + g.dx + epsilon
      || g.lat0 > tile.south + 1 + epsilon || g.lat0 < tile.south + 1 - Math.abs(g.dy) - epsilon
      || g.lon0 + (g.width - 1) * g.dx > tile.west + 1 + epsilon
      || g.lat0 + (g.height - 1) * g.dy < tile.south - epsilon) {
    ctx.addIssue({ code: 'custom', message: 'Terrain raster does not belong to its source geocell' });
  }
});
export type TerrainTile = z.infer<typeof terrainTileSchema>;
export const terrainCatalogSchema = z.strictObject({
  version: z.literal(1), source: sourceSchema, inventorySha256: digest, dataId: digest,
  packing: z.strictObject({ method: z.literal(TERRAIN_PACKING.method), blockSize: z.literal(TERRAIN_PACKING.blockSize) }),
  tiles: z.array(terrainTileSchema).min(1).max(64_800).refine(sortedTiles, 'Terrain catalog must be sorted and unique')
}).superRefine((catalog, ctx) => {
  if (catalog.dataId !== dataIdentity(catalog)) ctx.addIssue({ code: 'custom', message: 'Terrain data identity does not match source contents' });
});
export type TerrainCatalog = z.infer<typeof terrainCatalogSchema>;
export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
/** Packing bytes can change while the original samples, placement and interpretation stay identical. */
export function dataIdentity(catalog: { source: typeof TERRAIN_SOURCE; inventorySha256: string; tiles: readonly TerrainTile[] }): string {
  return sha256(JSON.stringify({ source: sourceSchema.parse(catalog.source), inventorySha256: catalog.inventorySha256,
    tiles: catalog.tiles.map(tile => ({ id: tile.id, sourceSha256: tile.sourceSha256, geometry: terrainGeometrySchema.parse(tile.geometry), nodata: tile.nodata })) }));
}
export function encodeJson(value: unknown, limit = CATALOG_MAX_BYTES): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(value));
  if (!Number.isSafeInteger(limit) || limit < 1 || bytes.length > limit) throw new Error('Terrain JSON exceeds byte budget');
  return bytes;
}
export function parseJson<T>(bytes: Uint8Array, schema: z.ZodType<T>, limit = CATALOG_MAX_BYTES): T {
  if (!Number.isSafeInteger(limit) || limit < 1 || bytes.length > limit) throw new Error('Terrain JSON exceeds byte budget');
  return schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
