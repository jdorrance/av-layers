import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { forecastObjects, getProvenanceReference, manifestSchema, MAX_RETAINED_BUILDS, modelIdSchema, modelPointerSchema, parseProvenance, validateArtifactRecords, type Manifest, type ModelId, type ModelPointer } from '@av/contracts';
import type { ObjectStorage } from './storage.js';
import { loadCoverage, localPath, runConcurrent, sha256, validateBuild, wasValidatedInProcess } from './validate.js';
import { BUILD_BUDGETS } from './capacity.js';

const encode = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));
const decode = (value: Uint8Array): unknown => JSON.parse(Buffer.from(value).toString('utf8'));
const pointerKey = (model: ModelId): string => `catalog/${model}/latest.json`;
const manifestKey = (model: ModelId, id: string): string => `builds/${model}/${id}/manifest.json`;
const safeId = (id: string): boolean => /^\d{8}T\d{6}Z-[a-f0-9-]{36}$/.test(id);
export const UPLOAD_BUFFER_BYTES = BUILD_BUDGETS.samplePackBytes;

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

async function readPointer(store: ObjectStorage, model: ModelId): Promise<{ pointer: ModelPointer | null; etag?: string }> {
  const object = await store.get(pointerKey(model));
  if (!object) return { pointer: null };
  const pointer = modelPointerSchema.parse(decode(object.bytes));
  if (pointer.model !== model) throw new Error('Pointer model mismatch');
  return { pointer, etag: object.etag };
}

async function casPointer(store: ObjectStorage, model: ModelId, pointer: ModelPointer, etag?: string): Promise<void> {
  modelPointerSchema.parse(pointer);
  await store.put(pointerKey(model), encode(pointer), etag ? { ifMatch: etag } : { ifNoneMatch: '*' }, 'application/json');
}

export async function publish(store: ObjectStorage, root: string, raw: unknown, options: { allowSameCycle?: boolean; now?: () => number } = {}): Promise<void> {
  const validatedHere = wasValidatedInProcess(root, raw);
  const now = options.now ?? Date.now, manifest = manifestSchema.parse(raw);
  const provenance = getProvenanceReference(manifest);
  assertLifetime(manifest, now());
  const captured = await readPointer(store, manifest.model);
  if (captured.pointer) {
    const latestCycle = Math.max(...captured.pointer.retained.map(item => Date.parse(item.cycle)));
    if (Date.parse(manifest.cycle) < latestCycle) throw new Error('Older cycle cannot be published');
    if (Date.parse(manifest.cycle) === latestCycle && !options.allowSameCycle) throw new Error('Same-cycle replacement requires explicit intent');
    if (captured.pointer.retained.some(item => item.buildId === manifest.buildId)) throw new Error('Build ID already retained');
  }
  const retained = (captured.pointer?.retained ?? []).filter(item => Date.parse(item.expiresAt) > now());
  if (retained.length >= MAX_RETAINED_BUILDS) throw new Error('Retained build limit reached');
  if (!validatedHere) await validateBuild(root, manifest, await loadCoverage());
  const prefix = `builds/${manifest.model}/${manifest.buildId}/`;
  const files = forecastObjects(manifest);
  if (new Set(files.map(f => f.key)).size !== files.length || files.some(f => !f.key.startsWith(prefix))) throw new Error('Invalid artifact set');
  await runConcurrent(files, 4, async file => {
    assertLifetime(manifest, now());
    const bytes = await readFile(localPath(root, file.key));
    if (!bytes.length || bytes.length > UPLOAD_BUFFER_BYTES) throw new Error(`Artifact exceeds upload buffer budget: ${file.key}`);
    if (sha256(bytes) !== file.sha256) throw new Error(`Local hash mismatch: ${file.key}`);
    const length = Math.min(bytes.length, 32);
    const md5 = createHash('md5').update(bytes).digest();
    const expectedEtag = `"${md5.toString('hex')}"`;
    assertLifetime(manifest, now());
    await store.put(file.key, bytes, { ifNoneMatch: '*' }, file.contentType, md5.toString('base64'));
    const uploaded = await store.head(file.key);
    if (!uploaded || uploaded.size !== bytes.length || uploaded.etag !== expectedEtag) {
      throw new Error(`R2 single-PUT MD5 ETag or size mismatch: ${file.key}`);
    }
    const range = await store.get(file.key, { offset: bytes.length - length, length });
    if (!range || range.etag !== expectedEtag || !Buffer.from(range.bytes).equals(bytes.subarray(bytes.length - length))) {
      throw new Error(`R2 tail or ETag mismatch: ${file.key}`);
    }
  });
  if (provenance) {
    const provenanceBytes = await readFile(localPath(root, provenance.key));
    if (sha256(provenanceBytes) !== provenance.sha256) throw new Error(`Local hash mismatch: ${provenance.key}`);
    parseProvenance(decode(provenanceBytes), manifest);
    assertLifetime(manifest, now());
    await store.put(provenance.key, provenanceBytes, { ifNoneMatch: '*' }, 'application/json');
    const uploadedProvenance = await store.get(provenance.key);
    if (!uploadedProvenance || !Buffer.from(uploadedProvenance.bytes).equals(Buffer.from(provenanceBytes))) {
      throw new Error('Provenance readback mismatch');
    }
  }
  assertLifetime(manifest, now());
  const key = manifestKey(manifest.model, manifest.buildId), content = encode(manifest);
  await store.put(key, content, { ifNoneMatch: '*' }, 'application/json');
  const uploadedManifest = await store.get(key);
  if (!uploadedManifest || !Buffer.from(uploadedManifest.bytes).equals(Buffer.from(content))) throw new Error('Manifest readback mismatch');
  assertLifetime(manifest, now());
  retained.unshift({ buildId: manifest.buildId, manifestKey: key, cycle: manifest.cycle, expiresAt: manifest.expiresAt });
  await casPointer(store, manifest.model, { version: 1, model: manifest.model, latestBuildId: manifest.buildId, retained }, captured.etag);
}

export async function rollback(store: ObjectStorage, model: ModelId, target: string, paused: boolean, now = Date.now()): Promise<void> {
  const started = Date.now();
  modelIdSchema.parse(model);
  if (!paused) throw new Error('Pause all publishers and wait for active jobs before rollback');
  const captured = await readPointer(store, model), pointer = captured.pointer;
  const retained = pointer?.retained.find(item => item.buildId === target && Date.parse(item.expiresAt) > now);
  if (!pointer || !retained || retained.manifestKey !== manifestKey(model, target)) throw new Error('Rollback target is not retained and unexpired');
  const object = await store.get(retained.manifestKey);
  if (!object) throw new Error('Rollback manifest missing');
  const manifest = manifestSchema.parse(decode(object.bytes));
  if (manifest.buildId !== target || manifest.model !== model || manifest.cycle !== retained.cycle || manifest.expiresAt !== retained.expiresAt) {
    throw new Error('Rollback manifest does not match pointer');
  }
  const provenance = getProvenanceReference(manifest);
  if (provenance) {
    const receipt = await store.get(provenance.key);
    if (!receipt || sha256(receipt.bytes) !== provenance.sha256) throw new Error(`Rollback provenance missing or corrupt: ${provenance.key}`);
    parseProvenance(decode(receipt.bytes), manifest);
  }
  validateArtifactRecords(manifest);
  for (const { key, sha256: hash } of forecastObjects(manifest)) {
    const item = await store.get(key);
    if (!item || sha256(item.bytes) !== hash) throw new Error(`Rollback artifact missing or corrupt: ${key}`);
  }
  if (Date.parse(retained.expiresAt) <= now + (Date.now() - started)) throw new Error('Rollback target expired during verification');
  await casPointer(store, model, { ...pointer, latestBuildId: target }, captured.etag);
}

export async function cleanup(store: ObjectStorage, model: ModelId, paused: boolean, now = Date.now()): Promise<number> {
  modelIdSchema.parse(model);
  if (!paused) throw new Error('Pause all publishers and wait for active jobs before cleanup');
  const captured = await readPointer(store, model);
  if (!captured.pointer) throw new Error('Cannot cleanup without an authoritative pointer');
  const live = captured.pointer.retained.filter(item => Date.parse(item.expiresAt) > now || item.buildId === captured.pointer!.latestBuildId);
  if (live.length !== captured.pointer.retained.length) await casPointer(store, model, { ...captured.pointer, retained: live }, captured.etag);
  const objects = await store.list(`builds/${model}/`);
  const current = await readPointer(store, model);
  if (!current.pointer) throw new Error('Pointer disappeared during cleanup');
  const protectedIds = new Set(current.pointer.retained.map(item => item.buildId));
  const groups = new Map<string, typeof objects>();
  for (const object of objects) {
    const id = object.key.slice(`builds/${model}/`.length).split('/')[0];
    if (!safeId(id)) continue;
    const group = groups.get(id) ?? []; group.push(object); groups.set(id, group);
  }
  const deletes: string[] = [];
  for (const [id, group] of groups) {
    if (protectedIds.has(id) || buildIdTime(id) > now - 86400000 || group.some(object => object.lastModified.getTime() > now - 86400000)) continue;
    deletes.push(...group.map(object => object.key));
  }
  if (deletes.length) await store.delete(deletes);
  return deletes.length;
}
