import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PMTiles } from 'pmtiles';
import { openArchive, Compression, TileType } from './archive-reader.js';
import { CELL_BYTES, encodeBoundedJson, MAX_MANIFEST_BYTES, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, parseBoundedJson, expectedTiles, getBit, getProduct, getProvenanceReference, GFS_PRODUCT, manifestSchema, parseProvenance, RETENTION_DAYS, validateArtifactRecords, validateSampleCell, validateSampleFlags, type CoverageMask, type LayerId, type Manifest, type ProductDefinition } from '@av/contracts';
import { prepareSamplePackLayout } from '@av/forecast';
import { BUILD_BUDGETS } from './capacity.js';
import { decodeWebp } from './webp.js';
import { describeCoverage } from './coverage.js';
import { readLocalFile } from './local-file.js';

const COVERAGE_DIR = fileURLToPath(new URL('../../../packages/contracts/coverage', import.meta.url));

export const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

const validated = new WeakMap<object, { root: string; hash: string }>();
const manifestHash = (manifest: Manifest): string => sha256(Buffer.from(JSON.stringify(manifest)));

export function wasValidatedInProcess(root: string, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const record = validated.get(raw);
  return !!record && record.root === resolve(root) && record.hash === manifestHash(raw as Manifest);
}

/** Attach post-validation timings without allowing any validated forecast metadata to change. */
export function finalizeValidatedMetrics(root: string, manifest: Manifest, metrics: Manifest['metrics']): Manifest {
  if (!wasValidatedInProcess(root, manifest)) throw new Error('Build validation result is missing or changed');
  const result = manifestSchema.parse({ ...manifest, metrics: structuredClone(metrics) });
  encodeBoundedJson(result, MAX_MANIFEST_BYTES);
  validated.set(result, { root: resolve(root), hash: manifestHash(result) });
  return result;
}

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function localPath(root: string, key: string): string {
  const base = resolve(root), path = resolve(base, key);
  if (!path.startsWith(base + sep)) throw new Error(`Invalid artifact key: ${key}`);
  return path;
}

export async function runConcurrent<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  const iterator = items.values();
  let failed = false, failure: unknown;
  const worker = async (): Promise<void> => {
    for (const item of iterator) {
      if (failed) return;
      try { await fn(item); }
      catch (error) { if (!failed) { failed = true; failure = error; } return; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failed) throw failure;
}

export async function loadCoverage(): Promise<CoverageMask> {
  const [output, halo, tiles] = await Promise.all(['output.bin', 'halo.bin', 'tiles.bin'].map(name => readFile(resolve(COVERAGE_DIR, name))));
  const mask = { grid: GFS_PRODUCT.grid, bounds: GFS_PRODUCT.bounds, output, halo, tiles, maxZoom: GFS_PRODUCT.maxNativeZoom };
  await verifyCoverage(mask);
  return mask;
}

export async function verifyCoverage(mask: CoverageMask): Promise<string> {
  const bytes = await readFile(resolve(COVERAGE_DIR, 'manifest.json'));
  const metadata: unknown = JSON.parse(bytes.toString('utf8'));
  if (!metadata || typeof metadata !== 'object') throw new Error('Invalid coverage manifest');
  const record = metadata as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.id !== GFS_PRODUCT.coverageId || mask.maxZoom !== GFS_PRODUCT.maxNativeZoom || JSON.stringify(mask.grid) !== JSON.stringify(GFS_PRODUCT.grid)) {
    throw new Error('Coverage identity mismatch');
  }
  const expectedTileBytes = Math.ceil(((4 ** (GFS_PRODUCT.maxNativeZoom + 1) - 1) / 3) / 8);
  for (const [name, data, length] of [['output', mask.output, 129780], ['halo', mask.halo, 129780], ['tiles', mask.tiles, expectedTileBytes]] as const) {
    const item = record[name];
    if (!item || typeof item !== 'object' || data.length !== length || (item as Record<string, unknown>).bytes !== length || (item as Record<string, unknown>).sha256 !== sha256(data)) {
      throw new Error(`Coverage ${name} bitset hash mismatch`);
    }
  }
  return describeCoverage(mask, GFS_PRODUCT).hash;
}

/** Bound digest identities; share pending decodes as well as successfully verified content. */
export function createArchiveContentValidator(maxEntries = 1024) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 16_384) throw new RangeError('Invalid archive validation cache size');
  const verified = new Map<string, Promise<void>>();
  return async (bytes: Uint8Array): Promise<void> => {
    if (bytes.byteLength < 25 || bytes.byteLength > 1024 * 1024) throw new Error('Invalid tile byte length');
    const key = sha256(bytes), prior = verified.get(key);
    if (prior) { verified.delete(key); verified.set(key, prior); return prior; }
    const work = (async () => {
      const dims = await decodeWebp(bytes);
      if (dims.width !== 256 || dims.height !== 256) throw new Error('Invalid tile dimensions');
    })();
    verified.set(key, work);
    if (verified.size > maxEntries) verified.delete(verified.keys().next().value!);
    try { await work; }
    catch (error) { if (verified.get(key) === work) verified.delete(key); throw error; }
  };
}

async function verifyArchiveTile(archive: PMTiles, path: string, tile: { z: number; x: number; y: number }, verifyContent: (bytes: Uint8Array) => Promise<void>): Promise<void> {
  const result = await archive.getZxy(tile.z, tile.x, tile.y);
  if (!result || result.data.byteLength < 25) throw new Error(`Missing or invalid active tile ${path} ${tile.z}/${tile.x}/${tile.y}`);
  await verifyContent(new Uint8Array(result.data)).catch(error => {
    const reason = error instanceof Error && error.message === 'Invalid tile dimensions' ? error.message : 'Missing or invalid active tile';
    throw new Error(`${reason} ${path} ${tile.z}/${tile.x}/${tile.y}`);
  });
}

export async function validateArchive(path: string, mask: CoverageMask): Promise<void> {
  const source = await openArchive(path), archive = source.reader;
  try {
    const header = await archive.getHeader();
    if (header.tileType !== TileType.Webp || header.tileCompression !== Compression.None || ![Compression.None, Compression.Gzip].includes(header.internalCompression) || header.minZoom !== 0 || header.maxZoom !== mask.maxZoom) {
      throw new Error(`Unsupported archive ${path}: ${JSON.stringify({ type: header.tileType, tileCompression: header.tileCompression, internalCompression: header.internalCompression, minZoom: header.minZoom, maxZoom: header.maxZoom })}`);
    }
    const tiles = Array.from({ length: mask.maxZoom + 1 }, (_, z) => expectedTiles(mask, z)).flat(), verifyContent = createArchiveContentValidator();
    await runConcurrent(tiles, 8, tile => verifyArchiveTile(archive, path, tile, verifyContent));
  } finally {
    await source.close();
  }
}

/** Validate all packed blocks, including byte-exact equality of duplicated halo/wrap cells. */
export async function validateSamplePack(path: string, manifest: Manifest, mask: CoverageMask): Promise<void> {
  const layout = prepareSamplePackLayout(mask.grid, mask.output, mask.halo, manifest.samples.blockSize);
  const { samples } = manifest, channels = manifest.frames.length * manifest.layers.length, stride = channels * CELL_BYTES;
  if (samples.channelCount !== channels || samples.storedCells !== layout.storedCells || samples.bytes !== layout.storedCells * stride || samples.bytes > BUILD_BUDGETS.samplePackBytes) {
    throw new Error('Invalid sample pack layout');
  }
  const pack = await readLocalFile(path, BUILD_BUDGETS.samplePackBytes, samples.bytes);
  if (pack.byteLength !== samples.bytes) throw new Error(`Invalid samples ${samples.key}`);
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const specs = Array.from({ length: channels }, (_, i) => manifest.descriptors.layers[manifest.layers[i % manifest.layers.length]]);
  const firstOffset = new Int32Array(layout.cellCount).fill(-1);
  for (let slot = 0; slot < layout.blockSlots; slot++) {
    const block = layout.block(slot);
    if (!block) continue;
    const total = block.width * block.height;
    for (let i = 0; i < total; i++) {
      const x = i % block.width, y = (i - x) / block.width;
      const index = (block.row + y) * mask.grid.width + ((block.column + x) % mask.grid.width);
      const active = getBit(mask.output, index) || getBit(mask.halo, index), offset = (block.cellOffset + i) * stride;
      for (let channel = 0; channel < channels; channel++) {
        validateSampleCell(view, offset + channel * CELL_BYTES, specs[channel], samples.key, active);
      }
      const prior = firstOffset[index];
      if (prior < 0) firstOffset[index] = offset;
      else if (!pack.subarray(offset, offset + stride).equals(pack.subarray(prior, prior + stride))) {
        throw new Error(`Duplicate sample cell differs: ${samples.key} cell ${index}`);
      }
    }
  }
  if (sha256(pack) !== samples.sha256) throw new Error(`Invalid samples hash ${samples.key}`);
}

export function validateSamples(samples: Buffer, mask: CoverageMask, layer: LayerId, key: string): void {
  validateSampleFlags(samples, mask.grid.width * mask.grid.height * CELL_BYTES, layer, mask, key);
}

export async function validateBuild(root: string, raw: unknown, mask: CoverageMask, expectedCoverageHash?: string, trustedProduct?: ProductDefinition): Promise<Manifest> {
  const manifest = manifestSchema.parse(raw);
  encodeBoundedJson(manifest, MAX_MANIFEST_BYTES);
  const product = trustedProduct ?? getProduct(manifest.model);
  if (!product || JSON.stringify(manifest.grid) !== JSON.stringify(product.grid) || manifest.coverage.maxZoom !== product.maxNativeZoom) {
    throw new Error('Unsupported model, grid or zoom');
  }
  const admittedHash = expectedCoverageHash ?? await verifyCoverage(mask);
  if (manifest.coverage.id !== product.coverageId || manifest.coverage.hash !== admittedHash || describeCoverage(mask, product).hash !== admittedHash) {
    throw new Error('Coverage identity mismatch');
  }
  if (manifest.coverage.maskKey !== `coverage/${manifest.coverage.hash}/manifest.json` || JSON.stringify(mask.grid) !== JSON.stringify(manifest.grid) || JSON.stringify(manifest.descriptors.bounds) !== JSON.stringify(mask.bounds ?? product.bounds)) throw new Error('Coverage descriptor binding mismatch');
  const cycle = Date.parse(manifest.cycle), created = Date.parse(manifest.createdAt), expiry = Date.parse(manifest.expiresAt);
  if (!(created < expiry) || expiry > created + RETENTION_DAYS * 86400000 || !Number.isFinite(cycle)) throw new Error('Invalid build timestamps');
  const frames = product.frameHours.map(hour => `f${String(hour).padStart(3, '0')}`);
  if (manifest.frames.length !== frames.length || manifest.layers.length !== product.layers.length || product.layers.some((layer, i) => manifest.layers[i] !== layer)) {
    throw new Error('Incomplete frame or layer set');
  }
  for (let i = 0; i < frames.length; i++) {
    const frame = manifest.frames[i];
    const hour = product.frameHours[i], end = cycle + hour * 3600000;
    if (frame.id !== frames[i] || Date.parse(frame.intervalStart) !== end - product.intervalHours * 3600000 || Date.parse(frame.intervalEnd) !== end || Date.parse(frame.validTime) !== end) {
      throw new Error(`Invalid frame interval ${frame.id}`);
    }
  }
  validateArtifactRecords(manifest);
  const provenance = getProvenanceReference(manifest);
  const provenanceBytes = await readLocalFile(localPath(root, provenance.key), MAX_PROVENANCE_BYTES);
  if (sha256(provenanceBytes) !== provenance.sha256) throw new Error(`Invalid provenance hash ${provenance.key}`);
  parseProvenance(parseBoundedJson(provenanceBytes, MAX_PROVENANCE_JSON_TOKENS), manifest);
  await validateSamplePack(localPath(root, manifest.samples.key), manifest, mask);
  for (const artifact of manifest.artifacts) {
    if (await fileSha256(localPath(root, artifact.tilesKey)) !== artifact.tilesSha256) throw new Error(`Invalid archive hash ${artifact.tilesKey}`);
    await validateArchive(localPath(root, artifact.tilesKey), mask);
  }
  validated.set(manifest, { root: resolve(root), hash: manifestHash(manifest) });
  return manifest;
}
