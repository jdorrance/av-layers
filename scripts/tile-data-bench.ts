import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';
import { CELL_BYTES, compilePaletteColor, PALETTES, samplePaletteValueInto, expectedTiles, manifestSchema, MAX_MANIFEST_BYTES, STATUS_MASK, STATUS_VALID, type LayerId } from '@av/contracts';
import { prepareGridSampling, prepareSamplePackLayout, type GridField, type Sample } from '@av/forecast';
import { readGridCoverage } from '../apps/batch/src/coverage.js';
import { readLocalFile } from '../apps/batch/src/local-file.js';
import { createRasterizer, mercatorPoint, RASTER_SAMPLING } from '../apps/batch/src/raster.js';
import { decodeWebp, encodeWebp, WEBP_ENCODER } from '../apps/batch/src/webp.js';

// Native-field pilot: compare a range-preserving two-plane candidate with the
// same quarter-pixel raster inputs before adding a published data-tile format.
const path = process.argv[2], dataEffort = Number(process.argv[3] ?? 4), precisionM = Number(process.argv[4] ?? 25);
if (!path || !Number.isInteger(dataEffort) || dataEffort < 0 || dataEffort > 6 || ![1, 25].includes(precisionM)) throw new Error('Usage: pnpm exec node --import tsx scripts/tile-data-bench.ts MANIFEST [DATA_EFFORT] [PRECISION_METERS:25|1]');
const manifestPath = resolve(path), manifestBytes = await readLocalFile(manifestPath, MAX_MANIFEST_BYTES);
const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
const root = resolve(dirname(manifestPath), '../../..'), mask = await readGridCoverage(root, manifest);
const cells = mask.grid.width * mask.grid.height;
if (cells > 2_000_000 || manifest.samples.bytes > 128 * 1024 ** 2) throw new Error('Pilot exceeds native-field memory budget');
const pack = await readLocalFile(resolve(root, manifest.samples.key), 128 * 1024 ** 2, manifest.samples.bytes);
const packSha256 = createHash('sha256').update(pack).digest('hex');
if (packSha256 !== manifest.samples.sha256) throw new Error('Source sample pack digest mismatch');
const layout = prepareSamplePackLayout(mask.grid, mask.output, mask.halo), stride = manifest.samples.channelCount * CELL_BYTES;
const layers: LayerId[] = ['usable-lift-msl', 'usable-lift-agl'];
if (layers.some(layer => !manifest.layers.includes(layer))) throw new Error('Pilot requires both lift layers');
const zooms = [...new Set([Math.max(0, mask.maxZoom - 2), Math.max(0, mask.maxZoom - 1), mask.maxZoom])];
const tiles = zooms.flatMap(z => {
  const all = expectedTiles(mask, z), count = Math.min(8, all.length);
  return Array.from({ length: count }, (_, i) => all[Math.floor((i + 0.5) * all.length / count)]!);
});
let rasterBytes = 0, dataBytes = 0, rasterEncodeMs = 0, dataEncodeMs = 0, samplingMs = 0, rasterSamplingMs = 0, jobs = 0;
let validPixels = 0, clipped8BitPixels = 0, min = Infinity, max = -Infinity, maxQuantizationErrorM = 0;
const hash = createHash('sha256');
const perFrame = [];
let countZeroWithNonOutsideStatus = 0, noLiftSamples = 0, unavailableSamples = 0, outsideSamples = 0, differentPixels = 0, comparedPixels = 0, maxChannelError = 0, sumChannelError = 0;
const palette = compilePaletteColor(PALETTES.lift, 'linear-rgb');
const decodedColor = new Uint8Array(4);

await encodeWebp(new Uint8Array(256 * 256 * 4));
for (let frame = 0; frame < Math.min(3, manifest.frames.length); frame++) {
  const fields: GridField[] = layers.map(() => ({ values: new Float32Array(cells).fill(NaN), flags: new Uint8Array(cells).fill(3) }));
  for (let slot = 0; slot < layout.blockSlots; slot++) {
    const block = layout.block(slot);
    if (!block) continue;
    for (let y = 0; y < block.height; y++) for (let x = 0; x < block.width; x++) {
      const index = (block.row + y) * mask.grid.width + (block.column + x) % mask.grid.width;
      const rank = block.cellOffset + y * block.width + x;
      for (let layer = 0; layer < layers.length; layer++) {
        const channel = frame * manifest.layers.length + manifest.layers.indexOf(layers[layer]!);
        const offset = rank * stride + channel * CELL_BYTES;
        fields[layer]!.values[index] = pack.readFloatLE(offset);
        fields[layer]!.flags[index] = pack[offset + 4]!;
      }
    }
  }
  const renderer = createRasterizer(mask, undefined, undefined, 'linear-rgb');
  const startRaster = rasterBytes, startData = dataBytes;
  for (const tile of tiles) {
    const rasterImages: Uint8Array[] = [];
    for (let layer = 0; layer < fields.length; layer++) {
      const samplingStart = performance.now(), rgba = renderer.renderTilePixels(fields[layer]!, layers[layer]!, tile.z, tile.x, tile.y).rgba;
      rasterImages.push(rgba);
      rasterSamplingMs += performance.now() - samplingStart;
      const start = performance.now(), encoded = await encodeWebp(rgba);
      rasterEncodeMs += performance.now() - start; rasterBytes += encoded.length;
    }
    const start = performance.now(), lats = new Float64Array(512), lons = new Float64Array(512);
    for (let i = 0; i < 512; i++) {
      lats[i] = mercatorPoint(tile.z, tile.x, tile.y, 0, (i + 0.5) / 2).lat;
      lons[i] = mercatorPoint(tile.z, tile.x, tile.y, (i + 0.5) / 2, 0).lon;
    }
    const plan = prepareGridSampling(mask, lats, lons), samplers = fields.map((field, i) => plan.bind(field, layers[i]!, RASTER_SAMPLING.useStoredMslNoLift));
    const numeric = new Uint8Array(256 * 256 * 4), flags = new Uint8Array(numeric.length), sample: Sample = { value: null, status: 3, support: 0, interpolated: false };
    for (let pixel = 0; pixel < 256 * 256; pixel++) {
      const x = (pixel % 256) * 2, y = Math.floor(pixel / 256) * 2, offset = pixel * 4;
      flags[offset + 3] = 0;
      for (let layer = 0; layer < samplers.length; layer++) {
        let sum = 0, count = 0, support = 0, statusKinds = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          samplers[layer]!(x + dx, y + dy, sample);
          statusKinds |= 1 << sample.status;
          if (sample.status === 1) noLiftSamples++;
          if (sample.status === 2) unavailableSamples++;
          if (sample.status === 3) outsideSamples++;
          support |= sample.support;
          if ((sample.status & STATUS_MASK) === STATUS_VALID && sample.value !== null) { sum += sample.value; count++; }
        }
        if (!count && (statusKinds & 6)) countZeroWithNonOutsideStatus++;
        const value = count ? sum / count : 0;
        // Signed steps retain negative terrain; overflow rejects the candidate.
        const code = Math.round(value / precisionM) + 32768;
        if (code < 0 || code > 65535) throw new Error('Candidate scalar range exceeded');
        numeric[offset + layer * 2] = code & 255; numeric[offset + layer * 2 + 1] = code >> 8;
        flags[offset + layer] = support;
        flags[offset + 3] |= statusKinds << (layer * 4);
        flags[offset + 2] |= count << (layer * 3);
        if (count) {
          validPixels++; min = Math.min(min, value); max = Math.max(max, value);
          if (value < 0 || value > 6375) clipped8BitPixels++;
          maxQuantizationErrorM = Math.max(maxQuantizationErrorM, Math.abs((code - 32768) * precisionM - value));
        }
      }
    }
    samplingMs += performance.now() - start;
    for (let layer = 0; layer < 2; layer++) for (let pixel = 0; pixel < 256 * 256; pixel++) {
      const at = pixel * 4, count = (flags[at + 2]! >> (layer * 3)) & 7;
      decodedColor.fill(0);
      if (count) {
        const code = numeric[at + layer * 2]! | (numeric[at + layer * 2 + 1]! << 8);
        samplePaletteValueInto(palette, (code - 32768) * precisionM, decodedColor);
        decodedColor[3] = Math.round(decodedColor[3]! * count / 4);
      }
      let changed = false;
      for (let c = 0; c < 4; c++) {
        const delta = Math.abs(decodedColor[c]! - rasterImages[layer]![at + c]!);
        if (delta) changed = true;
        sumChannelError += delta; maxChannelError = Math.max(maxChannelError, delta);
      }
      comparedPixels++; if (changed) differentPixels++;
    }
    const encodeStart = performance.now(), encoded = [await encodeWebp(numeric, 256, 256, dataEffort), await encodeWebp(flags, 256, 256, dataEffort)];
    dataEncodeMs += performance.now() - encodeStart;
    for (const [i, bytes] of encoded.entries()) {
      dataBytes += bytes.length; hash.update(bytes);
      const decoded = await decodeWebp(bytes), expected = i ? flags : numeric;
      if (!Buffer.from(decoded.data).equals(expected)) throw new Error('WebP numeric round trip changed bytes');
    }
    jobs++;
  }
  perFrame.push({ frame: manifest.frames[frame]!.id, rasterBytes: rasterBytes - startRaster, dataBytes: dataBytes - startData });
}
console.log(JSON.stringify({ model: manifest.model, buildId: manifest.buildId, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  candidate: 'signed16-status-sets', precisionM, packSha256,
  semanticAudit: { countZeroWithNonOutsideStatus, noLiftSamples, unavailableSamples, outsideSamples, differentPixels, comparedPixels, differentPixelRatio: differentPixels / comparedPixels, maxChannelError, meanChannelError: sumChannelError / (comparedPixels * 4) },
  scope: 'native two-lift-layer pilot; signed16 valid-value means, quarter-pixel status sets, support and valid counts; excludes regional patches, precipitation, archive overhead and browser costs',
  encoder: WEBP_ENCODER, dataEffort, jobs, zooms, perFrame, rasterBytes, dataBytes, storageRatio: dataBytes / rasterBytes,
  rasterEncodeMs, dataEncodeMs, encodeTimeRatio: dataEncodeMs / rasterEncodeMs, samplingMs, rasterSamplingMs,
  rasterTotalMs: rasterSamplingMs + rasterEncodeMs, dataTotalMs: samplingMs + dataEncodeMs,
  totalTimeRatio: (samplingMs + dataEncodeMs) / (rasterSamplingMs + rasterEncodeMs), validPixels, clipped8BitPixels,
  minM: Number.isFinite(min) ? min : null, maxM: Number.isFinite(max) ? max : null, maxQuantizationErrorM,
  decodedBytesPerFrameTile: 2 * 256 * 256 * 4, outputSha256: hash.digest('hex'), peakRssBytes: process.resourceUsage().maxRSS * 1024 }));
