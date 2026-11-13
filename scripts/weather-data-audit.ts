import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { coverageDescriptorSchema, sparseCoverageDescriptorSchema } from '@av/contracts';
import { RETENTION_DAYS, SAMPLE_BLOCK_SIZE } from '@av/contracts/format';
import { prepareGridGeometry, type Grid } from '@av/contracts/geometry';
import { PRODUCTS } from '@av/contracts/models';
import { prepareSamplePackLayout } from '@av/forecast/sample-pack';
import { sampleCells, type SamplePlan } from '@av/forecast/sampler';

// Run from the repository root: pnpm exec node --import tsx scripts/weather-data-audit.ts
const sources: Record<string, string> = {};
async function source(path: string) {
  const bytes = await readFile(path);
  sources[path] = createHash('sha256').update(bytes).digest('hex');
  return bytes;
}
await source('packages/contracts/config/models.json');
const models = [];
for (const product of PRODUCTS) {
  const directory = `packages/contracts/${product.coverageDir}`;
  const descriptor = coverageDescriptorSchema.parse(JSON.parse((await source(`${directory}/manifest.json`)).toString()));
  const layout = prepareSamplePackLayout(descriptor.grid, await source(`${directory}/output.bin`), await source(`${directory}/halo.bin`));
  const frames = product.frameHours.length, levels = product.capabilities.maxVerticalLevels;
  const bytes = layout.storedCells * frames * (7 * levels + 5);
  const dailyBytes = bytes * product.expectedRunsPerDay;
  models.push({ model: product.modelId, frames, levels, storedCells: layout.storedCells, blocks: layout.blockCount,
    bytes, dailyBytes, retainedBytes: dailyBytes * RETENTION_DAYS, runsPerDay: product.expectedRunsPerDay,
    flatIndexBytesAt24BytesPerBlockFrame: layout.blockCount * frames * 24 });
}

const directory = 'packages/contracts/coverage/rrfs-conus-land-v1';
const native = coverageDescriptorSchema.parse(JSON.parse((await source(`${directory}/manifest.json`)).toString())).grid;
const fine = sparseCoverageDescriptorSchema.parse(JSON.parse((await source(`${directory}/fine/manifest.json`)).toString())).grid;
const center = { lat: 38.88, lon: -78.51 }, radians = Math.PI / 180;
const cx = (center.lon + 180) / 360, cy = (1 - Math.asinh(Math.tan(center.lat * radians)) / Math.PI) / 2;

function envelope(grid: Grid, width: number, height: number, zoom: number, blocksAcross = 1) {
  const geometry = prepareGridGeometry(grid), world = 512 * 2 ** zoom;
  const xs: number[] = [], ys: number[] = [];
  function include(dx: number, dy: number) {
    const lon = (cx + dx / world) * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (cy + dy / world)))) / radians;
    const point = geometry.geographicToGrid(lat, lon);
    if (!point) throw new Error('Viewport projection failed');
    xs.push(point.x); ys.push(point.y);
  }
  for (let i = 0; i <= 64; i++) {
    const f = i / 64;
    include(-width / 2 + width * f, -height / 2); include(-width / 2 + width * f, height / 2);
    include(-width / 2, -height / 2 + height * f); include(width / 2, -height / 2 + height * f);
  }
  const size = SAMPLE_BLOCK_SIZE * blocksAcross;
  const left = Math.floor(Math.min(...xs) / size), right = Math.floor(Math.max(...xs) / size);
  const top = Math.floor(Math.min(...ys) / size), bottom = Math.floor(Math.max(...ys) / size);
  assert(left >= 0 && top >= 0 && right * size < grid.width && bottom * size < grid.height);
  return (right - left + 1) * (bottom - top + 1);
}

const viewports = [];
for (const [width, height] of [[1200, 600], [390, 600]]) for (const zoom of [7, 8, 9, 10]) {
  const nativeBlocks = envelope(native, width, height, zoom), fineBlocks = envelope(fine, width, height, zoom);
  const ungroupedRequests = nativeBlocks + 2 * fineBlocks;
  const windBytes = nativeBlocks * 17 ** 2 * (7 * 25 + 5), companionBytes = 2 * fineBlocks * 17 ** 2 * 5;
  // Illustrative fixed spatial grouping: four native storage blocks or 64 fine blocks per HTTP chunk.
  const nativeChunks = envelope(native, width, height, zoom, 2), companionChunks = 2 * envelope(fine, width, height, zoom, 8);
  const groupedRawBytes = nativeChunks * 4 * 17 ** 2 * 180 + companionChunks * 64 * 17 ** 2 * 5;
  viewports.push({ width, height, zoom, nativeBlocks, fineBlocks, ungroupedRequests, windBytes, companionBytes,
    groupedRequests: nativeChunks + companionChunks, groupedRawBytes });
}

const plan: SamplePlan = { contributors: Array.from({ length: 4 }, (_, i) => ({ index: i, row: i >> 1, column: i % 2, weight: .25 })), byteRange: { offset: 0, length: 20 } };
const lift = (flags: number[]) => sampleCells(plan, flags.map(flag => ({ value: flag ? 500 : 2000, flags: flag })), 'usable-lift-msl', true);
const majorityNoLift = lift([0, 1, 1, 1]), halfNoLift = lift([0, 0, 1, 1]);
assert.equal(majorityNoLift.status, 1); assert.equal(majorityNoLift.value, null);
assert.equal(halfNoLift.status, 0); assert.equal(halfNoLift.value, 1250);
const uAt = (height: number) => height <= 1000 ? 0 : (height - 1000) * 20 / 1000;
const nodeInterpolatedMps = (uAt(100 + 600) + uAt(700 + 600)) / 2;
const directlySampledMps = uAt((100 + 700) / 2 + 600);
assert.equal(nodeInterpolatedMps, 3); assert.equal(directlySampledMps, 0);

console.log(JSON.stringify({
  basis: 'b49a3bd configuration; raw arithmetic and existing sampler checks; no network/GPU/compression timing',
  sources, columnBytes: 'storedCells * frames * (7 * levels + 5)', retentionDays: RETENTION_DAYS, models,
  totalDailyBytes: models.reduce((sum, model) => sum + model.dailyBytes, 0),
  totalRetainedBytes: models.reduce((sum, model) => sum + model.retainedBytes, 0),
  viewportMethod: 'Unrotated WebMercator at512px/world zoom, projected perimeter sampled64times per edge; rectangular native-grid envelopes, no coverage-mask pruning or pan margin. Grouping includes whole aligned groups; headers/indexes/overviews excluded.',
  center, viewports,
  counterexamples: { majorityNoLift, halfNoLift, displayField: { nodeInterpolatedMps, directlySampledMps, differenceKmh: (nodeInterpolatedMps - directlySampledMps) * 3.6 } }
}, null, 2));
