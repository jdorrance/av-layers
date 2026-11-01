import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expectedTiles, setBit, STATUS_NO_LIFT, type CoverageMask, type LayerId } from '@av/contracts';
import { openArchive } from './archive-reader.js';
import { createRasterPool, rasterWorkerCount } from './raster-pool.js';
import { createRenderer } from './render.js';
import { decodeWebp } from './webp.js';

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
    expect([1, 2, 3, 4, 128].map(rasterWorkerCount)).toEqual([0, 2, 3, 3, 3]);
    for (const invalid of [0, -1, NaN, Infinity, 1.5]) expect(() => rasterWorkerCount(invalid)).toThrow();
    expect(() => createRenderer(fixture().mask, { rasterWorkers: 4 })).toThrow('resource limits');
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
