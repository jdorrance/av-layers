import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { assertCoverageBinding, assertSparseCoverageHalo, CELL_BYTES, canonicalGridJson, coverageDescriptorSchema, sparseCoverageDescriptorSchema, decodeSparseCoverage, sameGrid, coveragePrefix, encodeBoundedJson, MAX_COVERAGE_DESCRIPTOR_BYTES, MAX_COVERAGE_BITSET_BYTES, MAX_SPARSE_COVERAGE_BYTES, MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS, MAX_POINTER_BYTES, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, parseBoundedJson, forecastGrids, forecastObjects, forecastObjectsV5, renderedFrames, getProduct, getProvenanceReference, publishedManifestSchema, MAX_RETAINED_BUILDS, RETENTION_DAYS, modelIdSchema, modelPointerSchema, parseProvenance, provenanceObjects, parseFrameProvenance, validateArtifactRecords, assertSampleLayoutBindingV5, assertProfileLayoutBindingV5, type PublishedManifest, type ManifestV5, type ModelId, type ModelPointer } from '@av/contracts';
import { prepareShardedSamplePackLayout } from '@av/forecast';
import type { ObjectStorage } from './storage.js';
import { assertTerrainManifestBinding, assertValidatedBuild, localPath, sha256, validateBuild, type ValidatedBuild } from './validate.js';
import { BUILD_BUDGETS, MAX_BUILD_LIFETIME_MS } from './capacity.js';
import { loadCoverage, readCoverage, readSparseCoverage } from './coverage.js';
import { validateSparsePreparedTerrain } from './terrain/sparse.js';
import { assertAuthority, type PublicationAuthority } from './authority.js';
import { putImmutable, uploadBounded } from './immutable-upload.js';
import { readLocalFile } from './local-file.js';
import { readLocalProvenance } from './frame-provenance.js';

const decode = parseBoundedJson;
const pointerKey = (model: ModelId): string => `catalog/${model}/latest.json`;
const manifestKey = (model: ModelId, id: string): string => `builds/${model}/${id}/manifest.json`;
const safeId = (id: string): boolean => /^\d{8}T\d{6}Z-[a-f0-9-]{36}$/.test(id);
export const MAX_UPLOAD_ARTIFACT_BYTES = BUILD_BUDGETS.samplePackBytes;
export const MAX_UPLOAD_RESERVED_BYTES = 2 * MAX_UPLOAD_ARTIFACT_BYTES;
export const SMOKE_VERIFY_RESERVE_MS = 60_000;

export function buildIdTime(id: string): number {
  if (!safeId(id)) throw new Error('Invalid build ID');
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(id)!;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`, time = Date.parse(iso);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== iso) throw new Error('Invalid build ID timestamp');
  return time;
}

function assertLifetime(manifest: PublishedManifest, now: number): void {
  const start = buildIdTime(manifest.buildId);
  if (Date.parse(manifest.createdAt) < start || Date.parse(manifest.createdAt) >= start + 1000 || now < start || now - start > MAX_BUILD_LIFETIME_MS || Date.parse(manifest.expiresAt) <= now) {
    throw new Error('Build is outside its publication lifetime');
  }
}

export async function readPointer(store: ObjectStorage, model: ModelId, signal?: AbortSignal): Promise<{ pointer: ModelPointer | null; etag?: string }> {
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

export function assertUsefulHorizon(manifest: PublishedManifest, now: number): void {
  const product = getProduct(manifest.model);
  if (!product) throw new Error('No trusted publication recipe');
  const cycleAgeHours = (now - Date.parse(manifest.cycle)) / 3600000;
  const horizonHours = (Math.max(...renderedFrames(manifest).map(frame => Date.parse(frame.validTime))) - now) / 3600000;
  const daylightFiltered = product.capabilities.daylightFrames === 'regional-daylight';
  const coverageHours = daylightFiltered ? (product.mapEndHour ?? product.frameHours.at(-1)!) - cycleAgeHours : horizonHours;
  if (cycleAgeHours < 0 || cycleAgeHours > product.freshness.maxCycleAgeHours || coverageHours < product.freshness.minHorizonHours || horizonHours <= 0) {
    throw new Error('Build lacks the required useful forecast horizon');
  }
}

export async function publish(store: ObjectStorage, root: string, raw: unknown, options: { authority: PublicationAuthority; allowSameCycle?: boolean; now?: () => number; signal?: AbortSignal; validated?: ValidatedBuild; receiptsOnly?: boolean; deadlineAt?: string; committedOnly?: boolean; timings?: { r2UploadWallMs?: number; casCommitWallMs?: number } }): Promise<void> {
  const now = options.now ?? Date.now, manifest = publishedManifestSchema.parse(raw);
  if (options.validated) assertValidatedBuild(root, manifest, options.validated);
  assertAuthority(options.authority, manifest.model);
  const provenance = getProvenanceReference(manifest), key = manifestKey(manifest.model, manifest.buildId), content = encodeBoundedJson(manifest, MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS);
  const captured = await readPointer(store, manifest.model, options.signal);
  const existing = captured.pointer?.retained.find(item => item.buildId === manifest.buildId);
  if (options.committedOnly && (!existing || captured.pointer?.latestBuildId !== manifest.buildId)) throw new Error('Recovery requires the committed latest build');
  const alreadyRetained = !!existing;
  if (existing && (existing.manifestKey !== key || existing.cycle !== manifest.cycle || existing.expiresAt !== manifest.expiresAt)) throw new Error('Retained build identity mismatch');
  if (existing && captured.pointer?.latestBuildId !== manifest.buildId) throw new Error('Retained build is no longer latest');
  const check = (): void => { options.signal?.throwIfAborted(); if (!alreadyRetained) { assertLifetime(manifest, now()); assertUsefulHorizon(manifest, now()); } };
  if (captured.pointer && !alreadyRetained) {
    const latestCycle = Math.max(...captured.pointer.retained.map(item => Date.parse(item.cycle)));
    if (Date.parse(manifest.cycle) < latestCycle) throw new Error('Older cycle cannot be published');
    if (Date.parse(manifest.cycle) === latestCycle && !options.allowSameCycle) throw new Error('Same-cycle replacement requires explicit intent');
  }
  check();
  const retained = (captured.pointer?.retained ?? []).filter(item => Date.parse(item.expiresAt) > now());
  if (!alreadyRetained && retained.length >= MAX_RETAINED_BUILDS) throw new Error('Retained build limit reached');
  if (options.receiptsOnly) {
    if (manifest.version !== 5) throw new Error('Receipt publication requires a v5 manifest');
    const { verifyBuildReceipts } = await import('./parallel.js');
    const objects = await verifyBuildReceipts(root, manifest, store, options.signal);
    const product = getProduct(manifest.model);
    if (!product) throw new Error('No trusted publication recipe');
    await validateBuild(root, manifest, await loadCoverage(product), undefined, product, { store, objects, signal: options.signal });
  } else if (!options.validated) {
    if (manifest.version === 5) {
      const product = getProduct(manifest.model);
      if (!product) throw new Error('No trusted publication recipe');
      await validateBuild(root, manifest, await loadCoverage(product));
    } else await validateBuild(root, manifest, await readCoverage(root, manifest.coverage.hash), manifest.coverage.hash);
  }
  if (manifest.version !== 5) validateArtifactRecords(manifest);
  const uploadStarted = Date.now();
  const prefix = `builds/${manifest.model}/${manifest.buildId}/`;
  const localProvenance = await readLocalProvenance(root, manifest);
  const files = [...(manifest.version === 5 ? forecastObjectsV5(manifest) : forecastObjects(manifest)), ...provenanceObjects(localProvenance.value)];
  if (new Set(files.map(f => f.key)).size !== files.length || files.some(f => !f.key.startsWith(prefix))) throw new Error('Invalid artifact set');
  const sized = options.receiptsOnly ? [] : await Promise.all(files.map(async file => {
    const { size } = await stat(localPath(root, file.key));
    if (!size || size > MAX_UPLOAD_ARTIFACT_BYTES) throw new Error(`Artifact exceeds per-file upload limit: ${file.key}`);
    return { ...file, size };
  }));
  if (manifest.version === 5 && !options.receiptsOnly) await publishV5Dependencies(store, root, manifest, check, options.signal);
  else if (manifest.version !== 5) for (const grid of forecastGrids(manifest)) {
    const coverageBytes = await readLocalFile(localPath(root, grid.coverage.maskKey), MAX_COVERAGE_DESCRIPTOR_BYTES);
    if (sha256(coverageBytes) !== grid.coverage.hash) throw new Error('Coverage descriptor hash mismatch');
    const descriptor = coverageDescriptorSchema.parse(decode(coverageBytes));
    assertCoverageBinding(descriptor, grid);
    for (const name of ['output', 'halo', 'tiles'] as const) {
      const objectKey = `${coveragePrefix(grid.coverage.hash)}/${name}.bin`, bytes = await readLocalFile(localPath(root, objectKey), MAX_COVERAGE_BITSET_BYTES, descriptor.files[name].bytes);
      if (bytes.byteLength !== descriptor.files[name].bytes || sha256(bytes) !== descriptor.files[name].sha256) throw new Error(`Coverage ${name} hash mismatch`);
      check(); await putImmutable(store, objectKey, bytes, 'application/octet-stream', options.signal);
    }
    check(); await putImmutable(store, grid.coverage.maskKey, coverageBytes, 'application/json', options.signal);
  }
  await uploadBounded(sized, MAX_UPLOAD_RESERVED_BYTES, async file => {
    check();
    const bytes = await readLocalFile(localPath(root, file.key), MAX_UPLOAD_ARTIFACT_BYTES, file.size);
    if (sha256(bytes) !== file.sha256) throw new Error(`Local hash mismatch: ${file.key}`);
    check(); await putImmutable(store, file.key, bytes, file.contentType, options.signal, manifest.version === 5 && file.contentType === 'application/octet-stream');
  });
  const provenanceBytes = localProvenance.bytes;
  check(); await putImmutable(store, provenance.key, provenanceBytes, 'application/json', options.signal);
  const uploadedProvenance = await store.get(provenance.key, undefined, MAX_PROVENANCE_BYTES, options.signal);
  if (!uploadedProvenance || !Buffer.from(uploadedProvenance.bytes).equals(provenanceBytes)) throw new Error('Provenance readback mismatch');
  check(); await putImmutable(store, key, content, 'application/json', options.signal);
  const uploadedManifest = await store.get(key, undefined, MAX_MANIFEST_BYTES, options.signal);
  if (!uploadedManifest || !Buffer.from(uploadedManifest.bytes).equals(content)) throw new Error('Manifest readback mismatch');
  if (options.timings) options.timings.r2UploadWallMs = Date.now() - uploadStarted;
  if (alreadyRetained) {
    const current = (await readPointer(store, manifest.model, options.signal)).pointer;
    const retained = current?.retained.find(item => item.buildId === manifest.buildId);
    if (current?.latestBuildId !== manifest.buildId || retained?.manifestKey !== key || retained.cycle !== manifest.cycle || retained.expiresAt !== manifest.expiresAt) throw new Error('Committed latest build changed during validation');
    if (options.timings) options.timings.casCommitWallMs = 0;
    return;
  }
  check();
  const deadline = Date.parse(manifest.createdAt) + BUILD_BUDGETS.elapsedMs;
  if (options.deadlineAt !== undefined && Date.parse(options.deadlineAt) !== deadline) throw new Error('Invalid publication deadline');
  if (now() > deadline - SMOKE_VERIFY_RESERVE_MS) throw new Error('Build exceeds pre-publication deadline');
  retained.unshift({ buildId: manifest.buildId, manifestKey: key, cycle: manifest.cycle, expiresAt: manifest.expiresAt });
  const casStarted = Date.now();
  try { await casPointer(store, manifest.model, { version: 1, model: manifest.model, latestBuildId: manifest.buildId, retained }, captured.etag); }
  catch (error) {
    // Cancellation/network failure after CAS is ambiguous. Read the authority before reporting failure.
    const reconciled = await readPointer(store, manifest.model);
    if (!reconciled.pointer?.retained.some(item => item.buildId === manifest.buildId && item.manifestKey === key && item.cycle === manifest.cycle && item.expiresAt === manifest.expiresAt)) throw error;
    const committed = await store.get(key, undefined, MAX_MANIFEST_BYTES);
    if (!committed || !Buffer.from(committed.bytes).equals(content)) throw error;
  } finally { if (options.timings) options.timings.casCommitWallMs = Date.now() - casStarted; }
}

async function publishV5Dependencies(store: ObjectStorage, root: string, manifest: ManifestV5, check: () => void, signal?: AbortSignal): Promise<void> {
  const product = getProduct(manifest.model);
  if (!product) throw new Error('No trusted publication recipe');
  for (const surface of manifest.surfaces) {
    const coverage = await readSparseCoverage(root, surface.coverage.hash);
    if (!sameGrid(surface.grid, coverage.descriptor.grid) || surface.gridHash !== coverage.descriptor.gridHash || surface.coverage.id !== coverage.descriptor.id || surface.coverage.maxZoom !== coverage.descriptor.maxZoom || surface.coverage.maskKey !== `coverage/${surface.coverage.hash}/manifest.json`) throw new Error('Sparse coverage binding mismatch');
    for (const name of ['sparse', 'tiles'] as const) {
      const file = coverage.descriptor.files[name], key = `${coveragePrefix(surface.coverage.hash)}/${name}.bin`;
      const bytes = await readLocalFile(localPath(root, key), name === 'sparse' ? MAX_SPARSE_COVERAGE_BYTES : MAX_COVERAGE_BITSET_BYTES, file.bytes);
      if (sha256(bytes) !== file.sha256) throw new Error(`Coverage ${name} hash mismatch`);
      check(); await putImmutable(store, key, bytes, 'application/octet-stream', signal);
    }
    check(); await putImmutable(store, surface.coverage.maskKey, coverage.bytes, 'application/json', signal);
    if (surface.terrain) {
      const terrain = surface.terrain, { size } = await stat(localPath(root, terrain.key));
      const ref = { key: terrain.key, sha256: terrain.sha256, bytes: size, arrayBytes: coverage.mask.coverage.offsets[coverage.mask.coverage.blockIds.length] * 5 };
      const verified = await validateSparsePreparedTerrain(ref, asset => readLocalFile(localPath(root, asset.key), asset.bytes, asset.bytes), surface.grid, coverage.mask.coverage, coverage.bytes, signal);
      assertTerrainManifestBinding(manifest, terrain, verified.descriptor, ref.arrayBytes, product);
      for (const asset of [...verified.descriptor.files.elevationM, ...verified.descriptor.files.valid, ref]) {
        const bytes = await readLocalFile(localPath(root, asset.key), asset.bytes, asset.bytes);
        if (sha256(bytes) !== asset.sha256) throw new Error(`Terrain hash mismatch: ${asset.key}`);
        check(); await putImmutable(store, asset.key, bytes, asset.key === terrain.key ? 'application/json' : 'application/octet-stream', signal);
      }
    }
  }
}

async function verifyV5Dependencies(store: ObjectStorage, manifest: ManifestV5, signal?: AbortSignal): Promise<void> {
  const product = getProduct(manifest.model);
  if (!product) throw new Error('No trusted publication recipe');
  for (const surface of manifest.surfaces) {
    const object = await store.get(surface.coverage.maskKey, undefined, MAX_COVERAGE_DESCRIPTOR_BYTES, signal);
    if (!object || sha256(object.bytes) !== surface.coverage.hash || surface.coverage.maskKey !== `coverage/${surface.coverage.hash}/manifest.json`) throw new Error('Rollback sparse coverage missing or corrupt');
    const descriptor = sparseCoverageDescriptorSchema.parse(decode(object.bytes));
    if (descriptor.id !== surface.coverage.id || descriptor.maxZoom !== surface.coverage.maxZoom || descriptor.gridHash !== surface.gridHash || sha256(Buffer.from(canonicalGridJson(descriptor.grid))) !== descriptor.gridHash || !sameGrid(descriptor.grid, surface.grid)) throw new Error('Rollback sparse coverage binding mismatch');
    const values: Uint8Array[] = [];
    for (const name of ['sparse', 'tiles'] as const) {
      const file = descriptor.files[name], key = `${coveragePrefix(surface.coverage.hash)}/${name}.bin`, max = name === 'sparse' ? MAX_SPARSE_COVERAGE_BYTES : MAX_COVERAGE_BITSET_BYTES;
      await verifyRemoteHash(store, key, file.sha256, max, file.bytes, signal);
      const item = await store.get(key, undefined, max, signal);
      if (!item || item.bytes.length !== file.bytes || sha256(item.bytes) !== file.sha256) throw new Error(`Rollback coverage corrupt: ${key}`);
      values.push(item.bytes);
    }
    const coverage = decodeSparseCoverage(values[0], descriptor.gridHash);
    if (coverage.width !== surface.grid.width || coverage.height !== surface.grid.height || coverage.wrapLongitude !== surface.grid.wrapLongitude) throw new Error('Rollback sparse grid mismatch');
    assertSparseCoverageHalo(coverage);
    const binding = { grid: descriptor.grid, gridHash: descriptor.gridHash, coverageHash: surface.coverage.hash, blockIds: coverage.blockIds };
    assertSampleLayoutBindingV5(surface, binding);
    if (surface.profiles) assertProfileLayoutBindingV5(surface, binding);
    const groups = surface.samples.format === 'cell-major-block-shards-v1'
      ? [{ channels: surface.samples.channelCount, shards: surface.samples.shards }]
      : surface.samples.shards.filter(shard => shard.blockShard === 0).map(first => ({
        channels: first.frameCount * surface.layers.length, shards: surface.samples.shards.filter(shard => 'group' in shard && shard.group === first.group)
      }));
    const packedGroups = [...groups.map(group => ({ ...group, recordBytes: CELL_BYTES })),
      ...(surface.profiles?.groups.map(group => ({
        channels: group.frameCount, recordBytes: surface.profiles!.recordBytes, shards: group.shards
      })) ?? [])];
    for (const group of packedGroups) {
      const layout = prepareShardedSamplePackLayout(surface.grid, coverage.blockIds, group.channels, undefined, group.recordBytes);
      if (layout.shards.length !== group.shards.length || layout.shards.some((item, i) => item.firstBlock !== group.shards[i].firstBlock || item.blockCount !== group.shards[i].blockCount || item.byteLength !== group.shards[i].bytes)) throw new Error('Rollback sample layout mismatch');
    }
    for (const shard of [...surface.samples.shards, ...(surface.profiles?.groups.flatMap(group => group.shards) ?? [])]) await verifyRemoteHash(store, shard.key, shard.sha256, shard.bytes, shard.bytes, signal, true);
    if (surface.terrain) {
      const terrain = surface.terrain, head = await store.head(terrain.key, signal);
      if (!head) throw new Error('Rollback terrain descriptor missing');
      const ref = { key: terrain.key, sha256: terrain.sha256, bytes: head.size, arrayBytes: coverage.offsets[coverage.blockIds.length] * 5 };
      const verified = await validateSparsePreparedTerrain(ref, async asset => {
        await verifyRemoteHash(store, asset.key, asset.sha256, asset.bytes, asset.bytes, signal);
        const item = await store.get(asset.key, undefined, asset.bytes, signal);
        if (!item) throw new Error(`Rollback terrain missing: ${asset.key}`);
        return item.bytes;
      }, surface.grid, coverage, object.bytes, signal);
      assertTerrainManifestBinding(manifest, terrain, verified.descriptor, ref.arrayBytes, product);
    }
  }
  for (const artifact of manifest.artifacts) await verifyRemoteHash(store, artifact.tilesKey, artifact.tilesSha256, MAX_UPLOAD_ARTIFACT_BYTES, undefined, signal);
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
  const manifest = publishedManifestSchema.parse(decode(object.bytes, MAX_MANIFEST_JSON_TOKENS));
  if (manifest.buildId !== target || manifest.model !== model || manifest.cycle !== retained.cycle || manifest.expiresAt !== retained.expiresAt) {
    throw new Error('Rollback manifest does not match pointer');
  }
  const provenance = getProvenanceReference(manifest);
  const receipt = await store.get(provenance.key, undefined, MAX_PROVENANCE_BYTES, options.signal);
  check();
  if (!receipt || sha256(receipt.bytes) !== provenance.sha256) throw new Error(`Rollback provenance missing or corrupt: ${provenance.key}`);
  const provenanceValue = parseProvenance(decode(receipt.bytes, MAX_PROVENANCE_JSON_TOKENS), manifest);
  for (const [index, reference] of provenanceObjects(provenanceValue).entries()) {
    check();
    const object = await store.get(reference.key, undefined, reference.bytes, options.signal);
    if (!object || object.bytes.byteLength !== reference.bytes || sha256(object.bytes) !== reference.sha256) throw new Error(`Rollback provenance missing or corrupt: ${reference.key}`);
    const value = parseFrameProvenance(decode(object.bytes, MAX_PROVENANCE_JSON_TOKENS), manifest, manifest.frames[index]!);
    if (value.hour !== reference.hour) throw new Error('Rollback provenance hour mismatch');
  }
  if (manifest.version === 5) await verifyV5Dependencies(store, manifest, options.signal);
  else {
  validateArtifactRecords(manifest);
  const grids = forecastGrids(manifest);
  for (const grid of grids) {
    const coverage = await store.get(grid.coverage.maskKey, undefined, MAX_COVERAGE_DESCRIPTOR_BYTES, options.signal);
    check();
    if (!coverage || sha256(coverage.bytes) !== grid.coverage.hash) throw new Error('Rollback coverage descriptor missing or corrupt');
    const descriptor = coverageDescriptorSchema.parse(decode(coverage.bytes));
    assertCoverageBinding(descriptor, grid);
    for (const name of ['output', 'halo', 'tiles'] as const) {
      const file = descriptor.files[name], key = `${coveragePrefix(grid.coverage.hash)}/${name}.bin`;
      await verifyRemoteHash(store, key, file.sha256, file.bytes, file.bytes, options.signal);
    }
  }
  for (const { key, sha256: hash } of forecastObjects(manifest)) {
    await verifyRemoteHash(store, key, hash, MAX_UPLOAD_ARTIFACT_BYTES, grids.find(grid => key === grid.samples.key)?.samples.bytes, options.signal);
  }
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
async function verifyRemoteHash(store: ObjectStorage, key: string, expectedHash: string, maxBytes: number, expectedBytes?: number, signal?: AbortSignal, requireMetadata = false): Promise<void> {
  signal?.throwIfAborted();
  const head = await store.head(key, signal);
  signal?.throwIfAborted();
  if (!head || !Number.isSafeInteger(head.size) || head.size < 1 || head.size > maxBytes || (expectedBytes !== undefined && head.size !== expectedBytes) || (requireMetadata && head.metadata?.sha256 !== expectedHash)) throw new Error(`Rollback object missing or invalid size or metadata: ${key}`);
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
  sourceInputs?: { deleted: number; deferred: number; reason?: string };
}
const emptyCleanupObjects = (): CleanupObjects => ({ objects: 0, knownBytes: 0, unknownSizeObjects: 0 });
function countCleanupObject(total: CleanupObjects, object: { size?: number }): void {
  total.objects++;
  if (Number.isSafeInteger(object.size) && object.size! >= 0 && Number.isSafeInteger(total.knownBytes + object.size!)) total.knownBytes += object.size!;
  else total.unknownSizeObjects++;
}

/** A committed build or an assembled build past publication lifetime needs only advertised data. */
async function cleanupSourceInputs(store: ObjectStorage, model: ModelId, id: string, keys: string[], retained: ModelPointer['retained'][number] | undefined, signal?: AbortSignal): Promise<NonNullable<CleanupSummary['sourceInputs']> | null> {
  let manifest: PublishedManifest;
  try {
    const object = await store.get(manifestKey(model, id), undefined, MAX_MANIFEST_BYTES, signal);
    if (!object) throw new Error('Source cleanup manifest is missing');
    manifest = publishedManifestSchema.parse(decode(object.bytes, MAX_MANIFEST_JSON_TOKENS));
    if (manifest.model !== model || manifest.buildId !== id || (retained && (manifest.cycle !== retained.cycle || manifest.expiresAt !== retained.expiresAt || retained.manifestKey !== manifestKey(model, id)))) throw new Error('Source cleanup manifest identity mismatch');
  } catch (error) {
    signal?.throwIfAborted();
    if (retained) throw error;
    return null;
  }
  const advertised = new Set((manifest.version === 5 ? forecastObjectsV5(manifest) : forecastObjects(manifest)).map(item => item.key));
  const disposable = keys.filter(key => !advertised.has(key));
  if (!disposable.length) return null;
  try {
    signal?.throwIfAborted();
    await store.delete(disposable, signal);
    return { deleted: disposable.length, deferred: 0 };
  } catch (error) { return { deleted: 0, deferred: disposable.length, reason: String(error) }; }
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
    const deletes: string[] = [], eligible = emptyCleanupObjects(), cutoff = now - RETENTION_DAYS * 86400000;
    for (const [id, group] of groups) {
      const retained = current.pointer.retained.find(item => item.buildId === id);
      if (!retained && buildIdTime(id) <= cutoff && group.every(object => object.lastModified.getTime() <= cutoff)) {
        for (const object of group) { deletes.push(object.key); countCleanupObject(eligible, object); }
        continue;
      }
      const source = group.filter(object => /^surfaces\/(native|fine)\/samples\/src-g\d+-b\d+\.bin$/.test(object.key.slice(`${prefix}${id}/`.length)));
      if (source.length && (retained || buildIdTime(id) + MAX_BUILD_LIFETIME_MS <= now)) {
        const state = await cleanupSourceInputs(store, model, id, source.map(item => item.key), retained, signal);
        if (state) {
          const inputs = summary.sourceInputs ??= { deleted: 0, deferred: 0 };
          inputs.deleted += state.deleted; inputs.deferred += state.deferred;
          if (state.reason) inputs.reason = state.reason;
        }
      }
    }
    summary.eligible = eligible;
    signal?.throwIfAborted();
    if (deletes.length) {
      summary.deleted = null; // The provider may partially delete before reporting an error.
      await store.delete(deletes, signal);
      summary.deleted = { ...eligible };
    }
    summary.status = 'complete';
    return deletes.length + (summary.sourceInputs?.deleted ?? 0);
  } finally { onReport?.(summary); }
}
