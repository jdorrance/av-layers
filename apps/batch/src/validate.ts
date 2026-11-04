import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { PMTiles } from 'pmtiles';
import { openArchive, Compression, TileType } from './archive-reader.js';
import { CELL_BYTES, SAMPLE_BLOCK_SIZE, RASTER_TILE_SIZE, MAX_TILE_BYTES, encodeBoundedJson, MAX_MANIFEST_BYTES, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, parseBoundedJson, expectedTiles, getBit, getProduct, getProvenanceReference, sameGrid, publishedManifestSchema, parseProvenance, RETENTION_DAYS, validateArtifactRecords, validateSampleCell, validateSampleFlags, assertSampleLayoutBindingV5, sparseCoverageLookup, createWholeDomainDescriptors, TERRAIN_CLEARANCE_METHOD, TERRAIN_COLUMN_METHODS_BY_VERTICAL_COORDINATE, type CoverageMask, type LayerId, type Manifest, type ManifestV5, type PublishedManifest, type ProductDefinition } from '@av/contracts';
import { prepareSamplePackLayout, prepareShardedSamplePackLayout, resolveProductFrameHours, type ShardedSampleBlock } from '@av/forecast';
import { BUILD_BUDGETS } from './capacity.js';
import { decodeWebp } from './webp.js';
import { describeCoverage, describeSparseCoverage, loadCoverage, readGridCoverage, readSparseCoverage } from './coverage.js';
import { forecastGrids, type ForecastGrid } from '@av/contracts';
import { validateRefinementCoverage } from './refinement/coverage.js';
import { readLocalFile } from './local-file.js';
import { loadBundledFineCoverage, nativeSparseMask, wholeDomainPlan } from './whole-domain/coverage.js';
import { validateSparsePreparedTerrain } from './terrain/sparse.js';

export const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** An in-process validation result, never a serialized trust token. Upload still rechecks each file. */
const validationSeal = Symbol('ValidatedBuild');
export interface ValidatedBuild<T extends PublishedManifest = PublishedManifest> { readonly [validationSeal]: true; readonly root: string; readonly manifest: T; readonly hash: string }
const seals = new WeakSet<object>();
const manifestHash = (manifest: PublishedManifest): string => sha256(Buffer.from(JSON.stringify(manifest)));
function validatedResult<T extends PublishedManifest>(root: string, manifest: T): ValidatedBuild<T> {
  const result = { [validationSeal]: true as const, root: resolve(root), manifest, hash: manifestHash(manifest) };
  Object.defineProperty(result, validationSeal, { enumerable: false });
  seals.add(result);
  return Object.freeze(result);
}

export function assertValidatedBuild(root: string, manifest: PublishedManifest, result: ValidatedBuild): void {
  if (!seals.has(result) || result[validationSeal] !== true || result.root !== resolve(root) || result.hash !== manifestHash(result.manifest) || result.hash !== manifestHash(manifest)) throw new Error('Build validation result is missing or changed');
}

export function assertTerrainManifestBinding(manifest: ManifestV5, terrain: NonNullable<ManifestV5['surfaces'][number]['terrain']>, descriptor: Awaited<ReturnType<typeof validateSparsePreparedTerrain>>['descriptor'], arrayBytes: number, product: ProductDefinition): void {
  const source = manifest.source.terrain;
  if (descriptor.dataId !== terrain.dataId || descriptor.source.verticalDatum !== terrain.verticalDatum || descriptor.source.surface !== terrain.surface
      || !source || typeof source !== 'object' || !('dataId' in source) || source.dataId !== terrain.dataId || !('key' in source) || source.key !== terrain.key
      || !('sha256' in source) || source.sha256 !== terrain.sha256 || !('arrayBytes' in source) || source.arrayBytes !== arrayBytes
      || manifest.tool.terrainMethod !== TERRAIN_COLUMN_METHODS_BY_VERTICAL_COORDINATE[product.capabilities.verticalCoordinate].id
      || manifest.tool.terrainClearance !== TERRAIN_CLEARANCE_METHOD.id) throw new Error('Terrain source or method mismatch');
}

/** Attach timings after validation while preserving the validated forecast metadata. */
export function finalizeValidatedMetrics(root: string, result: ValidatedBuild<Manifest>, metrics: Manifest['metrics']): ValidatedBuild<Manifest>;
export function finalizeValidatedMetrics(root: string, result: ValidatedBuild<ManifestV5>, metrics: Manifest['metrics']): ValidatedBuild<ManifestV5>;
export function finalizeValidatedMetrics(root: string, result: ValidatedBuild, metrics: Manifest['metrics']): ValidatedBuild;
export function finalizeValidatedMetrics(root: string, result: ValidatedBuild, metrics: Manifest['metrics']): ValidatedBuild {
  assertValidatedBuild(root, result.manifest, result);
  const manifest = publishedManifestSchema.parse({ ...result.manifest, metrics: structuredClone(metrics) });
  encodeBoundedJson(manifest, MAX_MANIFEST_BYTES);
  return validatedResult(root, manifest);
}

export async function fileSha256(path: string, maxBytes = Number.POSITIVE_INFINITY): Promise<string> {
  if (maxBytes !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) throw new RangeError('Invalid file hash budget');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path, Number.isFinite(maxBytes) ? { end: maxBytes } : undefined)) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new RangeError(`File hash byte budget exceeded: ${path}`);
    hash.update(chunk);
  }
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

/** Bound digest identities; share pending decodes as well as successfully verified content. */
export function createArchiveContentValidator(maxEntries = 1024) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 16_384) throw new RangeError('Invalid archive validation cache size');
  const verified = new Map<string, Promise<void>>();
  return async (bytes: Uint8Array): Promise<void> => {
    if (bytes.byteLength < 25 || bytes.byteLength > MAX_TILE_BYTES) throw new Error('Invalid tile byte length');
    const key = sha256(bytes), prior = verified.get(key);
    if (prior) { verified.delete(key); verified.set(key, prior); return prior; }
    const work = (async () => {
      const dims = await decodeWebp(bytes);
      if (dims.width !== RASTER_TILE_SIZE || dims.height !== RASTER_TILE_SIZE) throw new Error('Invalid tile dimensions');
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

export async function validateArchive(path: string, mask: Pick<CoverageMask, 'tiles' | 'maxZoom'>): Promise<void> {
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
export async function validateSamplePack(path: string, manifest: Pick<Manifest, 'frames'> & ForecastGrid, mask: CoverageMask): Promise<void> {
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

export async function validateBuild(root: string, raw: ManifestV5, mask: CoverageMask, expectedCoverageHash?: string, trustedProduct?: ProductDefinition): Promise<ValidatedBuild<ManifestV5>>;
export async function validateBuild(root: string, raw: Manifest, mask: CoverageMask, expectedCoverageHash?: string, trustedProduct?: ProductDefinition): Promise<ValidatedBuild<Manifest>>;
export async function validateBuild(root: string, raw: unknown, mask: CoverageMask, expectedCoverageHash?: string, trustedProduct?: ProductDefinition): Promise<ValidatedBuild>;
export async function validateBuild(root: string, raw: unknown, mask: CoverageMask, expectedCoverageHash?: string, trustedProduct?: ProductDefinition): Promise<ValidatedBuild> {
  const manifest = publishedManifestSchema.parse(raw);
  encodeBoundedJson(manifest, MAX_MANIFEST_BYTES);
  if (manifest.version === 5) return validateBuildV5(root, manifest, mask, trustedProduct);
  const product = trustedProduct ?? getProduct(manifest.model);
  if (!product || manifest.model !== product.modelId || manifest.recipe.id !== product.id || (Object.keys(product.source) as (keyof ProductDefinition['source'])[]).some(key => manifest.recipe.source[key] !== product.source[key]) || !sameGrid(manifest.grid, product.grid) || manifest.coverage.maxZoom !== product.maxNativeZoom) {
    throw new Error('Unsupported model, grid or zoom');
  }
  const admittedHash = expectedCoverageHash ?? describeCoverage(await loadCoverage(product), product).hash;
  if (manifest.coverage.id !== product.coverageId || manifest.coverage.hash !== admittedHash || describeCoverage(mask, product).hash !== admittedHash) {
    throw new Error('Coverage identity mismatch');
  }
  if (manifest.coverage.maskKey !== `coverage/${manifest.coverage.hash}/manifest.json` || !sameGrid(mask.grid, manifest.grid) || JSON.stringify(manifest.descriptors.bounds) !== JSON.stringify(mask.bounds ?? product.bounds)) throw new Error('Coverage descriptor binding mismatch');
  const cycle = Date.parse(manifest.cycle), created = Date.parse(manifest.createdAt), expiry = Date.parse(manifest.expiresAt);
  if (!(created < expiry) || expiry > created + RETENTION_DAYS * 86400000 || !Number.isFinite(cycle)) throw new Error('Invalid build timestamps');
  const expectedHours = resolveProductFrameHours(product, mask, manifest.cycle);
  const frames = expectedHours.map(hour => `f${String(hour).padStart(3, '0')}`);
  if (manifest.frames.length !== frames.length || manifest.layers.length !== product.layers.length || product.layers.some((layer, i) => manifest.layers[i] !== layer)) {
    throw new Error('Incomplete frame or layer set');
  }
  for (let i = 0; i < frames.length; i++) {
    const frame = manifest.frames[i];
    const hour = expectedHours[i], end = cycle + hour * 3600000;
    if (frame.id !== frames[i] || Date.parse(frame.intervalStart) !== end - product.intervalHours * 3600000 || Date.parse(frame.intervalEnd) !== end || Date.parse(frame.validTime) !== end) {
      throw new Error(`Invalid frame interval ${frame.id}`);
    }
  }
  validateArtifactRecords(manifest);
  const provenance = getProvenanceReference(manifest);
  const provenanceBytes = await readLocalFile(localPath(root, provenance.key), MAX_PROVENANCE_BYTES);
  if (sha256(provenanceBytes) !== provenance.sha256) throw new Error(`Invalid provenance hash ${provenance.key}`);
  parseProvenance(parseBoundedJson(provenanceBytes, MAX_PROVENANCE_JSON_TOKENS), manifest);
  if (forecastGrids(manifest).reduce((sum, grid) => sum + grid.samples.bytes, 0) > BUILD_BUDGETS.samplePackBytes) throw new Error('Aggregate sample packs exceed the build byte budget');
  if (forecastGrids(manifest).reduce((sum, grid) => sum + grid.grid.width * grid.grid.height, 0) > BUILD_BUDGETS.gridCells) throw new Error('Aggregate forecast grids exceed the cell budget');
  await validateSamplePack(localPath(root, manifest.samples.key), manifest, mask);
  for (const patch of manifest.patches ?? []) {
    const patchMask = await readGridCoverage(root, patch);
    validateRefinementCoverage(mask, patchMask, { geometry: patch.geometry, bounds: patch.descriptors.bounds });
    await validateSamplePack(localPath(root, patch.samples.key), { ...patch, frames: manifest.frames }, patchMask);
  }
  for (const artifact of manifest.artifacts) {
    if (await fileSha256(localPath(root, artifact.tilesKey)) !== artifact.tilesSha256) throw new Error(`Invalid archive hash ${artifact.tilesKey}`);
    await validateArchive(localPath(root, artifact.tilesKey), mask);
  }
  return validatedResult(root, manifest);
}

async function validateBuildV5(root: string, manifest: ManifestV5, mask: CoverageMask, trustedProduct?: ProductDefinition): Promise<ValidatedBuild<ManifestV5>> {
  const product = trustedProduct ?? getProduct(manifest.model), plan = product && wholeDomainPlan(product);
  if (!product || !plan || product.modelId !== manifest.model || manifest.recipe.id !== product.id
      || (Object.keys(product.source) as (keyof ProductDefinition['source'])[]).some(key => manifest.recipe.source[key] !== product.source[key])
      || !sameGrid(mask.grid, product.grid) || mask.maxZoom !== product.maxNativeZoom
      || JSON.stringify(manifest.descriptors) !== JSON.stringify(createWholeDomainDescriptors(product))
      || manifest.layers.length !== product.layers.length || product.layers.some((layer, i) => manifest.layers[i] !== layer)) throw new Error('Unsupported model, grid or layers');
  const registered = getProduct(product.modelId);
  const bundledFine = registered && registered.id === product.id ? await loadBundledFineCoverage(product, plan) : undefined;
  if (registered && registered.id === product.id && describeCoverage(mask, product).hash !== describeCoverage(await loadCoverage(product), product).hash) throw new Error('Native coverage identity mismatch');
  const cycle = Date.parse(manifest.cycle), created = Date.parse(manifest.createdAt), expiry = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(cycle) || !(created < expiry) || expiry > created + RETENTION_DAYS * 86400000) throw new Error('Invalid build timestamps');
  const hours = resolveProductFrameHours(product, mask, manifest.cycle);
  if (hours.length !== manifest.frames.length) throw new Error('Incomplete frame set');
  for (let i = 0; i < hours.length; i++) {
    const frame = manifest.frames[i], end = cycle + hours[i] * 3600000;
    if (frame.id !== `f${String(hours[i]).padStart(3, '0')}` || Date.parse(frame.intervalStart) !== end - product.intervalHours * 3600000
        || Date.parse(frame.intervalEnd) !== end || Date.parse(frame.validTime) !== end) throw new Error(`Invalid frame interval ${frame.id}`);
  }
  const provenance = getProvenanceReference(manifest), receipt = await readLocalFile(localPath(root, provenance.key), MAX_PROVENANCE_BYTES);
  if (sha256(receipt) !== provenance.sha256) throw new Error(`Invalid provenance hash ${provenance.key}`);
  parseProvenance(parseBoundedJson(receipt, MAX_PROVENANCE_JSON_TOKENS), manifest);
  const masks = new Map<string, Awaited<ReturnType<typeof readSparseCoverage>>>();
  for (const surface of manifest.surfaces) {
    const coverage = await readSparseCoverage(root, surface.coverage.hash), descriptor = coverage.descriptor;
    if (surface.coverage.maskKey !== `coverage/${surface.coverage.hash}/manifest.json` || descriptor.id !== product.coverageId
        || descriptor.id !== surface.coverage.id || descriptor.maxZoom !== product.maxNativeZoom || descriptor.maxZoom !== surface.coverage.maxZoom
        || descriptor.gridHash !== surface.gridHash || !sameGrid(descriptor.grid, surface.grid)
        || !sameGrid(surface.grid, surface.kind === 'native' ? plan.native : plan.fine)
        || JSON.stringify(descriptor.bounds) !== JSON.stringify(product.bounds)) throw new Error('Sparse coverage descriptor binding mismatch');
    if (surface.kind === 'native' && describeSparseCoverage(nativeSparseMask(mask), product).hash !== surface.coverage.hash) throw new Error('Native coverage identity mismatch');
    if (surface.kind === 'fine' && bundledFine && surface.coverage.hash !== bundledFine.hash) throw new Error('Fine coverage identity mismatch');
    const layout = prepareShardedSamplePackLayout(surface.grid, coverage.mask.coverage.blockIds, surface.samples.channelCount);
    assertSampleLayoutBindingV5(surface, { grid: descriptor.grid, gridHash: descriptor.gridHash, coverageHash: surface.coverage.hash, blockIds: coverage.mask.coverage.blockIds });
    if (layout.shards.length !== surface.samples.shards.length || layout.shards.some((shard, i) => shard.firstBlock !== surface.samples.shards[i].firstBlock || shard.blockCount !== surface.samples.shards[i].blockCount || shard.byteLength !== surface.samples.shards[i].bytes)) throw new Error('Noncanonical sample shard layout');
    const stride = surface.samples.channelCount * CELL_BYTES, gridWidth = surface.grid.width;
    let scratch: Buffer | undefined;
    for (let i = 0; i < surface.samples.shards.length; i++) {
      const shard = surface.samples.shards[i], data = await readLocalFile(localPath(root, shard.key), shard.bytes, shard.bytes);
      if (sha256(data) !== shard.sha256) throw new Error(`Invalid sample shard hash ${shard.key}`);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength), specs = surface.layers.map(layer => manifest.descriptors.layers[layer]);
      for (let ordinal = shard.firstBlock; ordinal < shard.firstBlock + shard.blockCount; ordinal++) {
        const block = layout.block(ordinal);
        const compare = async (neighbor: ShardedSampleBlock | null, x: number, y: number, dx: number, dy: number, count: number): Promise<void> => {
          if (!neighbor) return;
          let bytes = data, base = neighbor.byteOffset;
          if (neighbor.shard !== i) {
            const other = surface.samples.shards[neighbor.shard], file = await open(localPath(root, other.key), 'r');
            try {
              const before = await file.stat();
              if (!before.isFile() || before.size !== other.bytes) throw new Error(`Invalid sample shard size ${other.key}`);
              scratch ??= Buffer.alloc((SAMPLE_BLOCK_SIZE + 1) ** 2 * stride);
              bytes = scratch.subarray(0, neighbor.byteLength); base = 0;
              for (let offset = 0; offset < bytes.length;) {
                const part = await file.read(bytes, offset, bytes.length - offset, neighbor.byteOffset + offset);
                if (!part.bytesRead) throw new Error(`Short sample shard read ${other.key}`);
                offset += part.bytesRead;
              }
              const after = await file.stat();
              if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error(`Sample shard changed during read ${other.key}`);
            } finally { await file.close(); }
          }
          for (let n = 0; n < count; n++) {
            const column = (block.column + x + n * dx) % gridWidth, row = block.row + y + n * dy;
            const nx = (column - neighbor.column + gridWidth) % gridWidth, ny = row - neighbor.row;
            if (nx >= neighbor.width || ny < 0 || ny >= neighbor.height) throw new Error('Invalid sample block overlap');
            const a = block.byteOffset + ((y + n * dy) * block.width + x + n * dx) * stride;
            const b = base + (ny * neighbor.width + nx) * stride;
            if (!data.subarray(a, a + stride).equals(bytes.subarray(b, b + stride))) throw new Error(`Duplicate sample cell differs: ${shard.key} cell ${row * gridWidth + column}`);
          }
        };
        if (block.width > Math.min(SAMPLE_BLOCK_SIZE, gridWidth - block.column)) {
          const x = block.width - 1, column = (block.column + x) % gridWidth;
          await compare(layout.blockFor(block.row * gridWidth + column), x, 0, 0, 1, block.height);
        }
        if (block.height > SAMPLE_BLOCK_SIZE) {
          const y = block.height - 1, row = block.row + y, right = (block.column + block.width - 1) % gridWidth;
          await compare(layout.blockFor(row * gridWidth + block.column), 0, y, 1, 0, block.width);
          await compare(layout.blockFor(row * gridWidth + right), block.width - 1, y, 0, 0, 1);
          if (block.column > 0 || surface.grid.wrapLongitude) {
            const left = layout.blockFor(row * gridWidth + (block.column + gridWidth - 1) % gridWidth);
            if (left && (left.column + left.width - 1) % gridWidth === block.column) await compare(left, 0, y, 0, 0, 1);
          }
        }
        for (let y = 0; y < block.height; y++) for (let x = 0; x < block.width; x++) {
          const active = !!sparseCoverageLookup(coverage.mask.coverage, (block.column + x) % surface.grid.width, block.row + y);
          const offset = block.byteOffset + (y * block.width + x) * surface.samples.channelCount * CELL_BYTES;
          for (let channel = 0; channel < surface.samples.channelCount; channel++) validateSampleCell(view, offset + channel * CELL_BYTES, specs[channel % specs.length], shard.key, active);
        }
      }
    }
    masks.set(surface.kind, coverage);
    if (surface.terrain) {
      const terrain = surface.terrain, path = localPath(root, terrain.key), { size } = await stat(path);
      const ref = { key: terrain.key, sha256: terrain.sha256, bytes: size, arrayBytes: coverage.mask.coverage.offsets[coverage.mask.coverage.blockIds.length] * 5 };
      const verified = await validateSparsePreparedTerrain(ref, asset => readLocalFile(localPath(root, asset.key), asset.bytes, asset.bytes), surface.grid, coverage.mask.coverage, coverage.bytes);
      assertTerrainManifestBinding(manifest, terrain, verified.descriptor, ref.arrayBytes, product);
    }
  }
  for (const artifact of manifest.artifacts) {
    const coverage = masks.get(artifact.layer === 'precip-rate' ? 'native' : 'fine');
    if (!coverage || await fileSha256(localPath(root, artifact.tilesKey), BUILD_BUDGETS.samplePackBytes) !== artifact.tilesSha256) throw new Error(`Invalid archive hash ${artifact.tilesKey}`);
    await validateArchive(localPath(root, artifact.tilesKey), coverage.mask);
  }
  return validatedResult(root, manifest);
}
