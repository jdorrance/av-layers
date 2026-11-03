import { createHash } from 'node:crypto';
import { dataIdentity, encodeJson, sha256, TERRAIN_PACKING, TERRAIN_SOURCE, type TerrainAsset, type TerrainCatalog } from './contract.js';
import type { ObjectStorage } from '../storage.js';

export function terrainCatalogFixture(): TerrainCatalog {
  const catalog = {
    version: 1 as const, source: TERRAIN_SOURCE, packing: TERRAIN_PACKING,
    inventorySha256: 'a'.repeat(64), dataId: '',
    tiles: [{ id: 'Copernicus_DSM_COG_30_N00_00_E000_00_DEM', south: 0, west: 0,
      asset: { key: 'terrain/assets/tile.tif', bytes: 1, sha256: 'b'.repeat(64) },
      sourceSha256: 'c'.repeat(64), nodata: -32767,
      geometry: { width: 2, height: 2, lon0: 0, lat0: 1, dx: 1, dy: -1 } }]
  };
  catalog.dataId = dataIdentity(catalog);
  return catalog;
}

export function seedTerrainCatalog(storage: TerrainTestStorage, catalog = terrainCatalogFixture()): TerrainAsset {
  const bytes = encodeJson(catalog), hash = sha256(bytes), key = `terrain/catalogs/${hash}.json`;
  storage.objects.set(key, bytes);
  return { key, sha256: hash, bytes: bytes.byteLength };
}

/** Immutable single-PUT storage used by preparation and staging fixtures. */
export class TerrainTestStorage implements ObjectStorage {
  objects = new Map<string, Uint8Array>();
  gets: string[] = [];
  private etag(bytes: Uint8Array) { return `"${createHash('md5').update(bytes).digest('hex')}"`; }
  async get(key: string, range?: { offset: number; length: number }, maxBytes = Infinity, signal?: AbortSignal) {
    signal?.throwIfAborted(); this.gets.push(key);
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    const selected = range ? bytes.slice(range.offset, range.offset + range.length) : bytes;
    if (selected.byteLength > maxBytes) throw new Error('Read byte budget exceeded');
    return { bytes: selected, etag: this.etag(bytes) };
  }
  async head(key: string) { const bytes = this.objects.get(key); return bytes ? { size: bytes.length, etag: this.etag(bytes) } : null; }
  async put(key: string, bytes: Uint8Array, condition: { ifMatch?: string; ifNoneMatch?: '*' }) {
    if (condition.ifNoneMatch === '*' && this.objects.has(key)) throw new Error('Precondition failed');
    this.objects.set(key, new Uint8Array(bytes));
  }
  async list(prefix: string) { return [...this.objects].filter(([key]) => key.startsWith(prefix)).map(([key, bytes]) => ({ key, size: bytes.length, lastModified: new Date() })); }
  async delete(keys: string[]) { for (const key of keys) this.objects.delete(key); }
}
