import { createHash } from 'node:crypto';
import z from 'zod';
import { encodeBoundedJson, getProvenanceReference, mapFrameCount, MAX_MANIFEST_BYTES, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS,
  parseBoundedJson, parseProvenance, sameJsonValue, sourceIntervalHours, type ManifestV5, type ProductDefinition } from '@av/contracts';
import { runConcurrent } from './concurrent.js';
import { forecastFrame } from './frame-build.js';
import { verifyObjectReceipts, type ObjectReceipt } from './immutable-upload.js';
import { readLocalFile } from './local-file.js';
import type { BuildPlan, WholeDomainReceipt } from './parallel.js';
import { servingSampleShards, type HourSamplePart } from './serving-groups.js';
import type { ObjectStorage } from './storage.js';
import { localPath, sha256 } from './validate.js';
import type { WholeDomainPrepared } from './whole-domain/prepare.js';
import { MAX_FORECAST_RECEIPT_ENTRIES, MAX_V5_SHARD_BYTES } from './capacity.js';

const servingReceiptSchema = z.strictObject({ version: z.literal(1), planHash: z.string().regex(/^[a-f0-9]{64}$/), objects: z.array(z.strictObject({
  key: z.string().min(1), bytes: z.number().int().positive().max(MAX_V5_SHARD_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/), etag: z.string().min(1)
})) });

export function hourSampleParts(receipts: readonly WholeDomainReceipt[], plan: BuildPlan, product: ProductDefinition, id: 'native' | 'fine'): HourSamplePart[] {
  const parts: HourSamplePart[] = [];
  let firstFrame = 0;
  for (const receipt of receipts) {
    const frameCount = id === 'native' ? plan.groups[receipt.shard]!.length : mapFrameCount({ ...product, frameHours: plan.groups[receipt.shard]! });
    if (!frameCount) continue;
    const surface = receipt.surfaces.find(item => item.id === id);
    if (!surface) throw new Error(`Forecast shard is missing ${id} samples`);
    parts.push({ firstFrame, frameCount, shards: surface.shards });
    firstFrame += frameCount;
  }
  return parts;
}

/** Match a sealed publication to its admitted shard receipts before checking remote objects. */
export async function verifyPublicationReceipts(options: {
  root: string; manifest: ManifestV5; store: ObjectStorage; plan: BuildPlan; receipts: readonly WholeDomainReceipt[];
  product: ProductDefinition; whole: WholeDomainPrepared; signal?: AbortSignal;
}): Promise<ObjectReceipt[]> {
  const { root, manifest, store, plan, receipts, product, whole, signal } = options;
  if (!sameJsonValue(manifest.frames, plan.groups.flat().map(hour => forecastFrame(plan.cycle, hour, sourceIntervalHours(product, hour))))
      || !sameJsonValue(manifest.artifacts, receipts.flatMap(receipt => receipt.artifacts))) throw new Error('Manifest forecast receipt mismatch');
  const provenance = getProvenanceReference(manifest), provenanceBytes = await readLocalFile(localPath(root, provenance.key), MAX_PROVENANCE_BYTES);
  if (sha256(provenanceBytes) !== provenance.sha256 || !sameJsonValue(parseProvenance(parseBoundedJson(provenanceBytes, MAX_PROVENANCE_JSON_TOKENS), manifest).frames, receipts.flatMap(receipt => receipt.provenance))) throw new Error('Manifest provenance receipt mismatch');
  if (!sameJsonValue(manifest.surfaces.map(surface => surface.id), receipts[0].surfaces.map(surface => surface.id))
      || manifest.surfaces.some(surface => surface.coverage.maxZoom !== product.maxNativeZoom)) throw new Error('Manifest surface receipt mismatch');
  for (const surface of manifest.surfaces) {
    if (surface.samples.format !== 'frame-group-block-shards-v1') throw new Error('Receipt build requires grouped samples');
    const info = surface.kind === 'native' ? whole.native : whole.fine;
    const expected = servingSampleShards({ model: plan.model, buildId: plan.buildId, surfaceId: surface.id,
      grid: surface.kind === 'native' ? whole.plan.native : whole.plan.fine, blockIds: info.mask.coverage.blockIds, layers: surface.layers.length,
      parts: hourSampleParts(receipts, plan, product, surface.kind) });
    if (surface.samples.shards.length !== expected.length || surface.samples.shards.some((shard, index) => {
      const item = expected[index]!;
      return shard.group !== item.group || shard.firstFrame !== item.firstFrame || shard.frameCount !== item.frameCount
        || shard.blockShard !== item.blockShard || shard.firstBlock !== item.firstBlock || shard.blockCount !== item.blockCount
        || shard.storedCells !== item.storedCells || shard.bytes !== item.bytes || shard.key !== item.key;
    })) throw new Error('Manifest sample receipt mismatch');
    const profileBasis = receipts[0]!.surfaces.find(part => part.id === surface.id)?.profiles;
    if (!!surface.profiles !== !!profileBasis) throw new Error('Manifest profile receipt mismatch');
    if (surface.profiles && profileBasis) {
      let firstFrame = 0;
      const expectedProfiles = receipts.map(receipt => {
        const part = receipt.surfaces.find(item => item.id === surface.id)?.profiles;
        if (!part || part.levelCount !== profileBasis.levelCount || part.recordBytes !== profileBasis.recordBytes) throw new Error('Missing or inconsistent receipt profiles');
        const frameCount = plan.groups[receipt.shard]!.length;
        const group = { firstFrame, frameCount, shards: part.shards };
        firstFrame += frameCount;
        return group;
      });
      if (surface.profiles.levelCount !== profileBasis.levelCount || surface.profiles.recordBytes !== profileBasis.recordBytes
        || !sameJsonValue(surface.profiles.groups, expectedProfiles)) throw new Error('Manifest profile receipt mismatch');
    }
  }
  const objects = receipts.flatMap(receipt => receipt.objects!);
  const hourSamples = receipts.flatMap(receipt => receipt.surfaces.flatMap(surface => surface.shards.map(shard => ({ key: shard.key, sha256: shard.sha256, bytes: shard.bytes }))));
  const hourExpected = [...hourSamples,
    ...manifest.surfaces.flatMap(surface => (surface.profiles?.groups.flatMap(group => group.shards) ?? []).map(shard => ({ key: shard.key, sha256: shard.sha256, bytes: shard.bytes }))),
    ...manifest.artifacts.map(artifact => ({ key: artifact.tilesKey, sha256: artifact.tilesSha256 })),
    ...receipts.flatMap(receipt => receipt.provenance.map(item => ({ key: item.key, sha256: item.sha256, bytes: item.bytes })))];
  const byKey = new Map(objects.map(object => [object.key, object]));
  if (byKey.size !== objects.length || byKey.size !== hourExpected.length || hourExpected.some(item => {
    const object = byKey.get(item.key);
    return !object || object.sha256 !== item.sha256 || ('bytes' in item && object.bytes !== item.bytes);
  })) throw new Error('Forecast object receipt set mismatch');
  const hourSampleKeys = new Set(hourSamples.map(item => item.key));
  const serving = manifest.surfaces.flatMap(surface => surface.samples.shards);
  const record = await readLocalFile(localPath(root, `builds/${plan.model}/${plan.buildId}/serving-receipts.json`), MAX_PROVENANCE_BYTES)
    .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  const saved = record ? servingReceiptSchema.parse(parseBoundedJson(record, MAX_PROVENANCE_JSON_TOKENS, MAX_FORECAST_RECEIPT_ENTRIES)) : undefined;
  if (saved && saved.planHash !== sha256(encodeBoundedJson(plan, MAX_MANIFEST_BYTES))) throw new Error('Serving receipt plan mismatch');
  const savedByKey = new Map(saved?.objects.map(object => [object.key, object]));
  if (saved && savedByKey.size !== saved.objects.length) throw new Error('Duplicate serving object receipt');
  const published = new Array<ObjectReceipt>(serving.length);
  await runConcurrent(serving.map((shard, index) => ({ shard, index })), 4, async ({ shard, index }) => {
    signal?.throwIfAborted();
    const head = await store.head(shard.key, signal);
    signal?.throwIfAborted();
    if (!head || head.size !== shard.bytes || !head.etag || head.metadata?.sha256 !== shard.sha256) throw new Error(`Remote object receipt mismatch: ${shard.key}`);
    const receipt = savedByKey.get(shard.key);
    if (receipt && receipt.bytes === shard.bytes && receipt.sha256 === shard.sha256) {
      if (receipt.etag !== head.etag) throw new Error(`Remote object receipt mismatch: ${shard.key}`);
      published[index] = receipt;
      return;
    }
    if (shard.bytes > MAX_V5_SHARD_BYTES) throw new Error(`Remote object exceeds byte budget: ${shard.key}`);
    const hash = createHash('sha256');
    for (let offset = 0; offset < shard.bytes; offset += 4 * 1024 * 1024) {
      signal?.throwIfAborted();
      const length = Math.min(4 * 1024 * 1024, shard.bytes - offset);
      const part = await store.get(shard.key, { offset, length }, length, signal, undefined, { etag: head.etag, bytes: head.size });
      signal?.throwIfAborted();
      if (!part || part.bytes.length !== length || part.etag !== head.etag) throw new Error(`Remote object range mismatch: ${shard.key}`);
      hash.update(part.bytes);
    }
    if (hash.digest('hex') !== shard.sha256) throw new Error(`Remote object hash mismatch: ${shard.key}`);
    published[index] = { key: shard.key, bytes: shard.bytes, sha256: shard.sha256, etag: head.etag };
  });
  const workerObjects: ObjectReceipt[] = [];
  for (const item of hourExpected) {
    if (hourSampleKeys.has(item.key)) continue;
    const object = byKey.get(item.key);
    if (!object) throw new Error('Forecast object receipt set mismatch');
    workerObjects.push(object);
  }
  await verifyObjectReceipts(store, workerObjects, signal);
  return [...published, ...workerObjects];
}
