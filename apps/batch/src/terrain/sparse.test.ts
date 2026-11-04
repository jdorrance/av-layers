import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalGridJson, encodeSparseCoverage, sparseCoverageFromDense } from '@av/contracts';
import { sha256 } from './contract.js';
import { createTerrainReader, type TerrainReadStats } from './reader.js';
import { prepareSparseTerrain, type SparseTerrainProgress } from './sparse.js';
import { verifyTerrainCatalogInventory } from './source.js';
import { terrainCatalogFixture, TerrainTestStorage } from './test-fixtures.js';

const hooks = vi.hoisted(() => ({
  sourceBlocks: undefined as ((latitude: number, longitude: number) => string | void) | undefined,
  sampleBatch: undefined as ((points: readonly { latitude: number; longitude: number }[]) => Array<{ elevationM: number; source: 'dem' | 'ocean' } | null> | void) | undefined,
  closed: vi.fn()
}));
vi.mock('./source.js', async importOriginal => ({ ...await importOriginal<typeof import('./source.js')>(), verifyTerrainCatalogInventory: vi.fn(async () => {}) }));
vi.mock('./reader.js', async importOriginal => ({
  ...await importOriginal<typeof import('./reader.js')>(),
  createTerrainReader: vi.fn(async () => {
    const stats: TerrainReadStats = { requests: 0, bytesRead: 0, readBytesBound: 0, decodedPixels: 0, outputPixels: 0, cacheHits: 0 };
    return {
      sourceBlocks: (latitude: number, longitude: number) => hooks.sourceBlocks?.(latitude, longitude) ?? '',
      sampleBatch: async (points: readonly { latitude: number; longitude: number }[]) => {
        const samples = hooks.sampleBatch?.(points);
        stats.outputPixels += points.length;
        return samples ?? points.map(() => ({ elevationM: 0, source: 'ocean' as const }));
      },
      stats: () => ({ ...stats }), close: hooks.closed
    };
  })
}));

beforeEach(() => { vi.clearAllMocks(); hooks.sourceBlocks = undefined; hooks.sampleBatch = undefined; });
afterEach(() => { vi.restoreAllMocks(); });

function fixture(width = 3, height = 2, dy = -1 / height) {
  const grid = { kind: 'regular-latlon' as const, width, height, earthRadiusM: 6371229, lon0: 0, lat0: 0.75, dx: 1 / width, dy, wrapLongitude: false };
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

describe('sparse terrain window checkpoints', () => {
  const checkpointKeys = (storage: TerrainTestStorage) => [...storage.objects.keys()].filter(key => /^terrain\/checkpoints\/[a-f0-9]{64}\/w\d+\.bin$/.test(key)).sort();
  const preparedObjects = (storage: TerrainTestStorage) => [...storage.objects].filter(([key]) => key.startsWith('terrain/prepared/')).sort(([a], [b]) => a.localeCompare(b));
  const samples = (points: readonly { latitude: number; longitude: number }[]) => points.map(point =>
    Math.round(point.longitude * 1024) % 23 === 0 ? null : { elevationM: point.latitude * 123.456789 + point.longitude * 31.234567, source: 'dem' as const });

  it('resumes after a later source timeout and preserves the uninterrupted prepared bytes', async () => {
    const baseline = fixture(1024, 130);
    hooks.sampleBatch = samples;
    const expected = await prepareSparseTerrain(baseline);
    expect(checkpointKeys(baseline.storage)).toHaveLength(0);
    const input = fixture(1024, 130), timeout = Object.assign(new Error('R2 source read timed out'), { name: 'TimeoutError' });
    hooks.sampleBatch = points => {
      if (checkpointKeys(input.storage).length) throw timeout;
      return samples(points);
    };
    await expect(prepareSparseTerrain({ ...input, checkpoints: true })).rejects.toBe(timeout);
    expect(checkpointKeys(input.storage)).toHaveLength(1);
    expect(preparedObjects(input.storage)).toHaveLength(0);
    const completed = input.storage.objects.get(checkpointKeys(input.storage)[0])!.slice();
    let sampled = 0;
    hooks.sampleBatch = points => { sampled += points.length; return samples(points); };
    expect(await prepareSparseTerrain({ ...input, checkpoints: true })).toEqual(expected);
    expect(sampled).toBe(1024 * 130 - 65_536);
    expect(checkpointKeys(input.storage)).toHaveLength(3);
    expect(input.storage.objects.get(checkpointKeys(input.storage)[0])).toEqual(completed);
    expect(preparedObjects(input.storage)).toEqual(preparedObjects(baseline.storage));
  });

  it('retains a completed checkpoint when cancellation follows its immutable write', async () => {
    const input = fixture(1024, 128), controller = new AbortController(), reason = new Error('cancel after checkpoint');
    const put = input.storage.put.bind(input.storage);
    vi.spyOn(input.storage, 'put').mockImplementation(async (key, bytes, condition) => {
      await put(key, bytes, condition);
      if (key.endsWith('/w0.bin')) controller.abort(reason);
    });
    hooks.sampleBatch = samples;
    await expect(prepareSparseTerrain({ ...input, checkpoints: true, signal: controller.signal })).rejects.toBe(reason);
    expect(checkpointKeys(input.storage)).toHaveLength(1);
    expect(preparedObjects(input.storage)).toHaveLength(0);
    let sampled = 0;
    hooks.sampleBatch = points => { sampled += points.length; return samples(points); };
    await prepareSparseTerrain({ ...input, checkpoints: true });
    expect(sampled).toBe(65_536);
  });

  it('keeps canonical window offsets when the grid contains unmappable cells', async () => {
    const baseline = fixture(1024, 130, -2);
    hooks.sampleBatch = samples;
    const expected = await prepareSparseTerrain(baseline);
    const input = fixture(1024, 130, -2), controller = new AbortController(), reason = new Error('first mixed window complete');
    const put = input.storage.put.bind(input.storage);
    vi.spyOn(input.storage, 'put').mockImplementation(async (key, bytes, condition) => {
      await put(key, bytes, condition);
      if (key.endsWith('/w0.bin')) controller.abort(reason);
    });
    await expect(prepareSparseTerrain({ ...input, checkpoints: true, signal: controller.signal })).rejects.toBe(reason);
    expect(checkpointKeys(input.storage)).toHaveLength(1);
    const sampled = vi.fn(samples);
    hooks.sampleBatch = sampled;
    expect(await prepareSparseTerrain({ ...input, checkpoints: true })).toEqual(expected);
    expect(sampled).not.toHaveBeenCalled();
    expect(checkpointKeys(input.storage)).toHaveLength(3);
    expect(preparedObjects(input.storage)).toEqual(preparedObjects(baseline.storage));
  });

  it('rejects a corrupt checkpoint before sampling or publishing prepared objects', async () => {
    const input = fixture(1024, 128), timeout = new Error('stop after first window');
    hooks.sampleBatch = points => {
      if (checkpointKeys(input.storage).length) throw timeout;
      return samples(points);
    };
    await expect(prepareSparseTerrain({ ...input, checkpoints: true })).rejects.toBe(timeout);
    const key = checkpointKeys(input.storage)[0], bytes = input.storage.objects.get(key)!;
    bytes[bytes.length - 1] ^= 1;
    const sampled = vi.fn(samples);
    hooks.sampleBatch = sampled;
    await expect(prepareSparseTerrain({ ...input, checkpoints: true })).rejects.toThrow(/checkpoint|digest|integrity/i);
    expect(sampled).not.toHaveBeenCalled();
    expect(preparedObjects(input.storage)).toHaveLength(0);
  });

  it('prefetches distinct cold-window assets and releases them after completion or failure', async () => {
    const input = fixture(1024, 128), timeout = new Error('second window failed'), tile = input.catalog.tiles[0];
    hooks.sourceBlocks = () => `${tile.id}/0/0|${tile.id}/1/0`;
    let pinned = false;
    const release = vi.fn(() => { pinned = false; });
    const prefetchSources = vi.fn(async (_keys: readonly string[], _signal?: AbortSignal) => { pinned = true; return release; });
    hooks.sampleBatch = points => {
      expect(pinned).toBe(true);
      if (checkpointKeys(input.storage).length) throw timeout;
      return samples(points);
    };
    await expect(prepareSparseTerrain({ ...input, checkpoints: true, prefetchSources })).rejects.toBe(timeout);
    expect(prefetchSources).toHaveBeenCalledTimes(2);
    for (const call of prefetchSources.mock.calls) expect(call[0]).toEqual([tile.asset.key]);
    expect(release).toHaveBeenCalledTimes(2);
    expect(pinned).toBe(false);
    prefetchSources.mockClear(); release.mockClear();
    hooks.sampleBatch = points => { expect(pinned).toBe(true); return samples(points); };
    await prepareSparseTerrain({ ...input, checkpoints: true, prefetchSources });
    expect(prefetchSources).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(pinned).toBe(false);
  });
});
