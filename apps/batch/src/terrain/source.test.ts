import { describe, expect, it, vi } from 'vitest';
import { ASSET_MAX_BYTES, sha256 } from './contract.js';
import * as contract from './contract.js';
import { fetchSourceInventory, fetchSourceTile, INVENTORY_MAX_BYTES, parseSourceInventory, TERRAIN_INVENTORY_BYTES, TERRAIN_INVENTORY_SHA256, verifyTerrainCatalogInventory } from './source.js';
import { terrainCatalogFixture, TerrainTestStorage } from './test-fixtures.js';

const north = 'Copernicus_DSM_COG_30_N40_00_E044_00_DEM';
const south = 'Copernicus_DSM_COG_30_S90_00_W180_00_DEM';
const encode = (value: string) => new TextEncoder().encode(value);

describe('terrain source inventory', () => {
  it('requires the trusted snapshot and exact catalog membership', async () => {
    const catalog = terrainCatalogFixture(), storage = new TerrainTestStorage();
    await expect(verifyTerrainCatalogInventory(catalog, storage)).rejects.toThrow('not the trusted provider inventory');
    catalog.inventorySha256 = TERRAIN_INVENTORY_SHA256;
    await expect(verifyTerrainCatalogInventory(catalog, storage)).rejects.toThrow('snapshot missing or corrupt');
    const bytes = new Uint8Array(TERRAIN_INVENTORY_BYTES).fill(32);
    bytes.set(encode(`${catalog.tiles[0].id}\n`));
    storage.objects.set(`terrain/inventories/${TERRAIN_INVENTORY_SHA256}.txt`, bytes);
    await expect(verifyTerrainCatalogInventory(catalog, storage)).rejects.toThrow('snapshot missing or corrupt');
    const hash = vi.spyOn(contract, 'sha256').mockReturnValue(TERRAIN_INVENTORY_SHA256);
    try {
      await expect(verifyTerrainCatalogInventory(catalog, storage)).resolves.toBeUndefined();
      await expect(verifyTerrainCatalogInventory({ ...catalog, tiles: [] }, storage)).rejects.toThrow('does not match trusted inventory');
      await expect(verifyTerrainCatalogInventory({ ...catalog, tiles: [{ ...catalog.tiles[0], west: 1 }] }, storage)).rejects.toThrow('does not match trusted inventory');
    } finally { hash.mockRestore(); }
  });
  it('retains the exact source digest while sorting a global inventory', async () => {
    const bytes = encode(`${south}\r\n${north}\r\n`), fetch = vi.fn(async () => new Response(bytes));
    const result = await fetchSourceInventory({ fetch });
    expect(Uint8Array.from(result.bytes)).toEqual(bytes);
    expect(result.inventory.sha256).toBe(sha256(bytes));
    expect(result.inventory.tiles).toEqual([{ id: north, south: 40, west: 44 }, { id: south, south: -90, west: -180 }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['', `${north}\n${north}`, '../tile', 'https://example.com/tile', 'Copernicus_DSM_COG_30_N90_00_E044_00_DEM', 'Copernicus_DSM_COG_30_N40_00_E180_00_DEM'])('rejects invalid source inventory %s', value => {
    expect(() => parseSourceInventory(encode(value))).toThrow();
  });

  it('rejects invalid UTF-8 and duplicate signed-zero geocells', () => {
    expect(() => parseSourceInventory(new Uint8Array([255]))).toThrow();
    expect(() => parseSourceInventory(encode('Copernicus_DSM_COG_30_N00_00_E044_00_DEM\nCopernicus_DSM_COG_30_S00_00_E044_00_DEM'))).toThrow();
  });

  it('bounds streamed inventories even when Content-Length is absent', async () => {
    const cancel = vi.fn(), fetch = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(INVENTORY_MAX_BYTES + 1)); }, cancel
    })));
    await expect(fetchSourceInventory({ fetch })).rejects.toThrow('byte budget');
    expect(cancel).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not reinterpret an expected missing tile as ocean or retry it', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(fetchSourceTile({ id: north, south: 40, west: 44 }, { fetch })).rejects.toThrow('HTTP 404');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized source objects before reading their bodies', async () => {
    const fetch = vi.fn(async () => new Response('small', { headers: { 'content-length': String(ASSET_MAX_BYTES + 1) } }));
    await expect(fetchSourceTile({ id: north, south: 40, west: 44 }, { fetch })).rejects.toThrow('byte budget');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries transient source responses and preserves caller cancellation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    const fetch = vi.fn(async () => ++calls === 1 ? new Response(null, { status: 503 }) : new Response(encode(`${north}\n`)));
    try {
      const pending = fetchSourceInventory({ fetch });
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toHaveProperty('inventory.tiles.0.id', north);
      expect(fetch).toHaveBeenCalledTimes(2);
      const controller = new AbortController(); controller.abort(new Error('stop terrain'));
      await expect(fetchSourceInventory({ fetch, signal: controller.signal })).rejects.toThrow('stop terrain');
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
