import z from 'zod';
import { canonicalGridJson, encodeSparseCoverage, gridSchema, MAX_COVERAGE_DESCRIPTOR_BYTES, prepareGridGeometry, sameGrid, SAMPLE_BLOCK_SIZE, sparseCoverageDescriptorSchema, type Grid, type SparseCoverage } from '@av/contracts';
import { putImmutable } from '../immutable-upload.js';
import { ASSET_MAX_BYTES, encodeJson, parseJson, sha256, TERRAIN_BATCH_POINTS, terrainAssetSchema, terrainCatalogSchema, type TerrainAsset, type TerrainCatalog, type TerrainStorage } from './contract.js';
import { createTerrainReadBudget, createTerrainReader, TERRAIN_READ_LIMITS, type TerrainReadStats } from './reader.js';
import { PREPARED_DESCRIPTOR_MAX_BYTES, PREPARED_TERRAIN_CELL_BYTES, PREPARED_TERRAIN_METHOD } from './prepare.js';
import { TERRAIN_INVENTORY_BYTES, verifyTerrainCatalogInventory } from './source.js';

export const MAX_SPARSE_TERRAIN_BYTES = 256 * 1024 * 1024;
const MAX_ARRAY_BYTES = MAX_SPARSE_TERRAIN_BYTES;
const CHUNK_CELLS = ASSET_MAX_BYTES / 4;
const WINDOW_POINTS = TERRAIN_BATCH_POINTS * 16;
const SOURCE_INTEGRITY = 'sha256-before-sampling-v1';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().regex(/^terrain\/prepared\/[a-f0-9]{64}\/manifest\.json$/);
export const sparseTerrainRefSchema = terrainAssetSchema.extend({ key, bytes: z.number().int().positive().max(PREPARED_DESCRIPTOR_MAX_BYTES), arrayBytes: z.number().int().positive().max(MAX_ARRAY_BYTES) }).strict();
export type SparseTerrainRef = z.infer<typeof sparseTerrainRefSchema>;

const descriptorSchema = z.strictObject({
  version: z.literal(2), dataId: digest, method: z.literal(PREPARED_TERRAIN_METHOD), grid: gridSchema,
  gridHash: digest, coverageHash: digest, layoutVersion: z.literal(1), oceanCoverage: z.literal('verified'), sourceIntegrity: z.literal(SOURCE_INTEGRITY), cells: z.number().int().positive().max(Math.floor(MAX_ARRAY_BYTES / PREPARED_TERRAIN_CELL_BYTES)),
  source: terrainCatalogSchema.shape.source,
  files: z.strictObject({ elevationM: z.array(terrainAssetSchema).min(1).max(32), valid: z.array(terrainAssetSchema).min(1).max(32) })
}).superRefine((value, ctx) => {
  const prefix = sparsePrefix(value.dataId, value.gridHash, value.coverageHash), count = Math.ceil(value.cells / CHUNK_CELLS);
  if (value.gridHash !== gridHash(value.grid) || value.files.elevationM.length !== count || value.files.valid.length !== count) {
    ctx.addIssue({ code: 'custom', message: 'Invalid sparse terrain identity or chunks' });
    return;
  }
  for (let i = 0; i < count; i++) {
    const cells = Math.min(CHUNK_CELLS, value.cells - i * CHUNK_CELLS);
    if (value.files.elevationM[i].key !== `${prefix}/elevation-${i}.f32` || value.files.valid[i].key !== `${prefix}/valid-${i}.u8`
        || value.files.elevationM[i].bytes !== cells * 4 || value.files.valid[i].bytes !== cells) ctx.addIssue({ code: 'custom', message: 'Invalid sparse terrain chunk layout' });
  }
});

export type SparsePreparedTerrain = { descriptor: z.infer<typeof descriptorSchema>; elevationM: Float32Array; valid: Uint8Array };
export interface SparseTerrainProgress {
  phase: 'cache-check' | 'cache-validation' | 'planning' | 'sampling' | 'upload' | 'complete';
  cells: number; completedCells: number; elapsedMs: number;
  cacheHit?: boolean; sourceBlocks?: number; sourceAssets?: number; reader?: TerrainReadStats;
}
export interface SparseTerrainOptions {
  catalog: TerrainCatalog; storage: TerrainStorage; grid: Grid; coverage: SparseCoverage; coverageDescriptor: Uint8Array; signal?: AbortSignal;
  cacheOnly?: boolean;
  limits?: { maxArrayBytes?: number; maxDurationMs?: number; reader?: Parameters<typeof createTerrainReader>[0]['limits']; total?: Partial<Parameters<typeof createTerrainReadBudget>[0]> };
  onProgress?: (progress: SparseTerrainProgress) => void;
  onReport?: (report: { cacheHit: boolean; cells: number; arrayBytes: number; elapsedMs: number; inventoryReadBytesBound: number; reader?: TerrainReadStats; sourceBlocks?: number; sourceAssets?: number; totalLimits?: Parameters<typeof createTerrainReadBudget>[0]; planning?: { windowPoints: number; windows: number; maxWindowGroups: number; blockBitmapBytes: number; sampledPeakRssBytes: number; sampledPeakHeapUsedBytes: number; decodedBlocks: number; readBatches: number } }) => void;
}

function gridHash(grid: Grid): string { return sha256(canonicalGridJson(grid)); }
function sparsePrefix(dataId: string, gridHashValue: string, coverageHash: string): string {
  return `terrain/prepared/${sha256(encodeJson({ dataId, gridHash: gridHashValue, method: PREPARED_TERRAIN_METHOD, coverageHash, layoutVersion: 1, oceanCoverage: 'verified', sourceIntegrity: SOURCE_INTEGRITY }, PREPARED_DESCRIPTOR_MAX_BYTES))}`;
}
function identity(gridInput: Grid, coverageInput: SparseCoverage, descriptorBytes: Uint8Array) {
  const grid = gridSchema.parse(gridInput), coverage = coverageInput, hash = gridHash(grid);
  const descriptor = parseJson(descriptorBytes, sparseCoverageDescriptorSchema, MAX_COVERAGE_DESCRIPTOR_BYTES), encoded = encodeSparseCoverage(coverage);
  if (coverage.width !== grid.width || coverage.height !== grid.height || coverage.wrapLongitude !== grid.wrapLongitude || coverage.gridHash !== hash
      || !sameGrid(descriptor.grid, grid) || descriptor.gridHash !== hash || descriptor.files.sparse.bytes !== encoded.length || descriptor.files.sparse.sha256 !== sha256(encoded)) throw new Error('Sparse terrain coverage grid mismatch');
  return { grid, coverage, gridHash: hash, coverageHash: sha256(descriptorBytes), cells: coverage.offsets[coverage.blockIds.length] };
}
function check(asset: TerrainAsset, bytes: Uint8Array): void {
  if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) throw new Error(`Sparse terrain asset integrity mismatch: ${asset.key}`);
}

export async function validateSparsePreparedTerrain(refInput: SparseTerrainRef, read: (asset: TerrainAsset) => Promise<Uint8Array>, grid: Grid, coverage: SparseCoverage, coverageDescriptor: Uint8Array, signal?: AbortSignal, collect = false): Promise<{ descriptor: SparsePreparedTerrain['descriptor']; elevationM?: Float32Array; valid?: Uint8Array }> {
  signal?.throwIfAborted();
  const expected = identity(grid, coverage, coverageDescriptor), ref = sparseTerrainRefSchema.parse(refInput), manifest = await read(ref);
  signal?.throwIfAborted();
  check(ref, manifest);
  const descriptor = parseJson(manifest, descriptorSchema, PREPARED_DESCRIPTOR_MAX_BYTES);
  if (!sameGrid(descriptor.grid, expected.grid) || descriptor.gridHash !== expected.gridHash || descriptor.coverageHash !== expected.coverageHash
      || descriptor.cells !== expected.cells || ref.arrayBytes !== expected.cells * PREPARED_TERRAIN_CELL_BYTES
      || ref.key !== `${sparsePrefix(descriptor.dataId, descriptor.gridHash, descriptor.coverageHash)}/manifest.json`) throw new Error('Sparse terrain identity or coverage mismatch');
  const elevationM = collect ? new Float32Array(descriptor.cells) : undefined, valid = collect ? new Uint8Array(descriptor.cells) : undefined;
  for (let i = 0; i < descriptor.files.elevationM.length; i++) {
    signal?.throwIfAborted();
    const heights = await read(descriptor.files.elevationM[i]);
    check(descriptor.files.elevationM[i], heights);
    const mask = await read(descriptor.files.valid[i]);
    check(descriptor.files.valid[i], mask);
    const view = new DataView(heights.buffer, heights.byteOffset, heights.byteLength), start = i * CHUNK_CELLS;
    for (let j = 0; j < mask.length; j++) {
      if (j % WINDOW_POINTS === 0) {
        signal?.throwIfAborted();
        if (j) await new Promise<void>(resolve => setImmediate(resolve));
        signal?.throwIfAborted();
      }
      const value = view.getFloat32(j * 4, true);
      if (mask[j] > 1 || !Number.isFinite(value) || (!mask[j] && value !== 0)) throw new Error('Invalid sparse terrain cell');
      if (elevationM) elevationM[start + j] = value;
    }
    valid?.set(mask, start);
    signal?.throwIfAborted();
    await new Promise<void>(resolve => setImmediate(resolve));
    signal?.throwIfAborted();
  }
  return { descriptor, elevationM, valid };
}

export async function readSparsePreparedTerrain(ref: SparseTerrainRef, read: (asset: TerrainAsset) => Promise<Uint8Array>, grid: Grid, coverage: SparseCoverage, coverageDescriptor: Uint8Array, signal?: AbortSignal): Promise<SparsePreparedTerrain> {
  const result = await validateSparsePreparedTerrain(ref, read, grid, coverage, coverageDescriptor, signal, true);
  return { descriptor: result.descriptor, elevationM: result.elevationM!, valid: result.valid! };
}

export async function prepareSparseTerrain(options: SparseTerrainOptions): Promise<SparseTerrainRef> {
  const started = Date.now(), duration = options.limits?.maxDurationMs;
  if (duration !== undefined && (!Number.isSafeInteger(duration) || duration < 1 || duration > 2_147_483_647)) throw new Error('Invalid terrain preparation deadline');
  const signal = duration === undefined ? options.signal : options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(duration)]) : AbortSignal.timeout(duration);
  const checkDeadline = () => { signal?.throwIfAborted(); if (duration !== undefined && Date.now() - started >= duration) throw new Error('Terrain preparation deadline exceeded'); };
  const checkpoint = async () => { checkDeadline(); await new Promise<void>(resolve => setImmediate(resolve)); checkDeadline(); };
  checkDeadline();
  const catalog = terrainCatalogSchema.parse(options.catalog), target = identity(options.grid, options.coverage, options.coverageDescriptor);
  const arrayBytes = target.cells * PREPARED_TERRAIN_CELL_BYTES, maximum = options.limits?.maxArrayBytes ?? MAX_ARRAY_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_ARRAY_BYTES || !target.cells || arrayBytes > maximum) throw new Error('Sparse terrain array budget exceeded');
  let lastProgressAt = started, lastPhase: SparseTerrainProgress['phase'] | undefined;
  function progress(phase: SparseTerrainProgress['phase'], completedCells: number, details?: () => Pick<SparseTerrainProgress, 'cacheHit' | 'sourceBlocks' | 'sourceAssets' | 'reader'>): void {
    if (!options.onProgress) return;
    const now = Date.now();
    if (phase === lastPhase && now - lastProgressAt < 10_000) return;
    checkDeadline();
    lastProgressAt = now; lastPhase = phase;
    options.onProgress({ phase, cells: target.cells, completedCells, elapsedMs: now - started, ...details?.() });
    checkDeadline();
  }
  progress('cache-check', 0);
  const prefix = sparsePrefix(catalog.dataId, target.gridHash, target.coverageHash), manifestKey = `${prefix}/manifest.json`;
  const existing = await options.storage.get(manifestKey, undefined, PREPARED_DESCRIPTOR_MAX_BYTES, signal);
  checkDeadline();
  if (!existing && options.cacheOnly) throw new Error(`Prepared terrain cache is missing: ${manifestKey}; run pnpm operations forecast-terrain before forecast planning`);
  let inventoryReadBytesBound = TERRAIN_INVENTORY_BYTES;
  await verifyTerrainCatalogInventory(catalog, options.storage, signal, () => { inventoryReadBytesBound += TERRAIN_INVENTORY_BYTES; });
  checkDeadline();
  if (existing) {
    progress('cache-validation', 0, () => ({ cacheHit: true }));
    const ref = sparseTerrainRefSchema.parse({ key: manifestKey, bytes: existing.bytes.length, sha256: sha256(existing.bytes), arrayBytes });
    const loaded = await validateSparsePreparedTerrain(ref, async asset => {
      if (asset.key === manifestKey) return existing.bytes;
      const result = await options.storage.get(asset.key, undefined, asset.bytes, signal);
      if (!result) throw new Error(`Sparse terrain asset missing: ${asset.key}`);
      return result.bytes;
    }, target.grid, target.coverage, options.coverageDescriptor, signal);
    if (loaded.descriptor.dataId !== catalog.dataId) throw new Error('Sparse terrain source identity mismatch');
    checkDeadline();
    options.onReport?.({ cacheHit: true, cells: target.cells, arrayBytes, inventoryReadBytesBound, elapsedMs: Date.now() - started });
    progress('complete', target.cells, () => ({ cacheHit: true }));
    return ref;
  }
  progress('planning', 0, () => ({ cacheHit: false, sourceBlocks: 0, sourceAssets: 0 }));
  const geometry = prepareGridGeometry(target.grid), limits = { ...TERRAIN_READ_LIMITS, ...options.limits?.reader };
  const planner = await createTerrainReader({ catalog, storage: options.storage, signal, limits: options.limits?.reader });
  let bitmapBits = 0;
  const assets = new Map(catalog.tiles.map((tile, index) => {
    const width = Math.ceil(tile.geometry.width / catalog.packing.blockSize), height = Math.ceil(tile.geometry.height / catalog.packing.blockSize), base = bitmapBits;
    bitmapBits += width * height;
    return [tile.id, { index, base, width }] as const;
  }));
  const blockBitmap = new Uint8Array(Math.ceil(bitmapBits / 8)), usedAssets = new Uint8Array(catalog.tiles.length);
  const blockPixels = catalog.packing.blockSize ** 2, cacheBlocks = Math.floor(limits.maxCachedPixels / blockPixels);
  let sourceBlocks = 0, sourceAssets = 0, decodedBlocks = 0, readBatches = 0, windows = 0, maxWindowGroups = 0;
  let sampledPeakRssBytes = 0, sampledPeakHeapUsedBytes = 0;
  function batchSize(blocks: string): number {
    const count = blocks ? blocks.split('|').length : 0;
    return Math.max(1, Math.min(TERRAIN_BATCH_POINTS, limits.maxOutputPixels,
      count > cacheBlocks ? Math.floor(limits.maxDecodedPixels / (4 * blockPixels)) : TERRAIN_BATCH_POINTS));
  }
  const columns = Math.ceil(target.grid.width / SAMPLE_BLOCK_SIZE), maskBytes = SAMPLE_BLOCK_SIZE * SAMPLE_BLOCK_SIZE / 8;
  function* targets() {
    for (let block = 0; block < target.coverage.blockIds.length; block++) {
      let offset = target.coverage.offsets[block];
      const id = target.coverage.blockIds[block], x0 = (id % columns) * SAMPLE_BLOCK_SIZE, y0 = Math.floor(id / columns) * SAMPLE_BLOCK_SIZE;
      for (let local = 0; local < SAMPLE_BLOCK_SIZE * SAMPLE_BLOCK_SIZE; local++) {
        const index = block * maskBytes + Math.floor(local / 8);
        if (!((target.coverage.output[index] | target.coverage.halo[index]) & (1 << (local % 8)))) continue;
        const point = geometry.gridToGeographic(x0 + local % SAMPLE_BLOCK_SIZE, y0 + Math.floor(local / SAMPLE_BLOCK_SIZE));
        yield point ? { latitude: point.lat, longitude: point.lon, offset } : null;
        offset++;
      }
      checkDeadline();
    }
  }
  let groups = new Map<string, number>(), windowPoints = 0, plannedCells = 0;
  function planWindow(): void {
    if (!windowPoints) return;
    windows++;
    maxWindowGroups = Math.max(maxWindowGroups, groups.size);
    for (const [blocks, count] of groups) {
      const required = blocks ? blocks.split('|').length : 0;
      decodedBlocks += required > cacheBlocks ? 4 * count : required;
      readBatches += Math.ceil(count / batchSize(blocks));
    }
    const usage = process.memoryUsage();
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, usage.rss);
    sampledPeakHeapUsedBytes = Math.max(sampledPeakHeapUsedBytes, usage.heapUsed);
    groups = new Map(); windowPoints = 0;
  }
  try {
    for (const point of targets()) {
      if (point) {
        const blocks = planner.sourceBlocks(point.latitude, point.longitude);
        groups.set(blocks, (groups.get(blocks) ?? 0) + 1);
        for (const block of blocks.split('|')) if (block) {
          const [id, x, y] = block.split('/'), asset = assets.get(id)!;
          const bit = asset.base + Number(y) * asset.width + Number(x), byte = bit >> 3, mask = 1 << (bit & 7);
          if (!(blockBitmap[byte] & mask)) { blockBitmap[byte] |= mask; sourceBlocks++; }
          if (!usedAssets[asset.index]) { usedAssets[asset.index] = 1; sourceAssets++; }
        }
      }
      plannedCells++;
      if (++windowPoints === WINDOW_POINTS) { planWindow(); progress('planning', plannedCells, () => ({ sourceBlocks, sourceAssets })); await checkpoint(); }
    }
    if (windowPoints) { planWindow(); await checkpoint(); }
  } finally { planner.close(); }
  const totalLimits = { maxReadBytes: Math.max(TERRAIN_INVENTORY_BYTES, readBatches * limits.maxReadBytes), maxDecodedPixels: Math.max(1, decodedBlocks * blockPixels), maxOutputPixels: target.cells, ...options.limits?.total };
  const budget = createTerrainReadBudget(totalLimits, { signal, ...(duration === undefined ? {} : { deadlineAt: started + duration }) });
  const heights = new Uint8Array(target.cells * 4), valid = new Uint8Array(target.cells), view = new DataView(heights.buffer);
  const reader = await createTerrainReader({ catalog, storage: options.storage, signal, limits: options.limits?.reader, budget });
  let sampledCells = 0;
  try {
    progress('sampling', 0, () => ({ sourceBlocks, sourceAssets, reader: reader.stats() }));
    let points: Array<{ latitude: number; longitude: number; offset: number; blocks: string }> = [];
    const flush = async () => {
      if (!points.length) return;
      checkDeadline();
      points.sort((a, b) => a.blocks < b.blocks ? -1 : a.blocks > b.blocks ? 1 : a.offset - b.offset);
      for (let start = 0; start < points.length;) {
        let end = start + 1;
        const maximum = batchSize(points[start].blocks);
        while (end < points.length && points[end].blocks === points[start].blocks && end - start < maximum) end++;
        const batch = points.slice(start, end);
        const samples = await reader.sampleBatch!(batch);
        checkDeadline();
        for (let i = 0; i < samples.length; i++) {
          const sample = samples[i], offset = batch[i].offset;
          if (!sample) continue;
          view.setFloat32(offset * 4, sample.elevationM, true);
          if (!Number.isFinite(view.getFloat32(offset * 4, true))) throw new Error('Terrain elevation exceeds float32 storage');
          valid[offset] = 1;
        }
        sampledCells += batch.length;
        progress('sampling', sampledCells, () => ({ sourceBlocks, sourceAssets, reader: reader.stats() }));
        start = end;
      }
      points = [];
    };
    let scanned = 0;
    for (const point of targets()) {
      if (point) points.push({ ...point, blocks: reader.sourceBlocks(point.latitude, point.longitude) });
      else sampledCells++;
      if (++scanned === WINDOW_POINTS) { await flush(); await checkpoint(); scanned = 0; }
    }
    if (scanned) { await flush(); await checkpoint(); }
  } finally {
    const readerStats = reader.stats();
    reader.close();
    options.onReport?.({ cacheHit: false, cells: target.cells, arrayBytes, inventoryReadBytesBound, elapsedMs: Date.now() - started, reader: readerStats, sourceBlocks, sourceAssets, totalLimits, planning: { windowPoints: WINDOW_POINTS, windows, maxWindowGroups, blockBitmapBytes: blockBitmap.byteLength, sampledPeakRssBytes, sampledPeakHeapUsedBytes, decodedBlocks, readBatches } });
  }
  progress('upload', target.cells, () => ({ sourceBlocks, sourceAssets }));
  const files: { elevationM: TerrainAsset[]; valid: TerrainAsset[] } = { elevationM: [], valid: [] };
  for (let start = 0, i = 0; start < target.cells; start += CHUNK_CELLS, i++) {
    const end = Math.min(start + CHUNK_CELLS, target.cells);
    for (const [name, bytes, list] of [[`elevation-${i}.f32`, heights.subarray(start * 4, end * 4), files.elevationM], [`valid-${i}.u8`, valid.subarray(start, end), files.valid]] as const) {
      checkDeadline();
      const asset = { key: `${prefix}/${name}`, bytes: bytes.length, sha256: sha256(bytes) };
      await putImmutable(options.storage, asset.key, bytes, 'application/octet-stream', signal);
      list.push(asset);
    }
  }
  const descriptor = descriptorSchema.parse({ version: 2, dataId: catalog.dataId, method: PREPARED_TERRAIN_METHOD, grid: target.grid, gridHash: target.gridHash, coverageHash: target.coverageHash, layoutVersion: 1, oceanCoverage: 'verified', sourceIntegrity: SOURCE_INTEGRITY, cells: target.cells, source: catalog.source, files });
  const bytes = encodeJson(descriptor, PREPARED_DESCRIPTOR_MAX_BYTES);
  checkDeadline();
  await putImmutable(options.storage, manifestKey, bytes, 'application/json', signal);
  checkDeadline();
  progress('complete', target.cells, () => ({ cacheHit: false, sourceBlocks, sourceAssets }));
  return sparseTerrainRefSchema.parse({ key: manifestKey, bytes: bytes.length, sha256: sha256(bytes), arrayBytes });
}
