import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PerformanceObserver, type PerformanceEntry } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { coverageIndices, GFS_PRODUCT, type LayerId } from '@av/contracts';
import { packCells, prepareSamplePackLayout, type GridField } from '@av/forecast';
import { deriveColumn, type ColumnInput, type ColumnResult } from '../packages/forecast/src/science.js';
import { createSamplePackBuilder } from '../apps/batch/src/sample-pack.js';
import { loadCoverage } from '../apps/batch/src/validate.js';
import { encodeWebp, decodeWebp } from '../apps/batch/src/webp.js';
import { createRenderer } from '../apps/batch/src/render.js';
import { expectedTiles } from '@av/contracts';

const { values } = parseArgs({ options: { help: { type: 'boolean' }, 'baseline-root': { type: 'string' }, case: { type: 'string' }, variant: { type: 'string' }, output: { type: 'string' } } });
if (values.help) { console.log('Usage: --baseline-root PATH --case pack|levels|encode --variant baseline|candidate --output FILE'); process.exit(0); }
if (!values['baseline-root'] || !values.case || !values.variant || !values.output || !['pack', 'levels', 'encode'].includes(values.case) || !['baseline', 'candidate'].includes(values.variant)) throw new Error('Usage: --baseline-root PATH --case pack|levels|encode --variant baseline|candidate --output FILE');
const baselineRoot = resolve(values['baseline-root']), mask = await loadCoverage(), indices = coverageIndices(mask);
const temporary = await mkdtemp(join(tmpdir(), 'av-foundation-bench-'));
const runs: unknown[] = [], hashes = new Set<string>();
const baselinePack = await import(pathToFileURL(join(baselineRoot, 'apps/batch/src/sample-pack.ts')).href) as { writeSamplePack: (path: string, fields: Uint8Array[], layout: ReturnType<typeof prepareSamplePackLayout>) => Promise<{ sha256: string; bytes: number }> };
const baselineScience = await import(pathToFileURL(join(baselineRoot, 'packages/forecast/src/science.ts')).href) as { deriveColumn: (input: ColumnInput) => ColumnResult };
const layout = prepareSamplePackLayout(mask.grid, mask.output, mask.halo), cellCount = mask.grid.width * mask.grid.height;
const channels = GFS_PRODUCT.frameHours.length * GFS_PRODUCT.layers.length;
const makeField = (channel: number): GridField => {
  const field = { values: new Float32Array(cellCount), flags: new Uint8Array(cellCount).fill(3) };
  for (const i of indices.active) { field.values[i] = channel + (i % 31) / 32; field.flags[i] = 0; }
  return field;
};
const gcEntries: PerformanceEntry[] = [];
const gcObserver = new PerformanceObserver(list => { gcEntries.push(...list.getEntries()); });
gcObserver.observe({ entryTypes: ['gc'] });
try {
  for (let repetition = 0; repetition <= 5; repetition++) {
    const memoryBefore = process.memoryUsage(), started = performance.now(), cpu = process.cpuUsage();
    let outputSha256: string, bytes: number;
    let inputLevelObjects = 0, inputLevelArrays = 0;
    if (values.case === 'pack') {
      const output = join(temporary, `${repetition}.bin`);
      if (values.variant === 'candidate') {
        const builder = createSamplePackBuilder(layout, channels);
        for (let channel = 0; channel < channels; channel++) builder.writeChannel(channel, makeField(channel));
        const result = await builder.finish(output); outputSha256 = result.sha256; bytes = result.bytes;
      } else {
        const fields = Array.from({ length: channels }, (_, channel) => packCells(makeField(channel)));
        const result = await baselinePack.writeSamplePack(output, fields, layout); outputSha256 = result.sha256; bytes = result.bytes;
      }
      await rm(output);
    } else if (values.case === 'levels') {
      const results = new Float64Array(100_000 * 6), scratch = values.variant === 'candidate' ? Array.from({ length: 21 }, () => ({ heightM: 0, temperatureC: 0 })) : undefined;
      if (scratch) { inputLevelObjects = scratch.length; inputLevelArrays = 1; }
      for (let cell = 0; cell < 100_000; cell++) {
        const count = 5 + cell % 17, levels = scratch ?? [];
        if (!scratch) inputLevelArrays++;
        for (let level = 0; level < count; level++) {
          const heightM = 200 + level * 200, temperatureC = 20 - heightM * 0.0105 + (cell % 11) * 0.05;
          if (values.variant === 'candidate') { levels[level].heightM = heightM; levels[level].temperatureC = temperatureC; }
          else { levels.push({ heightM, temperatureC }); inputLevelObjects++; }
        }
        const input: ColumnInput = { terrainM: 0, surfaceTemperatureC: 20, surfacePressureHpa: 1000, humidity: { specificHumidityKgKg: 0.006 }, sensibleHeatFluxWm2: 170 + cell % 200, latentHeatFluxWm2: 100, pblHeightM: 1800, levels };
        const result = values.variant === 'candidate' ? deriveColumn(input, count) : baselineScience.deriveColumn(input);
        results.set([result.msl.value ?? NaN, result.msl.flags, result.agl.value ?? NaN, result.agl.flags, result.depthM ?? NaN, result.thermalVelocityMps ?? NaN], cell * 6);
      }
      outputSha256 = createHash('sha256').update(new Uint8Array(results.buffer)).digest('hex'); bytes = results.byteLength;
    } else {
      const renderer = createRenderer(mask), field = makeField(0), tiles = expectedTiles(mask, mask.maxZoom), hash = createHash('sha256');
      bytes = 0;
      for (let i = 0; i < 16; i++) {
        const tile = tiles[Math.floor(i * tiles.length / 16)], layer: LayerId = 'precip-rate', rgba = renderer.renderTileRgba(field, layer, tile.z, tile.x, tile.y);
        const encoded = await encodeWebp(rgba, 256, 256, values.variant === 'baseline' ? 4 : 1);
        const decoded = await decodeWebp(encoded);
        if (!Buffer.from(rgba).equals(Buffer.from(decoded.data))) throw new Error('Lossless encoder changed RGBA');
        bytes += encoded.length; hash.update(decoded.data);
      }
      outputSha256 = hash.digest('hex');
    }
    hashes.add(outputSha256);
    const finished = performance.now(), cpuMicros = process.cpuUsage(cpu), memoryAfter = process.memoryUsage();
    // GC notifications arrive asynchronously. Flush them outside the timed operation without forcing collection.
    await setImmediate();
    gcEntries.push(...gcObserver.takeRecords());
    const duringOperation = gcEntries.filter(entry => entry.startTime >= started && entry.startTime <= finished);
    const gc = { events: duringOperation.length, observedDurationMs: duringOperation.reduce((sum, entry) => sum + entry.duration, 0) };
    gcEntries.length = 0;
    const run = { repetition, state: repetition ? 'warm-process' : 'cold-process', elapsedMs: finished - started, cpuMicros, peakRssBytes: process.resourceUsage().maxRSS * 1024, memoryBefore, memoryAfter, gc, ...(values.case === 'levels' ? { countedInputAllocations: { levelObjects: inputLevelObjects, levelArrays: inputLevelArrays } } : {}), outputSha256, bytes };
    runs.push(run); console.error(JSON.stringify(run));
  }
  if (hashes.size !== 1) throw new Error('Repeated output changed');
  await writeFile(values.output, JSON.stringify({ kind: values.case, variant: values.variant, node: process.version, cpu: cpus()[0]?.model, activeCells: indices.active.length, storedCells: layout.storedCells, channels, runs, note: 'Cold means first process operation; OS/filesystem caches not purged. Compare variants in separate processes; maxRSS is process high-water, not per-iteration memory. GC counts/durations observe V8 events starting during the measured operation, without forcing GC. Memory snapshots and their deltas are not allocated bytes; explicit input-level object/array counts exclude scientific-kernel and runtime allocations.' }, null, 2));
} finally { gcObserver.disconnect(); await rm(temporary, { recursive: true, force: true }); }
