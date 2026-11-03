import { setTimeout as delay } from 'node:timers/promises';
import { ASSET_MAX_BYTES, TERRAIN_SOURCE, sha256, terrainInventorySchema, type TerrainInventory, type TerrainTileSource } from './contract.js';

const SOURCE_ORIGIN = 'https://copernicus-dem-90m.s3.amazonaws.com';
export const INVENTORY_MAX_BYTES = 4 * 1024 * 1024;
export interface SourceOptions { fetch?: typeof globalThis.fetch; signal?: AbortSignal }

/** Freeze the provider's complete tile list; a missing listed tile is never ocean. */
export async function fetchSourceInventory(options: SourceOptions = {}): Promise<{ inventory: TerrainInventory; bytes: Uint8Array }> {
  const bytes = await fetchBytes(`${SOURCE_ORIGIN}/tileList.txt`, INVENTORY_MAX_BYTES, options);
  return { inventory: parseSourceInventory(bytes), bytes };
}

export function parseSourceInventory(bytes: Uint8Array): TerrainInventory {
  if (!bytes.byteLength || bytes.byteLength > INVENTORY_MAX_BYTES) throw new Error('Terrain source inventory exceeds byte budget or is empty');
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim().split(/\r?\n/);
  const seen = new Set<string>();
  const tiles = lines.map(line => {
    const id = line.trim(), match = /^Copernicus_DSM_COG_30_([NS])(\d{2})_00_([EW])(\d{3})_00_DEM$/.exec(id);
    if (!match) throw new Error(`Invalid terrain source tile: ${id.slice(0, 100)}`);
    const south = Number(match[2]) * (match[1] === 'S' ? -1 : 1), west = Number(match[4]) * (match[3] === 'W' ? -1 : 1);
    const cell = `${south}/${west}`;
    if (south < -90 || south >= 90 || west < -180 || west >= 180 || seen.has(cell)) throw new Error(`Duplicate or invalid terrain source cell: ${id}`);
    seen.add(cell);
    return { id, south, west };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return terrainInventorySchema.parse({ version: 1, source: TERRAIN_SOURCE, sha256: sha256(bytes), tiles });
}

/** A source URL is constructed only from an inventory tile, never from remote metadata. */
export async function fetchSourceTile(tile: TerrainTileSource, options: SourceOptions = {}): Promise<Uint8Array> {
  const checked = parseSourceInventory(new TextEncoder().encode(`${tile.id}\n`)).tiles[0];
  if (checked.south !== tile.south || checked.west !== tile.west) throw new Error('Terrain source tile coordinates disagree with its identity');
  return fetchBytes(`${SOURCE_ORIGIN}/${tile.id}/${tile.id}.tif`, ASSET_MAX_BYTES, options);
}

class SourceResponseError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

async function fetchBytes(url: string, limit: number, { fetch: request = globalThis.fetch, signal }: SourceOptions): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(60_000), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const response = await request(url, { signal: combined, headers: { 'accept-encoding': 'identity' }, redirect: 'error' });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new SourceResponseError(`Terrain source returned HTTP ${response.status}: ${url}`, response.status === 429 || response.status >= 500);
      }
      const declared = response.headers.get('content-length');
      if (!response.body || (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))) {
        await response.body?.cancel();
        throw new SourceResponseError(`Terrain source exceeds byte budget: ${url}`, false);
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          combined.throwIfAborted();
          const result = await reader.read();
          if (result.done) break;
          length += result.value.byteLength;
          if (length > limit) throw new SourceResponseError(`Terrain source exceeds byte budget: ${url}`, false);
          chunks.push(result.value);
        }
        if (!length || (declared !== null && Number(declared) !== length)) throw new SourceResponseError(`Terrain source response length mismatch: ${url}`, true);
        return Buffer.concat(chunks, length);
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt >= 2 || (error instanceof SourceResponseError && !error.retryable)) throw error;
      await delay(500 * (attempt + 1), undefined, { signal });
    }
  }
}
