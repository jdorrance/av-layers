import { createHash } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sparseCoverageLookup, type SparseCoverage } from '@av/contracts/sparse-coverage';
import { STATUS_MASK, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_MASK } from '@av/contracts/layers';
import { WIND_CHUNK_LIMIT, WIND_FINE_CELL_BYTES, WIND_HEIGHTS, WIND_OVERVIEW_CELL_BYTES, WIND_OVERVIEW_TILE_SIZE, WIND_OVERVIEW_VALUES, windOverviewLayout, windFrameParts, WIND_FRAME_LIMIT, WIND_FRAME_MAX_PAGES, WIND_INDEX_ENTRIES, WIND_ROOT_LIMIT, assertWindFrameLayout, encodeTileMask, windFrameSchema, parseWindFrame, windDataSchema, windLayout, type WindFrame } from '@av/contracts/wind-data';
import { SAMPLE_BLOCK_SIZE, encodeBoundedJson, parseBoundedJson, sameGrid, type ManifestV5, type WholeDomainGrid } from '@av/contracts';
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
export interface WindSparsity { activeIndices?: Uint32Array; fineCoverage?: SparseCoverage }

interface TileSelection { total: number; count: number; tiles?: number[]; mask?: string }

function selectActiveTiles(grid: WholeDomainGrid['native'], size: number, kind: 'wind' | 'fine', sparsity?: WindSparsity): TileSelection {
  if (!Number.isSafeInteger(grid.width) || !Number.isSafeInteger(grid.height) || grid.width < 1 || grid.height < 1) throw new Error('Invalid wind grid dimensions');
  const cols = Math.ceil(grid.width / size), rows = Math.ceil(grid.height / size), total = cols * rows;
  if (!Number.isSafeInteger(total) || total < 1) throw new Error('Invalid wind grid dimensions');
  const present = new Uint8Array(Math.ceil(total / 8));
  let populated = false;
  if (kind === 'wind' && sparsity?.activeIndices?.length) {
    populated = true;
    for (let i = 0; i < sparsity.activeIndices.length; i++) {
      const idx = sparsity.activeIndices[i]!, x = idx % grid.width, y = Math.floor(idx / grid.width);
      if (x >= 0 && x < grid.width && y >= 0 && y < grid.height) {
        const t = Math.floor(y / size) * cols + Math.floor(x / size);
        present[t >> 3] |= 1 << (t & 7);
      }
    }
  } else if (kind === 'fine' && sparsity?.fineCoverage) {
    populated = true;
    const cov = sparsity.fineCoverage, blockCols = Math.ceil(cov.width / SAMPLE_BLOCK_SIZE);
    for (let i = 0; i < cov.blockIds.length; i++) {
      const id = cov.blockIds[i]!, bx = id % blockCols, by = Math.floor(id / blockCols);
      const t = Math.floor((by * SAMPLE_BLOCK_SIZE) / size) * cols + Math.floor((bx * SAMPLE_BLOCK_SIZE) / size);
      if (t >= 0 && t < total) present[t >> 3] |= 1 << (t & 7);
    }
  }
  if (!populated) return { total, count: total };
  const tiles: number[] = [];
  for (let t = 0; t < total; t++) if (present[t >> 3]! & (1 << (t & 7))) tiles.push(t);
  if (!tiles.length || tiles.length === total) return { total, count: total };
  return { total, count: tiles.length, tiles, mask: encodeTileMask(present, total) };
}

function admitWindData(maxLevels: number, plan: WindGrids, capacity: WindCapacity, sparsity?: WindSparsity): number {
  const tileSize = maxLevels <= 77 ? 16 : 8;
  if (!Number.isSafeInteger(maxLevels) || maxLevels < 1 || maxLevels > 256 || !Number.isSafeInteger(capacity.mapFrames) || capacity.mapFrames < 1 || capacity.mapFrames > 256 || !Number.isSafeInteger(capacity.numericBytes) || capacity.numericBytes < 0 || !Number.isSafeInteger(capacity.estimatedPeakBytes) || capacity.estimatedPeakBytes < 0) throw new Error('Invalid wind capacity');
  const windSel = selectActiveTiles(plan.native, tileSize, 'wind', sparsity), fineSel = selectActiveTiles(plan.fine, 64, 'fine', sparsity);
  if (windSel.count > WIND_INDEX_ENTRIES * WIND_FRAME_MAX_PAGES || fineSel.count > WIND_INDEX_ENTRIES * WIND_FRAME_MAX_PAGES) throw new Error('Wind grid exceeds index budget');
  const wind = windLayout(plan.native.width, plan.native.height, tileSize, maxLevels, windSel.count);
  const fine = windLayout(plan.fine.width, plan.fine.height, 64, undefined, fineSel.count);
  const overviews = overviewStrides(plan.native).map(stride => windOverviewLayout(plan.native, stride));
  const overviewBytes = overviews.reduce((sum, item) => sum + item.count * (item.chunkBytes + 32), 0);
  const windChunkBytes = wind.chunkBytes, fineChunkBytes = fine.chunkBytes, pages = wind.pages + fine.pages + overviews.reduce((sum, item) => sum + item.pages, 0);
  if (capacity.mapFrames * (2 * pages + 1) > MAX_FORECAST_RECEIPT_ENTRIES) throw new Error('Wind objects exceed receipt budget');
  const frameDescriptorBytes = 1024 + pages * 256 + (windSel.mask?.length ?? 0) + (fineSel.mask?.length ?? 0);
  const rootDescriptorBytes = 1024 + capacity.mapFrames * 256;
  const encodedBytes = capacity.mapFrames * (windSel.count * windChunkBytes + fineSel.count * fineChunkBytes + (windSel.count + fineSel.count) * 32 + overviewBytes + frameDescriptorBytes) + rootDescriptorBytes;
  const shardBytes = Math.max(Math.min(windSel.count, WIND_INDEX_ENTRIES) * windChunkBytes, Math.min(fineSel.count, WIND_INDEX_ENTRIES) * fineChunkBytes, ...overviews.map(item => Math.min(item.count, WIND_INDEX_ENTRIES) * item.chunkBytes));
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

function overviewStrides(grid: WindGrids['native']): number[] {
  const strides: number[] = [];
  for (let stride = 2; ; stride *= 2) {
    strides.push(stride);
    if (Math.max(Math.ceil(grid.width / stride), Math.ceil(grid.height / stride)) <= 128) return strides;
  }
}

function columnWind(column: ReturnType<typeof normalizedWindColumn>, height: number | 'surface') {
  if (height === 'surface') return column.surface;
  for (let i = 0; i < column.levels.length; i++) {
    const a = column.levels[i], b = column.levels[i + 1];
    if (!a) continue;
    if (height === a.height) return a.wind;
    if (b && height > a.height && height < b.height) {
      const t = (height - a.height) / (b.height - a.height);
      return { u: a.wind.u + t * (b.wind.u - a.wind.u), v: a.wind.v + t * (b.wind.v - a.wind.v) };
    }
  }
  return null;
}

async function encodeOverview(directory: string, id: string, stride: number, x0: number, y0: number, frame: NormalizedFrame,
  prepared: WholeDomainPrepared, terrain: WindTerrain, lift: GridField, slotFor: (index: number) => number, signal?: AbortSignal): Promise<Uint8Array> {
  const size = WIND_OVERVIEW_TILE_SIZE, bytes = new Uint8Array(size * size * WIND_OVERVIEW_CELL_BYTES), view = new DataView(bytes.buffer);
  const { native, fine } = prepared.plan, grid = windOverviewLayout(native, stride);
  const previous = stride > 2 ? windOverviewLayout(native, stride / 2) : undefined;
  const children = new Map<number, DataView>();
  if (previous) {
    const width = Math.ceil(previous.width / size);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      const tx = x0 * 2 / size + x, ty = y0 * 2 / size + y;
      if (tx >= width || ty >= Math.ceil(previous.height / size)) continue;
      const tile = ty * width + tx, page = Math.floor(tile / WIND_INDEX_ENTRIES), file = await open(resolve(directory, id, `overview-${stride / 2}-${page}.bin`), 'r');
      const data = new Uint8Array(previous.chunkBytes);
      try {
        const result = await file.read(data, 0, data.length, tile % WIND_INDEX_ENTRIES * data.length);
        if (result.bytesRead !== data.length) throw new Error('Wind overview child missing');
      } finally { await file.close(); }
      children.set(tile, new DataView(data.buffer));
    }
  }
  const factor = native.kind === 'regular-latlon' && fine.kind === 'regular-latlon' ? native.dx / fine.dx
    : native.kind === 'lambert-conformal' && fine.kind === 'lambert-conformal' ? native.dxM / fine.dxM : 1;
  const sumU = new Float64Array(WIND_OVERVIEW_VALUES), sumV = new Float64Array(WIND_OVERVIEW_VALUES);
  const counts = new Uint16Array(WIND_OVERVIEW_VALUES), noLift = new Uint16Array(WIND_OVERVIEW_VALUES), unavail = new Uint16Array(WIND_OVERVIEW_VALUES);
  for (let i = 0; i < size * size; i++) {
    signal?.throwIfAborted();
    const x = x0 + i % size, y = y0 + Math.floor(i / size), pos = i * WIND_OVERVIEW_CELL_BYTES;
    for (let mode = 0; mode < WIND_OVERVIEW_VALUES; mode++) view.setUint8(pos + mode * 9 + 8, STATUS_OUTSIDE);
    if (x >= grid.width || y >= grid.height) continue;
    if (previous) {
      let exactNoLift = 0, exactValidLift = 0;
      for (let dy = 0; dy < stride; dy++) for (let dx = 0; dx < stride; dx++) {
        const nx = x * stride + dx, ny = y * stride + dy;
        if (nx >= native.width || ny >= native.height || slotFor(ny * native.width + nx) < 0) continue;
        const target = sparseCoverageLookup(prepared.fine.mask.coverage, Math.round(nx * factor), Math.round(ny * factor));
        if (!target?.output || !Number.isFinite(lift.values[target.offset])) continue;
        const st = lift.flags[target.offset] & STATUS_MASK;
        if (st === STATUS_NO_LIFT) exactNoLift++;
        else if (st === STATUS_VALID) exactValidLift++;
      }
      for (let mode = 0; mode < WIND_OVERVIEW_VALUES; mode++) {
        let u = 0, v = 0, validWeight = 0, noLiftWeight = 0, unavailWeight = 0, outsideWeight = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const cx = x * 2 + dx, cy = y * 2 + dy;
          if (cx >= previous.width || cy >= previous.height) continue;
          const tile = Math.floor(cy / size) * Math.ceil(previous.width / size) + Math.floor(cx / size);
          const child = children.get(tile)!, offset = ((cy % size) * size + cx % size) * WIND_OVERVIEW_CELL_BYTES + mode * 9;
          const childStatus = child.getUint8(offset + 8);
          const weight = Math.min(stride / 2, native.width - cx * stride / 2) * Math.min(stride / 2, native.height - cy * stride / 2);
          if (childStatus === STATUS_NO_LIFT) noLiftWeight += weight;
          else if (childStatus === STATUS_VALID) {
            u += child.getFloat32(offset, true) * weight; v += child.getFloat32(offset + 4, true) * weight; validWeight += weight;
          } else if (childStatus === STATUS_UNAVAILABLE) unavailWeight += weight;
          else outsideWeight += weight;
        }
        const coveredWeight = validWeight + noLiftWeight + unavailWeight;
        const majorityNoLift = mode === WIND_OVERVIEW_VALUES - 1 ? exactNoLift > exactValidLift : noLiftWeight > validWeight;
        const finalStatus = validWeight > 0
          ? (majorityNoLift && coveredWeight >= outsideWeight ? STATUS_NO_LIFT : STATUS_VALID)
          : coveredWeight === 0 || coveredWeight < outsideWeight
            ? STATUS_OUTSIDE
            : noLiftWeight > 0 && noLiftWeight >= unavailWeight ? STATUS_NO_LIFT : STATUS_UNAVAILABLE;
        const offset = pos + mode * 9;
        view.setUint8(offset + 8, finalStatus);
        if (finalStatus === STATUS_VALID && validWeight) { view.setFloat32(offset, u / validWeight, true); view.setFloat32(offset + 4, v / validWeight, true); }
      }
      continue;
    }
    sumU.fill(0); sumV.fill(0); counts.fill(0); noLift.fill(0); unavail.fill(0);
    let outsideCells = 0;
    for (let dy = 0; dy < stride; dy++) for (let dx = 0; dx < stride; dx++) {
      const nx = x * stride + dx, ny = y * stride + dy;
      if (nx >= native.width || ny >= native.height) continue;
      const slot = slotFor(ny * native.width + nx);
      const target = slot < 0 ? null : sparseCoverageLookup(prepared.fine.mask.coverage, Math.round(nx * factor), Math.round(ny * factor));
      if (!target?.output) { outsideCells++; continue; }
      const column = normalizedWindColumn(frame, slot);
      for (let mode = 0; mode < WIND_OVERVIEW_VALUES; mode++) {
        let status = mode === 0 ? STATUS_VALID : mode === WIND_OVERVIEW_VALUES - 1
          ? Number.isFinite(lift.values[target.offset]) ? lift.flags[target.offset] & STATUS_MASK : STATUS_UNAVAILABLE
          : terrain.valid[target.offset] === 1 && Number.isFinite(terrain.elevationM[target.offset]) ? STATUS_VALID : STATUS_UNAVAILABLE;
        const height = mode === 0 ? 'surface' : mode === WIND_OVERVIEW_VALUES - 1 ? lift.values[target.offset] : terrain.elevationM[target.offset] + WIND_HEIGHTS[mode - 1];
        const wind = status === STATUS_VALID ? columnWind(column, height) : null;
        if (status === STATUS_VALID && !wind) status = STATUS_UNAVAILABLE;
        if (status === STATUS_NO_LIFT) noLift[mode]++;
        else if (wind) { sumU[mode] += wind.u; sumV[mode] += wind.v; counts[mode]++; }
        else unavail[mode]++;
      }
    }
    for (let mode = 0; mode < WIND_OVERVIEW_VALUES; mode++) {
      const offset = pos + mode * 9, covered = counts[mode]! + noLift[mode]! + unavail[mode]!;
      if (counts[mode]!) {
        if (noLift[mode]! > counts[mode]! && covered >= outsideCells) view.setUint8(offset + 8, STATUS_NO_LIFT);
        else {
          view.setUint8(offset + 8, STATUS_VALID);
          view.setFloat32(offset, sumU[mode]! / counts[mode]!, true);
          view.setFloat32(offset + 4, sumV[mode]! / counts[mode]!, true);
        }
      } else if (covered > 0 && covered >= outsideCells) {
        view.setUint8(offset + 8, noLift[mode]! > 0 && noLift[mode]! >= unavail[mode]! ? STATUS_NO_LIFT : STATUS_UNAVAILABLE);
      }
    }
  }
  return bytes;
}

/** Stream bounded wind chunks and retain their publication receipts until finish. */
export function createWindDataWriter(root: string, model: string, buildId: string, maxLevels: number, plan: WindGrids, capacity: WindCapacity, signalOuter?: AbortSignal, sparsity?: WindSparsity) {
  const tileSize = admitWindData(maxLevels + 1, plan, capacity, sparsity);
  const prefix = `builds/${model}/${buildId}/map-data`, directory = resolve(root, prefix);
  const frames: Array<{ id: string; bytes: number; sha256: string }> = [];
  const objects: WindObject[] = [];
  async function writeFrame(frame: NormalizedFrame, id: string, lift: GridField, prepared: WholeDomainPrepared, terrain: WindTerrain, frameSignal?: AbortSignal) {
    const signal = frameSignal && signalOuter ? AbortSignal.any([signalOuter, frameSignal]) : frameSignal ?? signalOuter;
    signal?.throwIfAborted();
    if (frames.length >= capacity.mapFrames || frame.hgtM.length < 1 || frame.hgtM.length > maxLevels || !sameGrid(prepared.plan.native, plan.native) || !sameGrid(prepared.plan.fine, plan.fine)) throw new Error('Wind frame exceeds admitted capacity');
    const frameSparsity: WindSparsity = sparsity ?? { activeIndices: frame.activeIndices, fineCoverage: prepared.fine?.mask.coverage };
    const windSel = selectActiveTiles(prepared.plan.native, tileSize, 'wind', frameSparsity);
    const fineSel = selectActiveTiles(prepared.plan.fine, 64, 'fine', frameSparsity);
    const frameObjects: typeof objects = [];
    await mkdir(resolve(directory, id), { recursive: true });
    const slots = frame.activeIndices;
    const slotFor = (index: number) => {
      let lo = 0, hi = slots.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (slots[mid] < index) lo = mid + 1; else hi = mid; }
      return slots[lo] === index ? lo : -1;
    };
    const writeGrid = async (kind: 'wind' | 'fine' | `overview-${number}`, stride?: number): Promise<WindFrame['wind']> => {
      const overview = stride === undefined ? undefined : windOverviewLayout(plan.native, stride);
      const sel = overview ? undefined : kind === 'wind' ? windSel : fineSel;
      const size = overview ? WIND_OVERVIEW_TILE_SIZE : kind === 'wind' ? tileSize : 64;
      const grid = overview ?? (kind === 'wind' ? prepared.plan.native : prepared.plan.fine);
      const width = Math.ceil(grid.width / size);
      const { count, pageCount } = overview ?? windLayout(grid.width, grid.height, size, kind === 'wind' ? frame.hgtM.length + 1 : undefined, sel?.count);
      const shards: WindFrame['wind'] = [];
      for (let first = 0, page = 0; first < count; first += WIND_INDEX_ENTRIES, page++) {
        signal?.throwIfAborted();
        const length = pageCount(page), indexes = Buffer.alloc(length * 32), digest = length > 1 ? createHash('sha256') : undefined;
        const file = await open(resolve(directory, id, `${kind}-${page}.bin`), 'wx');
        let bytes = 0, singleSha = '';
        try {
          for (let n = 0; n < length; n++) {
            signal?.throwIfAborted();
            const logicalTile = sel?.tiles ? sel.tiles[first + n]! : first + n;
            const x0 = (logicalTile % width) * size, y0 = Math.floor(logicalTile / width) * size;
            const data = overview ? await encodeOverview(directory, id, stride!, x0, y0, frame, prepared, terrain, lift, slotFor, signal) : kind === 'wind' ? encodeWindColumns(Array.from({ length: size * size }, (_, i) => {
              const x = x0 + i % size, y = y0 + Math.floor(i / size);
              const slot = x < grid.width && y < grid.height ? slotFor(y * grid.width + x) : -1;
              return slot < 0 ? null : normalizedWindColumn(frame, slot);
            }), frame.hgtM.length + 1) : encodeFineTargets(prepared, terrain, lift, x0, y0);
            if (data.length > WIND_CHUNK_LIMIT) throw new Error('Wind chunk exceeds byte budget');
            const chunkDigest = createHash('sha256').update(data).digest();
            chunkDigest.copy(indexes, n * 32);
            if (digest) digest.update(data); else singleSha = chunkDigest.toString('hex');
            await file.writeFile(data); bytes += data.length;
          }
        } finally { await file.close(); }
        signal?.throwIfAborted();
        await writeFile(resolve(directory, id, `${kind}-${page}.idx`), indexes, { flag: 'wx' });
        const sha256 = digest ? digest.digest('hex') : singleSha, indexSha256 = hash(indexes);
        shards.push({ sha256, bytes, indexSha256, count: length });
        frameObjects.push({ key: `${prefix}/${id}/${kind}-${page}.bin`, bytes, sha256, contentType: 'application/octet-stream' },
          { key: `${prefix}/${id}/${kind}-${page}.idx`, bytes: indexes.length, sha256: indexSha256, contentType: 'application/octet-stream' });
      }
      return shards;
    };
    const wind = await writeGrid('wind'), fine = await writeGrid('fine'), overview = [];
    for (const stride of overviewStrides(plan.native)) overview.push({ stride, shards: await writeGrid(`overview-${stride}`, stride) });
    const data = windFrameSchema.parse({
      version: 3, frame: id, levels: frame.hgtM.length + 1, tileSize, fineTileSize: 64,
      ...(windSel.mask ? { windMask: windSel.mask } : {}), ...(fineSel.mask ? { fineMask: fineSel.mask } : {}),
      wind, fine, overview
    });
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
    for (const { kind, shards } of windFrameParts(descriptor)) {
      for (const [page, shard] of shards.entries()) {
        signal?.throwIfAborted();
        const chunkBytes = shard.bytes / shard.count;
        const base = `${prefix}/map-data/${frame.id}/${kind}-${page}`, idxKey = `${base}.idx`, dataKey = `${base}.bin`;
        const index = await readLocalFile(resolve(root, idxKey), WIND_INDEX_ENTRIES * 32, shard.count * 32);
        if (hash(index) !== shard.indexSha256) throw new Error('Wind index digest mismatch');
        const file = await open(resolve(root, dataKey), 'r'), digest = shard.count > 1 ? createHash('sha256') : undefined, buffer = Buffer.alloc(chunkBytes);
        let singleSha = '';
        try {
          const before = await file.stat();
          if (!before.isFile() || before.size !== shard.bytes) throw new Error('Wind shard size mismatch');
          for (let i = 0; i < shard.count; i++) {
            signal?.throwIfAborted();
            const { bytesRead } = await file.read(buffer, 0, chunkBytes, i * chunkBytes);
            const chunkHex = hash(buffer);
            if (bytesRead !== chunkBytes || chunkHex !== index.subarray(i * 32, (i + 1) * 32).toString('hex')) throw new Error('Wind chunk digest mismatch');
            if (digest) digest.update(buffer); else singleSha = chunkHex;
          }
          const after = await file.stat();
          if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Wind shard changed during read');
        } finally { await file.close(); }
        if ((digest ? digest.digest('hex') : singleSha) !== shard.sha256) throw new Error('Wind shard digest mismatch');
        objects.push({ key: idxKey, sha256: shard.indexSha256, bytes: index.length, contentType: 'application/octet-stream' }, { key: dataKey, sha256: shard.sha256, bytes: shard.bytes, contentType: 'application/octet-stream' });
      }
    }
  }
  const reference = { bytes: rootBytes.length, sha256: hash(rootBytes) };
  signal?.throwIfAborted();
  objects.push({ key: rootKey, ...reference, contentType: 'application/json' });
  return { reference, objects };
}
