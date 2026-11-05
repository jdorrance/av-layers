import { INDEXED_PRODUCT, SPLIT_PRODUCT } from '../../../tests/model-fixtures.js';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectedTiles, setBit, sparseCoverageFromDense, sparseCoverageLookup, STATUS_NO_LIFT, type CoverageMask, type LayerId } from '@av/contracts';
import { openArchive } from './archive-reader.js';
import { BUILD_BUDGETS } from './capacity.js';
import { createRasterPool, rasterWorkerCount, RASTER_WORKER_RESERVE_BYTES } from './raster-pool.js';
import { createRenderer } from './render.js';
import { decodeWebp } from './webp.js';
import { admitWholeDomain } from './whole-domain/capacity.js';
import { loadBundledFineCoverage, wholeDomainPlan } from './whole-domain/coverage.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function fixture() {
  const grid = { kind: 'regular-latlon' as const, earthRadiusM: 6371229, width: 4, height: 3, lon0: -180, lat0: 60, dx: 90, dy: -60, wrapLongitude: true };
  const mask: CoverageMask = { grid, output: new Uint8Array(2), halo: new Uint8Array(2), tiles: new Uint8Array(1), maxZoom: 1 };
  for (let cell = 0; cell < 12; cell++) setBit(mask.output, cell);
  for (let tile = 0; tile < 5; tile++) setBit(mask.tiles, tile);
  const layers: LayerId[] = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'];
  const targets = layers.map((layer, index) => ({ layer, field: { values: Float32Array.from({ length: 12 }, (_, cell) => (cell + 1) * (index ? 0.5 : 100)), flags: Uint8Array.from({ length: 12 }, (_, cell) => index < 2 && cell === 4 ? STATUS_NO_LIFT : 0) } }));
  return { mask, targets };
}

describe('bounded per-frame raster workers', () => {
  it('uses inline on one CPU and caps valid effective worker counts', () => {
    expect([1, 2, 3, 4, 128].map(cpus => rasterWorkerCount(cpus))).toEqual([0, 2, 3, 3, 3]);
    expect([0, 1, 2, 3].map(limit => rasterWorkerCount(4, limit))).toEqual([0, 1, 2, 3]);
    expect(rasterWorkerCount(1, 3)).toBe(0);
    for (const limit of [-1, 0.5, 4, NaN]) expect(() => rasterWorkerCount(4, limit)).toThrow('worker ceiling');
    for (const invalid of [0, -1, NaN, Infinity, 1.5]) expect(() => rasterWorkerCount(invalid)).toThrow();
    expect(() => createRenderer(fixture().mask, { rasterWorkers: 4 })).toThrow('resource limits');
  });

  it('shares packed snapshots and sparse masks with exact raster parity and cleanup', async () => {
    const { mask, targets } = fixture(), field = targets[0].field;
    mask.output.fill(0); mask.halo.fill(0);
    setBit(mask.output, 4);
    for (let i = 0; i < 12; i++) if (i !== 4) setBit(mask.halo, i);
    const coverage = sparseCoverageFromDense({ ...mask.grid, gridHash: 'b'.repeat(64), output: mask.output, halo: mask.halo });
    const packed = { values: new Float32Array(12), flags: new Uint8Array(12), coverage };
    for (let i = 0; i < 12; i++) {
      const offset = sparseCoverageLookup(coverage, i % 4, Math.floor(i / 4))!.offset;
      packed.values[offset] = field.values[i]; packed.flags[offset] = field.flags[i];
    }
    const sparse = { grid: mask.grid, tiles: mask.tiles, maxZoom: mask.maxZoom, coverage };
    const denseRaster = createRenderer(mask, { rasterWorkers: 0 }), sparseRaster = createRenderer(sparse, { rasterWorkers: 0 });
    const expected = denseRaster.renderTileRgba(field, targets[0].layer, 0, 0, 0);
    expect(sparseRaster.renderTileRgba(packed, targets[0].layer, 0, 0, 0)).toEqual(expected);
    const pool = await createRasterPool(sparse, [{ field: packed, layer: targets[0].layer }], { workers: 1, geometryCacheBytes: 120_000, maxPending: 1 });
    try {
      expect(pool.sharedInputBytes).toBe(137);
      packed.values.fill(0); coverage.output.fill(0);
      expect((await pool.render(0, 0, 0, 0, 0)).rgba).toEqual(expected);
    } finally { await pool.close(); await pool.close(); }
    await expect(pool.render(0, 0, 0, 0, 0)).rejects.toThrow('closed');
  }, 20_000);

  it('reuses shared packed fields and sparse masks with offset views', async () => {
    const { mask, targets } = fixture();
    const original = sparseCoverageFromDense({ ...mask.grid, gridHash: 'c'.repeat(64), output: mask.output, halo: mask.halo });
    const bytes = (source: Uint8Array) => { const result = new Uint8Array(new SharedArrayBuffer(source.length + 8), 4, source.length); result.set(source); return result; };
    const words = (source: Uint32Array) => { const result = new Uint32Array(new SharedArrayBuffer(source.byteLength + 8), 4, source.length); result.set(source); return result; };
    const coverage = { ...original, blockIds: words(original.blockIds), offsets: words(original.offsets), output: bytes(original.output), halo: bytes(original.halo) };
    const values = new Float32Array(new SharedArrayBuffer(12 * 4 + 8), 4, 12), flags = new Uint8Array(new SharedArrayBuffer(20), 4, 12);
    values.set(targets[0].field.values); flags.set(targets[0].field.flags);
    const packed = { values, flags, coverage }, sparse = { grid: mask.grid, tiles: bytes(mask.tiles), maxZoom: mask.maxZoom, coverage };
    const pool = await createRasterPool(sparse, [{ field: packed, layer: targets[0].layer }], { workers: 1, geometryCacheBytes: 120_000, maxPending: 1 });
    try {
      expect(pool.copiedInputBytes).toBe(0);
      values.fill(5); flags.fill(0);
      const expected = createRenderer(sparse, { rasterWorkers: 0 }).renderTileRgba(packed, targets[0].layer, 0, 0, 0);
      expect((await pool.render(0, 0, 0, 0, 0)).rgba).toEqual(expected);
    } finally { await pool.close(); }
  }, 20_000);

  it('rejects a process working set exceeding the build budget before allocating worker inputs', async () => {
    const { mask, targets } = fixture();
    await expect(createRasterPool(mask, targets, { workers: 1, geometryCacheBytes: 2 * 1024 ** 3, maxPending: 1 })).rejects.toThrow('process working-set budget');
  });

  it.each([INDEXED_PRODUCT, SPLIT_PRODUCT])('admits each configured packed snapshot within a bounded whole-domain budget', async product => {
    const plan = wholeDomainPlan(product)!, fine = (await loadBundledFineCoverage(product, plan)).mask;
    const active = fine.coverage.offsets[fine.coverage.blockIds.length]!;
    expect(active).toBeGreaterThan(0);
    const fields = (['usable-lift-msl', 'usable-lift-agl'] as const).map(layer => ({ layer, field: { values: new Float32Array(active), flags: new Uint8Array(active), coverage: fine.coverage } }));
    const nativeCells = plan.native.width * plan.native.height, nativeMaskBytes = 2 * Math.ceil(nativeCells / 8) + fine.tiles.byteLength;
    const capacity = admitWholeDomain({ product, plan, nativeBlocks: Uint32Array.of(0), nativeActive: 1, nativeMask: fine, fine, nativeMaskBytes,
      frames: 1, nativeLayers: product.layers.includes('precip-rate') ? 1 : 0, fineLayers: 2, terrainBytes: 0, maxLevels: 1, retainedGeometryFields: 0,
      columns: { byteLength: 0, workspaceBufferBytes: 0, workspaceObjectBudgetBytes: 0, outputBufferBytes: active * 10 } });
    const expectedBytes = capacity.rasterSharedInputBytes;
    expect(capacity.rasterWorkers).toBe(rasterWorkerCount(undefined, product.execution.workers));
    expect(capacity.violations).toEqual([]);
    expect(capacity.estimatedPeakBytes).toBeLessThanOrEqual(BUILD_BUDGETS.peakRssBytes);
    expect(capacity.workingSet.rasterSharedInputs).toBe(capacity.rasterWorkers ? expectedBytes : 0);
    expect(capacity.workingSet.rasterWorkerRuntimes).toBe(capacity.rasterWorkers * RASTER_WORKER_RESERVE_BYTES);
    if (capacity.rasterWorkers) expect(capacity.workingSet.rasterInline).toBe(0);
    else expect(capacity.workingSet.rasterInline).toBeGreaterThan(0);
    await expect(createRasterPool(fine, fields, { workers: 1, geometryCacheBytes: 0, maxPending: 1 })).rejects.toThrow('shared input byte budget');
    const pool = await createRasterPool(fine, fields, { workers: 1, geometryCacheBytes: 0, maxPending: 1, maxSharedInputBytes: capacity.rasterSharedInputBytes });
    try { expect(pool.sharedInputBytes).toBe(expectedBytes); expect(pool.admittedPeakBytes).toBeLessThanOrEqual(BUILD_BUDGETS.peakRssBytes); }
    finally { await pool.close(); }
  }, 30_000);

  it('falls back inline when whole-domain worker headroom is exhausted', async () => {
    const { mask, targets } = fixture(), directory = await mkdtemp(join(tmpdir(), 'av-raster-headroom-')); temporary.push(directory);
    const rss = vi.spyOn(process.memoryUsage, 'rss').mockReturnValue(BUILD_BUDGETS.peakRssBytes);
    try {
      const renderer = createRenderer(mask, { rasterWorkers: 3, rasterSharedInputBytes: 1000 });
      const path = join(directory, 'inline.pmtiles');
      await renderer.renderArchives([{ ...targets[0], path }]);
      expect(renderer.metrics()).toMatchObject({ rasterWorkers: 0, workerStarts: 0, peakSharedInputBytes: 0, geometryBytes: 0 });
      const archive = await openArchive(path);
      try {
        const encoded = await archive.reader.getZxy(0, 0, 0);
        expect(Buffer.from((await decodeWebp(new Uint8Array(encoded!.data))).data)).toEqual(Buffer.from(createRenderer(mask, { rasterWorkers: 0 }).renderTileRgba(targets[0].field, targets[0].layer, 0, 0, 0)));
      } finally { await archive.close(); }
    } finally { rss.mockRestore(); }
  }, 20_000);

  it.skipIf(rasterWorkerCount() === 0)('keeps a fitting derive-only pair at the worker budget boundary', async () => {
    const product = { ...INDEXED_PRODUCT, execution: { ...INDEXED_PRODUCT.execution, workers: 3 } };
    const plan = wholeDomainPlan(product)!, fine = (await loadBundledFineCoverage(product, plan)).mask;
    const nativeCells = plan.native.width * plan.native.height, active = fine.coverage.offsets.at(-1)!;
    const admit = (nativeActive: number) => admitWholeDomain({ product, plan, nativeBlocks: Uint32Array.of(0), nativeActive, nativeMask: fine, fine,
      nativeMaskBytes: 2 * Math.ceil(nativeCells / 8), frames: 1, maxLevels: 1, retainedGeometryFields: 257,
      nativeLayers: 0, fineLayers: 2, terrainBytes: 0,
      columns: { byteLength: 0, workspaceBufferBytes: Math.min(4, nativeActive) * 64, workspaceObjectBudgetBytes: 0, outputBufferBytes: active * 10 } });
    let low = 0, high = nativeCells;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2), capacity = admit(middle);
      if (capacity.rasterWorkers + capacity.deriveWorkers > 0) low = middle;
      else high = middle - 1;
    }
    const capacity = admit(low), inline = admit(low + 1);
    expect(capacity).toMatchObject({ rasterWorkers: 0, deriveWorkers: 1, violations: [] });
    expect(capacity.workingSet.rasterInline).toBeGreaterThan(0);
    expect(capacity.estimatedPeakBytes).toBeLessThanOrEqual(BUILD_BUDGETS.peakRssBytes);
    expect(inline).toMatchObject({ rasterWorkers: 0, deriveWorkers: 0, violations: [] });
    expect(inline.workingSet.rasterInline).toBeGreaterThan(0);
  });

  it('matches inline archives exactly while sharing one total queue/cache budget', async () => {
    const { mask, targets } = fixture(), directory = await mkdtemp(join(tmpdir(), 'av-worker-proof-')); temporary.push(directory);
    const inline = createRenderer(mask, { rasterWorkers: 0 }), workers = createRenderer(mask, { rasterWorkers: 3, encodeConcurrency: 4, geometryCacheBytes: 180_000 });
    await workers.renderArchives(targets.map((target, index) => ({ ...target, path: join(directory, `${index}.pmtiles`) })));
    for (let index = 0; index < targets.length; index++) {
      const source = await openArchive(join(directory, `${index}.pmtiles`)), target = targets[index];
      try {
        for (const tile of [...expectedTiles(mask, 0), ...expectedTiles(mask, 1)]) {
          const encoded = await source.reader.getZxy(tile.z, tile.x, tile.y);
          expect(encoded).toBeDefined();
          const actual = (await decodeWebp(new Uint8Array(encoded!.data))).data, expected = inline.renderTileRgba(target.field, target.layer, tile.z, tile.x, tile.y);
          expect(Buffer.from(actual).equals(Buffer.from(expected)), `${target.layer}/${tile.z}/${tile.x}/${tile.y}`).toBe(true);
        }
      } finally { await source.close(); }
    }
    expect(workers.metrics()).toMatchObject({ rasterWorkers: 3, workerStarts: 3, geometryBytes: 0, geometryMisses: 5, geometryHits: 10, peakPendingTiles: 4, peakSharedInputBytes: 185 });
    expect(workers.metrics().peakGeometryBytes).toBeLessThanOrEqual(180_000);
    await workers.renderArchives(targets.map((target, index) => ({ ...target, path: join(directory, `second-${index}.pmtiles`) })));
    expect(workers.metrics()).toMatchObject({ rasterWorkers: 3, workerStarts: 6, geometryBytes: 0, geometryMisses: 10, geometryHits: 20 });
  }, 20_000);

  it('keeps worker lift interpolation identical to inline for step and linear-rgb modes', async () => {
    const { mask, targets } = fixture(), target = targets[0];
    for (const mode of ['step', 'linear-rgb'] as const) {
      const inline = createRenderer(mask, { rasterWorkers: 0, liftInterpolation: mode }).renderTileRgba(target.field, target.layer, 1, 0, 0);
      const pool = await createRasterPool(mask, [target], { workers: 1, geometryCacheBytes: 120_000, maxPending: 1, liftInterpolation: mode });
      try {
        const result = await pool.render(0, 0, 1, 0, 0);
        expect(Buffer.from(result.rgba).equals(Buffer.from(inline)), mode).toBe(true);
      } finally { await pool.close(); }
    }
  }, 20_000);

  it('propagates worker sampling errors, settles admitted work and closes the pool', async () => {
    const { mask, targets } = fixture(); targets[2].field.values[0] = NaN;
    const pool = await createRasterPool(mask, [targets[2]], { workers: 2, geometryCacheBytes: 120_000, maxPending: 2 });
    try {
      const work = [pool.render(0, 0, 0, 0, 0), pool.render(1, 0, 0, 0, 0)];
      await expect(pool.render(2, 0, 0, 0, 0)).rejects.toThrow('pending job budget');
      const results = await Promise.allSettled(work);
      expect(results.every(result => result.status === 'rejected' && /non-finite/.test(String(result.reason)))).toBe(true);
      await expect(pool.render(3, 0, 0, 0, 0)).rejects.toThrow('non-finite');
    } finally { await pool.close(); await pool.close(); }
  }, 20_000);

  it('aborts pending raster jobs and permits idempotent cleanup before returning', async () => {
    const { mask, targets } = fixture(), controller = new AbortController();
    const pool = await createRasterPool(mask, targets, { workers: 2, geometryCacheBytes: 120_000, maxPending: 2, signal: controller.signal });
    const jobs = [pool.render(0, 0, 0, 0, 0), pool.render(1, 1, 0, 0, 0)];
    controller.abort(new Error('cancel raster frame'));
    expect((await Promise.allSettled(jobs)).every(result => result.status === 'rejected')).toBe(true);
    await expect(pool.render(2, 2, 0, 0, 0)).rejects.toThrow('cancel raster frame');
    await pool.close(); await pool.close();
    await expect(createRasterPool(mask, targets, { workers: 2, geometryCacheBytes: 120_000, maxPending: 2, signal: controller.signal })).rejects.toThrow('cancel raster frame');
    const startup = new AbortController();
    const initializing = createRasterPool(mask, targets, { workers: 2, geometryCacheBytes: 120_000, maxPending: 2, signal: startup.signal });
    startup.abort(new Error('cancel worker startup'));
    await expect(initializing).rejects.toThrow('cancel worker startup');
  }, 20_000);

  it('cleans failed archive workers and releases the renderer for a retry', async () => {
    const { mask, targets } = fixture(), directory = await mkdtemp(join(tmpdir(), 'av-worker-retry-')); temporary.push(directory);
    const target = { ...targets[2], path: join(directory, 'retry.pmtiles') }, renderer = createRenderer(mask, { rasterWorkers: 2, encodeConcurrency: 2 });
    target.field.values[0] = NaN;
    await expect(renderer.renderArchives([target])).rejects.toThrow('non-finite');
    await expect(stat(target.path)).rejects.toMatchObject({ code: 'ENOENT' });
    target.field.values[0] = 1;
    await renderer.renderArchives([target]);
    expect((await stat(target.path)).size).toBeGreaterThan(0);
    expect(renderer.metrics().geometryBytes).toBe(0);
  }, 20_000);
});
