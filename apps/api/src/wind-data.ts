import { WIND_CHUNK_LIMIT, WIND_FRAME_LIMIT, WIND_INDEX_ENTRIES, WIND_ROOT_LIMIT, windDataSchema, parseWindFrame, windLayout } from '@av/contracts/wind-data';
import type { ManifestV5, StoredModelPointer } from '@av/contracts';
import { sha256 } from './coverage';
import { ensureLive, fail } from './http';
import { binaryRead, ByteCache, countCacheHit, getR2Object, parseBoundedJson, readObjectBytes, type WaitContext } from './resources';

type Entry = StoredModelPointer['retained'][number];
const caches = new WeakMap<R2Bucket, ByteCache<string, Uint8Array>>();

async function verified(bucket: R2Bucket, key: string, ref: { bytes: number; sha256: string }, limit: number, expiresAt: string, ctx: WaitContext, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  let cache = caches.get(bucket);
  if (!cache) { cache = new ByteCache(128, 4 * 1024 * 1024); caches.set(bucket, cache); }
  const cacheKey = JSON.stringify(['wind-object', key, ref.sha256, ref.bytes, limit]);
  const hit = cache.get(cacheKey);
  if (hit) { countCacheHit(ctx); return hit; }
  return binaryRead(bucket, cacheKey, async ownerSignal => {
    const cached = cache!.get(cacheKey);
    if (cached) return cached;
    const object = await getR2Object(bucket, key, ctx);
    if (!object) return fail(503, 'publication-incomplete', 'Wind data object missing');
    const bytes = await readObjectBytes(object, limit, false, ctx, ownerSignal);
    if (bytes.length !== ref.bytes || await sha256(bytes) !== ref.sha256) return fail(503, 'publication-invalid', 'Wind data digest mismatch');
    ownerSignal.throwIfAborted();
    cache!.set(cacheKey, bytes, bytes.byteLength, Date.parse(expiresAt));
    return bytes;
  }, ctx, signal);
}

async function loadFrame(bucket: R2Bucket, m: ManifestV5, entry: Entry, frame: string, ctx: WaitContext, signal: AbortSignal) {
  if (!entry.mapData) return fail(409, 'product-unavailable', 'Numeric wind is unavailable for this build');
  if (!m.frames.slice(0, m.mapFrameCount ?? m.frames.length).some(item => item.id === frame)) return fail(404, 'unknown-resource', 'Unknown numeric frame');
  ensureLive(entry.expiresAt);
  const prefix = `builds/${m.model}/${m.buildId}`;
  const rootBytes = await verified(bucket, `${prefix}/map-data.json`, entry.mapData, WIND_ROOT_LIMIT, entry.expiresAt, ctx, signal);
  let root;
  try { root = windDataSchema.parse(parseBoundedJson(rootBytes)); } catch { return fail(503, 'publication-invalid', 'Invalid wind descriptor'); }
  const expectedFrames = m.frames.slice(0, m.mapFrameCount ?? m.frames.length).map(item => item.id);
  if (root.model !== m.model || root.buildId !== m.buildId || root.frames.length !== expectedFrames.length || root.frames.some((item, i) => item.id !== expectedFrames[i])) return fail(503, 'publication-invalid', 'Wind descriptor identity mismatch');
  const ref = root.frames.find(item => item.id === frame)!;
  const bytes = await verified(bucket, `${prefix}/map-data/${frame}.json`, ref, WIND_FRAME_LIMIT, entry.expiresAt, ctx, signal);
  let descriptor;
  try { descriptor = parseWindFrame(bytes); } catch { return fail(503, 'publication-invalid', 'Invalid wind frame descriptor'); }
  if (descriptor.frame !== frame) return fail(503, 'publication-invalid', 'Wind frame identity mismatch');
  for (const kind of ['wind', 'fine'] as const) {
    const surface = m.surfaces.find(item => item.kind === (kind === 'wind' ? 'native' : 'fine'));
    if (!surface) return fail(503, 'publication-invalid', 'Wind grid missing');
    const size = kind === 'wind' ? descriptor.tileSize : descriptor.fineTileSize;
    const { count: tiles, chunkBytes, pages, pageCount } = windLayout(surface.grid.width, surface.grid.height, size, kind === 'wind' ? descriptor.levels : undefined);
    if (!Number.isSafeInteger(tiles) || chunkBytes > WIND_CHUNK_LIMIT || descriptor[kind].length !== pages) return fail(503, 'publication-invalid', 'Invalid wind grid layout');
    for (let i = 0; i < descriptor[kind].length; i++) {
      const shard = descriptor[kind][i], count = pageCount(i);
      if (shard.count !== count || shard.bytes !== count * chunkBytes) return fail(503, 'publication-invalid', 'Invalid wind shard layout');
    }
  }
  ensureLive(entry.expiresAt);
  signal.throwIfAborted();
  return { descriptor, bytes, prefix };
}

export async function windFrame(bucket: R2Bucket, m: ManifestV5, entry: Entry, frame: string, ctx: WaitContext, signal: AbortSignal) {
  const result = await loadFrame(bucket, m, entry, frame, ctx, signal);
  return { ...result, bytes: result.bytes.slice() };
}

export async function windChunk(bucket: R2Bucket, m: ManifestV5, entry: Entry, frame: string, kind: 'wind' | 'fine', tile: number, ctx: WaitContext, signal: AbortSignal) {
  const { descriptor, prefix } = await loadFrame(bucket, m, entry, frame, ctx, signal);
  const page = Math.floor(tile / WIND_INDEX_ENTRIES), index = tile % WIND_INDEX_ENTRIES, shard = descriptor[kind][page];
  if (!shard || index >= shard.count) return fail(404, 'unknown-resource', 'Unknown wind chunk');
  const indexes = await verified(bucket, `${prefix}/map-data/${frame}/${kind}-${page}.idx`, { bytes: shard.count * 32, sha256: shard.indexSha256 }, WIND_INDEX_ENTRIES * 32, entry.expiresAt, ctx, signal);
  const length = shard.bytes / shard.count, offset = index * length;
  const expected = Array.from(indexes.subarray(index * 32, (index + 1) * 32), byte => byte.toString(16).padStart(2, '0')).join('');
  const key = `${prefix}/map-data/${frame}/${kind}-${page}.bin`;
  const bytes = await binaryRead(bucket, JSON.stringify(['wind-range', key, shard.sha256, shard.bytes, offset, length, expected]), async ownerSignal => {
    const object = await getR2Object(bucket, key, ctx, { range: { offset, length } });
    if (!object || !('body' in object)) return fail(503, 'publication-incomplete', 'Wind shard missing');
    if (object.size !== shard.bytes || object.customMetadata?.sha256 !== shard.sha256 || !object.range || !('offset' in object.range) || object.range.offset !== offset || !('length' in object.range) || object.range.length !== length) {
      void object.body.cancel().catch(() => {}); return fail(503, 'publication-invalid', 'Wind shard range mismatch');
    }
    const result = await readObjectBytes(object, length, true, ctx, ownerSignal);
    if (result.length !== length || await sha256(result) !== expected) return fail(503, 'publication-invalid', 'Wind chunk digest mismatch');
    ownerSignal.throwIfAborted();
    return result;
  }, ctx, signal);
  ensureLive(entry.expiresAt);
  signal.throwIfAborted();
  return bytes.slice();
}
