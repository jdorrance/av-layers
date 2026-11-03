import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ObjectStorage } from '../storage.js';
import { encodeJson, parseJson, sha256, terrainCatalogSchema } from './contract.js';
import { finalizeTerrainCatalog, syncTerrainShard, terrainImportId } from './ingest.js';
import { parseSourceInventory } from './source.js';

function memoryStorage() {
  const objects = new Map<string, Uint8Array>();
  const etag = (bytes: Uint8Array) => `"${createHash('md5').update(bytes).digest('hex')}"`;
  const store: ObjectStorage = {
    async get(key, range, maxBytes, signal) {
      signal?.throwIfAborted();
      const object = objects.get(key);
      if (!object) return null;
      const bytes = range ? object.slice(range.offset, range.offset + range.length) : object;
      if (maxBytes !== undefined && bytes.length > maxBytes) throw new Error('read byte budget');
      return { bytes, etag: etag(object) };
    },
    async head(key) { const bytes = objects.get(key); return bytes ? { size: bytes.length, etag: etag(bytes) } : null; },
    async put(key, bytes, condition) {
      if (condition.ifNoneMatch && objects.has(key)) throw new Error('exists');
      objects.set(key, Uint8Array.from(bytes));
    },
    async list() { throw new Error('Terrain import must not list the entire bucket'); },
    async delete() { throw new Error('Terrain import must not delete objects'); }
  };
  return { store, objects };
}

function fixture(count = 3) {
  const raw = Buffer.from(Array.from({ length: count }, (_, index) => `Copernicus_DSM_COG_30_N40_00_E0${44 + index}_00_DEM`).join('\n'));
  const inventory = parseSourceInventory(raw);
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const index = inventory.tiles.findIndex(tile => String(url).includes(tile.id));
    if (index < 0) throw new Error('unexpected source URL');
    return new Response(new Uint8Array([index + 1]));
  });
  const repack = vi.fn(async (bytes: Uint8Array) => {
    const tile = inventory.tiles[bytes[0] - 1];
    return { bytes: new Uint8Array([1, 2, 3, bytes[0]]), nodata: -32767,
      geometry: { width: 1200, height: 1200, lon0: tile.west, lat0: tile.south + 1, dx: 1 / 1200, dy: -1 / 1200 } };
  });
  return { inventory, fetch, repack, raw };
}

describe('global terrain ingestion', () => {
  it('invalidates import receipts when the repacking helper changes', async () => {
    const { inventory } = fixture(1), original = terrainImportId(inventory);
    vi.resetModules();
    vi.doMock('node:fs/promises', async importOriginal => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return { ...actual, readFile: async (path: URL) => {
        const bytes = await actual.readFile(path);
        return path.pathname.endsWith('/repack.py') ? Buffer.concat([bytes, Buffer.from('\n# changed helper\n')]) : bytes;
      } };
    });
    try {
      const changed = await import('./ingest.js');
      expect(changed.terrainImportId(inventory)).not.toBe(original);
    } finally { vi.doUnmock('node:fs/promises'); vi.resetModules(); }
  });

  it('partitions every tile, resumes verified assets, and publishes the catalog last', async () => {
    const { store, objects } = memoryStorage(), input = fixture();
    objects.set(`terrain/inventories/${input.inventory.sha256}.txt`, input.raw);
    const first = await syncTerrainShard({ store, ...input, shardIndex: 0, shardCount: 2 });
    expect(first).toMatchObject({ completed: 2, reused: 0, total: 2 });
    await expect(finalizeTerrainCatalog({ store, inventory: input.inventory })).rejects.toThrow('incomplete');
    expect([...objects.keys()].some(key => key.startsWith('terrain/catalogs/'))).toBe(false);
    await syncTerrainShard({ store, ...input, shardIndex: 1, shardCount: 2 });
    const retry = await syncTerrainShard({ store, ...input });
    expect(retry).toMatchObject({ completed: 0, reused: 3, total: 3 });
    expect(input.fetch).toHaveBeenCalledTimes(3);
    const reference = await finalizeTerrainCatalog({ store, inventory: input.inventory });
    const catalog = parseJson(objects.get(reference.key)!, terrainCatalogSchema);
    expect(catalog.tiles.map(tile => tile.id)).toEqual(input.inventory.tiles.map(tile => tile.id));
    expect(sha256(objects.get(reference.key)!)).toBe(reference.sha256);
    expect(await finalizeTerrainCatalog({ store, inventory: input.inventory })).toEqual(reference);
  });

  it('rejects altered bytes and never publishes a catalog from changed assets', async () => {
    const { store, objects } = memoryStorage(), input = fixture(1);
    objects.set(`terrain/inventories/${input.inventory.sha256}.txt`, input.raw);
    await syncTerrainShard({ store, ...input });
    const asset = [...objects.keys()].find(key => key.endsWith('.tif'))!;
    objects.set(asset, new Uint8Array([9, 8, 7, 6]));
    await expect(syncTerrainShard({ store, ...input })).rejects.toThrow('asset changed');
    await expect(finalizeTerrainCatalog({ store, inventory: input.inventory })).rejects.toThrow('asset changed');
  });

  it('repairs a missing asset only when its original source and packed bytes still match', async () => {
    const { store, objects } = memoryStorage(), input = fixture(1);
    await syncTerrainShard({ store, ...input });
    const asset = [...objects.keys()].find(key => key.endsWith('.tif'))!;
    objects.delete(asset);
    const changedFetch = vi.fn(async () => new Response(new Uint8Array([2])));
    await expect(syncTerrainShard({ store, ...input, fetch: changedFetch })).rejects.toThrow('source changed');
    expect(input.repack).toHaveBeenCalledTimes(1);
    expect(await syncTerrainShard({ store, ...input })).toMatchObject({ completed: 1, reused: 0 });
    expect(objects.has(asset)).toBe(true);
  });

  it('rejects foreign inventory receipts', async () => {
    const { store, objects } = memoryStorage(), input = fixture(1);
    objects.set(`terrain/inventories/${input.inventory.sha256}.txt`, input.raw);
    await syncTerrainShard({ store, ...input });
    const key = [...objects.keys()].find(key => key.includes('/imports/'))!;
    const receipt = JSON.parse(Buffer.from(objects.get(key)!).toString());
    receipt.inventorySha256 = 'a'.repeat(64);
    objects.set(key, encodeJson(receipt));
    await expect(finalizeTerrainCatalog({ store, inventory: input.inventory })).rejects.toThrow('does not match');
  });

  it.each(['sync', 'finalize'] as const)('identifies a failed tile receipt read during %s without retrying it', async command => {
    const { store, objects } = memoryStorage(), input = fixture(1), cause = new Error('aborted');
    objects.set(`terrain/inventories/${input.inventory.sha256}.txt`, input.raw);
    const read = store.get;
    store.get = vi.fn(async (...args: Parameters<ObjectStorage['get']>) => {
      if (args[0].includes('/imports/')) throw cause;
      return read(...args);
    });
    const promise = command === 'sync' ? syncTerrainShard({ store, ...input }) : finalizeTerrainCatalog({ store, inventory: input.inventory });
    await expect(promise).rejects.toMatchObject({
      message: `Terrain ${input.inventory.tiles[0].id}: read ${command === 'sync' ? 'import' : 'catalog'} receipt failed: aborted`, cause
    });
    expect(store.get).toHaveBeenCalledTimes(command === 'sync' ? 1 : 2);
    expect(input.fetch).not.toHaveBeenCalled();
    expect(input.repack).not.toHaveBeenCalled();
    expect(objects.size).toBe(1);
  });

  it.each(['sync', 'finalize'] as const)('preserves caller cancellation during %s', async command => {
    const { store, objects } = memoryStorage(), input = fixture(1), controller = new AbortController(), reason = new Error('caller stopped import');
    objects.set(`terrain/inventories/${input.inventory.sha256}.txt`, input.raw);
    const read = store.get;
    store.get = async (...args: Parameters<ObjectStorage['get']>) => {
      if (args[0].includes('/imports/')) { controller.abort(reason); throw new Error('read interrupted'); }
      return read(...args);
    };
    const promise = command === 'sync'
      ? syncTerrainShard({ store, ...input, signal: controller.signal })
      : finalizeTerrainCatalog({ store, inventory: input.inventory, signal: controller.signal });
    await expect(promise).rejects.toBe(reason);
    expect(input.fetch).not.toHaveBeenCalled();
    expect(input.repack).not.toHaveBeenCalled();
    expect(objects.size).toBe(1);
  });

  it('requires the pinned raw inventory and rejects a catalog with truncated coverage', async () => {
    const { store, objects } = memoryStorage(), input = fixture(2);
    await syncTerrainShard({ store, ...input });
    await expect(finalizeTerrainCatalog({ store, inventory: input.inventory })).rejects.toThrow('snapshot is missing or changed');
    const key = `terrain/inventories/${input.inventory.sha256}.txt`;
    objects.set(key, Buffer.from('changed inventory'));
    await expect(finalizeTerrainCatalog({ store, inventory: input.inventory })).rejects.toThrow('snapshot is missing or changed');
    objects.set(key, input.raw);
    const truncated = { ...input.inventory, tiles: input.inventory.tiles.slice(0, 1) };
    await expect(finalizeTerrainCatalog({ store, inventory: truncated })).rejects.toThrow('complete source inventory');
    expect([...objects.keys()].some(key => key.startsWith('terrain/catalogs/'))).toBe(false);
  });

  it('bounds admitted repacks and drains work after a failure', async () => {
    const { store } = memoryStorage(), input = fixture(6);
    let active = 0, maximum = 0;
    const repack = vi.fn(async (bytes: Uint8Array) => {
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      if (bytes[0] === 1) throw new Error('packing failed');
      return input.repack(bytes);
    });
    await expect(syncTerrainShard({ store, ...input, repack, concurrency: 2 })).rejects.toThrow('packing failed');
    expect(maximum).toBe(2);
    expect(active).toBe(0);
    expect(repack).toHaveBeenCalledTimes(2);
  });

  it('cancels an active sibling repack on the first failure and preserves that failure', async () => {
    const { store, objects } = memoryStorage(), input = fixture(4);
    const cause = new Error('first packing failure');
    let secondStarted = () => {};
    const started = new Promise<void>(resolve => { secondStarted = resolve; });
    let siblingAborted = false;
    const repack = vi.fn(async (bytes: Uint8Array, signal?: AbortSignal) => {
      if (bytes[0] === 1) { await started; throw cause; }
      secondStarted();
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => {
        siblingAborted = true; reject(signal!.reason);
      }, { once: true }));
      return input.repack(bytes);
    });
    await expect(syncTerrainShard({ store, ...input, repack, concurrency: 2 })).rejects.toMatchObject({
      message: `Terrain ${input.inventory.tiles[0].id}: repack source failed: first packing failure`, cause
    });
    expect(siblingAborted).toBe(true);
    expect(repack).toHaveBeenCalledTimes(2);
    expect(objects.size).toBe(0);
  });

  it('does not publish a receipt when an upload fails', async () => {
    const { store, objects } = memoryStorage(), input = fixture(1), cause = new Error('upload failed');
    store.put = async () => { throw cause; };
    await expect(syncTerrainShard({ store, ...input })).rejects.toMatchObject({
      message: `Terrain ${input.inventory.tiles[0].id}: write terrain asset failed: upload failed`, cause
    });
    expect(objects.size).toBe(0);
  });

  it('validates shard and concurrency limits before downloads', async () => {
    const { store } = memoryStorage(), input = fixture(1);
    for (const override of [{ shardCount: 0 }, { shardIndex: 2, shardCount: 2 }, { concurrency: 5 }]) {
      await expect(syncTerrainShard({ store, ...input, ...override })).rejects.toThrow();
    }
    expect(input.fetch).not.toHaveBeenCalled();
    expect(terrainImportId(input.inventory)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects source geometries belonging to another cell', async () => {
    const { store } = memoryStorage(), input = fixture(1);
    const repack = async (bytes: Uint8Array) => {
      const result = await input.repack(bytes);
      return { ...result, geometry: { ...result.geometry, lon0: 90 } };
    };
    await expect(syncTerrainShard({ store, ...input, repack })).rejects.toThrow('source geocell');
  });
});
