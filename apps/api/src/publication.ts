import { MAX_POINTER_BYTES, MAX_MANIFEST_BYTES, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, getProduct, gridSchema, getProvenanceReference, manifestSchema, modelPointerSchema, parseProvenance, validateArtifactRecords, type LayerId, type Manifest, type ModelId, type ModelPointer } from '@av/contracts';
import { resolveCoverage } from './coverage';
import { Problem, fail, validateId, ensureLive } from './http';
import { binaryRead, countRead, countCacheHit, ByteCache, MaterializedReads, readObjectBytes, readObjectJson, parseBoundedJson, reserveAllocation, estimateJsonBytes, type WaitContext } from './resources';

const POINTER_TTL_MS = 15_000;
const NEGATIVE_POINTER_TTL_MS = 5_000;
const MEMBERSHIP_REFRESH_MS = 1_000;
type PointerEntry = { pointer: ModelPointer; fetchedAt: number } | { problem: Problem };
const pointerCache = new WeakMap<R2Bucket, ByteCache<ModelId, PointerEntry>>();
const pointerReads = new WeakMap<R2Bucket, MaterializedReads<ModelPointer>>();
const manifestCache = new WeakMap<R2Bucket, ByteCache<string, Manifest>>();
const manifestReads = new WeakMap<R2Bucket, MaterializedReads<{ manifest: Manifest; bytes: number }>>();
const artifactIndexes = new WeakMap<Manifest, Map<string, Manifest['artifacts'][number] & { channel: number }>>();

export async function pointer(bucket: R2Bucket, model: ModelId, refresh = false, ctx?: WaitContext): Promise<ModelPointer> {
  let entries = pointerCache.get(bucket);
  if (!entries) { entries = new ByteCache(32, 1024 * 1024); pointerCache.set(bucket, entries); }
  const cached = entries.get(model);
  if (cached && 'problem' in cached) { countCacheHit(ctx); throw cached.problem; }
  // A membership miss queues a real refresh; it must not turn a newly discovered build into a false 404.
  if (cached && !refresh) { countCacheHit(ctx); return cached.pointer; }
  let reads = pointerReads.get(bucket);
  if (!reads) { reads = new MaterializedReads(); pointerReads.set(bucket, reads); }
  return reads.run(model, async signal => {
    const delay = cached ? Math.max(0, cached.fetchedAt + MEMBERSHIP_REFRESH_MS - Date.now()) : 0;
    if (refresh && delay) await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
      signal.addEventListener('abort', abort, { once: true });
    });
    signal.throwIfAborted();
    countRead(ctx);
    const object = await bucket.get(`catalog/${model}/latest.json`);
    if (!object) {
      const problem = new Problem(503, 'publication-unavailable', `No publication available for ${model}`);
      entries!.set(model, { problem }, 256, Date.now() + NEGATIVE_POINTER_TTL_MS);
      throw problem;
    }
    let decoded: Awaited<ReturnType<typeof readObjectJson>>;
    try { decoded = await readObjectJson(object, MAX_POINTER_BYTES, ctx, signal); }
    catch { return fail(503, 'publication-invalid', 'Invalid or oversized model pointer'); }
    const result = modelPointerSchema.safeParse(decoded.value);
    if (!result.success || result.data.model !== model) fail(503, 'publication-invalid', 'Invalid model pointer');
    entries!.set(model, { pointer: result.data, fetchedAt: Date.now() }, decoded.estimatedBytes, Date.now() + POINTER_TTL_MS);
    return result.data;
  }, ctx);
}

export async function admit(bucket: R2Bucket, model: ModelId, build: string, ctx?: WaitContext) {
  validateId(build);
  let current = await pointer(bucket, model, false, ctx);
  let entry = current.retained.find(item => item.buildId === build);
  if (!entry) {
    current = await pointer(bucket, model, true, ctx);
    entry = current.retained.find(item => item.buildId === build);
  }
  if (!entry) return fail(404, 'not-retained', 'Build is expired or not retained');
  ensureLive(entry.expiresAt);
  if (entry.manifestKey !== `builds/${model}/${build}/manifest.json`) fail(503, 'publication-invalid', 'Invalid manifest key');
  return entry;
}

export async function manifest(
  bucket: R2Bucket,
  model: ModelId,
  build: string,
  entry: Awaited<ReturnType<typeof admit>>,
  ctx?: WaitContext,
  product = getProduct(model)
): Promise<Manifest> {
  let entries = manifestCache.get(bucket);
  if (!entries) { entries = new ByteCache(64, 4 * 1024 * 1024); manifestCache.set(bucket, entries); }
  const cacheKey = `${model}/${build}`;
  let m = entries.get(cacheKey);
  if (m) countCacheHit(ctx);
  let decodedBytes = 0;
  if (!m) {
    let reads = manifestReads.get(bucket);
    if (!reads) { reads = new MaterializedReads(4); manifestReads.set(bucket, reads); }
    const loaded = await reads.run(cacheKey, async signal => {
      countRead(ctx);
      const object = await bucket.get(entry.manifestKey);
      if (!object) fail(503, 'publication-incomplete', 'Manifest is missing');
      let decoded: Awaited<ReturnType<typeof readObjectJson>>;
      try { decoded = await readObjectJson(object, MAX_MANIFEST_BYTES, ctx, signal); }
      catch { return fail(503, 'publication-invalid', 'Invalid or oversized manifest'); }
      const parsed = manifestSchema.safeParse(decoded.value);
      if (!parsed.success) fail(503, 'publication-invalid', 'Invalid manifest');
      return { manifest: parsed.data, bytes: decoded.estimatedBytes };
    }, ctx);
    m = loaded.manifest;
    decodedBytes = loaded.bytes;
  }
  if (m.model !== model || m.buildId !== build || m.expiresAt !== entry.expiresAt || m.cycle !== entry.cycle) {
    entries.delete(cacheKey);
    fail(503, 'publication-invalid', 'Manifest does not match retained entry');
  }
  ensureLive(m.expiresAt);
  if (!product || m.recipe.id !== product.id || m.recipe.source.modelFamily !== product.source.modelFamily
      || m.recipe.source.configurationId !== product.source.configurationId || m.recipe.source.domainId !== product.source.domainId
      || m.coverage.id !== product.coverageId || m.coverage.maxZoom > product.maxNativeZoom
      || m.layers.some(layer => !product.layers.includes(layer)) || JSON.stringify(m.grid) !== JSON.stringify(gridSchema.parse(product.grid))) {
    fail(503, 'publication-invalid', 'Publication does not match admitted product');
  }
  const { layout: sampleLayout } = await resolveCoverage(bucket, m, ctx);
  if (!artifactIndexes.has(m)) {
    provenanceReference(m);
    try { validateArtifactRecords(m); } catch { fail(503, 'publication-invalid', 'Invalid artifact records or sample pack metadata'); }
    if (m.samples.storedCells !== sampleLayout.storedCells) fail(503, 'publication-invalid', 'Sample pack layout does not match coverage');
    const frames = new Map(m.frames.map((frame, i) => [frame.id, i]));
    const layers = new Map(m.layers.map((layer, i) => [layer, i]));
    const index = new Map<string, Manifest['artifacts'][number] & { channel: number }>();
    for (const item of m.artifacts) {
      index.set(`${item.layer}/${item.frame}`, { ...item, channel: frames.get(item.frame)! * m.layers.length + layers.get(item.layer)! });
    }
    artifactIndexes.set(m, index);
  }
  if (decodedBytes) {
    // The artifact lookup duplicates records and keys retained with this manifest.
    for (const [key, item] of artifactIndexes.get(m)!) decodedBytes += 64 + key.length * 2 + estimateJsonBytes(item);
    entries.set(cacheKey, m, decodedBytes, Date.parse(m.expiresAt));
  }
  return m;
}

export function provenanceReference(m: Manifest) {
  try {
    return getProvenanceReference(m);
  } catch {
    return fail(503, 'publication-invalid', 'Invalid provenance reference');
  }
}

export function servedSource(m: Manifest, origin: string): Manifest['source'] {
  provenanceReference(m);
  return { ...m.source, provenanceUrl: `${origin}/v1/models/${m.model}/runs/${m.buildId}/provenance` };
}

export function artifact(m: Manifest, layer: LayerId, frame: string) {
  validateId(frame);
  if (!m.layers.includes(layer) || !m.frames.some(f => f.id === frame)) fail(404, 'unknown-resource', 'Unknown frame or layer');
  const item = artifactIndexes.get(m)?.get(`${layer}/${frame}`);
  if (!item) fail(503, 'publication-incomplete', 'Artifact missing from manifest');
  const prefix = `builds/${m.model}/${m.buildId}`;
  if (item.tilesKey !== `${prefix}/${layer}/${frame}.pmtiles`) {
    fail(503, 'publication-invalid', 'Invalid artifact key');
  }
  return item;
}

export function readProvenance(bucket: R2Bucket, m: Manifest, reference: ReturnType<typeof provenanceReference>, ctx: WaitContext): Promise<Uint8Array> {
  return binaryRead(bucket, `${reference.key}:${reference.sha256}`, async signal => {
    // Verification stays in the coalesced operation; consumers never reparse the receipt.
    countRead(ctx);
    const object = await bucket.get(reference.key);
    if (!object) fail(503, 'publication-incomplete', 'Provenance is missing');
    if (signal.aborted) { void object.body?.cancel?.(signal.reason); throw signal.reason; }
    let release: () => void;
    try { release = reserveAllocation(12 * MAX_PROVENANCE_BYTES); }
    catch (error) { void object.body?.cancel?.(error); throw error; }
    try {
      const value = await readObjectBytes(object, MAX_PROVENANCE_BYTES, false, ctx, signal);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value as Uint8Array<ArrayBuffer>)), byte => byte.toString(16).padStart(2, '0')).join('');
      signal.throwIfAborted();
      if (digest !== reference.sha256) fail(503, 'publication-invalid', 'Provenance hash mismatch');
      try { parseProvenance(parseBoundedJson(value, MAX_PROVENANCE_JSON_TOKENS), m); }
      catch { return fail(503, 'publication-invalid', 'Invalid provenance JSON or identity'); }
      return value;
    } finally { release(); }
  }, ctx);
}
