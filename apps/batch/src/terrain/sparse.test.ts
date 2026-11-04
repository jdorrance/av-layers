import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalGridJson, encodeSparseCoverage, sparseCoverageFromDense } from '@av/contracts';
import { dataIdentity, sha256 } from './contract.js';
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

function changedMetadata(input: ReturnType<typeof fixture>, coverage = input.coverage) {
  const descriptor = JSON.parse(input.coverageDescriptor.toString()), sparse = encodeSparseCoverage(coverage), tiles = Uint8Array.of(1, 0, 0);
  return { ...input, coverage, coverageDescriptor: Buffer.from(JSON.stringify({ ...descriptor, maxZoom: 2, policy: 'updated tile coverage',
    files: { sparse: { bytes: sparse.length, sha256: sha256(sparse) }, tiles: { bytes: tiles.length, sha256: sha256(tiles) } } })) };
}

function seedCoverage(input: ReturnType<typeof fixture>): string {
  const prefix = `coverage/${sha256(input.coverageDescriptor)}`;
  input.storage.objects.set(`${prefix}/manifest.json`, input.coverageDescriptor);
  input.storage.objects.set(`${prefix}/sparse.bin`, encodeSparseCoverage(input.coverage));
  return prefix;
}

describe('sparse terrain cache admission and progress', () => {
  it('rejects a missing cache before inventory checks, source reads or target traversal', async () => {
    const input = fixture(), head = vi.spyOn(input.storage, 'head'), onProgress = vi.fn(), reuseFrom = vi.fn();
    await expect(prepareSparseTerrain({ ...input, cacheOnly: true, onProgress, reuseFrom })).rejects.toThrow('run pnpm operations forecast-terrain before forecast planning');
    expect(input.storage.gets).toEqual([expect.stringMatching(/^terrain\/prepared\/[a-f0-9]{64}\/manifest\.json$/)]);
    expect(verifyTerrainCatalogInventory).not.toHaveBeenCalled();
    expect(createTerrainReader).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
    expect(reuseFrom).not.toHaveBeenCalled();
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

describe('sparse terrain metadata reuse', () => {
  it('rekeys verified arrays without sampling and produces the exact cold-prepared bytes', async () => {
    const input = fixture();
    hooks.sampleBatch = points => points.map(point => ({ elevationM: point.latitude * 123.456789 + point.longitude, source: 'dem' as const }));
    const source = await prepareSparseTerrain(input);
    seedCoverage(input);
    const updated = changedMetadata(input), baseline = new TerrainTestStorage();
    const expected = await prepareSparseTerrain({ ...updated, storage: baseline });
    const oldObjects = [...input.storage.objects].map(([key, bytes]) => [key, bytes.slice()] as const);
    vi.clearAllMocks(); input.storage.gets = [];
    const reuseFrom = vi.fn(async () => ({ key: source.key, sha256: source.sha256 })), onProgress = vi.fn(), prefetchSources = vi.fn();
    const writes = vi.spyOn(input.storage, 'put');
    const ref = await prepareSparseTerrain({ ...updated, reuseFrom, onProgress, prefetchSources });
    expect(ref).toEqual(expected);
    expect(ref.key).not.toEqual(source.key);
    expect(reuseFrom).toHaveBeenCalledOnce();
    expect(createTerrainReader).not.toHaveBeenCalled();
    expect(prefetchSources).not.toHaveBeenCalled();
    for (const [key, bytes] of baseline.objects) expect(input.storage.objects.get(key)).toEqual(bytes);
    for (const [key, bytes] of oldObjects) expect(input.storage.objects.get(key)).toEqual(bytes);
    expect(writes.mock.calls.map(([key]) => key)).toEqual([ref.key.replace('manifest.json', 'elevation-0.f32'), ref.key.replace('manifest.json', 'valid-0.u8'), ref.key]);
    expect(writes).toHaveBeenLastCalledWith(ref.key, expect.any(Uint8Array), { ifNoneMatch: '*' }, 'application/json', expect.any(String), { sha256: ref.sha256 });
    expect(onProgress.mock.calls.map(([event]) => event.phase)).toEqual(['cache-check', 'cache-reuse', 'complete']);
    reuseFrom.mockClear(); writes.mockClear();
    expect(await prepareSparseTerrain({ ...updated, reuseFrom, cacheOnly: true })).toEqual(ref);
    expect(reuseFrom).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });

  it.each(['source', 'grid', 'packed coverage'] as const)('samples anew when the %s changes', async change => {
    const input = fixture(), source = await prepareSparseTerrain(input);
    seedCoverage(input);
    let updated = changedMetadata(input);
    if (change === 'source') {
      const catalog = structuredClone(input.catalog);
      catalog.tiles[0].sourceSha256 = 'd'.repeat(64); catalog.dataId = dataIdentity(catalog);
      updated = { ...updated, catalog };
    } else if (change === 'grid') updated = { ...changedMetadata(fixture(4)), storage: input.storage };
    else {
      const coverage = sparseCoverageFromDense({ width: input.grid.width, height: input.grid.height, wrapLongitude: false,
        gridHash: sha256(canonicalGridJson(input.grid)), output: Uint8Array.of(62), halo: Uint8Array.of(1) });
      expect(coverage.offsets.at(-1)).toBe(input.coverage.offsets.at(-1));
      updated = changedMetadata(input, coverage);
    }
    vi.clearAllMocks();
    const onProgress = vi.fn();
    await prepareSparseTerrain({ ...updated, reuseFrom: async () => source, onProgress });
    expect(createTerrainReader).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls.some(([event]) => event.phase === 'cache-reuse')).toBe(false);
    expect(onProgress.mock.calls.at(-1)![0]).toMatchObject({ cacheHit: false });
  });

  it.each(['manifest', 'coverage', 'sparse', 'array'] as const)('fails closed on corrupt reused %s bytes before publishing a new manifest', async defect => {
    const input = fixture(), source = await prepareSparseTerrain(input), coveragePrefix = seedCoverage(input), updated = changedMetadata(input);
    const key = defect === 'manifest' ? source.key : defect === 'coverage' ? `${coveragePrefix}/manifest.json`
      : defect === 'sparse' ? `${coveragePrefix}/sparse.bin` : source.key.replace('manifest.json', 'elevation-0.f32');
    input.storage.objects.get(key)![0] ^= 1;
    vi.clearAllMocks();
    const writes = vi.spyOn(input.storage, 'put');
    await expect(prepareSparseTerrain({ ...updated, reuseFrom: async () => source })).rejects.toThrow(/integrity/);
    expect(writes).not.toHaveBeenCalled();
    expect(createTerrainReader).not.toHaveBeenCalled();
  });

  it.each(['method', 'nonfinite elevation', 'invalid mask'] as const)('rejects checksummed reused terrain with an unsupported %s', async defect => {
    const input = fixture(), source = await prepareSparseTerrain(input);
    seedCoverage(input);
    const descriptor = JSON.parse(Buffer.from(input.storage.objects.get(source.key)!).toString());
    if (defect === 'method') descriptor.method = 'unsupported-method';
    else {
      const asset = defect === 'invalid mask' ? descriptor.files.valid[0] : descriptor.files.elevationM[0];
      const bytes = input.storage.objects.get(asset.key)!;
      if (defect === 'invalid mask') bytes[0] = 2;
      else new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat32(0, NaN, true);
      asset.sha256 = sha256(bytes);
    }
    const bytes = Buffer.from(JSON.stringify(descriptor));
    input.storage.objects.set(source.key, bytes);
    vi.mocked(createTerrainReader).mockClear();
    const writes = vi.spyOn(input.storage, 'put');
    await expect(prepareSparseTerrain({ ...changedMetadata(input), reuseFrom: async () => ({ key: source.key, sha256: sha256(bytes) }) })).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled();
    expect(createTerrainReader).not.toHaveBeenCalled();
  });

  it('retains copied chunks on cancellation and completes the same canonical preparation on retry', async () => {
    const input = fixture(), source = await prepareSparseTerrain(input);
    seedCoverage(input);
    const updated = changedMetadata(input), baseline = new TerrainTestStorage();
    const expected = await prepareSparseTerrain({ ...updated, storage: baseline });
    const controller = new AbortController(), reason = new Error('stop after first copied chunk'), put = input.storage.put.bind(input.storage);
    vi.spyOn(input.storage, 'put').mockImplementation(async (key, bytes, condition) => {
      await put(key, bytes, condition);
      if (key === expected.key.replace('manifest.json', 'elevation-0.f32')) controller.abort(reason);
    });
    vi.mocked(createTerrainReader).mockClear();
    await expect(prepareSparseTerrain({ ...updated, reuseFrom: async () => source, signal: controller.signal })).rejects.toBe(reason);
    expect(input.storage.objects.has(expected.key)).toBe(false);
    expect(input.storage.objects.has(expected.key.replace('manifest.json', 'elevation-0.f32'))).toBe(true);
    expect(await prepareSparseTerrain({ ...updated, reuseFrom: async () => source })).toEqual(expected);
    for (const [key, bytes] of baseline.objects) expect(input.storage.objects.get(key)).toEqual(bytes);
    expect(createTerrainReader).not.toHaveBeenCalled();
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
