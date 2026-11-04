import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalGridJson, encodeSparseCoverage, sparseCoverageFromDense } from '@av/contracts';
import { sha256 } from './contract.js';
import { createTerrainReader, type TerrainReadStats } from './reader.js';
import { prepareSparseTerrain, type SparseTerrainProgress } from './sparse.js';
import { verifyTerrainCatalogInventory } from './source.js';
import { terrainCatalogFixture, TerrainTestStorage } from './test-fixtures.js';

const hooks = vi.hoisted(() => ({ sourceBlocks: undefined as (() => void) | undefined, sampleBatch: undefined as (() => void) | undefined, closed: vi.fn() }));
vi.mock('./source.js', async importOriginal => ({ ...await importOriginal<typeof import('./source.js')>(), verifyTerrainCatalogInventory: vi.fn(async () => {}) }));
vi.mock('./reader.js', async importOriginal => ({
  ...await importOriginal<typeof import('./reader.js')>(),
  createTerrainReader: vi.fn(async () => {
    const stats: TerrainReadStats = { requests: 0, bytesRead: 0, readBytesBound: 0, decodedPixels: 0, outputPixels: 0, cacheHits: 0 };
    return {
      sourceBlocks: () => { hooks.sourceBlocks?.(); return ''; },
      sampleBatch: async (points: readonly unknown[]) => { hooks.sampleBatch?.(); stats.outputPixels += points.length; return points.map(() => ({ elevationM: 0, source: 'ocean' as const })); },
      stats: () => ({ ...stats }), close: hooks.closed
    };
  })
}));

beforeEach(() => { vi.clearAllMocks(); hooks.sourceBlocks = undefined; hooks.sampleBatch = undefined; });
afterEach(() => { vi.restoreAllMocks(); });

function fixture(width = 3, height = 2) {
  const grid = { kind: 'regular-latlon' as const, width, height, earthRadiusM: 6371229, lon0: 0, lat0: 0.75, dx: 1 / width, dy: -1 / height, wrapLongitude: false };
  const cells = width * height, output = new Uint8Array(Math.ceil(cells / 8)).fill(255);
  if (cells % 8) output[output.length - 1] = (1 << (cells % 8)) - 1;
  const gridHash = sha256(canonicalGridJson(grid));
  const coverage = sparseCoverageFromDense({ width, height, wrapLongitude: false, gridHash, output, halo: new Uint8Array(output.length) });
  const encoded = encodeSparseCoverage(coverage), coverageDescriptor = Buffer.from(JSON.stringify({
    version: 2, id: 'fixture', grid, gridHash, bounds: [0, -1, 1, 1], policy: 'fixture', maxZoom: 0, supportHaloCells: 1,
    sampleLayout: { format: 'cell-major-block-shards-v1', blockSize: 16 },
    files: { sparse: { bytes: encoded.length, sha256: sha256(encoded) }, tiles: { bytes: 1, sha256: sha256(Uint8Array.of(1)) } }
  }));
  return { catalog: terrainCatalogFixture(), storage: new TerrainTestStorage(), grid, coverage, coverageDescriptor };
}

describe('sparse terrain cache admission and progress', () => {
  it('rejects a missing cache before inventory checks, source reads or target traversal', async () => {
    const input = fixture(), head = vi.spyOn(input.storage, 'head'), onProgress = vi.fn();
    await expect(prepareSparseTerrain({ ...input, cacheOnly: true, onProgress })).rejects.toThrow('run pnpm operations forecast-terrain before forecast planning');
    expect(input.storage.gets).toEqual([expect.stringMatching(/^terrain\/prepared\/[a-f0-9]{64}\/manifest\.json$/)]);
    expect(verifyTerrainCatalogInventory).not.toHaveBeenCalled();
    expect(createTerrainReader).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
    expect(input.storage.objects.size).toBe(0);
    expect(onProgress).toHaveBeenCalledExactlyOnceWith({ phase: 'cache-check', cells: 6, completedCells: 0, elapsedMs: expect.any(Number) });
  });

  it('reuses a complete cache and validates its inventory, identity and chunk bytes', async () => {
    const input = fixture(), ref = await prepareSparseTerrain(input);
    vi.clearAllMocks(); input.storage.gets = [];
    const onProgress = vi.fn();
    expect(await prepareSparseTerrain({ ...input, cacheOnly: true, onProgress })).toEqual(ref);
    expect(verifyTerrainCatalogInventory).toHaveBeenCalledOnce();
    expect(createTerrainReader).not.toHaveBeenCalled();
    expect(input.storage.gets).toHaveLength(3);
    expect(onProgress.mock.calls.map(([event]) => event.phase)).toEqual(['cache-check', 'cache-validation', 'complete']);
    expect(onProgress.mock.calls.at(-1)![0]).toMatchObject({ cells: 6, completedCells: 6, cacheHit: true });
    const descriptor = JSON.parse(Buffer.from(input.storage.objects.get(ref.key)!).toString());
    input.storage.objects.get(descriptor.files.valid[0].key)![0] ^= 1;
    await expect(prepareSparseTerrain({ ...input, cacheOnly: true })).rejects.toThrow('integrity mismatch');
    expect(createTerrainReader).not.toHaveBeenCalled();
  });

  it('reports phase boundaries and throttles planning and sampling updates to ten seconds', async () => {
    const input = fixture(1024, 192), events: SparseTerrainProgress[] = [];
    let now = Date.now(), phase: SparseTerrainProgress['phase'], planned = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    hooks.sourceBlocks = () => { if (phase === 'planning' && ++planned % 32_768 === 0) now += 6000; };
    hooks.sampleBatch = () => { now += 600; };
    await prepareSparseTerrain({ ...input, onProgress: event => { phase = event.phase; events.push(event); } });
    expect([...new Set(events.map(event => event.phase))]).toEqual(['cache-check', 'planning', 'sampling', 'upload', 'complete']);
    for (const current of ['planning', 'sampling'] as const) {
      const updates = events.filter(event => event.phase === current);
      expect(updates.length).toBeGreaterThan(1);
      expect(updates[0].completedCells).toBe(0);
      for (let i = 1; i < updates.length; i++) {
        expect(updates[i].elapsedMs - updates[i - 1].elapsedMs).toBeGreaterThanOrEqual(10_000);
        expect(updates[i].completedCells).toBeGreaterThan(updates[i - 1].completedCells);
      }
    }
    expect(events.find(event => event.phase === 'sampling')).toMatchObject({ sourceBlocks: 0, sourceAssets: 0, reader: { outputPixels: 0 } });
    expect(events.at(-1)).toMatchObject({ phase: 'complete', completedCells: 196_608, cells: 196_608, cacheHit: false });
  });

  it.each(['planning', 'sampling'] as const)('stops and closes readers when a %s progress callback cancels preparation', async phase => {
    const input = fixture(1024, 192), controller = new AbortController(), reason = new Error(`cancel ${phase}`);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    hooks.sourceBlocks = () => { now += 1; };
    hooks.sampleBatch = () => { now += 10_000; };
    await expect(prepareSparseTerrain({ ...input, signal: controller.signal, onProgress: event => {
      if (event.phase === phase && event.completedCells > 0) controller.abort(reason);
    } })).rejects.toBe(reason);
    expect(hooks.closed).toHaveBeenCalledTimes(phase === 'planning' ? 1 : 2);
    expect(input.storage.objects.size).toBe(0);
  });
});
