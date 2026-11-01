import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus } from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { coverageIndices, expectedTiles, GFS_GRID, type LayerId } from '@av/contracts';
import { deriveFrame } from '../apps/batch/src/build.js';
import { createGfsAcquisitionSession } from '../apps/batch/src/noaa/acquire.js';
import { createRenderer } from '../apps/batch/src/render.js';
import { loadCoverage } from '../apps/batch/src/validate.js';
import { createRasterPool, type RasterJob, type RasterMetrics, type RasterPixels } from '../apps/batch/src/raster-pool.js';

const { values } = parseArgs({ options: { help: { type: 'boolean' }, 'cache-dir': { type: 'string' }, output: { type: 'string' }, tiles: { type: 'string', default: '128' } } });
const usage = 'Usage: node --import tsx scripts/benchmark-raster-workers.ts --cache-dir PATH --output FILE [--tiles 128]\nOffline f003, 0/1/2/3 workers, shared immutable fields, tile affinity, total8 pending tiles. Cold +5 warm runs; exact RGBA digest required.';
if (values.help) { console.log(usage); process.exit(0); }
if (!values['cache-dir'] || !values.output) throw new Error(usage);
const tileCount = Number(values.tiles);
if (!Number.isInteger(tileCount) || tileCount < 16 || tileCount > 1024) throw new Error('Expected 16..1024 tiles');
const sourceHash = async () => {
  const hash = createHash('sha256');
  for (const path of ['packages/forecast/src/sampler.ts', 'apps/batch/src/raster.ts', 'apps/batch/src/render.ts', 'apps/batch/src/raster-pool.ts', 'apps/batch/src/raster-worker.ts']) hash.update(await readFile(path));
  return hash.digest('hex');
};
const sourceSha256 = await sourceHash();
const mask = await loadCoverage(), activeIndices = coverageIndices(mask).active;
const acquisition = await createGfsAcquisitionSession({ cycle: '2026-10-30T00:00:00Z', activeIndices, cacheDir: values['cache-dir'], retry: { maxAttempts: 1 }, fetch: async () => { throw new Error('Offline benchmark cache miss'); } });
let fields: ReturnType<typeof deriveFrame>;
try { fields = deriveFrame({ ...await acquisition.acquire(3), grid: GFS_GRID }, mask); }
finally { await acquisition.close(); }
const layers: LayerId[] = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'];
const sharedBytesTotal = layers.reduce((bytes, layer) => bytes + fields[layer].values.byteLength + fields[layer].flags.byteLength, 0) + mask.output.byteLength + mask.halo.byteLength + mask.tiles.byteLength;
const all = expectedTiles(mask, mask.maxZoom), tiles = Array.from({ length: tileCount }, (_, i) => all[Math.floor(i * all.length / tileCount)]);
const jobs: RasterJob[] = tiles.flatMap((tile, tileIndex) => layers.map((_, field) => ({ ...tile, field, id: tileIndex * layers.length + field })));
const geometryCacheBytes = 24 * 1024 * 1024, pendingLimit = 8;
const results: { workers: number; repetition: number; state: string; elapsedMs: number; userCpuMs: number; systemCpuMs: number; rssBytes: number; peakPending: number; outputSha256: string; geometryHits: number; geometryMisses: number; prepareMs: number; rasterMs: number }[] = [];
const startups: { workers: number; elapsedMs: number; rssBefore: number; rssAfter: number }[] = [];
const hashes = new Set<string>();

// Measure the production pool independently of native encoding and archive I/O.
for (const count of [0, 1, 2, 3]) {
  const metrics = new Map<number, RasterMetrics>();
  let pool: Awaited<ReturnType<typeof createRasterPool>> | undefined;
  const renderer = createRenderer(mask, { geometryCacheBytes, rasterWorkers: 0 });
  const startup = performance.now(), rssBefore = process.memoryUsage().rss;
  try {
    if (count) pool = await createRasterPool(mask, layers.map(layer => ({ layer, field: fields[layer] })), { workers: count, geometryCacheBytes, maxPending: pendingLimit, onMetrics(index, result) { metrics.set(index, result); } });
    startups.push({ workers: count, elapsedMs: performance.now() - startup, rssBefore, rssAfter: process.memoryUsage().rss });
    const totals = () => [...metrics.values()].reduce((total, item) => ({ geometryHits: total.geometryHits + item.geometryHits, geometryMisses: total.geometryMisses + item.geometryMisses, prepareMs: total.prepareMs + item.prepareMs, rasterMs: total.rasterMs + item.rasterMs }), { geometryHits: 0, geometryMisses: 0, prepareMs: 0, rasterMs: 0 });
    for (let repetition = 0; repetition <= 5; repetition++) {
      const before = count ? totals() : renderer.metrics(), cpu = process.cpuUsage(), started = performance.now(), hash = createHash('sha256');
      type Result = { rgba: Uint8Array } | { error: Error };
      const pending: Promise<Result>[] = [];
      let next = 0, peakPending = 0;
      const refill = () => {
        while (next < jobs.length && pending.length < pendingLimit) {
          const job = jobs[next++];
          pending.push(new Promise<RasterPixels>(resolve => {
            resolve(pool ? pool.render(Math.floor(job.id / layers.length), job.field, job.z, job.x, job.y) : renderer.renderTilePixels(fields[layers[job.field]], layers[job.field], job.z, job.x, job.y));
          }).catch(error => ({ error: error as Error })));
          peakPending = Math.max(peakPending, pending.length);
        }
      };
      try {
        while (next < jobs.length || pending.length) {
          refill(); const result = await pending.shift()!;
          if ('error' in result) throw result.error;
          hash.update(result.rgba);
        }
      } finally { await Promise.all(pending); }
      const elapsedMs = performance.now() - started, usedCpu = process.cpuUsage(cpu), after = count ? totals() : renderer.metrics();
      const outputSha256 = hash.digest('hex'); hashes.add(outputSha256);
      const result = { workers: count, repetition, state: repetition ? 'warm-process' : 'cold-process', elapsedMs, userCpuMs: usedCpu.user / 1000, systemCpuMs: usedCpu.system / 1000, rssBytes: process.memoryUsage().rss, peakPending, outputSha256, geometryHits: after.geometryHits - before.geometryHits, geometryMisses: after.geometryMisses - before.geometryMisses, prepareMs: after.prepareMs - before.prepareMs, rasterMs: after.rasterMs - before.rasterMs };
      results.push(result); console.error(JSON.stringify(result));
    }
  } finally {
    await pool?.close();
  }
}
if (hashes.size !== 1) throw new Error('Worker raster byte mismatch');
if (sourceSha256 !== await sourceHash()) throw new Error('Renderer source changed during measurement');
const median = (items: number[]) => [...items].sort((a, b) => a - b)[Math.floor(items.length / 2)];
const summaries = [0, 1, 2, 3].map(workers => {
  const warm = results.filter(result => result.workers === workers && result.repetition > 0).map(result => result.elapsedMs);
  return { workers, medianMs: median(warm), minMs: Math.min(...warm), maxMs: Math.max(...warm), startup: startups.find(startup => startup.workers === workers) };
});
await mkdir(dirname(values.output), { recursive: true });
await writeFile(values.output, JSON.stringify({ kind: 'bounded-raster-workers', node: process.version, cpu: cpus()[0]?.model, availableParallelism: availableParallelism(), sourceSha256, exactPixels: true, sharedBytesTotal, geometryCacheBytes, pendingLimit, maximumPendingRgbaBytes: pendingLimit * 256 * 256 * 4, layers, tiles, summaries, runs: results, note: 'Sequential variants, nonexclusive host. Cold means first operation; no OS cache purge. RSS is process-wide with shared acquisition and allocator history. Worker startup including shared input copy is excluded from raster runs and reported separately. Stage evidence only; no full-build resource claim.' }, null, 2));
console.log(JSON.stringify({ summaries, output: values.output }));
