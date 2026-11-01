import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { coverageDescriptorSchema, coveragePrefix, encodeBoundedJson, MAX_MANIFEST_BYTES, MAX_POINTER_BYTES, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, parseBoundedJson, forecastObjects, getProduct, getProvenanceReference, manifestSchema, MAX_RETAINED_BUILDS, modelIdSchema, modelPointerSchema, parseProvenance, validateArtifactRecords, type Manifest, type ModelId, type ModelPointer } from '@av/contracts';
import type { ObjectStorage } from './storage.js';
import { localPath, sha256, validateBuild, wasValidatedInProcess } from './validate.js';
import { BUILD_BUDGETS } from './capacity.js';
import { readCoverage } from './coverage.js';
import { assertAuthority, type PublicationAuthority } from './authority.js';
import { putImmutable, uploadBounded } from './immutable-upload.js';
import { readLocalFile } from './local-file.js';

const decode = parseBoundedJson;
const pointerKey = (model: ModelId): string => `catalog/${model}/latest.json`;
const manifestKey = (model: ModelId, id: string): string => `builds/${model}/${id}/manifest.json`;
const safeId = (id: string): boolean => /^\d{8}T\d{6}Z-[a-f0-9-]{36}$/.test(id);
export const MAX_UPLOAD_ARTIFACT_BYTES = BUILD_BUDGETS.samplePackBytes;
export const MAX_UPLOAD_RESERVED_BYTES = 2 * MAX_UPLOAD_ARTIFACT_BYTES;

export function buildIdTime(id: string): number {
  if (!safeId(id)) throw new Error('Invalid build ID');
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(id)!;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`, time = Date.parse(iso);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== iso) throw new Error('Invalid build ID timestamp');
  return time;
}

function assertLifetime(manifest: Manifest, now: number): void {
  const start = buildIdTime(manifest.buildId);
  if (Date.parse(manifest.createdAt) < start || Date.parse(manifest.createdAt) >= start + 1000 || now < start || now - start > 6 * 3600000 || Date.parse(manifest.expiresAt) <= now) {
    throw new Error('Build is outside its publication lifetime');
  }
}

async function readPointer(store: ObjectStorage, model: ModelId, signal?: AbortSignal): Promise<{ pointer: ModelPointer | null; etag?: string }> {
  const object = await store.get(pointerKey(model), undefined, MAX_POINTER_BYTES, signal);
  if (!object) return { pointer: null };
  const pointer = modelPointerSchema.parse(decode(object.bytes));
  if (pointer.model !== model) throw new Error('Pointer model mismatch');
  return { pointer, etag: object.etag };
}

async function casPointer(store: ObjectStorage, model: ModelId, pointer: ModelPointer, etag?: string): Promise<void> {
  modelPointerSchema.parse(pointer);
  await store.put(pointerKey(model), encodeBoundedJson(pointer, MAX_POINTER_BYTES), etag ? { ifMatch: etag } : { ifNoneMatch: '*' }, 'application/json');
}

export function assertUsefulHorizon(manifest: Manifest, now: number): void {
  const product = getProduct(manifest.model);
  if (!product) throw new Error('No trusted publication recipe');
  const cycleAgeHours = (now - Date.parse(manifest.cycle)) / 3600000;
  const horizonHours = (Math.max(...manifest.frames.map(frame => Date.parse(frame.validTime))) - now) / 3600000;
  if (cycleAgeHours < 0 || cycleAgeHours > product.freshness.maxCycleAgeHours || horizonHours < product.freshness.minHorizonHours) throw new Error('Build lacks the required useful forecast horizon');
}

export async function publish(store: ObjectStorage, root: string, raw: unknown, options: { authority: PublicationAuthority; allowSameCycle?: boolean; now?: () => number; signal?: AbortSignal }): Promise<void> {
  const validatedHere = wasValidatedInProcess(root, raw);
  const now = options.now ?? Date.now, manifest = manifestSchema.parse(raw);
  assertAuthority(options.authority, manifest.model);
  const provenance = getProvenanceReference(manifest), key = manifestKey(manifest.model, manifest.buildId), content = encodeBoundedJson(manifest, MAX_MANIFEST_BYTES);
  const captured = await readPointer(store, manifest.model);
  const existing = captured.pointer?.retained.find(item => item.buildId === manifest.buildId);
  const alreadyRetained = !!existing;
  if (existing && (existing.manifestKey !== key || existing.cycle !== manifest.cycle || existing.expiresAt !== manifest.expiresAt)) throw new Error('Retained build identity mismatch');
  const check = (): void => { options.signal?.throwIfAborted(); if (!alreadyRetained) { assertLifetime(manifest, now()); assertUsefulHorizon(manifest, now()); } };
  if (captured.pointer && !alreadyRetained) {
    const latestCycle = Math.max(...captured.pointer.retained.map(item => Date.parse(item.cycle)));
    if (Date.parse(manifest.cycle) < latestCycle) throw new Error('Older cycle cannot be published');
    if (Date.parse(manifest.cycle) === latestCycle && !options.allowSameCycle) throw new Error('Same-cycle replacement requires explicit intent');
  }
  check();
  const retained = (captured.pointer?.retained ?? []).filter(item => Date.parse(item.expiresAt) > now());
  if (!alreadyRetained && retained.length >= MAX_RETAINED_BUILDS) throw new Error('Retained build limit reached');
  if (!validatedHere) await validateBuild(root, manifest, await readCoverage(root, manifest.coverage.hash), manifest.coverage.hash);
  validateArtifactRecords(manifest);
  const prefix = `builds/${manifest.model}/${manifest.buildId}/`;
  const files = forecastObjects(manifest);
  if (new Set(files.map(f => f.key)).size !== files.length || files.some(f => !f.key.startsWith(prefix))) throw new Error('Invalid artifact set');
  const sized = await Promise.all(files.map(async file => {
    const { size } = await stat(localPath(root, file.key));
    if (!size || size > MAX_UPLOAD_ARTIFACT_BYTES) throw new Error(`Artifact exceeds per-file upload limit: ${file.key}`);
    return { ...file, size };
  }));
  const coverageBytes = await readLocalFile(localPath(root, manifest.coverage.maskKey), 128 * 1024);
  if (sha256(coverageBytes) !== manifest.coverage.hash || manifest.coverage.maskKey !== `${coveragePrefix(manifest.coverage.hash)}/manifest.json`) throw new Error('Coverage descriptor hash mismatch');
  const descriptor = coverageDescriptorSchema.parse(decode(coverageBytes));
  for (const name of ['output', 'halo', 'tiles'] as const) {
    const objectKey = `${coveragePrefix(manifest.coverage.hash)}/${name}.bin`, bytes = await readLocalFile(localPath(root, objectKey), 512 * 1024, descriptor.files[name].bytes);
    if (bytes.byteLength !== descriptor.files[name].bytes || sha256(bytes) !== descriptor.files[name].sha256) throw new Error(`Coverage ${name} hash mismatch`);
    check(); await putImmutable(store, objectKey, bytes, 'application/octet-stream', options.signal);
  }
  check(); await putImmutable(store, manifest.coverage.maskKey, coverageBytes, 'application/json', options.signal);
  await uploadBounded(sized, MAX_UPLOAD_RESERVED_BYTES, async file => {
    check();
    const bytes = await readLocalFile(localPath(root, file.key), MAX_UPLOAD_ARTIFACT_BYTES, file.size);
    if (sha256(bytes) !== file.sha256) throw new Error(`Local hash mismatch: ${file.key}`);
    check(); await putImmutable(store, file.key, bytes, file.contentType, options.signal);
  });
  const provenanceBytes = await readLocalFile(localPath(root, provenance.key), MAX_PROVENANCE_BYTES);
  if (provenanceBytes.byteLength > MAX_PROVENANCE_BYTES || sha256(provenanceBytes) !== provenance.sha256) throw new Error(`Local hash mismatch: ${provenance.key}`);
  parseProvenance(decode(provenanceBytes, MAX_PROVENANCE_JSON_TOKENS), manifest);
  check(); await putImmutable(store, provenance.key, provenanceBytes, 'application/json', options.signal);
  const uploadedProvenance = await store.get(provenance.key, undefined, MAX_PROVENANCE_BYTES);
  if (!uploadedProvenance || !Buffer.from(uploadedProvenance.bytes).equals(provenanceBytes)) throw new Error('Provenance readback mismatch');
  check(); await putImmutable(store, key, content, 'application/json', options.signal);
  const uploadedManifest = await store.get(key, undefined, MAX_MANIFEST_BYTES);
  if (!uploadedManifest || !Buffer.from(uploadedManifest.bytes).equals(content)) throw new Error('Manifest readback mismatch');
  if (alreadyRetained) return;
  check();
  retained.unshift({ buildId: manifest.buildId, manifestKey: key, cycle: manifest.cycle, expiresAt: manifest.expiresAt });
  try { await casPointer(store, manifest.model, { version: 1, model: manifest.model, latestBuildId: manifest.buildId, retained }, captured.etag); }
  catch (error) {
    // Cancellation/network failure after CAS is ambiguous. Read the authority before reporting failure.
    const reconciled = await readPointer(store, manifest.model);
    if (!reconciled.pointer?.retained.some(item => item.buildId === manifest.buildId && item.manifestKey === key && item.cycle === manifest.cycle && item.expiresAt === manifest.expiresAt)) throw error;
    const committed = await store.get(key, undefined, MAX_MANIFEST_BYTES);
    if (!committed || !Buffer.from(committed.bytes).equals(content)) throw error;
  }
}

export async function rollback(store: ObjectStorage, model: ModelId, target: string, authority: PublicationAuthority, now = Date.now(), options: { signal?: AbortSignal; onPointerOutcome?: (outcome: 'unconfirmed' | 'confirmed') => void } = {}): Promise<void> {
  const started = Date.now(), check = (): void => options.signal?.throwIfAborted();
  check();
  modelIdSchema.parse(model);
  assertAuthority(authority, model);
  const captured = await readPointer(store, model, options.signal), pointer = captured.pointer;
  const retained = pointer?.retained.find(item => item.buildId === target && Date.parse(item.expiresAt) > now);
  if (!pointer || !retained || retained.manifestKey !== manifestKey(model, target)) throw new Error('Rollback target is not retained and unexpired');
  check();
  const object = await store.get(retained.manifestKey, undefined, MAX_MANIFEST_BYTES, options.signal);
  check();
  if (!object) throw new Error('Rollback manifest missing');
  const manifest = manifestSchema.parse(decode(object.bytes));
  if (manifest.buildId !== target || manifest.model !== model || manifest.cycle !== retained.cycle || manifest.expiresAt !== retained.expiresAt) {
    throw new Error('Rollback manifest does not match pointer');
  }
  const provenance = getProvenanceReference(manifest);
  const receipt = await store.get(provenance.key, undefined, MAX_PROVENANCE_BYTES, options.signal);
  check();
  if (!receipt || sha256(receipt.bytes) !== provenance.sha256) throw new Error(`Rollback provenance missing or corrupt: ${provenance.key}`);
  parseProvenance(decode(receipt.bytes, MAX_PROVENANCE_JSON_TOKENS), manifest);
  validateArtifactRecords(manifest);
  const coverageKey = `${coveragePrefix(manifest.coverage.hash)}/manifest.json`;
  if (manifest.coverage.maskKey !== coverageKey) throw new Error('Rollback coverage descriptor key mismatch');
  const coverage = await store.get(coverageKey, undefined, 128 * 1024, options.signal);
  check();
  if (!coverage || sha256(coverage.bytes) !== manifest.coverage.hash) throw new Error('Rollback coverage descriptor missing or corrupt');
  const descriptor = coverageDescriptorSchema.parse(decode(coverage.bytes));
  if (descriptor.id !== manifest.coverage.id || descriptor.maxZoom !== manifest.coverage.maxZoom || JSON.stringify(descriptor.grid) !== JSON.stringify(manifest.grid) || JSON.stringify(descriptor.bounds) !== JSON.stringify(manifest.descriptors.bounds)) throw new Error('Rollback coverage descriptor binding mismatch');
  for (const name of ['output', 'halo', 'tiles'] as const) {
    const file = descriptor.files[name], key = `${coveragePrefix(manifest.coverage.hash)}/${name}.bin`;
    await verifyRemoteHash(store, key, file.sha256, file.bytes, file.bytes, options.signal);
  }
  for (const { key, sha256: hash } of forecastObjects(manifest)) {
    await verifyRemoteHash(store, key, hash, MAX_UPLOAD_ARTIFACT_BYTES, key === manifest.samples.key ? manifest.samples.bytes : undefined, options.signal);
  }
  if (Date.parse(retained.expiresAt) <= now + (Date.now() - started)) throw new Error('Rollback target expired during verification');
  check();
  options.onPointerOutcome?.('unconfirmed'); // Persist intent before a request whose response may be lost.
  try { await casPointer(store, model, { ...pointer, latestBuildId: target }, captured.etag); }
  catch (error) {
    // Never let cancellation suppress authoritative reconciliation after a possible commit.
    const reconciled = await readPointer(store, model);
    if (reconciled.pointer?.latestBuildId !== target || !reconciled.pointer.retained.some(item => item.buildId === target && item.manifestKey === retained.manifestKey && item.cycle === retained.cycle && item.expiresAt === retained.expiresAt)) throw error;
  }
  options.onPointerOutcome?.('confirmed');
}

/** Verify large immutable objects with one bounded range live at a time. */
async function verifyRemoteHash(store: ObjectStorage, key: string, expectedHash: string, maxBytes: number, expectedBytes?: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const head = await store.head(key, signal);
  signal?.throwIfAborted();
  if (!head || !Number.isSafeInteger(head.size) || head.size < 1 || head.size > maxBytes || (expectedBytes !== undefined && head.size !== expectedBytes)) throw new Error(`Rollback object missing or invalid size: ${key}`);
  const hash = createHash('sha256');
  for (let offset = 0; offset < head.size; offset += 4 * 1024 * 1024) {
    signal?.throwIfAborted();
    const length = Math.min(4 * 1024 * 1024, head.size - offset), part = await store.get(key, { offset, length }, length, signal);
    signal?.throwIfAborted();
    if (!part || part.bytes.byteLength !== length || part.etag !== head.etag) throw new Error(`Rollback object range mismatch: ${key}`);
    hash.update(part.bytes);
  }
  if (hash.digest('hex') !== expectedHash) throw new Error(`Rollback object corrupt: ${key}`);
}

export interface CleanupObjects { objects: number; knownBytes: number; unknownSizeObjects: number }
export interface CleanupSummary {
  version: 1; prefix: string; observedAt: string; status: 'complete' | 'failed';
  listed: CleanupObjects | null; protected: CleanupObjects | null; unreferenced: CleanupObjects | null;
  eligible: CleanupObjects | null; deleted: CleanupObjects | null;
}
const emptyCleanupObjects = (): CleanupObjects => ({ objects: 0, knownBytes: 0, unknownSizeObjects: 0 });
function countCleanupObject(total: CleanupObjects, object: { size?: number }): void {
  total.objects++;
  if (Number.isSafeInteger(object.size) && object.size! >= 0 && Number.isSafeInteger(total.knownBytes + object.size!)) total.knownBytes += object.size!;
  else total.unknownSizeObjects++;
}

/** Report only the listed build prefix. Missing sizes and partial deletion failures stay explicit. */
export async function cleanup(store: ObjectStorage, model: ModelId, authority: PublicationAuthority, now = Date.now(), onReport?: (summary: CleanupSummary) => void, signal?: AbortSignal): Promise<number> {
  modelIdSchema.parse(model);
  assertAuthority(authority, model);
  const prefix = `builds/${model}/`;
  const summary: CleanupSummary = { version: 1, prefix, observedAt: new Date(now).toISOString(), status: 'failed', listed: null, protected: null, unreferenced: null, eligible: null, deleted: emptyCleanupObjects() };
  try {
    signal?.throwIfAborted();
    const captured = await readPointer(store, model, signal);
    signal?.throwIfAborted();
    if (!captured.pointer) throw new Error('Cannot cleanup without an authoritative pointer');
    const live = captured.pointer.retained.filter(item => Date.parse(item.expiresAt) > now || item.buildId === captured.pointer!.latestBuildId);
    if (live.length !== captured.pointer.retained.length) await casPointer(store, model, { ...captured.pointer, retained: live }, captured.etag);
    signal?.throwIfAborted();
    const objects = await store.list(prefix, signal);
    signal?.throwIfAborted();
    if (objects.length > 100_000) throw new Error('Object listing exceeds maintenance budget');
    summary.listed = emptyCleanupObjects();
    for (const object of objects) countCleanupObject(summary.listed, object);
    const current = await readPointer(store, model, signal);
    signal?.throwIfAborted();
    if (!current.pointer) throw new Error('Pointer disappeared during cleanup');
    const protectedIds = new Set(current.pointer.retained.map(item => item.buildId));
    const groups = new Map<string, typeof objects>();
    summary.protected = emptyCleanupObjects(); summary.unreferenced = emptyCleanupObjects();
    for (const object of objects) {
      const id = object.key.slice(prefix.length).split('/')[0];
      countCleanupObject(protectedIds.has(id) ? summary.protected : summary.unreferenced, object);
      if (!safeId(id)) continue;
      const group = groups.get(id) ?? []; group.push(object); groups.set(id, group);
    }
    const deletes: string[] = [], eligible = emptyCleanupObjects();
    for (const [id, group] of groups) {
      if (protectedIds.has(id) || buildIdTime(id) > now - 86400000 || group.some(object => object.lastModified.getTime() > now - 86400000)) continue;
      for (const object of group) { deletes.push(object.key); countCleanupObject(eligible, object); }
    }
    summary.eligible = eligible;
    signal?.throwIfAborted();
    if (deletes.length) {
      summary.deleted = null; // The provider may partially delete before reporting an error.
      await store.delete(deletes, signal);
      summary.deleted = { ...eligible };
    }
    summary.status = 'complete';
    return deletes.length;
  } finally { onReport?.(summary); }
}
