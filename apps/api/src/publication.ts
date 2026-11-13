import { getProduct } from '@av/contracts/models';
import { MAX_POINTER_BYTES, MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS, MAX_NATIVE_ZOOM, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, PRECIPITATION_METHOD, PRECIPITATION_ALL_HOURS_METHOD, canonicalGridJson, createWholeDomainDescriptors, getProvenanceReference, manifestV5Schema, modelPointerSchema, parseProvenance, parseFrameProvenance, planWholeDomainGrid, sameGrid, sameJsonValue, type LayerId, type ManifestV5, type ModelId, type ModelPointer, type ProductDefinition } from '@av/contracts';
import { sha256 } from './coverage';
import { matchStorageBytes, storeStorageBytes } from './storage-cache';
import { Problem, fail, validateId, ensureLive } from './http';
import { binaryRead, getR2Object, countCacheHit, ByteCache, MaterializedReads, ResourceLimitError, readObjectBytes, parseBoundedJson, estimateJsonBytes, reserveAllocation, waitFor, type WaitContext } from './resources';

const POINTER_TTL_MS = 15_000;
const NEGATIVE_POINTER_TTL_MS = 5_000;
const MEMBERSHIP_REFRESH_MS = 1_000;
type PointerEntry = { pointer: ModelPointer; fetchedAt: number } | { problem: Problem };
const pointerCache = new WeakMap<R2Bucket, ByteCache<ModelId, PointerEntry>>();
const pointerReads = new WeakMap<R2Bucket, MaterializedReads<ModelPointer>>();
const pointerStates = new WeakMap<ModelPointer | Problem, { until: number; identity: string }>();
const manifestCache = new WeakMap<R2Bucket, ByteCache<string, ManifestV5>>();
interface ManifestRead { manifest: ManifestV5; bytes: number; write?: { key: string; bytes: Uint8Array } }
const manifestReads = new WeakMap<R2Bucket, MaterializedReads<ManifestRead>>();
const artifactIndexes = new WeakMap<ManifestV5, Map<string, ManifestV5['artifacts'][number]>>();
const productValidations = new WeakMap<ManifestV5, { product: ProductDefinition; pending: Promise<void> }>();

function isOperationalReadFailure(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (!(error instanceof ResourceLimitError)) return false;
  return !/JSON|Object exceeds byte budget|Response exceeds byte budget/.test(error.message);
}

export async function pointer(bucket: R2Bucket, model: ModelId, refresh = false, ctx?: WaitContext, waiterSignal?: AbortSignal): Promise<ModelPointer> {
  waiterSignal?.throwIfAborted();
  let entries = pointerCache.get(bucket);
  if (!entries) { entries = new ByteCache(32, 1024 * 1024); pointerCache.set(bucket, entries); }
  const cached = entries.get(model);
  // A membership miss queues a real refresh; it must not reuse a cached entry or an older in-flight read.
  if (cached && !refresh) {
    countCacheHit(ctx);
    if ('problem' in cached) throw cached.problem;
    return cached.pointer;
  }
  let reads = pointerReads.get(bucket);
  if (!reads) { reads = new MaterializedReads(); pointerReads.set(bucket, reads); }
  return reads.run(refresh ? `${model}:refresh` : model, async signal => {
    const delay = cached && 'fetchedAt' in cached ? Math.max(0, cached.fetchedAt + MEMBERSHIP_REFRESH_MS - Date.now()) : 0;
    if (refresh && delay) await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
      signal.addEventListener('abort', abort, { once: true });
    });
    signal.throwIfAborted();
    const key = `pointer:${model}`;
    const shared = !refresh && ctx?.cacheOrigin ? await matchStorageBytes(key, MAX_POINTER_BYTES, ctx, signal) : undefined;
    if (shared && shared.until <= Date.now() + POINTER_TTL_MS) {
      try {
        const parsed = modelPointerSchema.parse(parseBoundedJson(shared.bytes));
        if (parsed.model === model && shared.until > Date.now()) {
          const identity = await sha256(new TextEncoder().encode(JSON.stringify(parsed)));
          signal.throwIfAborted();
          if (shared.until > Date.now()) {
            pointerStates.set(parsed, { until: shared.until, identity });
            entries!.set(model, { pointer: parsed, fetchedAt: shared.until - POINTER_TTL_MS }, estimateJsonBytes(parsed) + 256, shared.until);
            countCacheHit(ctx);
            return parsed;
          }
        }
      } catch { signal.throwIfAborted(); }
    }
    const object = await getR2Object(bucket, `catalog/${model}/latest.json`, ctx);
    if (!object) {
      const problem = new Problem(503, 'publication-unavailable', `No publication available for ${model}`);
      const until = Date.now() + NEGATIVE_POINTER_TTL_MS;
      pointerStates.set(problem, { until, identity: `missing:${model}` });
      entries!.set(model, { problem }, 256, until);
      throw problem;
    }
    let bytes: Uint8Array, value: unknown;
    try {
      bytes = await readObjectBytes(object, MAX_POINTER_BYTES, false, ctx, signal);
      value = parseBoundedJson(bytes);
    } catch (error) {
      if (isOperationalReadFailure(error, signal)) throw error;
      return fail(503, 'publication-invalid', 'Invalid or oversized model pointer');
    }
    const result = modelPointerSchema.safeParse(value);
    if (!result.success || result.data.model !== model) fail(503, 'publication-invalid', 'Invalid model pointer');
    const fetchedAt = Date.now(), until = fetchedAt + POINTER_TTL_MS;
    const identity = await sha256(new TextEncoder().encode(JSON.stringify(result.data)));
    signal.throwIfAborted();
    pointerStates.set(result.data, { until, identity });
    entries!.set(model, { pointer: result.data, fetchedAt }, estimateJsonBytes(value) + 256, until);
    const stored = storeStorageBytes(key, { bytes, until }, ctx);
    if (ctx) ctx.waitUntil(stored); else await stored;
    return result.data;
  }, ctx, waiterSignal);
}

export function pointerCacheState(value: ModelPointer | Problem): { until: number; identity: string } | undefined {
  return pointerStates.get(value);
}

export async function admit(bucket: R2Bucket, model: ModelId, build: string, ctx?: WaitContext, currentPointer?: ModelPointer, waiterSignal?: AbortSignal) {
  waiterSignal?.throwIfAborted();
  validateId(build);
  let current = currentPointer ?? await pointer(bucket, model, false, ctx, waiterSignal);
  let entry = current.retained.find(item => item.buildId === build);
  if (!entry) {
    current = await pointer(bucket, model, true, ctx, waiterSignal);
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
  product: ProductDefinition | undefined = getProduct(model),
  waiterSignal?: AbortSignal
): Promise<ManifestV5> {
  waiterSignal?.throwIfAborted();
  let entries = manifestCache.get(bucket);
  if (!entries) { entries = new ByteCache(64, 4 * 1024 * 1024); manifestCache.set(bucket, entries); }
  const cacheKey = `${model}/${build}`;
  let m = entries.get(cacheKey);
  if (m) countCacheHit(ctx);
  let loaded: ManifestRead | undefined;
  if (!m) {
    let reads = manifestReads.get(bucket);
    if (!reads) { reads = new MaterializedReads(4); manifestReads.set(bucket, reads); }
    loaded = await reads.run(cacheKey, async signal => {
      const key = `manifest:${entry.manifestKey}:${entry.cycle}:${entry.expiresAt}`;
      const shared = ctx?.cacheOrigin ? await matchStorageBytes(key, MAX_MANIFEST_BYTES, ctx, signal) : undefined;
      let raw: Uint8Array | undefined, published: ManifestV5 | undefined;
      if (shared && shared.until === Date.parse(entry.expiresAt)) {
        try {
          const parsed = manifestV5Schema.parse(parseBoundedJson(shared.bytes, MAX_MANIFEST_JSON_TOKENS));
          if (parsed.model === model && parsed.buildId === build && parsed.expiresAt === entry.expiresAt && parsed.cycle === entry.cycle) {
            raw = shared.bytes; published = parsed;
          }
        } catch { signal.throwIfAborted(); }
      }
      if (!published) {
        const object = await getR2Object(bucket, entry.manifestKey, ctx);
        if (!object) fail(503, 'publication-incomplete', 'Manifest is missing');
        let value: unknown;
        try {
          raw = await readObjectBytes(object, MAX_MANIFEST_BYTES, false, ctx, signal);
          value = parseBoundedJson(raw, MAX_MANIFEST_JSON_TOKENS);
        } catch (error) {
          if (isOperationalReadFailure(error, signal)) throw error;
          return fail(503, 'publication-invalid', 'Invalid or oversized manifest');
        }
        const parsed = manifestV5Schema.safeParse(value);
        if (!parsed.success) fail(503, 'publication-invalid', 'Invalid manifest');
        published = parsed.data;
      } else countCacheHit(ctx);
      provenanceReference(published);
      signal.throwIfAborted();
      const index = new Map<string, ManifestV5['artifacts'][number]>();
      let bytes = estimateJsonBytes(published) + 128;
      for (const item of published.artifacts) {
        const key = `${item.layer}/${item.frame}`;
        index.set(key, item);
        bytes += 64 + key.length * 2;
      }
      artifactIndexes.set(published, index);
      return { manifest: published, bytes, write: raw !== shared?.bytes ? { key, bytes: raw! } : undefined };
    }, ctx, waiterSignal);
    m = loaded.manifest;
  }
  if (m.model !== model || m.buildId !== build || m.expiresAt !== entry.expiresAt || m.cycle !== entry.cycle) {
    entries.delete(cacheKey);
    fail(503, 'publication-invalid', 'Manifest does not match retained entry');
  }
  ensureLive(m.expiresAt);
  await waitFor(validateProduct(m, product), waiterSignal);
  ensureLive(m.expiresAt);
  if (loaded?.write) {
    const { key, bytes } = loaded.write;
    loaded.write = undefined;
    const stored = storeStorageBytes(key, { bytes, until: Date.parse(m.expiresAt) }, ctx);
    if (ctx) ctx.waitUntil(stored); else await stored;
  }
  if (loaded) entries.set(cacheKey, m, loaded.bytes, Date.parse(m.expiresAt));
  return m;
}

async function validateProduct(m: ManifestV5, product: ProductDefinition | undefined): Promise<void> {
  if (!product) fail(503, 'publication-invalid', 'Publication does not match admitted product');
  const cached = productValidations.get(m);
  if (cached?.product === product) return cached.pending;
  const entry = { product, pending: checkProduct(m, product) };
  productValidations.set(m, entry);
  try { await entry.pending; }
  catch (error) {
    if (productValidations.get(m) === entry) productValidations.delete(m);
    throw error;
  }
}

async function checkProduct(m: ManifestV5, product: ProductDefinition): Promise<void> {
  if (m.recipe.id !== product.id || m.recipe.source.modelFamily !== product.source.modelFamily
      || m.recipe.source.configurationId !== product.source.configurationId || m.recipe.source.domainId !== product.source.domainId
      || m.layers.some(layer => !product.layers.includes(layer))) {
    fail(503, 'publication-invalid', 'Publication does not match admitted product');
  }
  const expected = createWholeDomainDescriptors({ ...product, layers: m.layers });
  // Display labels are immutable publication metadata.
  for (const layer of m.layers) expected.layers[layer].label = m.descriptors.layers[layer].label;
  if (m.descriptors.layers['precip-rate']?.methodId === PRECIPITATION_METHOD.id) {
    expected.layers['precip-rate']!.methodId = PRECIPITATION_METHOD.id;
    expected.methods = Object.fromEntries(Object.entries(expected.methods).map(([id, method]) => id === PRECIPITATION_ALL_HOURS_METHOD.id ? [PRECIPITATION_METHOD.id, PRECIPITATION_METHOD] : [id, method]));
  }
  if (product.terrainSubdivisionFactor === undefined
      || !sameJsonValue(m.descriptors, expected)) fail(503, 'publication-invalid', 'Publication does not match admitted product');
  let plan: ReturnType<typeof planWholeDomainGrid>;
  try { plan = planWholeDomainGrid(product.grid, product.terrainSubdivisionFactor); }
  catch { return fail(503, 'publication-invalid', 'Invalid product grid'); }
  for (const surface of m.surfaces) {
    const expected = surface.kind === 'native' ? plan.native : plan.fine;
    const gridHash = await sha256(new TextEncoder().encode(canonicalGridJson(expected)));
    if (!sameGrid(surface.grid, expected) || surface.gridHash !== gridHash || surface.coverage.gridHash !== gridHash
        || surface.coverage.id !== product.coverageId || surface.coverage.maxZoom > MAX_NATIVE_ZOOM) fail(503, 'publication-invalid', 'Publication surface does not match admitted product');
  }
}

export function provenanceReference(m: ManifestV5) {
  try {
    return getProvenanceReference(m);
  } catch {
    return fail(503, 'publication-invalid', 'Invalid provenance reference');
  }
}

export function servedSource(m: ManifestV5, origin: string): ManifestV5['source'] {
  provenanceReference(m);
  return { ...m.source, provenanceUrl: `${origin}/v1/models/${m.model}/runs/${m.buildId}/provenance` };
}

export function artifact(m: ManifestV5, layer: LayerId, frame: string) {
  validateId(frame);
  const item = artifactIndexes.get(m)?.get(`${layer}/${frame}`);
  if (!item) fail(404, 'unknown-resource', 'Unknown frame or layer');
  return item;
}

export function readProvenance(bucket: R2Bucket, m: ManifestV5, reference: ReturnType<typeof provenanceReference>, ctx: WaitContext, signal?: AbortSignal): Promise<Uint8Array> {
  return readVerifiedProvenance(bucket, reference, value => { parseProvenance(value, m); }, ctx, signal);
}

export async function readProvenanceFrame(bucket: R2Bucket, m: ManifestV5, frameId: string, ctx: WaitContext, signal?: AbortSignal) {
  const frame = m.frames.find(frame => frame.id === frameId);
  if (!frame) return fail(404, 'unknown-resource', 'Unknown provenance frame');
  const index = await readProvenance(bucket, m, provenanceReference(m), ctx, signal);
  signal?.throwIfAborted();
  const release = reserveAllocation(3 * index.byteLength);
  let reference;
  try {
    const value = parseProvenance(parseBoundedJson(index, MAX_PROVENANCE_JSON_TOKENS), m);
    if (value.version !== 2) return fail(409, 'provenance-frame-unavailable', 'This build publishes inline provenance');
    reference = value.frames.find(reference => reference.frame === frameId)!;
  } finally { release(); }
  const bytes = await readVerifiedProvenance(bucket, reference, raw => {
    const value = parseFrameProvenance(raw, m, frame);
    if (value.hour !== reference.hour) throw new Error('Provenance hour mismatch');
  }, ctx, signal);
  return { bytes, sha256: reference.sha256 };
}

function readVerifiedProvenance(bucket: R2Bucket, reference: { key: string; sha256: string; bytes?: number }, verify: (value: unknown) => void, ctx: WaitContext, waiterSignal?: AbortSignal): Promise<Uint8Array> {
  return binaryRead(bucket, `${reference.key}:${reference.sha256}`, async signal => {
    const object = await getR2Object(bucket, reference.key, ctx);
    if (!object) fail(503, 'publication-incomplete', 'Provenance is missing');
    if (signal.aborted) { void object.body?.cancel?.(signal.reason); throw signal.reason; }
    const limit = reference.bytes ?? object.size;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PROVENANCE_BYTES) {
      void object.body?.cancel?.();
      throw new ResourceLimitError('Provenance exceeds byte budget');
    }
    let release: () => void;
    try { release = reserveAllocation(3 * limit); }
    catch (error) { void object.body?.cancel?.(error); throw error; }
    try {
      const value = await readObjectBytes(object, limit, false, ctx, signal, true);
      if (reference.bytes !== undefined && value.byteLength !== reference.bytes) fail(503, 'publication-invalid', 'Provenance length mismatch');
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value as Uint8Array<ArrayBuffer>)), byte => byte.toString(16).padStart(2, '0')).join('');
      signal.throwIfAborted();
      if (digest !== reference.sha256) fail(503, 'publication-invalid', 'Provenance hash mismatch');
      try { verify(parseBoundedJson(value, MAX_PROVENANCE_JSON_TOKENS)); }
      catch { return fail(503, 'publication-invalid', 'Invalid provenance JSON or identity'); }
      return value;
    } finally { release(); }
  }, ctx, waiterSignal);
}
