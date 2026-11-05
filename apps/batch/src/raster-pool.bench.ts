import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DEFAULT_MODEL, MAX_MODEL_WORKERS, coverageAtZoom, expectedTiles, getProduct, type LayerId } from '@av/contracts';
import { createRasterizer } from './raster.js';
import { createRasterPool, RASTER_WORKER_RESERVE_BYTES } from './raster-pool.js';
import { loadBundledFineCoverage, wholeDomainPlan } from './whole-domain/coverage.js';

const product = getProduct(process.argv[2] ?? DEFAULT_MODEL);
const count = Number(process.argv[3] ?? product?.execution.workers);
if (!product || !Number.isSafeInteger(count) || count < 0 || count > MAX_MODEL_WORKERS) throw new Error('Usage: node --import tsx apps/batch/src/raster-pool.bench.ts [MODEL] [WORKERS]');
const mask = coverageAtZoom((await loadBundledFineCoverage(product, wholeDomainPlan(product)!)).mask, product.maxNativeZoom);
const active = mask.coverage.offsets[mask.coverage.blockIds.length]!;
const fields = [0, 1].map(layer => {
  const values = new Float32Array(active), flags = new Uint8Array(active);
  for (let i = 0; i < active; i++) { values[i] = 200 + (i % 4000) * (layer ? 0.25 : 1); flags[i] = i % 37 === 0 ? 1 : 0; }
  return { values, flags, coverage: mask.coverage };
});
const layers: LayerId[] = ['usable-lift-msl', 'usable-lift-agl'];
const tiles = [Math.max(0, mask.maxZoom - 2), Math.max(0, mask.maxZoom - 1), mask.maxZoom].flatMap(z => {
  const all = expectedTiles(mask, z), n = Math.min(16, all.length);
  return Array.from({ length: n }, (_, i) => all[Math.floor((i + 0.5) * all.length / n)]!);
});
const hash = createHash('sha256'), startRss = process.memoryUsage.rss(), start = performance.now();
let sharedInputBytes = 0, startupMs = 0;
if (!count) {
  const rasterizer = createRasterizer(mask);
  for (const tile of tiles) for (let f = 0; f < fields.length; f++) hash.update(rasterizer.renderTilePixels(fields[f]!, layers[f]!, tile.z, tile.x, tile.y).rgba);
} else {
  const coverage = mask.coverage;
  const limit = fields.reduce((n, field) => n + field.values.byteLength + field.flags.byteLength, 0) + mask.tiles.byteLength + coverage.blockIds.byteLength + coverage.offsets.byteLength + coverage.output.byteLength + coverage.halo.byteLength;
  const pool = await createRasterPool(mask, fields.map((field, i) => ({ field, layer: layers[i]! })), { workers: count, geometryCacheBytes: 24 * 1024 ** 2, maxPending: 8, maxSharedInputBytes: limit });
  sharedInputBytes = pool.sharedInputBytes;
  startupMs = performance.now() - start;
  try {
    const jobs = tiles.flatMap((tile, index) => fields.map((_, field) => ({ tile, index, field })));
    let next = 0;
    const send = (id: number) => { const { tile, index, field } = jobs[id]!; return pool.render(index, field, tile.z, tile.x, tile.y); };
    const queue: ReturnType<typeof pool.render>[] = [];
    for (let done = 0; done < jobs.length; done++) {
      while (next < jobs.length && queue.length < 8) queue.push(send(next++));
      hash.update((await queue.shift()!).rgba);
    }
  } finally { await pool.close(); }
}
console.log(JSON.stringify({ model: product.modelId, workers: count, active, tiles: tiles.length, jobs: tiles.length * fields.length,
  outputSha256: hash.digest('hex'), fieldBytes: fields.reduce((n, field) => n + field.values.byteLength + field.flags.byteLength, 0), sharedInputBytes,
  workerReserveBytes: count * RASTER_WORKER_RESERVE_BYTES, geometryBudgetBytes: 24 * 1024 ** 2, pendingJobs: 8,
  startRssBytes: startRss, peakRssBytes: process.resourceUsage().maxRSS * 1024, startupMs: Math.round(startupMs), elapsedMs: Math.round(performance.now() - start) }));
