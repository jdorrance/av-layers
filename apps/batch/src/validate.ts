import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PMTiles } from 'pmtiles';
import { openArchive, Compression, TileType } from './archive-reader.js';
import { getProduct } from '@av/contracts/models';
import { CELL_BYTES, STATUS_OUTSIDE, SAMPLE_BLOCK_SIZE, RASTER_TILE_SIZE, MAX_TILE_BYTES, coverageAtZoom, encodeBoundedJson, MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS, expectedTiles, layerSurface, renderedLayers, sourceIntervalHours, mapFrameCount, sameGrid, manifestV5Schema, matchesFrameIntervals, RETENTION_DAYS, validateSampleCell, assertSampleLayoutBindingV5, assertProfileLayoutBindingV5, sparseCoverageLookup, createWholeDomainDescriptors, TERRAIN_CLEARANCE_METHOD, terrainColumnMethodForProduct, type CoverageMask, type ManifestV5, type ProductDefinition } from '@av/contracts';
import { prepareShardedSamplePackLayout, resolveProductFrameHours, validateProfileRecord, type ShardedSampleBlock } from '@av/forecast';
import { BUILD_BUDGETS } from './capacity.js';
import { decodeWebp } from './webp.js';
import { describeCoverage, describeSparseCoverage, loadCoverage, readSparseCoverage } from './coverage.js';
import { localPath, readLocalFile, type createLocalFileReader } from './local-file.js';
import { readLocalProvenance, readFrameProvenance } from './frame-provenance.js';
import { forecastObjects, provenanceObjects } from './publication-objects.js';
export { localPath } from './local-file.js';
import { loadBundledFineCoverage, nativeSparseMask, wholeDomainPlan } from './whole-domain/coverage.js';
import { validateSparsePreparedTerrain } from './terrain/sparse.js';
import { verifyObjectReceipts, type ObjectReceipt } from './immutable-upload.js';
import type { ObjectStorage } from './storage.js';
import { runConcurrent } from './concurrent.js';
export { runConcurrent } from './concurrent.js';

export const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** An in-process validation result, never a serialized trust token. Upload still rechecks each file. */
const validationSeal = Symbol('ValidatedBuild');
export interface ValidatedBuild { readonly [validationSeal]: true; readonly root: string; readonly manifest: ManifestV5; readonly hash: string }
const seals = new WeakSet<object>();
const remoteSeals = new WeakMap<object, ObjectStorage>();
const manifestHash = (manifest: ManifestV5): string => sha256(Buffer.from(JSON.stringify(manifest)));
function validatedResult(root: string, manifest: ManifestV5, remoteStore?: ObjectStorage): ValidatedBuild {
  const result = { [validationSeal]: true as const, root: resolve(root), manifest, hash: manifestHash(manifest) };
  Object.defineProperty(result, validationSeal, { enumerable: false });
  seals.add(result);
  if (remoteStore) remoteSeals.set(result, remoteStore);
  return Object.freeze(result);
}

export function assertValidatedBuild(root: string, manifest: ManifestV5, result: ValidatedBuild, remoteStore?: ObjectStorage): void {
  if (!seals.has(result) || result[validationSeal] !== true || result.root !== resolve(root) || result.hash !== manifestHash(result.manifest) || result.hash !== manifestHash(manifest)) throw new Error('Build validation result is missing or changed');
  if (remoteStore && remoteSeals.get(result) !== remoteStore) throw new Error('Build validation result does not cover this remote store');
}

export function assertTerrainManifestBinding(manifest: ManifestV5, terrain: NonNullable<ManifestV5['surfaces'][number]['terrain']>, descriptor: Awaited<ReturnType<typeof validateSparsePreparedTerrain>>['descriptor'], arrayBytes: number, product: ProductDefinition): void {
  const source = manifest.source.terrain;
  if (descriptor.dataId !== terrain.dataId || descriptor.source.verticalDatum !== terrain.verticalDatum || descriptor.source.surface !== terrain.surface
      || !source || typeof source !== 'object' || !('dataId' in source) || source.dataId !== terrain.dataId || !('key' in source) || source.key !== terrain.key
      || !('sha256' in source) || source.sha256 !== terrain.sha256 || !('arrayBytes' in source) || source.arrayBytes !== arrayBytes
      || manifest.tool.terrainMethod !== terrainColumnMethodForProduct({ ...product, layers: manifest.layers }).id
      || manifest.tool.terrainClearance !== TERRAIN_CLEARANCE_METHOD.id) throw new Error('Terrain source or method mismatch');
}

/** Attach timings after validation while preserving the validated forecast metadata. */
export function finalizeValidatedMetrics(root: string, result: ValidatedBuild, metrics: ManifestV5['metrics']): ValidatedBuild {
  assertValidatedBuild(root, result.manifest, result);
  const manifest = manifestV5Schema.parse({ ...result.manifest, metrics: structuredClone(metrics) });
  encodeBoundedJson(manifest, MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS);
  return validatedResult(root, manifest, remoteSeals.get(result));
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

export async function validateBuild(root: string, raw: unknown, mask: CoverageMask, trustedProduct?: ProductDefinition, remote?: { store: ObjectStorage; objects: ObjectReceipt[]; signal?: AbortSignal }): Promise<ValidatedBuild> {
  const manifest = manifestV5Schema.parse(raw);
  encodeBoundedJson(manifest, MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS);
  const product = trustedProduct ?? getProduct(manifest.model), plan = product && wholeDomainPlan(product);
  if (!product || !plan || product.modelId !== manifest.model || manifest.recipe.id !== product.id
      || (Object.keys(product.source) as (keyof ProductDefinition['source'])[]).some(key => manifest.recipe.source[key] !== product.source[key])
      || !sameGrid(mask.grid, product.grid) || manifest.surfaces.some(surface => mask.maxZoom < surface.coverage.maxZoom)
      || JSON.stringify(manifest.descriptors) !== JSON.stringify(createWholeDomainDescriptors(product))
      || manifest.layers.length !== product.layers.length || product.layers.some((layer, i) => manifest.layers[i] !== layer)) throw new Error('Unsupported model, grid or layers');
  const registered = getProduct(product.modelId);
  const bundledFine = registered && registered.id === product.id ? await loadBundledFineCoverage(product, plan) : undefined;
  if (registered && registered.id === product.id && describeCoverage(mask, product).hash !== describeCoverage(await loadCoverage(product), product).hash) throw new Error('Native coverage identity mismatch');
  const cycle = Date.parse(manifest.cycle), created = Date.parse(manifest.createdAt), expiry = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(cycle) || !(created < expiry) || expiry > created + RETENTION_DAYS * 86400000) throw new Error('Invalid build timestamps');
  const hours = resolveProductFrameHours(product, mask, manifest.cycle);
  if (hours.length !== manifest.frames.length) throw new Error('Incomplete frame set');
  if ((manifest.mapFrameCount ?? manifest.frames.length) !== mapFrameCount({ ...product, frameHours: hours })) throw new Error('Invalid map frame prefix');
  for (let i = 0; i < hours.length; i++) {
    const frame = manifest.frames[i], end = cycle + hours[i] * 3600000;
    if (frame.id !== `f${String(hours[i]).padStart(3, '0')}` || Date.parse(frame.intervalStart) !== end - sourceIntervalHours(product, hours[i]!) * 3600000
        || Date.parse(frame.intervalEnd) !== end || Date.parse(frame.validTime) !== end) throw new Error(`Invalid frame interval ${frame.id}`);
  }
  const provenance = await readLocalProvenance(root, manifest);
  if (provenance.value.version === 2) for (const [index, reference] of provenance.value.frames.entries()) {
    const frame = manifest.frames[index]!, chunk = await readFrameProvenance(remote ?? root, manifest, frame, reference);
    if (!matchesFrameIntervals(chunk.intervals, frame, manifest.layers.includes('precip-rate'))) throw new Error('Provenance frame interval mismatch');
  }
  const masks = new Map<string, Awaited<ReturnType<typeof readSparseCoverage>>['mask']>();
  for (const surface of manifest.surfaces) {
    const coverage = await readSparseCoverage(root, surface.coverage.hash), descriptor = coverage.descriptor;
    if (surface.coverage.maskKey !== `coverage/${surface.coverage.hash}/manifest.json` || descriptor.id !== product.coverageId
        || descriptor.id !== surface.coverage.id || descriptor.maxZoom < surface.coverage.maxZoom
        || descriptor.gridHash !== surface.gridHash || !sameGrid(descriptor.grid, surface.grid)
        || !sameGrid(surface.grid, surface.kind === 'native' ? plan.native : plan.fine)
        || JSON.stringify(descriptor.bounds) !== JSON.stringify(product.bounds)) throw new Error('Sparse coverage descriptor binding mismatch');
    if (surface.kind === 'native' && describeSparseCoverage(nativeSparseMask(mask), product).hash !== surface.coverage.hash) throw new Error('Native coverage identity mismatch');
    if (surface.kind === 'fine' && bundledFine && surface.coverage.hash !== bundledFine.hash) throw new Error('Fine coverage identity mismatch');
    const binding = { grid: descriptor.grid, gridHash: descriptor.gridHash, coverageHash: surface.coverage.hash, blockIds: coverage.mask.coverage.blockIds };
    assertSampleLayoutBindingV5(surface, binding);
    if (surface.kind === 'native' && renderedLayers(product.layers).length !== product.layers.length && !surface.profiles) throw new Error('Native profiles are required for point products');
    if (surface.profiles) assertProfileLayoutBindingV5(surface, binding);
    const groups = surface.samples.format === 'cell-major-block-shards-v1'
      ? [{ channels: surface.samples.channelCount, shards: surface.samples.shards }]
      : surface.samples.shards.filter(shard => shard.blockShard === 0).map(first => ({
        channels: first.frameCount * surface.layers.length, shards: surface.samples.shards.filter(shard => 'group' in shard && shard.group === first.group)
      }));
    for (const group of groups) {
      if (!remote) await validateSampleGroup(root, surface, coverage.mask.coverage, manifest.descriptors, group);
      else {
        packedGroupLayout(surface, coverage.mask.coverage, group);
      }
    }
    if (surface.profiles) {
      const profiles = surface.profiles;
      if (profiles.levelCount > product.capabilities.maxVerticalLevels) throw new Error('Profile levels exceed product capacity');
      for (const part of profiles.groups) {
        const group = { channels: part.frameCount, recordBytes: profiles.recordBytes, shards: part.shards };
        if (remote) packedGroupLayout(surface, coverage.mask.coverage, group);
        else await validateSampleGroup(root, surface, coverage.mask.coverage, manifest.descriptors, group);
      }
    }
    masks.set(surface.kind, coverageAtZoom(coverage.mask, surface.coverage.maxZoom));
    if (surface.terrain) {
      const terrain = surface.terrain, path = localPath(root, terrain.key), { size } = await stat(path);
      const ref = { key: terrain.key, sha256: terrain.sha256, bytes: size, arrayBytes: coverage.mask.coverage.offsets[coverage.mask.coverage.blockIds.length] * 5 };
      const verified = await validateSparsePreparedTerrain(ref, asset => readLocalFile(localPath(root, asset.key), asset.bytes, asset.bytes), surface.grid, coverage.mask.coverage, coverage.bytes);
      assertTerrainManifestBinding(manifest, terrain, verified.descriptor, ref.arrayBytes, product);
    }
  }
  for (const artifact of remote ? [] : manifest.artifacts) {
    const view = masks.get(layerSurface(artifact.layer));
    if (!view || await fileSha256(localPath(root, artifact.tilesKey), BUILD_BUDGETS.samplePackBytes) !== artifact.tilesSha256) throw new Error(`Invalid archive hash ${artifact.tilesKey}`);
    await validateArchive(localPath(root, artifact.tilesKey), view);
  }
  if (remote) {
    const expected = [...provenanceObjects(provenance.value), ...forecastObjects(manifest)];
    const byKey = new Map(remote.objects.map(object => [object.key, object]));
    if (byKey.size !== remote.objects.length || byKey.size !== expected.length || expected.some(item => {
      const object = byKey.get(item.key);
      return !object || object.sha256 !== item.sha256 || (item.bytes !== undefined && object.bytes !== item.bytes);
    })) throw new Error('Remote receipt artifact set mismatch');
    await verifyObjectReceipts(remote.store, remote.objects, remote.signal);
  }
  return validatedResult(root, manifest, remote?.store);
}

interface PackedGroup {
  channels: number;
  recordBytes?: number;
  shards: Array<{ firstBlock: number; blockCount: number; bytes: number; key: string; sha256: string }>;
}
function packedGroupLayout(surface: Pick<ManifestV5['surfaces'][number], 'grid'>, coverage: Awaited<ReturnType<typeof readSparseCoverage>>['mask']['coverage'], group: PackedGroup) {
  const layout = prepareShardedSamplePackLayout(surface.grid, coverage.blockIds, group.channels, undefined, group.recordBytes ?? CELL_BYTES);
  if (layout.shards.length !== group.shards.length || layout.shards.some((shard, i) => shard.firstBlock !== group.shards[i].firstBlock || shard.blockCount !== group.shards[i].blockCount || shard.byteLength !== group.shards[i].bytes)) throw new Error('Noncanonical sample shard layout');
  return layout;
}

export async function validateSampleGroup(root: string, surface: Pick<ManifestV5['surfaces'][number], 'grid' | 'layers'>, coverage: Awaited<ReturnType<typeof readSparseCoverage>>['mask']['coverage'], descriptors: ManifestV5['descriptors'], group: PackedGroup, options: { reader?: ReturnType<typeof createLocalFileReader>; signal?: AbortSignal } = {}): Promise<void> {
    const layout = packedGroupLayout(surface, coverage, group), recordBytes = group.recordBytes ?? CELL_BYTES;
    const stride = group.channels * recordBytes, gridWidth = surface.grid.width;
    let scratch: Buffer | undefined;
    for (let i = 0; i < group.shards.length; i++) {
      const shard = group.shards[i];
      const consume = async (data: Buffer): Promise<void> => {
        if (sha256(data) !== shard.sha256) throw new Error(`Invalid sample shard hash ${shard.key}`);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength), specs = surface.layers.map(layer => descriptors.layers[layer]);
        for (let ordinal = shard.firstBlock; ordinal < shard.firstBlock + shard.blockCount; ordinal++) {
          const block = layout.block(ordinal);
          const compare = async (neighbor: ShardedSampleBlock | null, x: number, y: number, dx: number, dy: number, count: number): Promise<void> => {
            if (!neighbor) return;
            let bytes = data, base = neighbor.byteOffset;
            if (neighbor.shard !== i) {
              const other = group.shards[neighbor.shard], file = await open(localPath(root, other.key), 'r');
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
                // A read can move ctime when Linux updates atime. Content changes move mtime.
                if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error(`Sample shard changed during read ${other.key}`);
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
            const active = !!sparseCoverageLookup(coverage, (block.column + x) % surface.grid.width, block.row + y);
            const offset = block.byteOffset + (y * block.width + x) * stride;
            for (let channel = 0; channel < group.channels; channel++) {
              const record = offset + channel * recordBytes;
              if (group.recordBytes !== undefined) {
                validateProfileRecord(data.subarray(record, record + recordBytes));
                if ((view.getUint8(record + 4) === STATUS_OUTSIDE) === active) throw new Error(`Profile coverage mismatch in ${shard.key}`);
              } else validateSampleCell(view, record, specs[channel % specs.length], shard.key, active);
            }
          }
        }
      };
      if (options.reader) await options.reader(localPath(root, shard.key), shard.bytes, consume, options.signal);
      else await consume(await readLocalFile(localPath(root, shard.key), shard.bytes, shard.bytes));
    }
}
