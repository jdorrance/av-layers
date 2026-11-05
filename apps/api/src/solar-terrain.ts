import { MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS, solarTerrainIndexSchema, type SolarTerrainIndex } from '@av/contracts';
import { sha256 } from './coverage';
import { cached, fail, response } from './http';
import { binaryRead, ByteCache, countCacheHit, countRead, estimateJsonBytes, MaterializedReads, parseBoundedJson, readObjectBytes, reserveAllocation, ResourceLimitError, type WaitContext } from './resources';

const INDEX_TTL_MS = 15_000;
const STATIC_CACHE_MS = 86_400_000;
interface Index { value: SolarTerrainIndex; bytes: Uint8Array; sha256: string; until: number }
const caches = new WeakMap<R2Bucket, ByteCache<string, Index>>();
const reads = new WeakMap<R2Bucket, MaterializedReads<Index>>();

async function index(bucket: R2Bucket, slug: string, generation: string | undefined, ctx: WaitContext, waiterSignal: AbortSignal): Promise<Index> {
  waiterSignal.throwIfAborted();
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug) || (generation !== undefined && !/^[a-f0-9]{12}$/.test(generation))) fail(400, 'invalid-parameter', 'Invalid solar terrain identifier');
  const key = `terrain/solar/${slug}/${generation === undefined ? '' : `${generation}/`}index.json`;
  let entries = caches.get(bucket);
  if (!entries) { entries = new ByteCache(16, 4 * 1024 * 1024); caches.set(bucket, entries); }
  const found = entries.get(key);
  if (found) { countCacheHit(ctx); return found; }
  let pending = reads.get(bucket);
  if (!pending) { pending = new MaterializedReads(4); reads.set(bucket, pending); }
  return pending.run(key, async signal => {
    countRead(ctx);
    const object = await bucket.get(key);
    if (!object) return fail(404, 'solar-unavailable', 'Solar terrain is unavailable for this launch');
    let release: () => void;
    try { release = reserveAllocation(3 * MAX_MANIFEST_BYTES); }
    catch (error) { void object.body?.cancel?.(error); throw error; }
    try {
      const bytes = await readObjectBytes(object, MAX_MANIFEST_BYTES, false, ctx, signal, true);
      let raw: unknown;
      try { raw = parseBoundedJson(bytes, MAX_MANIFEST_JSON_TOKENS); }
      catch (error) {
        if (error instanceof ResourceLimitError) throw error;
        return fail(503, 'solar-invalid', 'Invalid solar terrain JSON');
      }
      const parsed = solarTerrainIndexSchema.safeParse(raw);
      if (!parsed.success || parsed.data.slug !== slug || (generation !== undefined && parsed.data.generation !== generation)) return fail(503, 'solar-invalid', 'Invalid solar terrain index');
      const digest = await sha256(bytes);
      signal.throwIfAborted();
      if (object.customMetadata?.sha256 !== digest) return fail(503, 'solar-invalid', 'Solar terrain index hash mismatch');
      const result = { value: parsed.data, bytes, sha256: digest, until: generation === undefined ? Date.now() + INDEX_TTL_MS : Infinity };
      entries!.set(key, result, bytes.byteLength + estimateJsonBytes(parsed.data), result.until);
      return result;
    } finally { release(); }
  }, ctx, waiterSignal);
}

export async function serveSolarIndex(request: Request, bucket: R2Bucket, slug: string, generation: string | undefined, ctx: WaitContext): Promise<Response> {
  const entry = await index(bucket, slug, generation, ctx, request.signal);
  const cacheUntil = generation === undefined ? undefined : new Date(Date.now() + STATIC_CACHE_MS).toISOString();
  return cached(request, cacheUntil, ctx, async () => response(entry.bytes as Uint8Array<ArrayBuffer>, 'application/json; charset=utf-8', cacheUntil, entry.sha256),
    entry.sha256, generation === undefined ? entry.until : undefined);
}

/** Serve the exact gzip file bytes identified by the immutable generation inventory. */
export async function serveSolarAsset(request: Request, bucket: R2Bucket, slug: string, generation: string, asset: { z: string; x: string; y: string } | 'relief', ctx: WaitContext): Promise<Response> {
  if (asset !== 'relief' && ![asset.z, asset.x, asset.y].every(value => /^-?(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) && String(Number(value)) === value)) fail(400, 'invalid-parameter', 'Invalid solar tile coordinates');
  const entry = await index(bucket, slug, generation, ctx, request.signal), manifest = entry.value;
  let reference: { path: string; bytes: number; sha256: string };
  if (asset === 'relief') reference = manifest.relief;
  else {
    const z = Number(asset.z), x = Number(asset.x), y = Number(asset.y);
    const row = manifest.tiles.objects.find(group => group.z === z)?.columns.find(column => column.x === x)?.rows.find(row => row[0] === y);
    if (!row) return fail(404, 'unknown-resource', 'Solar tile is outside this generation');
    reference = { path: `${generation}/${z}/${x}/${y}.bin.gz`, bytes: row[1], sha256: row[2] };
  }
  const key = `terrain/solar/${slug}/${reference.path}`, cacheUntil = new Date(Date.now() + STATIC_CACHE_MS).toISOString();
  return cached(request, cacheUntil, ctx, async () => {
    const bytes = await binaryRead(bucket, `${key}:${reference.sha256}`, async signal => {
      const release = reserveAllocation(3 * reference.bytes);
      try {
        countRead(ctx);
        const object = await bucket.get(key);
        if (!object) return fail(503, 'solar-incomplete', 'Solar terrain asset is missing');
        const value = await readObjectBytes(object, reference.bytes, false, ctx, signal, true);
        if (value.byteLength !== reference.bytes || await sha256(value) !== reference.sha256) return fail(503, 'solar-invalid', 'Solar terrain asset hash mismatch');
        signal.throwIfAborted();
        return value;
      } finally { release(); }
    }, ctx, request.signal);
    return response(bytes as Uint8Array<ArrayBuffer>, 'application/gzip', cacheUntil, reference.sha256);
  }, reference.sha256);
}
