import { WIND_FRAME_LIMIT, WIND_INDEX_ENTRIES, WIND_ROOT_LIMIT, assertWindFrameLayout, windFrameParts, windDataSchema, parseWindFrame } from '@av/contracts/wind-data';
import type { ManifestV5, StoredModelPointer } from '@av/contracts';
import { sha256 } from './coverage';
import { ensureLive, fail } from './http';
import { binaryRead, ByteCache, countCacheHit, getR2Object, parseBoundedJson, readObjectBytes, type WaitContext } from './resources';
import { matchStorageBytes, storeStorageBytes } from './storage-cache';

const MAX_WIND_SPAN_BYTES = 1024 * 1024;
const HEX = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, '0'));
const hexSlice = (bytes: Uint8Array, start: number, end: number): string => {
  let out = '';
  for (let i = start; i < end; i++) out += HEX[bytes[i]!];
  return out;
};
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
    const until = Date.parse(expiresAt), sharedKey = `wind:${key}:${ref.sha256}:${ref.bytes}`;
    const shared = ctx.cacheOrigin ? await matchStorageBytes(sharedKey, limit, ctx, ownerSignal) : undefined;
    if (shared && shared.until === until && shared.bytes.length === ref.bytes) {
      cache!.set(cacheKey, shared.bytes, shared.bytes.byteLength, until);
      countCacheHit(ctx);
      return shared.bytes;
    }
    const object = await getR2Object(bucket, key, ctx);
    if (!object) return fail(503, 'publication-incomplete', 'Wind data object missing');
    const bytes = await readObjectBytes(object, limit, false, ctx, ownerSignal);
    if (bytes.length !== ref.bytes || await sha256(bytes) !== ref.sha256) return fail(503, 'publication-invalid', 'Wind data digest mismatch');
    ownerSignal.throwIfAborted();
    cache!.set(cacheKey, bytes, bytes.byteLength, until);
    const stored = storeStorageBytes(sharedKey, { bytes, until }, ctx);
    if (ctx) ctx.waitUntil(stored); else await stored;
    return bytes;
  }, ctx, signal);
}

async function loadFrame(bucket: R2Bucket, m: ManifestV5, entry: Entry, frame: string, ctx: WaitContext, signal: AbortSignal) {
  const mapData = entry.mapData;
  if (!mapData) return fail(409, 'product-unavailable', 'Numeric wind is unavailable for this build');
  if (m.mapData && (m.mapData.sha256 !== mapData.sha256 || m.mapData.bytes !== mapData.bytes)) {
    return fail(503, 'publication-invalid', 'Wind descriptor identity mismatch');
  }
  if (!m.frames.slice(0, m.mapFrameCount ?? m.frames.length).some(item => item.id === frame)) return fail(404, 'unknown-resource', 'Unknown numeric frame');
  ensureLive(entry.expiresAt);
  const prefix = `builds/${m.model}/${m.buildId}`;
  const rootBytes = await verified(bucket, `${prefix}/map-data.json`, mapData, WIND_ROOT_LIMIT, entry.expiresAt, ctx, signal);
  let root;
  try { root = windDataSchema.parse(parseBoundedJson(rootBytes)); } catch { return fail(503, 'publication-invalid', 'Invalid wind descriptor'); }
  const expectedFrames = m.frames.slice(0, m.mapFrameCount ?? m.frames.length).map(item => item.id);
  if (root.model !== m.model || root.buildId !== m.buildId || root.frames.length !== expectedFrames.length || root.frames.some((item, i) => item.id !== expectedFrames[i])) return fail(503, 'publication-invalid', 'Wind descriptor identity mismatch');
  const ref = root.frames.find(item => item.id === frame)!;
  const bytes = await verified(bucket, `${prefix}/map-data/${frame}.json`, ref, WIND_FRAME_LIMIT, entry.expiresAt, ctx, signal);
  const native = m.surfaces.find(surface => surface.kind === 'native'), fine = m.surfaces.find(surface => surface.kind === 'fine');
  if (!native || !fine) return fail(503, 'publication-invalid', 'Wind grid missing');
  let descriptor;
  try {
    descriptor = parseWindFrame(bytes);
    assertWindFrameLayout(descriptor, { native: native.grid, fine: fine.grid });
  } catch { return fail(503, 'publication-invalid', 'Invalid wind frame descriptor'); }
  if (descriptor.frame !== frame) return fail(503, 'publication-invalid', 'Wind frame identity mismatch');
  ensureLive(entry.expiresAt);
  signal.throwIfAborted();
  return { descriptor, bytes, sha256: ref.sha256, prefix };
}

export async function windFrame(bucket: R2Bucket, m: ManifestV5, entry: Entry, frame: string, ctx: WaitContext, signal: AbortSignal) {
  const result = await loadFrame(bucket, m, entry, frame, ctx, signal);
  return { ...result, bytes: result.bytes.slice() };
}

export async function windChunk(bucket: R2Bucket, m: ManifestV5, entry: Entry, frame: string, kind: string, tile: number, ctx: WaitContext, signal: AbortSignal, count = 1): Promise<Uint8Array<ArrayBuffer> & { etag?: string }> {
  const { descriptor, prefix } = await loadFrame(bucket, m, entry, frame, ctx, signal);
  const page = Math.floor(tile / WIND_INDEX_ENTRIES), index = tile % WIND_INDEX_ENTRIES, shard = windFrameParts(descriptor).find(part => part.kind === kind)?.shards[page];
  if (!shard || count < 1 || index + count > shard.count) return fail(404, 'unknown-resource', 'Unknown wind chunk');
  const chunkBytes = shard.bytes / shard.count, offset = index * chunkBytes, length = count * chunkBytes;
  if (length > MAX_WIND_SPAN_BYTES) return fail(400, 'invalid-parameter', 'Wind chunk span exceeds byte budget');
  const indexes = await verified(bucket, `${prefix}/map-data/${frame}/${kind}-${page}.idx`, { bytes: shard.count * 32, sha256: shard.indexSha256 }, WIND_INDEX_ENTRIES * 32, entry.expiresAt, ctx, signal);
  const expected = Array.from({ length: count }, (_, k) => hexSlice(indexes, (index + k) * 32, (index + k + 1) * 32));
  const key = `${prefix}/map-data/${frame}/${kind}-${page}.bin`;
  const bytes = await binaryRead(bucket, JSON.stringify(['wind-range', key, shard.sha256, shard.bytes, offset, length, expected]), async ownerSignal => {
    const object = await getR2Object(bucket, key, ctx, { range: { offset, length } });
    if (!object || !('body' in object)) return fail(503, 'publication-incomplete', 'Wind shard missing');
    if (object.size !== shard.bytes || object.customMetadata?.sha256 !== shard.sha256 || !object.range || !('offset' in object.range) || object.range.offset !== offset || !('length' in object.range) || object.range.length !== length) {
      void object.body.cancel().catch(() => {}); return fail(503, 'publication-invalid', 'Wind shard range mismatch');
    }
    const result = await readObjectBytes(object, length, true, ctx, ownerSignal);
    if (result.length !== length) return fail(503, 'publication-invalid', 'Wind chunk digest mismatch');
    for (let k = 0; k < count; k++) {
      if (await sha256(result.subarray(k * chunkBytes, (k + 1) * chunkBytes)) !== expected[k]) return fail(503, 'publication-invalid', 'Wind chunk digest mismatch');
    }
    ownerSignal.throwIfAborted();
    return result;
  }, ctx, signal);
  ensureLive(entry.expiresAt);
  signal.throwIfAborted();
  return Object.assign(bytes.slice(), { etag: count === 1 ? expected[0]! : `${shard.sha256}-${tile}-${tile + count - 1}` });
}
