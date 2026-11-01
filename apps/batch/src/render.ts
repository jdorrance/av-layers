import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { expectedTiles, LAYERS, type CoverageMask, type LayerId } from '@av/contracts';
import type { GridField } from '@av/forecast';
import { createRasterizer, renderTileRgba } from './raster.js';
export { mercatorPoint, renderTileRgba } from './raster.js';
import { encodeWebp } from './webp.js';
import { createRasterPool, MAX_RASTER_WORKERS, rasterWorkerCount, type RasterMetrics, type RasterPixels } from './raster-pool.js';

export interface ArchiveTarget { path: string; field: GridField; layer: LayerId }

export interface RendererOptions {
  /** Hard limit for retained axes and coverage bits; fields are never cached. */
  geometryCacheBytes?: number;
  /** Bounded native encodes and ordered output buffers, not JS CPU workers. */
  encodeConcurrency?: number;
  /** Inline on one CPU, otherwise at most three shared-input raster workers. */
  rasterWorkers?: number;
  signal?: AbortSignal;
}

/** One immutable coverage mask per build session; reuse across all frames and layers. */
export function createRenderer(mask: CoverageMask, options: RendererOptions = {}) {
  const budget = options.geometryCacheBytes ?? 24 * 1024 * 1024, concurrency = options.encodeConcurrency ?? 8;
  const rasterWorkers = options.rasterWorkers ?? rasterWorkerCount();
  if (!Number.isSafeInteger(budget) || budget < 0 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32
      || !Number.isSafeInteger(rasterWorkers) || rasterWorkers < 0 || rasterWorkers > MAX_RASTER_WORKERS) {
    throw new RangeError('Invalid renderer resource limits');
  }
  const tiles = Array.from({ length: mask.maxZoom + 1 }, (_, z) => expectedTiles(mask, z)).flat();
  const stats = {
    geometryBytes: 0, peakGeometryBytes: 0, geometryHits: 0, geometryMisses: 0,
    prepareMs: 0, rasterMs: 0, encodeWorkMs: 0, sqliteMs: 0, convertMs: 0, verifyMs: 0,
    tiles: 0, blankTiles: 0, peakPendingTiles: 0, peakPendingTileBytes: 0,
    rasterWorkers, workerStarts: 0, workerStartupMs: 0, peakSharedInputBytes: 0
  };
  const rasterizer = createRasterizer(mask, budget, stats);
  const binary = process.env.PMTILES_BIN || fileURLToPath(new URL('../../../.tools/pmtiles', import.meta.url));
  let toolChecked = false, blankEncoded: Promise<Buffer> | undefined;

  function renderRgba(field: GridField, layer: LayerId, z: number, x: number, y: number) {
    if (renderingArchives && rasterWorkers) throw new Error('Worker archive group owns the renderer');
    return rasterizer.renderTilePixels(field, layer, z, x, y);
  }

  async function encode(rgba: Uint8Array): Promise<Buffer> {
    const started = performance.now();
    try { return await encodeWebp(rgba, 256, 256); }
    finally { stats.encodeWorkMs += performance.now() - started; }
  }

  async function renderTile(field: GridField, layer: LayerId, z: number, x: number, y: number): Promise<Buffer> {
    return encodePixels(renderRgba(field, layer, z, x, y));
  }

  async function encodePixels(result: RasterPixels): Promise<Buffer> {
    if (!result.blank) return encode(result.rgba);
    blankEncoded ??= encode(result.rgba).catch(error => { blankEncoded = undefined; throw error; });
    return blankEncoded;
  }

  // Reserve one raw tile plus the admitted maximum encoded tile per queued job.
  const pendingTileBytes = 256 * 256 * 4 + 1024 * 1024;
  let renderingArchives = false;

  async function writeMbtiles(paths: readonly string[], targets: readonly ArchiveTarget[]): Promise<void> {
    const databases: DatabaseSync[] = [];
    type Encoded = { bytes: Buffer } | { error: unknown };
    const pending: Promise<Encoded>[] = [];
    let pool: Awaited<ReturnType<typeof createRasterPool>> | undefined;
    let hasFailure = false, firstFailure: unknown;
    let next = 0;
    const jobs = tiles.length * targets.length;
    const refill = () => {
      options.signal?.throwIfAborted();
      if (hasFailure) throw firstFailure;
      for (; pending.length < concurrency && next < jobs; next++) {
        const tile = tiles[Math.floor(next / targets.length)], target = targets[next % targets.length];
        const encoded = pool ? pool.render(Math.floor(next / targets.length), next % targets.length, tile.z, tile.x, tile.y).then(encodePixels) : renderTile(target.field, target.layer, tile.z, tile.x, tile.y);
        pending.push(encoded.then(bytes => {
          if (bytes.byteLength > 1024 * 1024) throw new Error('Encoded tile exceeds byte budget');
          return { bytes };
        }).catch(error => { if (!hasFailure) { hasFailure = true; firstFailure = error; } return { error }; }));
        stats.peakPendingTiles = Math.max(stats.peakPendingTiles, pending.length);
        stats.peakPendingTileBytes = Math.max(stats.peakPendingTileBytes, pending.length * pendingTileBytes);
      }
    };
    try {
      if (rasterWorkers) {
        rasterizer.clearGeometry();
        const workerMetrics = new Map<number, RasterMetrics>(), started = performance.now();
        pool = await createRasterPool(mask, targets, { workers: rasterWorkers, geometryCacheBytes: budget, maxPending: concurrency, signal: options.signal, onMetrics(worker, metrics) {
          const before = workerMetrics.get(worker);
          for (const key of ['geometryHits', 'geometryMisses', 'prepareMs', 'rasterMs', 'tiles', 'blankTiles'] as const) stats[key] += metrics[key] - (before?.[key] ?? 0);
          workerMetrics.set(worker, metrics);
          stats.geometryBytes = [...workerMetrics.values()].reduce((sum, item) => sum + item.geometryBytes, 0);
          stats.peakGeometryBytes = Math.max(stats.peakGeometryBytes, stats.geometryBytes);
        } });
        stats.workerStarts += rasterWorkers; stats.workerStartupMs += performance.now() - started;
        stats.peakSharedInputBytes = Math.max(stats.peakSharedInputBytes, pool.sharedInputBytes);
      }
      const inserts = paths.map((path, index) => {
        const db = new DatabaseSync(path); databases.push(db);
        db.exec('CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB); CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row); BEGIN');
        const metadata = db.prepare('INSERT INTO metadata VALUES (?, ?)');
        for (const [key, value] of Object.entries({ name: targets[index].layer, format: 'webp', type: 'overlay', version: '1', minzoom: '0', maxzoom: String(mask.maxZoom), bounds: '-180,-85.051129,180,85.051129' })) metadata.run(key, value);
        return db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)');
      });
      for (let job = 0; job < jobs; job++) {
        refill();
        const result = await pending.shift()!;
        options.signal?.throwIfAborted();
        if ('error' in result) throw result.error;
        const tile = tiles[Math.floor(job / targets.length)], started = performance.now();
        inserts[job % targets.length].run(tile.z, tile.x, 2 ** tile.z - 1 - tile.y, result.bytes);
        stats.sqliteMs += performance.now() - started;
      }
      for (const db of databases) db.exec('COMMIT');
    } finally {
      try { await pool?.close(); }
      finally {
        try { await Promise.all(pending); }
        finally { for (const db of databases) db.close(); if (pool) stats.geometryBytes = 0; }
      }
    }
  }

  async function renderArchives(targets: readonly ArchiveTarget[]): Promise<void> {
    if (renderingArchives) throw new Error('Renderer already has active archives');
    if (!targets.length || targets.length > Object.keys(LAYERS).length || new Set(targets.map(target => target.path)).size !== targets.length) throw new RangeError('Invalid archive target group');
    options.signal?.throwIfAborted();
    renderingArchives = true;
    let dir: string | undefined;
    try {
      if (!toolChecked) {
        const version = execFileSync(binary, ['version'], { encoding: 'utf8' });
        if (!/\b1\.31\.2\b/.test(version)) throw new Error(`Expected official pmtiles 1.31.2, got ${version.trim()}`);
        toolChecked = true;
      }
      dir = await mkdtemp(join(tmpdir(), 'av-mbtiles-'));
      const paths = targets.map((_, index) => join(dir!, `${index}.mbtiles`));
      await writeMbtiles(paths, targets);
      for (let i = 0; i < targets.length; i++) {
        options.signal?.throwIfAborted();
        const path = targets[i].path;
        await mkdir(dirname(path), { recursive: true });
        let started = performance.now();
        execFileSync(binary, ['convert', '--no-deduplication', paths[i], path], { stdio: 'pipe' });
        stats.convertMs += performance.now() - started;
        started = performance.now();
        execFileSync(binary, ['verify', path], { stdio: 'pipe' });
        stats.verifyMs += performance.now() - started;
      }
    } finally {
      try { if (dir) await rm(dir, { recursive: true, force: true }); }
      finally { renderingArchives = false; }
    }
  }

  return {
    metrics: () => ({ ...stats }),
    renderTile,
    renderTilePixels: renderRgba,
    renderTileRgba: (field: GridField, layer: LayerId, z: number, x: number, y: number) => renderRgba(field, layer, z, x, y).rgba,
    renderArchives,
    renderArchive: (path: string, field: GridField, layer: LayerId) => renderArchives([{ path, field, layer }])
  };
}

export function renderTile(field: GridField, mask: CoverageMask, layer: LayerId, z: number, x: number, y: number): Promise<Buffer> {
  return encodeWebp(renderTileRgba(field, mask, layer, z, x, y), 256, 256);
}
export function renderArchive(path: string, field: GridField, mask: CoverageMask, layer: LayerId): Promise<void> {
  return createRenderer(mask).renderArchive(path, field, layer);
}
