import type { GeographicBounds } from '@av/contracts';
import type { GeoTIFFImage } from 'geotiff';
import type { ObjectStorage } from '../storage';
import { TERRAIN_BATCH_POINTS, terrainCatalogSchema, type TerrainCatalog, type TerrainGeometry, type TerrainTile } from './contract';
import { TERRAIN_INVENTORY_BYTES, verifyTerrainCatalogInventory } from './source.js';

export const TERRAIN_READ_LIMITS = Object.freeze({
  maxReadBytes: 256 * 1024 * 1024, maxRangeBytes: 8 * 1024 * 1024,
  maxDecodedPixels: 64_000_000, maxOutputPixels: 4_000_000,
  maxCachedPixels: 8_000_000, maxOpenTiles: 8
});
export type TerrainReadLimits = { [K in keyof typeof TERRAIN_READ_LIMITS]: number };
export interface TerrainWindow {
  geometry: TerrainGeometry;
  values: Float32Array;
  missing: Uint8Array;
  source: 'dem' | 'ocean';
}
export interface TerrainReadStats {
  requests: number; bytesRead: number; readBytesBound: number; decodedPixels: number; outputPixels: number; cacheHits: number;
}
export interface TerrainReader {
  /** Native-row bilinear elevation in EGM2008 metres. Required nodata returns null; missing assets throw. */
  sample(latitude: number, longitude: number): Promise<{ elevationM: number; source: 'dem' | 'ocean' } | null>;
  sampleBatch?(points: readonly { latitude: number; longitude: number }[]): Promise<Array<{ elevationM: number; source: 'dem' | 'ocean' } | null>>;
  sourceBlocks(latitude: number, longitude: number): string;
  /** Native centres inside inclusive bounds, in bounded blocks; the caller owns yielded arrays. */
  readWindows(bounds: GeographicBounds): AsyncIterable<TerrainWindow>;
  stats(): TerrainReadStats;
  close(): void;
}

type Cached<T> = { promise: Promise<T>; settled: boolean; pixels: number };
type Block = { values: Float32Array; width: number; height: number; col: number; row: number };
type Section = { tile?: TerrainTile; geometry: TerrainGeometry; left: number; top: number; right: number; bottom: number };
type TerrainTotals = Pick<TerrainReadLimits, 'maxReadBytes' | 'maxDecodedPixels' | 'maxOutputPixels'>;
export type TerrainReadBudget = { readonly token: unique symbol };
type Proof = { etag: string; key: string; sha256: string; size: number };
const budgets = new WeakMap<TerrainReadBudget, { limits: TerrainTotals; stats: TerrainReadStats; etags: Map<string, Proof>; inBatch: boolean; readerOpen: boolean; dataId?: string; signal?: AbortSignal; deadlineAt?: number }>();
export function createTerrainReadBudget(limits: TerrainTotals, options: { deadlineAt?: number; signal?: AbortSignal } = {}): TerrainReadBudget {
  if (Object.keys(limits).length !== 3 || Object.keys(limits).some(key => !['maxReadBytes', 'maxDecodedPixels', 'maxOutputPixels'].includes(key)) || Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid terrain total limit');
  if (options.deadlineAt !== undefined && (!Number.isSafeInteger(options.deadlineAt) || options.deadlineAt < 1)) throw new Error('Invalid terrain deadline');
  const budget = {} as TerrainReadBudget;
  budgets.set(budget, { limits: { ...limits }, stats: { requests: 0, bytesRead: 0, readBytesBound: 0, decodedPixels: 0, outputPixels: 0, cacheHits: 0 }, etags: new Map(), inBatch: false, readerOpen: false, ...options });
  return budget;
}

/** One preparation lifetime: immutable catalog, bounded range I/O and decoded-block reuse, no model dependency. */
export async function createTerrainReader(options: {
  catalog: TerrainCatalog; storage: Pick<ObjectStorage, 'get' | 'head'>;
  limits?: Partial<TerrainReadLimits>; budget?: TerrainReadBudget; signal?: AbortSignal;
}): Promise<TerrainReader> {
  const catalog = terrainCatalogSchema.parse(options.catalog);
  const limits = { ...TERRAIN_READ_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(TERRAIN_READ_LIMITS, key) || !Number.isSafeInteger(value) || value < 1
        || value > TERRAIN_READ_LIMITS[key as keyof TerrainReadLimits]) throw new Error('Invalid terrain read limit');
  }
  const budget = options.budget ? budgets.get(options.budget) : undefined;
  if (options.budget && !budget) throw new Error('Invalid terrain read budget');
  if (budget?.dataId && budget.dataId !== catalog.dataId) throw new Error('Terrain read budget catalog mismatch');
  if (budget?.readerOpen) throw new Error('Terrain shared budget already has a reader');
  const stopped = new AbortController();
  const signals = [options.signal, budget?.signal, stopped.signal].filter((value): value is AbortSignal => value !== undefined);
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  signal.throwIfAborted();
  if (budget?.deadlineAt !== undefined && Date.now() >= budget.deadlineAt) throw new Error('Terrain preparation deadline exceeded');
  if (budget) { budget.readerOpen = true; budget.dataId = catalog.dataId; }
  let geotiff: typeof import('geotiff');
  try { geotiff = await import('geotiff'); signal.throwIfAborted(); }
  catch (error) { if (budget) budget.readerOpen = false; throw error; }
  const { BaseClient, BaseResponse, fromCustomClient } = geotiff;
  const tiles = new Map(catalog.tiles.map(tile => [`${tile.south}/${tile.west}`, tile]));
  const opened = new Map<string, Cached<GeoTIFFImage>>();
  const etags = budget?.etags ?? new Map<string, Proof>();
  const blocks = new Map<string, Cached<Block>>();
  let cachedPixels = 0;
  const stats: TerrainReadStats = budget?.stats ?? { requests: 0, bytesRead: 0, readBytesBound: 0, decodedPixels: 0, outputPixels: 0, cacheHits: 0 };
  let batchStart: TerrainReadStats | undefined;
  let inventoryProof: Promise<void> | undefined;
  let inBatch = false;
  let closed = false;
  function spend(kind: 'readBytesBound' | 'decodedPixels' | 'outputPixels', amount: number, maximum: number): void {
    signal.throwIfAborted();
    if (budget?.deadlineAt !== undefined && Date.now() >= budget.deadlineAt) throw new Error('Terrain preparation deadline exceeded');
    const totalMaximum = kind === 'readBytesBound' ? budget?.limits.maxReadBytes ?? maximum : kind === 'decodedPixels' ? budget?.limits.maxDecodedPixels ?? maximum : budget?.limits.maxOutputPixels ?? maximum;
    if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(stats[kind] + amount)
        || stats[kind] + amount > totalMaximum || (batchStart ? stats[kind] - batchStart[kind] + amount : stats[kind] + amount) > maximum) throw new Error(`Terrain ${kind} budget exceeded`);
    stats[kind] += amount;
  }
  function touch<T>(cache: Map<string, T>, key: string): T | undefined {
    const entry = cache.get(key);
    if (entry) { cache.delete(key); cache.set(key, entry); }
    return entry;
  }
  function evict<T>(cache: Map<string, Cached<T>>): number {
    for (const [key, entry] of cache) {
      if (entry.settled) { cache.delete(key); return entry.pixels; }
    }
    throw new Error('Terrain concurrent reads exceed cache budget');
  }
  async function imageFor(tile: TerrainTile): Promise<GeoTIFFImage> {
    signal.throwIfAborted();
    const key = tile.id;
    const hit = touch(opened, key);
    if (hit) return hit.promise;
    while (opened.size >= limits.maxOpenTiles) evict(opened);
    const entry: Cached<GeoTIFFImage> = { promise: Promise.resolve(null as never), settled: false, pixels: 0 };
    entry.promise = (async () => {
      const previous = etags.get(key), reserved = previous ? 0 : tile.asset.bytes;
      if (reserved) spend('readBytesBound', reserved, limits.maxReadBytes);
      let actual = 0, expectedEtag: string;
      try {
        stats.requests++;
        const head = await options.storage.head(tile.asset.key, signal);
        signal.throwIfAborted();
        if (!head || head.size !== tile.asset.bytes || (previous && (previous.etag !== head.etag || previous.key !== tile.asset.key || previous.sha256 !== tile.asset.sha256 || previous.size !== head.size))) throw new Error(`Missing or changed terrain asset: ${key}`);
        expectedEtag = head.etag;
        if (!previous) {
          let digest = head.computedSha256;
          if (digest !== undefined) actual = reserved;
          else {
            const hash = createHash('sha256');
            if (Math.ceil(tile.asset.bytes / limits.maxRangeBytes) > 4096) throw new Error('Terrain byte range exceeds identity proof request budget');
            for (let offset = 0; offset < tile.asset.bytes; offset += limits.maxRangeBytes) {
              signal.throwIfAborted();
              if (budget?.deadlineAt !== undefined && Date.now() >= budget.deadlineAt) throw new Error('Terrain preparation deadline exceeded');
              const length = Math.min(limits.maxRangeBytes, tile.asset.bytes - offset);
              stats.requests++;
              actual += length;
              const part = await options.storage.get(tile.asset.key, { offset, length }, length, signal, () => { spend('readBytesBound', length, limits.maxReadBytes); stats.requests++; });
              stats.bytesRead += part?.bytes.byteLength ?? 0;
              signal.throwIfAborted();
              if (!part || part.bytes.byteLength !== length || part.etag !== expectedEtag) throw new Error(`Missing or changed terrain range: ${key}`);
              hash.update(part.bytes);
            }
            digest = hash.digest('hex');
          }
          if (digest !== tile.asset.sha256) throw new Error(`Invalid terrain asset hash: ${key}`);
          etags.set(key, { etag: expectedEtag, key: tile.asset.key, sha256: tile.asset.sha256, size: head.size });
        }
      } finally { stats.readBytesBound -= reserved - actual; }
      class StorageClient extends BaseClient {
        async request(request?: RequestInit) {
          signal.throwIfAborted();
          const range = new Headers(request?.headers).get('Range');
          const match = range?.match(/^bytes=(\d+)-(\d+)$/);
          if (!match) throw new Error('Terrain reader requires one bounded byte range');
          const offset = Number(match[1]), end = Math.min(Number(match[2]), tile.asset.bytes - 1);
          const length = end - offset + 1;
          if (!Number.isSafeInteger(offset) || offset < 0 || length < 1 || length > limits.maxRangeBytes) throw new Error('Terrain byte range exceeds bounds');
          spend('readBytesBound', length, limits.maxReadBytes);
          stats.requests++;
          const result = await options.storage.get(tile.asset.key, { offset, length }, length, signal, () => { spend('readBytesBound', length, limits.maxReadBytes); stats.requests++; });
          stats.bytesRead += result?.bytes.byteLength ?? 0;
          signal.throwIfAborted();
          if (!result || result.bytes.length !== length || result.etag !== expectedEtag) throw new Error(`Missing or changed terrain range: ${key}`);
          const data = result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength) as ArrayBuffer;
          return new class extends BaseResponse {
            get status() { return 206; }
            getHeader(name: string) { return name.toLowerCase() === 'content-range' ? `bytes ${offset}-${end}/${tile.asset.bytes}` : undefined; }
            async getData() { return data; }
          }();
        }
      }
      const tiff = await fromCustomClient(new StorageClient(key), { allowFullFile: false }, signal);
      const image = await tiff.getImage(0);
      signal.throwIfAborted();
      validateImage(image, tile, catalog.packing.blockSize);
      return image;
    })();
    opened.set(key, entry);
    try { return await entry.promise; }
    catch (error) { if (opened.get(key) === entry) opened.delete(key); throw error; }
    finally { entry.settled = true; }
  }
  async function blockFor(tile: TerrainTile, column: number, row: number): Promise<Block> {
    signal.throwIfAborted();
    const size = catalog.packing.blockSize;
    const col = Math.floor(column / size) * size, top = Math.floor(row / size) * size;
    const key = `${tile.id}/${col}/${top}`;
    const hit = touch(blocks, key);
    if (hit) { stats.cacheHits++; return hit.promise; }
    const pixels = size * size;
    if (pixels > limits.maxCachedPixels) throw new Error('Terrain block exceeds cache budget');
    while (cachedPixels + pixels > limits.maxCachedPixels) cachedPixels -= evict(blocks);
    spend('decodedPixels', pixels, limits.maxDecodedPixels);
    cachedPixels += pixels;
    const entry: Cached<Block> = { promise: Promise.resolve(null as never), settled: false, pixels };
    entry.promise = (async () => {
      const image = await imageFor(tile);
      const width = Math.min(size, tile.geometry.width - col), height = Math.min(size, tile.geometry.height - top);
      const values = await image.readRasters({ window: [col, top, col + width, top + height], samples: [0], interleave: true, signal });
      signal.throwIfAborted();
      if (!(values instanceof Float32Array) || values.length !== width * height) throw new Error('Invalid native terrain block');
      return { values, width, height, col, row: top };
    })();
    blocks.set(key, entry);
    try { return await entry.promise; }
    catch (error) { if (blocks.get(key) === entry) { blocks.delete(key); cachedPixels -= pixels; } throw error; }
    finally { entry.settled = true; }
  }
  function tileAt(latitude: number, longitude: number) {
    return tiles.get(`${cellSouth(latitude)}/${Math.floor(wrap(longitude))}`);
  }
  async function proveOcean(): Promise<void> {
    if (!inventoryProof) {
      spend('readBytesBound', TERRAIN_INVENTORY_BYTES, limits.maxReadBytes);
      stats.requests++;
      inventoryProof = verifyTerrainCatalogInventory(catalog, options.storage, signal, () => { spend('readBytesBound', TERRAIN_INVENTORY_BYTES, limits.maxReadBytes); stats.requests++; }).then(() => { stats.bytesRead += TERRAIN_INVENTORY_BYTES; });
    }
    await inventoryProof;
  }
  async function valueAt(latitude: number, longitude: number): Promise<{ elevationM: number; source: 'dem' | 'ocean' } | null> {
    if (latitude < -90 || latitude > 90) return null;
    const lon = wrap(longitude), tile = tileAt(latitude, lon);
    if (!tile) { await proveOcean(); return { elevationM: 0, source: 'ocean' }; }
    const g = tile.geometry;
    const x = snap((lon - g.lon0) / g.dx), y = snap((latitude - g.lat0) / g.dy);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= g.width || y < 0 || y >= g.height) return null;
    const block = await blockFor(tile, x, y);
    const elevationM = block.values[(y - block.row) * block.width + x - block.col];
    return Number.isFinite(elevationM) && elevationM !== tile.nodata ? { elevationM, source: 'dem' } : null;
  }
  async function rowValue(latitude: number, longitude: number) {
    const lon = wrap(longitude), tile = tileAt(latitude, lon);
    const g = tile?.geometry ?? oceanGeometry(cellSouth(latitude), Math.floor(lon));
    const x = snap((lon - g.lon0) / g.dx), left = Math.floor(x), fraction = x - left;
    const first = await valueAt(latitude, g.lon0 + left * g.dx);
    if (!first || fraction === 0) return first;
    const second = await valueAt(latitude, g.lon0 + (left + 1) * g.dx);
    return mix(first, second, fraction);
  }
  function pointBlocks(latitude: number, longitude: number): string {
    const lon = wrap(longitude), tile = tileAt(latitude, lon);
    const g = tile?.geometry ?? oceanGeometry(cellSouth(latitude), Math.floor(lon));
    const y = snap((latitude - g.lat0) / g.dy), top = Math.floor(y), keys = new Set<string>();
    const rows = [g.lat0 + top * g.dy];
    if (y !== top) rows.push(g.lat0 + (top + 1) * g.dy);
    for (const lat of rows) {
      const rowTile = tileAt(lat, lon), rowGeometry = rowTile?.geometry ?? oceanGeometry(cellSouth(lat), Math.floor(lon));
      const x = snap((lon - rowGeometry.lon0) / rowGeometry.dx), left = Math.floor(x);
      const columns = [rowGeometry.lon0 + left * rowGeometry.dx];
      if (x !== left) columns.push(rowGeometry.lon0 + (left + 1) * rowGeometry.dx);
      for (const column of columns) {
        if (lat < -90 || lat > 90) continue;
        const wrapped = wrap(column), donor = tileAt(lat, wrapped);
        if (!donor) continue;
        const dx = snap((wrapped - donor.geometry.lon0) / donor.geometry.dx);
        const dy = snap((lat - donor.geometry.lat0) / donor.geometry.dy);
        if (!Number.isInteger(dx) || !Number.isInteger(dy) || dx < 0 || dx >= donor.geometry.width || dy < 0 || dy >= donor.geometry.height) continue;
        keys.add(`${donor.id}/${Math.floor(dx / catalog.packing.blockSize)}/${Math.floor(dy / catalog.packing.blockSize)}`);
      }
    }
    return [...keys].sort().join('|');
  }
  function validatePoint(latitude: number, longitude: number): void {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new Error('Invalid terrain point');
  }
  async function samplePoint(latitude: number, longitude: number) {
    const lon = wrap(longitude), tile = tileAt(latitude, lon);
    const g = tile?.geometry ?? oceanGeometry(cellSouth(latitude), Math.floor(lon));
    const y = snap((latitude - g.lat0) / g.dy), top = Math.floor(y), fraction = y - top;
    const first = await rowValue(g.lat0 + top * g.dy, lon);
    if (!first || fraction === 0) return first;
    const second = await rowValue(g.lat0 + (top + 1) * g.dy, lon);
    return mix(first, second, fraction);
  }
  return {
    sourceBlocks(latitude, longitude) { validatePoint(latitude, longitude); return pointBlocks(latitude, longitude); },
    async sample(latitude, longitude) {
      if (budget) throw new Error('Terrain shared budget requires batch reads');
      validatePoint(latitude, longitude);
      spend('outputPixels', 1, limits.maxOutputPixels);
      return samplePoint(latitude, longitude);
    },
    async sampleBatch(points) {
      signal.throwIfAborted();
      if (inBatch || budget?.inBatch) throw new Error('Terrain concurrent batches exceed budget');
      if (points.length > TERRAIN_BATCH_POINTS) throw new Error('Terrain batch point budget exceeded');
      for (const point of points) validatePoint(point.latitude, point.longitude);
      inBatch = true;
      if (budget) budget.inBatch = true;
      batchStart = budget ? { ...stats } : undefined;
      try {
        spend('outputPixels', points.length, limits.maxOutputPixels);
        const ordered = points.map((point, index) => ({ point, index, blocks: pointBlocks(point.latitude, point.longitude) }));
        ordered.sort((a, b) => a.blocks < b.blocks ? -1 : a.blocks > b.blocks ? 1 : a.index - b.index);
        const result: Array<{ elevationM: number; source: 'dem' | 'ocean' } | null> = Array(points.length);
        for (const { point, index } of ordered) {
          signal.throwIfAborted();
          if (budget?.deadlineAt !== undefined && Date.now() >= budget.deadlineAt) throw new Error('Terrain preparation deadline exceeded');
          result[index] = await samplePoint(point.latitude, point.longitude);
        }
        return result;
      } finally { batchStart = undefined; inBatch = false; if (budget) { budget.inBatch = false; if (closed) budget.readerOpen = false; } }
    },
    async *readWindows(bounds) {
      if (budget) throw new Error('Terrain shared budget requires batch reads');
      signal.throwIfAborted();
      const sections = sectionsFor(bounds, tiles, limits.maxOutputPixels - stats.outputPixels);
      const count = sections.reduce((sum, part) => sum + (part.right - part.left) * (part.bottom - part.top), 0);
      spend('outputPixels', count, limits.maxOutputPixels);
      if (sections.some(part => !part.tile)) await proveOcean();
      const size = catalog.packing.blockSize;
      for (const part of sections) {
        for (let row = part.top; row < part.bottom;) {
          const bottom = Math.min(part.bottom, (Math.floor(row / size) + 1) * size);
          for (let col = part.left; col < part.right;) {
            signal.throwIfAborted();
            const right = Math.min(part.right, (Math.floor(col / size) + 1) * size);
            const width = right - col, height = bottom - row;
            const values = new Float32Array(width * height), missing = new Uint8Array(values.length);
            if (part.tile) {
              const block = await blockFor(part.tile, col, row);
              for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
                const value = block.values[(row + y - block.row) * block.width + col + x - block.col];
                const i = y * width + x;
                values[i] = value;
                missing[i] = Number(!Number.isFinite(value) || value === part.tile.nodata);
              }
            }
            yield { geometry: { ...part.geometry, width, height, lon0: part.geometry.lon0 + col * part.geometry.dx, lat0: part.geometry.lat0 + row * part.geometry.dy }, values, missing, source: part.tile ? 'dem' : 'ocean' };
            col = right;
          }
          row = bottom;
        }
      }
    },
    stats: () => ({ ...stats }),
    close() { if (closed) return; closed = true; stopped.abort(new Error('Terrain reader closed')); opened.clear(); blocks.clear(); if (budget && !inBatch) budget.readerOpen = false; else if (!budget) etags.clear(); cachedPixels = 0; }
  };
}

function validateImage(image: GeoTIFFImage, tile: TerrainTile, blockSize: number): void {
  const keys = image.getGeoKeys(), registration = keys?.GTRasterTypeGeoKey;
  if (keys?.GeographicTypeGeoKey !== 4326 || keys.ProjectedCSTypeGeoKey !== undefined || (registration !== 1 && registration !== 2)
      || !image.isTiled || image.getTileWidth() !== blockSize || image.getTileHeight() !== blockSize
      || image.getSamplesPerPixel() !== 1 || image.getSampleFormat() !== 3 || image.getBitsPerSample() !== 32) throw new Error('Unsupported terrain COG geometry or sample format');
  const transform = image.fileDirectory.getValue('ModelTransformation');
  if (transform && (transform[1] !== 0 || transform[4] !== 0)) throw new Error('Rotated terrain rasters are unsupported');
  const [x, y] = image.getOrigin(), [dx, dy] = image.getResolution();
  const actual = { width: image.getWidth(), height: image.getHeight(), lon0: x + (registration === 1 ? dx / 2 : 0), lat0: y + (registration === 1 ? dy / 2 : 0), dx, dy };
  for (const key of Object.keys(actual) as Array<keyof TerrainGeometry>) {
    if (!Number.isFinite(actual[key]) || Math.abs(actual[key] - tile.geometry[key]) > 1e-9) throw new Error('Terrain COG does not match catalog geometry');
  }
  const nodata = image.getGDALNoData();
  if ((Number.isNaN(nodata) ? null : nodata) !== tile.nodata) throw new Error('Terrain COG does not match catalog nodata');
}
function wrap(longitude: number): number { return ((longitude + 180) % 360 + 360) % 360 - 180; }
function cellSouth(latitude: number): number { return Math.max(-90, Math.min(89, Math.ceil(latitude) - 1)); }
function snap(value: number): number {
  const nearest = Math.round(value);
  return Math.abs(value - nearest) <= 1e-8 ? nearest : value;
}
function mix(a: { elevationM: number; source: 'dem' | 'ocean' }, b: typeof a | null, fraction: number): typeof a | null {
  return b ? { elevationM: a.elevationM * (1 - fraction) + b.elevationM * fraction, source: a.source === 'ocean' && b.source === 'ocean' ? 'ocean' : 'dem' } : null;
}
function oceanGeometry(south: number, west: number): TerrainGeometry {
  const latitude = Math.min(Math.abs(south), Math.abs(south + 1));
  const width = latitude < 50 ? 1200 : latitude < 60 ? 800 : latitude < 70 ? 600 : latitude < 80 ? 400 : latitude < 85 ? 240 : 120;
  return { width, height: 1200, lon0: west, lat0: south + 1, dx: 1 / width, dy: -1 / 1200 };
}
function sectionsFor(bounds: GeographicBounds, tiles: Map<string, TerrainTile>, maximum: number): Section[] {
  const [west, south, east, north] = bounds;
  if (!bounds.every(Number.isFinite) || west < -180 || west > 180 || east < -180 || east > 180 || south < -90 || north > 90 || south > north || west === east) throw new Error('Invalid terrain window bounds');
  const longitudeRanges = west < east ? [[west, east]] : [[west, 180], [-180, east]];
  // The provider owns the +180-degree sample in its -180-degree geocell.
  if (east === 180 && west > -180) longitudeRanges.push([-180, -180]);
  const result: Section[] = [];
  let pixels = 0;
  for (const [left, right] of longitudeRanges) {
    for (let s = Math.max(-90, Math.ceil(south) - 1); s <= Math.min(89, Math.ceil(north) - 1); s++) {
      for (let w = Math.floor(left); w <= Math.min(179, Math.floor(right)); w++) {
        const tile = tiles.get(`${s}/${w}`), geometry = tile?.geometry ?? oceanGeometry(s, w);
        const x0 = Math.max(0, Math.ceil(snap((left - geometry.lon0) / geometry.dx)));
        const x1 = Math.min(geometry.width, Math.floor(snap((right - geometry.lon0) / geometry.dx)) + 1);
        const y0 = Math.max(0, Math.ceil(snap((north - geometry.lat0) / geometry.dy)));
        const y1 = Math.min(geometry.height, Math.floor(snap((south - geometry.lat0) / geometry.dy)) + 1);
        if (x0 < x1 && y0 < y1) {
          pixels += (x1 - x0) * (y1 - y0);
          if (pixels > maximum) throw new Error('Terrain outputPixels budget exceeded');
          result.push({ tile, geometry, left: x0, top: y0, right: x1, bottom: y1 });
        }
      }
    }
  }
  return result;
}
import { createHash } from 'node:crypto';
