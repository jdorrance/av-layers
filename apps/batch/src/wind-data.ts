import { createHash } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sparseCoverageLookup } from '@av/contracts/sparse-coverage';
import { STATUS_MASK, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_MASK } from '@av/contracts/layers';
import { WIND_CHUNK_LIMIT, WIND_FINE_CELL_BYTES, WIND_FRAME_LIMIT, WIND_FRAME_MAX_PAGES, WIND_INDEX_ENTRIES, WIND_ROOT_LIMIT, assertWindFrameLayout, windFrameSchema, parseWindFrame, windDataSchema, windLayout, type WindFrame } from '@av/contracts/wind-data';
import { encodeBoundedJson, parseBoundedJson, sameGrid, type ManifestV5, type WholeDomainGrid } from '@av/contracts';
import { encodeWindColumns, normalizedWindColumn } from '@av/forecast/wind';
import type { NormalizedFrame } from '@av/forecast/inputs';
import type { GridField } from '@av/forecast/sampler';
import type { WholeDomainPrepared } from './whole-domain/prepare.js';
import { BUILD_BUDGETS, MAX_FORECAST_RECEIPT_ENTRIES, MAX_V5_SHARD_BYTES } from './capacity.js';
import { readLocalFile } from './local-file.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type WindGrids = Pick<WholeDomainGrid, 'native' | 'fine'>;
interface WindCapacity { mapFrames: number; numericBytes: number; estimatedPeakBytes: number }
interface WindTerrain { elevationM: Float32Array; valid: Uint8Array }
interface WindObject { key: string; bytes: number; sha256: string; contentType: string }

function admitWindData(maxLevels: number, plan: WindGrids, capacity: WindCapacity): number {
  const tileSize = maxLevels <= 77 ? 16 : 8;
  if (!Number.isSafeInteger(maxLevels) || maxLevels < 1 || maxLevels > 256 || !Number.isSafeInteger(capacity.mapFrames) || capacity.mapFrames < 1 || capacity.mapFrames > 256 || !Number.isSafeInteger(capacity.numericBytes) || capacity.numericBytes < 0 || !Number.isSafeInteger(capacity.estimatedPeakBytes) || capacity.estimatedPeakBytes < 0) throw new Error('Invalid wind capacity');
  const tiles = (grid: WholeDomainGrid['native'], size: number) => {
    if (!Number.isSafeInteger(grid.width) || !Number.isSafeInteger(grid.height) || grid.width < 1 || grid.height < 1) throw new Error('Invalid wind grid dimensions');
    const { count } = windLayout(grid.width, grid.height, size);
    if (!Number.isSafeInteger(count) || count < 1 || count > WIND_INDEX_ENTRIES * WIND_FRAME_MAX_PAGES) throw new Error('Wind grid exceeds index budget');
    return count;
  };
  const nativeTiles = tiles(plan.native, tileSize), fineTiles = tiles(plan.fine, 64);
  const wind = windLayout(plan.native.width, plan.native.height, tileSize, maxLevels), fine = windLayout(plan.fine.width, plan.fine.height, 64);
  const windChunkBytes = wind.chunkBytes, fineChunkBytes = fine.chunkBytes, pages = wind.pages + fine.pages;
  if (capacity.mapFrames * (2 * pages + 1) > MAX_FORECAST_RECEIPT_ENTRIES) throw new Error('Wind objects exceed receipt budget');
  const frameDescriptorBytes = 1024 + pages * 256;
  const rootDescriptorBytes = 1024 + capacity.mapFrames * 256;
  const encodedBytes = capacity.mapFrames * (nativeTiles * windChunkBytes + fineTiles * fineChunkBytes + (nativeTiles + fineTiles) * 32 + frameDescriptorBytes) + rootDescriptorBytes;
  const shardBytes = Math.max(Math.min(nativeTiles, WIND_INDEX_ENTRIES) * windChunkBytes, Math.min(fineTiles, WIND_INDEX_ENTRIES) * fineChunkBytes);
  const uploadBytes = 2 * shardBytes;
  if (windChunkBytes > WIND_CHUNK_LIMIT || shardBytes > MAX_V5_SHARD_BYTES || frameDescriptorBytes > WIND_FRAME_LIMIT || rootDescriptorBytes > WIND_ROOT_LIMIT || !Number.isSafeInteger(encodedBytes) || !Number.isSafeInteger(capacity.numericBytes + encodedBytes) || capacity.numericBytes + encodedBytes > BUILD_BUDGETS.numericBytes || capacity.estimatedPeakBytes + 8 * 1024 * 1024 + uploadBytes > BUILD_BUDGETS.workingSetBytes) throw new Error('Wind data exceeds build capacity');
  return tileSize;
}

function encodeFineTargets(prepared: WholeDomainPrepared, terrain: WindTerrain, lift: GridField, x0: number, y0: number): Uint8Array {
  const grid = prepared.plan.fine, size = 64, data = new Uint8Array(size * size * WIND_FINE_CELL_BYTES);
  const view = new DataView(data.buffer);
  for (let i = 0; i < size * size; i++) {
    const x = x0 + i % size, y = y0 + Math.floor(i / size);
    const cell = x < grid.width && y < grid.height ? sparseCoverageLookup(prepared.fine.mask.coverage, x, y) : undefined;
    const pos = i * WIND_FINE_CELL_BYTES, valid = cell != null && terrain.valid[cell.offset] === 1 && Number.isFinite(terrain.elevationM[cell.offset]);
    const liftValid = cell != null && Number.isFinite(lift.values[cell.offset]);
    const terrainStatus = cell == null ? STATUS_OUTSIDE : valid ? STATUS_VALID : STATUS_UNAVAILABLE;
    const liftFlags = cell == null ? STATUS_OUTSIDE : liftValid ? lift.flags[cell.offset] : (lift.flags[cell.offset] & SUPPORT_MASK) | STATUS_UNAVAILABLE;
    view.setFloat32(pos, valid ? terrain.elevationM[cell!.offset] : 0, true);
    view.setFloat32(pos + 4, liftValid ? lift.values[cell!.offset] : 0, true);
    view.setUint8(pos + 8, terrainStatus | ((liftFlags & STATUS_MASK) << 2) | (cell?.output ? 16 : 0));
    view.setUint8(pos + 9, liftFlags & SUPPORT_MASK);
  }
  return data;
}

/** Stream bounded wind chunks and retain their publication receipts until finish. */
export function createWindDataWriter(root: string, model: string, buildId: string, maxLevels: number, plan: WindGrids, capacity: WindCapacity, signalOuter?: AbortSignal) {
  const tileSize = admitWindData(maxLevels, plan, capacity);
  const prefix = `builds/${model}/${buildId}/map-data`, directory = resolve(root, prefix);
  const frames: Array<{ id: string; bytes: number; sha256: string }> = [];
  const objects: WindObject[] = [];
  async function writeFrame(frame: NormalizedFrame, id: string, lift: GridField, prepared: WholeDomainPrepared, terrain: WindTerrain, frameSignal?: AbortSignal) {
    const signal = frameSignal && signalOuter ? AbortSignal.any([signalOuter, frameSignal]) : frameSignal ?? signalOuter;
    signal?.throwIfAborted();
    if (frames.length >= capacity.mapFrames || frame.hgtM.length < 1 || frame.hgtM.length > maxLevels || !sameGrid(prepared.plan.native, plan.native) || !sameGrid(prepared.plan.fine, plan.fine)) throw new Error('Wind frame exceeds admitted capacity');
    const frameObjects: typeof objects = [];
    await mkdir(resolve(directory, id), { recursive: true });
    const slots = frame.activeIndices;
    const slotFor = (index: number) => {
      let lo = 0, hi = slots.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (slots[mid] < index) lo = mid + 1; else hi = mid; }
      return slots[lo] === index ? lo : -1;
    };
    const writeGrid = async (kind: 'wind' | 'fine'): Promise<WindFrame['wind']> => {
      const size = kind === 'wind' ? tileSize : 64;
      const grid = kind === 'wind' ? prepared.plan.native : prepared.plan.fine;
      const width = Math.ceil(grid.width / size), { count, pageCount } = windLayout(grid.width, grid.height, size, kind === 'wind' ? frame.hgtM.length : undefined);
      const shards: WindFrame['wind'] = [];
      for (let first = 0, page = 0; first < count; first += WIND_INDEX_ENTRIES, page++) {
        signal?.throwIfAborted();
        const length = pageCount(page), indexes = Buffer.alloc(length * 32), digest = createHash('sha256');
        const file = await open(resolve(directory, id, `${kind}-${page}.bin`), 'wx');
        let bytes = 0;
        try {
          for (let n = 0; n < length; n++) {
            signal?.throwIfAborted();
            const tile = first + n, x0 = (tile % width) * size, y0 = Math.floor(tile / width) * size;
            const data = kind === 'wind' ? encodeWindColumns(Array.from({ length: size * size }, (_, i) => {
              const x = x0 + i % size, y = y0 + Math.floor(i / size);
              const slot = x < grid.width && y < grid.height ? slotFor(y * grid.width + x) : -1;
              return slot < 0 ? null : normalizedWindColumn(frame, slot);
            }), frame.hgtM.length) : encodeFineTargets(prepared, terrain, lift, x0, y0);
            if (data.length > WIND_CHUNK_LIMIT) throw new Error('Wind chunk exceeds byte budget');
            createHash('sha256').update(data).digest().copy(indexes, n * 32); digest.update(data);
            await file.writeFile(data); bytes += data.length;
          }
        } finally { await file.close(); }
        signal?.throwIfAborted();
        await writeFile(resolve(directory, id, `${kind}-${page}.idx`), indexes, { flag: 'wx' });
        const sha256 = digest.digest('hex'), indexSha256 = hash(indexes);
        shards.push({ sha256, bytes, indexSha256, count: length });
        frameObjects.push({ key: `${prefix}/${id}/${kind}-${page}.bin`, bytes, sha256, contentType: 'application/octet-stream' },
          { key: `${prefix}/${id}/${kind}-${page}.idx`, bytes: indexes.length, sha256: indexSha256, contentType: 'application/octet-stream' });
      }
      return shards;
    };
    const data = windFrameSchema.parse({ version: 3, frame: id, levels: frame.hgtM.length, tileSize, fineTileSize: 64, wind: await writeGrid('wind'), fine: await writeGrid('fine') });
    signal?.throwIfAborted();
    const bytes = encodeBoundedJson(data, WIND_FRAME_LIMIT);
    await writeFile(resolve(directory, `${id}.json`), bytes, { flag: 'wx' });
    signal?.throwIfAborted();
    const sha256 = hash(bytes);
    frames.push({ id, bytes: bytes.length, sha256 });
    objects.push(...frameObjects, { key: `${prefix}/${id}.json`, bytes: bytes.length, sha256, contentType: 'application/json' });
  }
  function finishShard(expectedFrames = capacity.mapFrames) {
    if (!Number.isSafeInteger(expectedFrames) || expectedFrames < 1 || expectedFrames > capacity.mapFrames || frames.length !== expectedFrames) throw new Error('Wind frame count differs from admitted capacity');
    return { frames, objects };
  }
  async function finish(expectedFrames = capacity.mapFrames) {
    finishShard(expectedFrames);
    const bytes = encodeBoundedJson(windDataSchema.parse({ version: 1, model, buildId, frames }), WIND_ROOT_LIMIT);
    await writeFile(resolve(root, `builds/${model}/${buildId}/map-data.json`), bytes, { flag: 'wx' });
    return { bytes: bytes.length, sha256: hash(bytes) };
  }
  return { writeFrame, finish, finishShard };
}

export async function localWindData(root: string, manifest: ManifestV5, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const prefix = `builds/${manifest.model}/${manifest.buildId}`, rootKey = `${prefix}/map-data.json`;
  const rootBytes = await readLocalFile(resolve(root, rootKey), WIND_ROOT_LIMIT).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!rootBytes) return null;
  const data = windDataSchema.parse(parseBoundedJson(rootBytes)), expected = manifest.frames.slice(0, manifest.mapFrameCount ?? manifest.frames.length);
  if (data.model !== manifest.model || data.buildId !== manifest.buildId || data.frames.length !== expected.length || data.frames.some((frame, i) => frame.id !== expected[i].id)) throw new Error('Wind root identity mismatch');
  const native = manifest.surfaces.find(surface => surface.kind === 'native'), fine = manifest.surfaces.find(surface => surface.kind === 'fine');
  if (!native || !fine) throw new Error('Wind surface missing');
  const objects: WindObject[] = [];
  for (const frame of data.frames) {
    signal?.throwIfAborted();
    const key = `${prefix}/map-data/${frame.id}.json`, bytes = await readLocalFile(resolve(root, key), WIND_FRAME_LIMIT, frame.bytes);
    if (hash(bytes) !== frame.sha256) throw new Error('Wind frame digest mismatch');
    const descriptor = parseWindFrame(bytes);
    if (descriptor.frame !== frame.id) throw new Error('Wind frame identity mismatch');
    assertWindFrameLayout(descriptor, { native: native.grid, fine: fine.grid });
    objects.push({ key, sha256: frame.sha256, bytes: frame.bytes, contentType: 'application/json' });
    for (const kind of ['wind', 'fine'] as const) {
      for (const [page, shard] of descriptor[kind].entries()) {
        signal?.throwIfAborted();
        const chunkBytes = shard.bytes / shard.count;
        const base = `${prefix}/map-data/${frame.id}/${kind}-${page}`, idxKey = `${base}.idx`, dataKey = `${base}.bin`;
        const index = await readLocalFile(resolve(root, idxKey), WIND_INDEX_ENTRIES * 32, shard.count * 32);
        if (hash(index) !== shard.indexSha256) throw new Error('Wind index digest mismatch');
        const file = await open(resolve(root, dataKey), 'r'), digest = createHash('sha256'), buffer = Buffer.alloc(chunkBytes);
        try {
          const before = await file.stat();
          if (!before.isFile() || before.size !== shard.bytes) throw new Error('Wind shard size mismatch');
          for (let i = 0; i < shard.count; i++) {
            signal?.throwIfAborted();
            const { bytesRead } = await file.read(buffer, 0, chunkBytes, i * chunkBytes);
            if (bytesRead !== chunkBytes || hash(buffer) !== index.subarray(i * 32, (i + 1) * 32).toString('hex')) throw new Error('Wind chunk digest mismatch');
            digest.update(buffer);
          }
          const after = await file.stat();
          if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Wind shard changed during read');
        } finally { await file.close(); }
        if (digest.digest('hex') !== shard.sha256) throw new Error('Wind shard digest mismatch');
        objects.push({ key: idxKey, sha256: shard.indexSha256, bytes: index.length, contentType: 'application/octet-stream' }, { key: dataKey, sha256: shard.sha256, bytes: shard.bytes, contentType: 'application/octet-stream' });
      }
    }
  }
  const reference = { bytes: rootBytes.length, sha256: hash(rootBytes) };
  signal?.throwIfAborted();
  objects.push({ key: rootKey, ...reference, contentType: 'application/json' });
  return { reference, objects };
}
