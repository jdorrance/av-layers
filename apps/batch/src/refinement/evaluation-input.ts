import { open, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import z from 'zod';
import {
  getProvenanceReference,
  MAX_PROVENANCE_BYTES,
  MAX_PROVENANCE_JSON_TOKENS,
  MAX_MANIFEST_BYTES,
  manifestSchema,
  parseBoundedJson,
  parseProvenance,
  matchesFrameIntervals,
  STATUS_MASK,
  STATUS_OUTSIDE,
  STATUS_VALID,
  SUPPORT_MASK,
  validateArtifactRecords,
  validateSampleCell,
  LAYERS,
  CELL_BYTES,
  type CoverageMask,
  type LayerId,
  type Manifest,
  type RefinementPatch
} from '@av/contracts';
import { prepareSamplePackLayout, type GridField, type SamplePackLayout } from '@av/forecast';
import { fileSha256, localPath } from '../validate.js';
import { readLocalFile } from '../local-file.js';
import { readGridCoverage } from '../coverage.js';
import { loadPreparedTerrain } from '../terrain/staging.js';
import {
  PREPARED_DESCRIPTOR_MAX_BYTES,
  PREPARED_TERRAIN_CELL_BYTES,
  preparedTerrainRefSchema,
  type PreparedTerrain,
  type PreparedTerrainRef
} from '../terrain/prepare.js';
import { sha256 } from '../terrain/contract.js';

export interface EvaluationControl {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly outputRoot: string;
  readonly buildDir: string;
  readonly manifest: Manifest;
  readonly patch: RefinementPatch;
  readonly sourceMask: CoverageMask;
  readonly targetMask: CoverageMask;
  readonly terrain: PreparedTerrain;
  readonly terrainRef: PreparedTerrainRef;
  readonly provenance: z.infer<typeof provenanceSchema>;
}

const provenanceSchema = z.object({
  version: z.literal(1),
  model: z.string(),
  buildId: z.string(),
  cycle: z.string(),
  provider: z.string().optional(),
  temporalApproximation: z.string().optional(),
  frames: z.array(z.object({ hour: z.number().int().min(1), intervals: z.unknown(), receipt: z.unknown() }))
});

export interface SourceFrameEvidence {
  readonly frameId: string;
  readonly hour: number;
  readonly intervals: unknown;
  readonly receipt: unknown;
}

export function evaluationPath(root: string, key: string): string {
  return localPath(root, key);
}

async function verifyLocalFile(path: string, expectedBytes: number, maxBytes: number): Promise<void> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || info.size > maxBytes) throw new RangeError(`Local evaluation file exceeds byte budget: ${path}`);
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size !== expectedBytes) {
      throw new Error(`Local evaluation file differs from its declared size: ${path}`);
    }
  } finally {
    await file.close();
  }
}

export const MAX_EVALUATION_FILE_BYTES = 512 * 1024 ** 2;
const MAX_EVALUATION_DECODED_BYTES = 512 * 1024 ** 2;
const MAX_EVALUATION_TOTAL_BYTES = 8 * 1024 ** 3;

async function verifyHash(path: string, expectedBytes: number, expectedSha256: string): Promise<void> {
  await verifyLocalFile(path, expectedBytes, MAX_EVALUATION_FILE_BYTES);
  if (await fileSha256(path, expectedBytes) !== expectedSha256) throw new Error(`Local evaluation file hash mismatch: ${path}`);
}

function controlRoot(manifestPath: string, manifest: Manifest): { outputRoot: string; buildDir: string } {
  const buildDir = dirname(resolve(manifestPath));
  if (basename(buildDir) !== manifest.buildId || basename(dirname(buildDir)) !== manifest.model
      || basename(dirname(dirname(buildDir))) !== 'builds') {
    throw new Error('Control manifest path does not match its build identity');
  }
  return { buildDir, outputRoot: resolve(buildDir, '../../..') };
}

function selectPatch(manifest: Manifest, patchId?: string): RefinementPatch {
  const patches = manifest.patches ?? [];
  const patch = patchId ? patches.find(candidate => candidate.id === patchId) : patches.length === 1 ? patches[0] : undefined;
  if (!patch) throw new Error('Control manifest requires exactly one refinement patch or an explicit patch id');
  return patch;
}

export async function loadEvaluationInput(options: { manifestPath: string; patchId?: string; signal?: AbortSignal }): Promise<EvaluationControl> {
  options.signal?.throwIfAborted();
  const manifestPath = resolve(options.manifestPath);
  const manifestBytes = await readLocalFile(manifestPath, MAX_MANIFEST_BYTES);
  const rawManifest = parseBoundedJson(manifestBytes);
  if (typeof rawManifest === 'object' && rawManifest !== null && 'version' in rawManifest && rawManifest.version === 5) {
    throw new Error('Control manifest must be a v4 regional-patch build; whole-domain v5 manifests do not carry a legacy terrain-clearance patch');
  }
  const manifest = manifestSchema.parse(rawManifest);
  validateArtifactRecords(manifest);
  for (const frame of manifest.frames) {
    if (frame.id === '.' || frame.id === '..' || frame.id.includes('/') || frame.id.includes('\\')) throw new Error(`Invalid frame ID ${frame.id}`);
    evaluationPath('frames', frame.id);
  }
  const { outputRoot, buildDir } = controlRoot(manifestPath, manifest);
  const patch = selectPatch(manifest, options.patchId);

  const provenanceRef = getProvenanceReference(manifest);
  const provenanceBytes = await readLocalFile(evaluationPath(outputRoot, provenanceRef.key), MAX_PROVENANCE_BYTES);
  if (sha256(provenanceBytes) !== provenanceRef.sha256) throw new Error('Control provenance hash mismatch');
  const provenance = provenanceSchema.parse(parseProvenance(
    parseBoundedJson(provenanceBytes, MAX_PROVENANCE_JSON_TOKENS), manifest));

  let admittedBytes = manifest.samples.bytes + patch.samples.bytes;
  if (!Number.isSafeInteger(admittedBytes) || admittedBytes > MAX_EVALUATION_TOTAL_BYTES) throw new RangeError('Evaluation input byte budget exceeded');
  await verifyHash(evaluationPath(outputRoot, manifest.samples.key), manifest.samples.bytes, manifest.samples.sha256);
  await verifyHash(evaluationPath(outputRoot, patch.samples.key), patch.samples.bytes, patch.samples.sha256);
  for (const artifact of manifest.artifacts) {
    options.signal?.throwIfAborted();
    const path = evaluationPath(outputRoot, artifact.tilesKey), size = (await stat(path)).size;
    admittedBytes += size;
    if (!Number.isSafeInteger(admittedBytes) || admittedBytes > MAX_EVALUATION_TOTAL_BYTES) throw new RangeError('Evaluation input byte budget exceeded');
    await verifyHash(path, size, artifact.tilesSha256);
  }

  const sourceMask = await readGridCoverage(outputRoot, {
    grid: manifest.grid, coverage: manifest.coverage, descriptors: { bounds: manifest.descriptors.bounds }
  });
  const targetMask = await readGridCoverage(outputRoot, {
    grid: patch.grid, coverage: patch.coverage, descriptors: { bounds: patch.descriptors.bounds }
  });

  const terrainDescriptor = await readLocalFile(evaluationPath(outputRoot, patch.terrain.key), PREPARED_DESCRIPTOR_MAX_BYTES);
  if (sha256(terrainDescriptor) !== patch.terrain.sha256) throw new Error('Prepared terrain descriptor hash mismatch');
  const terrainRef = preparedTerrainRefSchema.parse({
    key: patch.terrain.key,
    sha256: patch.terrain.sha256,
    bytes: terrainDescriptor.byteLength,
    arrayBytes: patch.grid.width * patch.grid.height * PREPARED_TERRAIN_CELL_BYTES
  });
  const terrain = await loadPreparedTerrain({ ref: terrainRef, out: outputRoot, grid: patch.grid, signal: options.signal });
  if (terrain.descriptor.dataId !== patch.terrain.dataId
      || terrain.descriptor.source.verticalDatum !== patch.terrain.verticalDatum
      || terrain.descriptor.source.surface !== patch.terrain.surface) {
    throw new Error('Prepared terrain source identity mismatch');
  }
  return { manifestPath, manifestSha256: sha256(manifestBytes), outputRoot, buildDir, manifest, patch, sourceMask, targetMask, terrain, terrainRef, provenance };
}

export function frameHour(manifest: Pick<Manifest, 'cycle'>, frame: Manifest['frames'][number]): number {
  const hours = (Date.parse(frame.validTime) - Date.parse(manifest.cycle)) / 3_600_000;
  if (!Number.isSafeInteger(hours) || hours < 1) throw new Error(`Frame ${frame.id} does not map to a positive integer cycle hour`);
  return hours;
}

export function selectSourceFrames(control: EvaluationControl, frameIds: readonly string[]): SourceFrameEvidence[] {
  if (!frameIds.length || new Set(frameIds).size !== frameIds.length) throw new Error('Select distinct evaluation frames');
  const requiresPrecipitation = control.manifest.layers.includes('precip-rate');
  return frameIds.map(frameId => {
    const frame = control.manifest.frames.find(candidate => candidate.id === frameId);
    if (!frame) throw new Error(`Unknown control frame ${frameId}`);
    const hour = frameHour(control.manifest, frame);
    const matches = control.provenance.frames.filter(entry => entry.hour === hour);
    if (matches.length !== 1) throw new Error(`Control provenance has ${matches.length} entries for hour ${hour}`);
    const entry = matches[0]!;
    if (!matchesFrameIntervals(entry.intervals, frame, requiresPrecipitation)) {
      throw new Error(`Control provenance interval mismatch for ${frameId}`);
    }
    return { frameId, hour, intervals: entry.intervals, receipt: entry.receipt };
  });
}

export function normalizeSourceEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSourceEvidence);
  if (!value || typeof value !== 'object') return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'cacheHit' || key === 'capturedAt') continue;
    normalized[key] = normalizeSourceEvidence(item);
  }
  return normalized;
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedValue((value as Record<string, unknown>)[key])]));
}

export function sameSourceEvidence(expected: Pick<SourceFrameEvidence, 'intervals' | 'receipt'>, actual: { intervals: unknown; receipt: unknown }): boolean {
  return JSON.stringify(sortedValue(normalizeSourceEvidence({ intervals: expected.intervals, receipt: expected.receipt })))
    === JSON.stringify(sortedValue(normalizeSourceEvidence({ intervals: actual.intervals, receipt: actual.receipt })));
}

export interface DecodedSamplePack {
  readonly frameIds: readonly string[];
  readonly layers: readonly LayerId[];
  readonly fields: Readonly<Record<string, Readonly<Record<string, GridField>>>>;
}

function sampleLayout(mask: CoverageMask): SamplePackLayout {
  return prepareSamplePackLayout(mask.grid, mask.output, mask.halo);
}

export function decodeSamplePack(
  bytes: Uint8Array,
  mask: CoverageMask,
  frameIds: readonly string[],
  layers: readonly LayerId[],
  channelCount: number
): DecodedSamplePack {
  const decodedBytes = mask.grid.width * mask.grid.height * channelCount * CELL_BYTES;
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes < 0 || decodedBytes > MAX_EVALUATION_DECODED_BYTES) throw new RangeError('Decoded evaluation byte budget exceeded');
  const layout = sampleLayout(mask), expectedChannels = frameIds.length * layers.length;
  if (!frameIds.length || !layers.length || new Set(frameIds).size !== frameIds.length
      || new Set(layers).size !== layers.length || channelCount !== expectedChannels) {
    throw new Error('Sample pack frame, layer or channel identity mismatch');
  }
  const stride = channelCount * CELL_BYTES, expectedBytes = layout.storedCells * stride;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || bytes.byteLength !== expectedBytes) {
    throw new Error('Sample pack byte length differs from its layout');
  }
  const fields: Record<string, Record<string, GridField>> = {};
  for (const frameId of frameIds) {
    fields[frameId] = {};
    for (const layer of layers) {
      fields[frameId]![layer] = {
        values: new Float32Array(layout.cellCount).fill(Number.NaN),
        flags: new Uint8Array(layout.cellCount).fill(STATUS_OUTSIDE)
      };
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let frameIndex = 0; frameIndex < frameIds.length; frameIndex++) {
    for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
      const channel = frameIndex * layers.length + layerIndex;
      const field = fields[frameIds[frameIndex]!]![layers[layerIndex]!]!;
      for (let slot = 0; slot < layout.blockSlots; slot++) {
        const block = layout.block(slot);
        if (!block) continue;
        for (let y = 0; y < block.height; y++) {
          for (let x = 0; x < block.width; x++) {
            const column = mask.grid.wrapLongitude ? (block.column + x) % mask.grid.width : block.column + x;
            const index = (block.row + y) * mask.grid.width + column;
            const offset = (block.cellOffset + y * block.width + x) * stride + channel * CELL_BYTES;
            validateSampleCell(view, offset, LAYERS[layers[layerIndex]!], `samples/${frameIds[frameIndex]}/${layers[layerIndex]}`);
            field.values[index] = view.getFloat32(offset, true);
            field.flags[index] = view.getUint8(offset + 4);
          }
        }
      }
    }
  }
  return { frameIds, layers, fields };
}

export function linearPercentile(sortedValues: readonly number[], probability: number): number | null {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new RangeError('Invalid percentile probability');
  if (!sortedValues.length) return null;
  for (let index = 0; index < sortedValues.length; index++) {
    if (!Number.isFinite(sortedValues[index]) || (index > 0 && sortedValues[index]! < sortedValues[index - 1]!)) {
      throw new RangeError('Percentile input must be finite and sorted');
    }
  }
  const position = (sortedValues.length - 1) * probability, lower = Math.floor(position), upper = Math.ceil(position);
  const low = sortedValues[lower]!;
  return lower === upper ? low : low + (sortedValues[upper]! - low) * (position - lower);
}

export interface TransitionCount {
  readonly from: number;
  readonly to: number;
  readonly count: number;
}

export interface PairedFieldSummary {
  readonly totalCells: number;
  readonly commonValidCells: number;
  readonly leftValidOnly: number;
  readonly rightValidOnly: number;
  readonly neitherValid: number;
  readonly medianAbsoluteDifference: number | null;
  readonly p95AbsoluteDifference: number | null;
  readonly maximumAbsoluteDifference: number | null;
  readonly statusTransitions: readonly TransitionCount[];
  readonly supportTransitions: readonly TransitionCount[];
}

export function transitionCounts(left: GridField, right: GridField, mask: number, indices?: Iterable<number>): TransitionCount[] {
  const counts = new Map<string, TransitionCount>();
  const visit = (index: number) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= left.flags.length) throw new RangeError('Transition index exceeds field coverage');
    const from = left.flags[index]! & mask, to = right.flags[index]! & mask, key = `${from}:${to}`;
    const current = counts.get(key);
    counts.set(key, { from, to, count: (current?.count ?? 0) + 1 });
  };
  if (indices) for (const index of indices) visit(index);
  else for (let index = 0; index < left.flags.length; index++) visit(index);
  return [...counts.values()].sort((a, b) => a.from - b.from || a.to - b.to);
}

export function summarizePairedFields(left: GridField, right: GridField): PairedFieldSummary {
  if (!(left.values instanceof Float32Array) || !(left.flags instanceof Uint8Array)
      || !(right.values instanceof Float32Array) || !(right.flags instanceof Uint8Array)
      || left.values.length !== left.flags.length || right.values.length !== right.flags.length
      || left.values.length !== right.values.length) {
    throw new Error('Paired field arrays differ in type, length or coverage');
  }
  const differences: number[] = [];
  let leftValidOnly = 0, rightValidOnly = 0, neitherValid = 0;
  for (let index = 0; index < left.flags.length; index++) {
    const leftValid = (left.flags[index]! & STATUS_MASK) === STATUS_VALID && Number.isFinite(left.values[index]);
    const rightValid = (right.flags[index]! & STATUS_MASK) === STATUS_VALID && Number.isFinite(right.values[index]);
    if (leftValid && rightValid) differences.push(Math.abs(left.values[index]! - right.values[index]!));
    else if (leftValid) leftValidOnly++;
    else if (rightValid) rightValidOnly++;
    else neitherValid++;
  }
  differences.sort((a, b) => a - b);
  return {
    totalCells: left.flags.length,
    commonValidCells: differences.length,
    leftValidOnly,
    rightValidOnly,
    neitherValid,
    medianAbsoluteDifference: linearPercentile(differences, 0.5),
    p95AbsoluteDifference: linearPercentile(differences, 0.95),
    maximumAbsoluteDifference: differences.length ? differences[differences.length - 1]! : null,
    statusTransitions: transitionCounts(left, right, STATUS_MASK),
    supportTransitions: transitionCounts(left, right, SUPPORT_MASK)
  };
}
