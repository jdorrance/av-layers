import z from 'zod';
import { gridSchema, MAX_GRID_CELLS, prepareGridGeometry, sameGrid, type Grid } from '@av/contracts';
import { putImmutable } from '../immutable-upload.js';
import { encodeJson, parseJson, sha256, terrainAssetSchema, terrainCatalogSchema, type TerrainAsset, type TerrainCatalog, type TerrainStorage } from './contract.js';
import { createTerrainReader, type TerrainReadStats } from './reader.js';

export const PREPARED_TERRAIN_METHOD = 'bilinear-native-v1';
export const PREPARED_DESCRIPTOR_MAX_BYTES = 16 * 1024;
export const PREPARED_TERRAIN_CELL_BYTES = Float32Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT;
export const MAX_PREPARED_TERRAIN_BYTES = MAX_GRID_CELLS * PREPARED_TERRAIN_CELL_BYTES;
const preparedKey = z.string().regex(/^terrain\/prepared\/[a-f0-9]{64}\/manifest\.json$/);
export const preparedTerrainRefSchema = terrainAssetSchema.extend({
  key: preparedKey,
  bytes: z.number().int().positive().max(PREPARED_DESCRIPTOR_MAX_BYTES),
  arrayBytes: z.number().int().positive().max(MAX_PREPARED_TERRAIN_BYTES)
}).strict();
export type PreparedTerrainRef = z.infer<typeof preparedTerrainRefSchema>;

const descriptorSchema = z.strictObject({
  version: z.literal(1),
  dataId: z.string().regex(/^[a-f0-9]{64}$/),
  method: z.literal(PREPARED_TERRAIN_METHOD),
  grid: gridSchema,
  source: terrainCatalogSchema.shape.source,
  files: z.strictObject({ elevationM: terrainAssetSchema, valid: terrainAssetSchema })
}).superRefine((value, ctx) => {
  const cells = value.grid.width * value.grid.height, prefix = preparationPrefix(value.dataId, value.grid);
  if (cells > MAX_GRID_CELLS || value.files.elevationM.bytes !== cells * 4 || value.files.valid.bytes !== cells
      || value.files.elevationM.key !== `${prefix}/elevation.f32` || value.files.valid.key !== `${prefix}/valid.u8`) {
    ctx.addIssue({ code: 'custom', message: 'Prepared terrain array layout mismatch' });
  }
});
export type PreparedTerrain = {
  descriptor: z.infer<typeof descriptorSchema>;
  elevationM: Float32Array;
  valid: Uint8Array;
};
type ReadAsset = (asset: TerrainAsset) => Promise<Uint8Array>;

function preparationPrefix(dataId: string, grid: Grid): string {
  return `terrain/prepared/${sha256(encodeJson({ dataId, grid: gridSchema.parse(grid), method: PREPARED_TERRAIN_METHOD }, PREPARED_DESCRIPTOR_MAX_BYTES))}`;
}
function checkBytes(asset: TerrainAsset, bytes: Uint8Array): void {
  if (bytes.byteLength !== asset.bytes || sha256(bytes) !== asset.sha256) throw new Error(`Prepared terrain asset integrity mismatch: ${asset.key}`);
}

/** Shared local/remote admission. Heights are metres EGM2008; valid=0 has zero storage, not sea level. */
export async function readPreparedTerrain(refInput: PreparedTerrainRef, read: ReadAsset, grid: Grid, signal?: AbortSignal): Promise<PreparedTerrain> {
  signal?.throwIfAborted();
  const ref = preparedTerrainRefSchema.parse(refInput), manifest = await read(ref);
  signal?.throwIfAborted();
  checkBytes(ref, manifest);
  const descriptor = parseJson(manifest, descriptorSchema, PREPARED_DESCRIPTOR_MAX_BYTES);
  if (!sameGrid(descriptor.grid, grid) || ref.key !== `${preparationPrefix(descriptor.dataId, descriptor.grid)}/manifest.json`
      || ref.arrayBytes !== descriptor.files.elevationM.bytes + descriptor.files.valid.bytes) throw new Error('Prepared terrain identity or grid mismatch');
  const elevationBytes = await read(descriptor.files.elevationM);
  signal?.throwIfAborted();
  checkBytes(descriptor.files.elevationM, elevationBytes);
  const valid = await read(descriptor.files.valid);
  signal?.throwIfAborted();
  checkBytes(descriptor.files.valid, valid);
  const cells = grid.width * grid.height, elevationM = new Float32Array(cells);
  const view = new DataView(elevationBytes.buffer, elevationBytes.byteOffset, elevationBytes.byteLength);
  for (let i = 0; i < cells; i++) {
    if (i % 4096 === 0) signal?.throwIfAborted();
    const value = view.getFloat32(i * 4, true);
    if (valid[i] > 1 || !Number.isFinite(value) || (!valid[i] && value !== 0)) throw new Error('Invalid prepared terrain cell');
    elevationM[i] = value;
  }
  return { descriptor, elevationM, valid };
}

export interface TerrainPreparationReport { cacheHit: boolean; cells: number; arrayBytes: number; elapsedMs: number; reader?: TerrainReadStats }
export interface PrepareTerrainOptions {
  catalog: TerrainCatalog;
  storage: TerrainStorage;
  grid: Grid;
  signal?: AbortSignal;
  limits?: { maxCells?: number; reader?: Parameters<typeof createTerrainReader>[0]['limits'] };
  onReport?: (report: TerrainPreparationReport) => void;
}

/** Prepare DEM elevations at target grid centres once; immutable source/method/grid identity is the cache key. */
export async function prepareTerrain(options: PrepareTerrainOptions): Promise<PreparedTerrainRef> {
  const { storage, signal } = options, started = Date.now();
  signal?.throwIfAborted();
  const catalog = terrainCatalogSchema.parse(options.catalog), grid = gridSchema.parse(options.grid);
  const cells = grid.width * grid.height, maxCells = options.limits?.maxCells ?? MAX_GRID_CELLS;
  if (!Number.isSafeInteger(maxCells) || maxCells < 1 || maxCells > MAX_GRID_CELLS || cells > maxCells) throw new Error('Prepared terrain cell budget exceeded');
  const prefix = preparationPrefix(catalog.dataId, grid), key = `${prefix}/manifest.json`;
  const existing = await storage.get(key, undefined, PREPARED_DESCRIPTOR_MAX_BYTES, signal);
  if (existing) {
    const ref = preparedTerrainRefSchema.parse({ key, bytes: existing.bytes.byteLength, sha256: sha256(existing.bytes), arrayBytes: cells * PREPARED_TERRAIN_CELL_BYTES });
    const prepared = await readPreparedTerrain(ref, async asset => {
      if (asset.key === key) return existing.bytes;
      const result = await storage.get(asset.key, undefined, asset.bytes, signal);
      if (!result) throw new Error(`Prepared terrain asset missing: ${asset.key}`);
      return result.bytes;
    }, grid, signal);
    if (prepared.descriptor.dataId !== catalog.dataId) throw new Error('Prepared terrain source identity mismatch');
    options.onReport?.({ cacheHit: true, cells, arrayBytes: cells * PREPARED_TERRAIN_CELL_BYTES, elapsedMs: Date.now() - started });
    return ref;
  }
  const elevationBytes = new Uint8Array(cells * 4), valid = new Uint8Array(cells);
  const view = new DataView(elevationBytes.buffer), geometry = prepareGridGeometry(grid);
  const reader = await createTerrainReader({ catalog, storage, signal, limits: options.limits?.reader });
  let readerStats: TerrainReadStats | undefined;
  try {
    for (let index = 0; index < cells; index++) {
      signal?.throwIfAborted();
      const point = geometry.gridToGeographic(index % grid.width, Math.floor(index / grid.width));
      if (!point) continue;
      const sample = await reader.sample(point.lat, point.lon);
      if (!sample) continue;
      view.setFloat32(index * 4, sample.elevationM, true);
      if (!Number.isFinite(view.getFloat32(index * 4, true))) throw new Error('Terrain elevation exceeds float32 storage');
      valid[index] = 1;
    }
    readerStats = reader.stats();
  } finally { await reader.close(); }
  const asset = (name: string, bytes: Uint8Array): TerrainAsset => ({ key: `${prefix}/${name}`, bytes: bytes.byteLength, sha256: sha256(bytes) });
  const descriptor = descriptorSchema.parse({ version: 1, dataId: catalog.dataId, method: PREPARED_TERRAIN_METHOD, grid, source: catalog.source,
    files: { elevationM: asset('elevation.f32', elevationBytes), valid: asset('valid.u8', valid) } });
  const bytes = encodeJson(descriptor, PREPARED_DESCRIPTOR_MAX_BYTES);
  await putImmutable(storage, descriptor.files.elevationM.key, elevationBytes, 'application/octet-stream', signal);
  await putImmutable(storage, descriptor.files.valid.key, valid, 'application/octet-stream', signal);
  await putImmutable(storage, key, bytes, 'application/json', signal);
  options.onReport?.({ cacheHit: false, cells, arrayBytes: cells * PREPARED_TERRAIN_CELL_BYTES, elapsedMs: Date.now() - started, reader: readerStats });
  return preparedTerrainRefSchema.parse({ key, bytes: bytes.byteLength, sha256: sha256(bytes), arrayBytes: cells * PREPARED_TERRAIN_CELL_BYTES });
}
