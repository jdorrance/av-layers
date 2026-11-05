import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { encodeBoundedJson, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, parseBoundedJson, parseFrameProvenance,
  getProvenanceReference, parseProvenance, provenanceFrameReferenceSchema, type Manifest, type ProvenanceFrameReference } from '@av/contracts';
import { localPath, readLocalFile } from './local-file.js';
import type { ObjectStorage } from './storage.js';

type Identity = Pick<Manifest, 'model' | 'buildId' | 'cycle'>;
type Frame = Manifest['frames'][number];
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const frameKey = (identity: Identity, frame: Frame): string => `builds/${identity.model}/${identity.buildId}/provenance/${frame.id}.json`;

export async function readLocalProvenance(root: string, manifest: Identity & Pick<Manifest, 'source' | 'frames'>) {
  const reference = getProvenanceReference(manifest);
  const bytes = await readLocalFile(localPath(root, reference.key), MAX_PROVENANCE_BYTES);
  if (digest(bytes) !== reference.sha256) throw new Error(`Invalid provenance hash ${reference.key}`);
  return { reference, bytes, value: parseProvenance(parseBoundedJson(bytes, MAX_PROVENANCE_JSON_TOKENS), manifest) };
}

/** Commit one bounded source receipt; the run index retains its verified reference. */
export async function writeFrameProvenance(root: string, identity: Identity, frame: Frame, receipt: { hour: number; intervals: unknown; receipt: unknown }): Promise<ProvenanceFrameReference> {
  const value = parseFrameProvenance({ version: 1, ...identity, frame, ...receipt }, identity, frame);
  const bytes = encodeBoundedJson(value, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS), key = frameKey(identity, frame);
  const reference = provenanceFrameReferenceSchema.parse({ hour: receipt.hour, frame: frame.id, key, bytes: bytes.byteLength, sha256: digest(bytes) });
  const file = localPath(root, key);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes, { flag: 'wx' });
  return reference;
}

export async function readFrameProvenance(source: string | { store: ObjectStorage; signal?: AbortSignal }, identity: Identity, frame: Frame, reference: ProvenanceFrameReference) {
  provenanceFrameReferenceSchema.parse(reference);
  if (reference.frame !== frame.id || reference.key !== frameKey(identity, frame)) throw new Error('Invalid provenance frame reference');
  let bytes: Uint8Array;
  if (typeof source === 'string') bytes = await readLocalFile(localPath(source, reference.key), MAX_PROVENANCE_BYTES, reference.bytes);
  else {
    source.signal?.throwIfAborted();
    const object = await source.store.get(reference.key, undefined, reference.bytes, source.signal);
    if (!object || object.bytes.byteLength !== reference.bytes) throw new Error('Provenance frame missing or wrong length');
    bytes = object.bytes;
  }
  if (digest(bytes) !== reference.sha256) throw new Error('Provenance frame hash mismatch');
  const value = parseFrameProvenance(parseBoundedJson(bytes, MAX_PROVENANCE_JSON_TOKENS), identity, frame);
  if (value.hour !== reference.hour) throw new Error('Provenance frame hour mismatch');
  return value;
}
