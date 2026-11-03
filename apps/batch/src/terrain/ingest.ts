import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import z from 'zod';
import { putImmutable } from '../immutable-upload.js';
import { ASSET_MAX_BYTES, CATALOG_MAX_BYTES, TERRAIN_PACKING, TERRAIN_SOURCE, dataIdentity, encodeJson, parseJson, sha256, terrainCatalogSchema, terrainGeometrySchema, terrainInventorySchema, terrainTileSchema, type TerrainAsset, type TerrainInventory, type TerrainStorage, type TerrainTile, type TerrainTileSource } from './contract.js';
import { fetchSourceTile, INVENTORY_MAX_BYTES, parseSourceInventory, type SourceOptions } from './source.js';

export const TERRAIN_REPACK_RECIPE = Object.freeze({
  ...TERRAIN_PACKING, rasterio: '1.4.3', numpy: '2.2.6', python: '3.12', gdal: '3.9.3',
  compression: 'DEFLATE', level: 6, predictor: 3, overviews: 'preserve-existing'
} as const);
const REPACK_HELPER_BYTES = await readFile(new URL('./repack.py', import.meta.url));
const RECIPE_SHA256 = sha256(encodeJson({ settings: TERRAIN_REPACK_RECIPE, helperSha256: sha256(REPACK_HELPER_BYTES) }));
const RECEIPT_MAX_BYTES = 16 * 1024;
const packingResultSchema = z.strictObject({ geometry: terrainGeometrySchema, nodata: z.number().finite().nullable() });
const helperResultSchema = packingResultSchema.extend({ runtime: z.strictObject({
  rasterio: z.literal(TERRAIN_REPACK_RECIPE.rasterio), numpy: z.literal(TERRAIN_REPACK_RECIPE.numpy),
  python: z.literal(TERRAIN_REPACK_RECIPE.python), gdal: z.literal(TERRAIN_REPACK_RECIPE.gdal)
}) });
type PackingResult = z.infer<typeof packingResultSchema> & { bytes: Uint8Array };
type Repack = (source: Uint8Array, signal?: AbortSignal) => Promise<PackingResult>;
const receiptSchema = z.strictObject({
  version: z.literal(1), inventorySha256: z.string().regex(/^[a-f0-9]{64}$/), recipeSha256: z.literal(RECIPE_SHA256),
  tile: terrainTileSchema, assetEtag: z.string().regex(/^"[a-f0-9]{32}"$/)
});
type Receipt = z.infer<typeof receiptSchema>;

export function terrainImportId(inventory: TerrainInventory): string {
  return sha256(encodeJson({ inventorySha256: inventory.sha256, recipeSha256: RECIPE_SHA256 }));
}

interface ImportOptions extends SourceOptions {
  store: TerrainStorage;
  inventory: TerrainInventory;
  shardIndex?: number;
  shardCount?: number;
  concurrency?: number;
  repack?: Repack;
  onProgress?: (progress: { completed: number; reused: number; total: number }) => void;
}

/** Independent deterministic shards resume only after proving the receipt's immutable asset. */
export async function syncTerrainShard(options: ImportOptions): Promise<{ importId: string; completed: number; reused: number; total: number }> {
  const inventory = terrainInventorySchema.parse(options.inventory);
  const { store, shardIndex = 0, shardCount = 1, concurrency = 2, repack = repackTerrain, signal } = options;
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 256
      || !Number.isSafeInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) throw new Error('Invalid terrain shard selection');
  const importId = terrainImportId(inventory), tiles = inventory.tiles.filter((_, index) => index % shardCount === shardIndex);
  let completed = 0, reused = 0;
  await bounded(tiles, concurrency, signal, async (tile, _index, signal) => {
    signal?.throwIfAborted();
    const key = receiptKey(importId, tile), existing = await readReceipt(store, key, inventory, tile, signal);
    if (existing && await proveAsset(store, existing, signal)) { reused++; options.onProgress?.({ completed, reused, total: tiles.length }); return; }
    const source = await fetchSourceTile(tile, { fetch: options.fetch, signal }), sourceSha256 = sha256(source);
    if (existing && sourceSha256 !== existing.tile.sourceSha256) throw new Error(`Terrain source changed during resumed import: ${tile.id}`);
    const packed = await repack(source, signal);
    signal?.throwIfAborted();
    if (!packed.bytes.byteLength || packed.bytes.byteLength > ASSET_MAX_BYTES) throw new Error('Packed terrain exceeds asset byte budget');
    const hash = sha256(packed.bytes), asset = { key: `terrain/assets/${hash}.tif`, sha256: hash, bytes: packed.bytes.byteLength };
    const result = terrainTileSchema.parse({ ...tile, asset, sourceSha256, ...packingResultSchema.parse({ geometry: packed.geometry, nodata: packed.nodata }) });
    const receipt = receiptSchema.parse({ version: 1, inventorySha256: inventory.sha256, recipeSha256: RECIPE_SHA256,
      tile: result, assetEtag: `"${createHash('md5').update(packed.bytes).digest('hex')}"` });
    if (existing && !Buffer.from(encodeJson(existing)).equals(encodeJson(receipt))) throw new Error(`Terrain repacking differs from the retained receipt: ${tile.id}`);
    await putImmutable(store, asset.key, packed.bytes, 'image/tiff', signal);
    await putImmutable(store, key, encodeJson(receipt, RECEIPT_MAX_BYTES), 'application/json', signal);
    completed++;
    options.onProgress?.({ completed, reused, total: tiles.length });
  });
  return { importId, completed, reused, total: tiles.length };
}

/** Publish one immutable catalog only after all global inventory receipts and assets are present. */
export async function finalizeTerrainCatalog({ store, inventory: input, concurrency = 4, signal }: {
  store: TerrainStorage; inventory: TerrainInventory; concurrency?: number; signal?: AbortSignal;
}): Promise<TerrainAsset> {
  const inventory = terrainInventorySchema.parse(input), importId = terrainImportId(inventory);
  const snapshot = await store.get(`terrain/inventories/${inventory.sha256}.txt`, undefined, INVENTORY_MAX_BYTES, signal);
  if (!snapshot || sha256(snapshot.bytes) !== inventory.sha256) throw new Error('Terrain source inventory snapshot is missing or changed');
  const original = parseSourceInventory(snapshot.bytes);
  if (!Buffer.from(encodeJson(original)).equals(encodeJson(inventory))) throw new Error('Terrain catalog must include the complete source inventory');
  const tiles = new Array<TerrainTile>(inventory.tiles.length);
  await bounded(inventory.tiles, concurrency, signal, async (source, index, signal) => {
    signal?.throwIfAborted();
    const receipt = await readReceipt(store, receiptKey(importId, source), inventory, source, signal);
    if (!receipt || !await proveAsset(store, receipt, signal)) throw new Error(`Terrain import is incomplete: ${source.id}`);
    tiles[index] = receipt.tile;
  });
  const identity = { source: TERRAIN_SOURCE, inventorySha256: inventory.sha256, tiles };
  const catalog = terrainCatalogSchema.parse({ version: 1, ...identity, dataId: dataIdentity(identity), packing: TERRAIN_PACKING });
  const bytes = encodeJson(catalog, CATALOG_MAX_BYTES), hash = sha256(bytes), asset = { key: `terrain/catalogs/${hash}.json`, sha256: hash, bytes: bytes.byteLength };
  await putImmutable(store, asset.key, bytes, 'application/json', signal);
  return asset;
}

function receiptKey(importId: string, tile: TerrainTileSource): string {
  return `terrain/imports/${importId}/${tile.id}.json`;
}

async function readReceipt(store: TerrainStorage, key: string, inventory: TerrainInventory, source: TerrainTileSource, signal?: AbortSignal): Promise<Receipt | null> {
  const object = await store.get(key, undefined, RECEIPT_MAX_BYTES, signal);
  if (!object) return null;
  const receipt = parseJson(object.bytes, receiptSchema, RECEIPT_MAX_BYTES), tile = receipt.tile;
  if (receipt.inventorySha256 !== inventory.sha256 || tile.id !== source.id || tile.south !== source.south || tile.west !== source.west
      || tile.asset.key !== `terrain/assets/${tile.asset.sha256}.tif`) throw new Error(`Terrain receipt does not match its inventory: ${source.id}`);
  return receipt;
}

async function proveAsset(store: TerrainStorage, receipt: Receipt, signal?: AbortSignal): Promise<boolean> {
  const head = await store.head(receipt.tile.asset.key, signal);
  if (!head) return false;
  if (head.size !== receipt.tile.asset.bytes || head.etag !== receipt.assetEtag) throw new Error(`Terrain immutable asset changed: ${receipt.tile.id}`);
  return true;
}

/** The sole native helper operates in a private temporary directory and verifies losslessness before returning. */
export async function repackTerrain(source: Uint8Array, signal?: AbortSignal): Promise<PackingResult> {
  signal?.throwIfAborted();
  if (!source.byteLength || source.byteLength > ASSET_MAX_BYTES) throw new Error('Terrain source exceeds asset byte budget');
  const directory = await mkdtemp(join(tmpdir(), 'av-terrain-repack-'));
  try {
    const input = join(directory, 'source.tif'), output = join(directory, 'packed.tif'), helper = join(directory, 'repack.py');
    await writeFile(input, source);
    await writeFile(helper, REPACK_HELPER_BYTES);
    const { stdout } = await promisify(execFile)('uv', ['run', '--python', TERRAIN_REPACK_RECIPE.python,
      '--with', `rasterio==${TERRAIN_REPACK_RECIPE.rasterio}`, '--with', `numpy==${TERRAIN_REPACK_RECIPE.numpy}`,
      'python', helper, input, output], {
      signal, timeout: 120_000, maxBuffer: 256 * 1024,
      env: { ...process.env, UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? join(tmpdir(), 'av-terrain-uv-cache') }
    });
    signal?.throwIfAborted();
    const size = (await stat(output)).size;
    if (!size || size > ASSET_MAX_BYTES) throw new Error('Packed terrain exceeds asset byte budget');
    const checked = helperResultSchema.parse(JSON.parse(stdout));
    return { geometry: checked.geometry, nodata: checked.nodata, bytes: await readFile(output) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Stop admission and cancel siblings on the first failure, then drain all tasks. */
async function bounded<T>(items: readonly T[], concurrency: number, parentSignal: AbortSignal | undefined, run: (item: T, index: number, signal: AbortSignal) => Promise<void>): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Terrain concurrency must be between 1 and 4');
  const controller = new AbortController(), signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  let next = 0, failed = false, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try { signal.throwIfAborted(); await run(items[index], index, signal); }
      catch (error) { if (!failed) { failed = true; failure = error; controller.abort(error); } }
    }
  }));
  if (failed) throw failure;
}
