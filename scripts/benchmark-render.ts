import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { coverageIndices, expectedTiles, GFS_GRID, setBit, type LayerId } from '@av/contracts';
import { deriveFrame } from '../apps/batch/src/build.js';
import { createGfsAcquisitionSession } from '../apps/batch/src/noaa/acquire.js';
import { createRenderer } from '../apps/batch/src/render.js';
import { loadCoverage } from '../apps/batch/src/validate.js';
import { openArchive } from '../apps/batch/src/archive-reader.js';
import { decodeWebp } from '../apps/batch/src/webp.js';

const { values } = parseArgs({ options: { help: { type: 'boolean' }, 'baseline-root': { type: 'string' }, 'cache-dir': { type: 'string' }, output: { type: 'string' }, tiles: { type: 'string', default: '16' }, archives: { type: 'boolean', default: false } } });
if (values.help) { console.log('Usage: --baseline-root PATH --cache-dir PATH --output FILE [--tiles 16] [--archives]'); process.exit(0); }
if (!values['baseline-root'] || !values['cache-dir'] || !values.output) throw new Error('Usage: --baseline-root PATH --cache-dir PATH --output FILE [--tiles 16] [--archives]');
const count = Number(values.tiles);
if (!Number.isInteger(count) || count < 1 || count > 128) throw new Error('Expected 1..128 tiles');
const baseline = await import(pathToFileURL(resolve(values['baseline-root'], 'apps/batch/src/render.ts')).href) as { createRenderer: typeof createRenderer };
const mask = await loadCoverage(), activeIndices = coverageIndices(mask).active;
const acquisition = await createGfsAcquisitionSession({ cycle: '2026-10-30T00:00:00Z', activeIndices, cacheDir: values['cache-dir'], retry: { maxAttempts: 1 }, fetch: async () => { throw new Error('Offline benchmark cache miss'); } });
let fields: ReturnType<typeof deriveFrame>;
try { fields = deriveFrame({ ...await acquisition.acquire(3), grid: GFS_GRID }, mask); }
finally { await acquisition.close(); }
const all = expectedTiles(mask, mask.maxZoom), tiles = Array.from({ length: count }, (_, i) => all[Math.floor(i * all.length / count)]);
if (values.archives) {
  tiles.unshift({ z: 0, x: 0, y: 0 });
  mask.tiles = new Uint8Array(mask.tiles.length);
  for (const tile of tiles) setBit(mask.tiles, (4 ** tile.z - 1) / 3 + tile.y * 2 ** tile.z + tile.x);
}
const layers: LayerId[] = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'];
// A deliberately small cache reproduces the production working set exceeding
// the 24 MiB cache; one z7 tile still fits per worker in the shared total budget.
const options = values.archives ? { geometryCacheBytes: 300_000 } : {};
const renderers = { baseline: baseline.createRenderer(mask, options), candidate: createRenderer(mask, options) };
const results: unknown[] = [], hashes = new Set<string>();
const temporary = await mkdtemp(join(tmpdir(), 'av-render-bench-'));
try {
for (let repetition = 0; repetition <= 5; repetition++) for (const name of (repetition % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) as ('baseline' | 'candidate')[]) {
  const renderer = renderers[name], before = renderer.metrics(), started = performance.now(), hash = createHash('sha256');
  const targets = layers.map(layer => ({ layer, field: fields[layer], path: join(temporary, `${name}-${repetition}-${layer}.pmtiles`) }));
  if (values.archives) {
    if (name === 'candidate') await renderer.renderArchives(targets);
    else for (const target of targets) await renderer.renderArchive(target.path, target.field, target.layer);
  } else for (const layer of layers) for (const tile of tiles) hash.update(renderer.renderTileRgba(fields[layer], layer, tile.z, tile.x, tile.y));
  const elapsedMs = performance.now() - started, after = renderer.metrics(), outputSha256 = hash.digest('hex');
  const archiveHash = createHash('sha256');
  if (values.archives) for (const target of targets) {
    const source = await openArchive(target.path);
    try { for (const tile of tiles) { const encoded = await source.reader.getZxy(tile.z, tile.x, tile.y); if (!encoded) throw new Error('Missing archive tile'); archiveHash.update((await decodeWebp(new Uint8Array(encoded.data))).data); } }
    finally { await source.close(); await rm(target.path); }
  }
  const digest = values.archives ? archiveHash.digest('hex') : outputSha256;
  hashes.add(digest);
  results.push({ variant: name, repetition, state: repetition ? 'warm-process' : 'cold-process', elapsedMs, prepareMs: after.prepareMs - before.prepareMs, rasterMs: after.rasterMs - before.rasterMs, encodeWorkMs: after.encodeWorkMs - before.encodeWorkMs, convertMs: after.convertMs - before.convertMs, verifyMs: after.verifyMs - before.verifyMs, geometryMisses: after.geometryMisses - before.geometryMisses, geometryHits: after.geometryHits - before.geometryHits, blankTiles: after.blankTiles - before.blankTiles, peakPendingTiles: after.peakPendingTiles, outputSha256: digest });
  console.error(JSON.stringify(results.at(-1)));
}
if (hashes.size !== 1) throw new Error('Baseline/candidate rendered pixel mismatch');
await writeFile(values.output, JSON.stringify({ kind: values.archives ? 'z7-archive-grouping' : 'z7-renderer-hotpaths', node: process.version, cpu: cpus()[0]?.model, exactPixels: true, frames: [3], layers, tiles, runs: results, note: 'Cold means first process operation; filesystem/OS caches were not purged. Archive mode uses a shared300KB cache to reproduce production eviction; exact decoded RGBA checked outside timings. Non-exclusive host; stage direction only, not a production speed claim.' }, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
