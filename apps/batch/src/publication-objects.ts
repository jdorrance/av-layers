import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseBoundedJson, renderedFrames, type ManifestV5, type parseProvenance } from '@av/contracts';
import { WIND_FRAME_LIMIT, WIND_ROOT_LIMIT, assertWindFrameLayout, parseWindFrame, windDataSchema, windFrameParts } from '@av/contracts/wind-data';
import { readLocalFile } from './local-file.js';
import type { ObjectStorage } from './storage.js';

export interface ForecastObject {
  key: string;
  sha256: string;
  contentType: string;
  bytes?: number;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** List numeric packs before raster archives in publication order. */
export function forecastObjects(manifest: ManifestV5): ForecastObject[] {
  const packs = manifest.surfaces.flatMap(surface => [...surface.samples.shards, ...(surface.profiles?.groups.flatMap(group => group.shards) ?? [])]);
  return [
    ...packs.map(({ key, sha256, bytes }) => ({ key, sha256, bytes, contentType: 'application/octet-stream' })),
    ...manifest.artifacts.map(({ tilesKey: key, tilesSha256: sha256 }) => ({ key, sha256, contentType: 'application/vnd.pmtiles' }))
  ];
}

async function readDescriptorBytes(root: string, key: string, limit: number, expectedBytes: number, remote?: { store: Pick<ObjectStorage, 'get'>; signal?: AbortSignal }): Promise<Uint8Array> {
  remote?.signal?.throwIfAborted();
  const local = await readLocalFile(resolve(root, key), limit, expectedBytes).catch((error: NodeJS.ErrnoException) => {
    if (error?.code === 'ENOENT' && remote) return null;
    throw error;
  });
  if (local) return local;
  const fetched = await remote!.store.get(key, undefined, expectedBytes, remote!.signal);
  if (!fetched) throw new Error(`Missing numeric wind descriptor: ${key}`);
  return fetched.bytes;
}

/** Enumerate verified numeric wind shards, indexes, frame descriptors, and root descriptor in publication order. */
export async function windObjects(root: string, manifest: ManifestV5, remote?: { store: Pick<ObjectStorage, 'get'>; signal?: AbortSignal }): Promise<ForecastObject[]> {
  if (!manifest.mapData) return [];
  const prefix = `builds/${manifest.model}/${manifest.buildId}`, rootKey = `${prefix}/map-data.json`;
  const rootBytes = await readDescriptorBytes(root, rootKey, WIND_ROOT_LIMIT, manifest.mapData.bytes, remote);
  if (rootBytes.byteLength !== manifest.mapData.bytes || sha256(rootBytes) !== manifest.mapData.sha256) throw new Error('Wind root digest mismatch');
  const data = windDataSchema.parse(parseBoundedJson(rootBytes)), expectedFrames = renderedFrames(manifest);
  if (data.model !== manifest.model || data.buildId !== manifest.buildId || data.frames.length !== expectedFrames.length || data.frames.some((frame, i) => frame.id !== expectedFrames[i]!.id)) {
    throw new Error('Wind root identity mismatch');
  }
  const native = manifest.surfaces.find(surface => surface.kind === 'native'), fine = manifest.surfaces.find(surface => surface.kind === 'fine');
  if (!native || !fine) throw new Error('Wind surface missing');
  const objects: ForecastObject[] = [];
  for (const frame of data.frames) {
    remote?.signal?.throwIfAborted();
    const frameKey = `${prefix}/map-data/${frame.id}.json`;
    const bytes = await readDescriptorBytes(root, frameKey, WIND_FRAME_LIMIT, frame.bytes, remote);
    if (bytes.byteLength !== frame.bytes || sha256(bytes) !== frame.sha256) throw new Error('Wind frame digest mismatch');
    const descriptor = parseWindFrame(bytes);
    if (descriptor.frame !== frame.id) throw new Error('Wind frame identity mismatch');
    assertWindFrameLayout(descriptor, { native: native.grid, fine: fine.grid });
    objects.push({ key: frameKey, sha256: frame.sha256, bytes: frame.bytes, contentType: 'application/json' });
    for (const { kind, shards } of windFrameParts(descriptor)) {
      for (const [page, shard] of shards.entries()) {
        const base = `${prefix}/map-data/${frame.id}/${kind}-${page}`;
        objects.push(
          { key: `${base}.idx`, sha256: shard.indexSha256, bytes: shard.count * 32, contentType: 'application/octet-stream' },
          { key: `${base}.bin`, sha256: shard.sha256, bytes: shard.bytes, contentType: 'application/octet-stream' }
        );
      }
    }
  }
  objects.push({ key: rootKey, sha256: manifest.mapData.sha256, bytes: manifest.mapData.bytes, contentType: 'application/json' });
  return objects;
}

/** Enumerate all immutable forecast build objects (packs, raster archives, and opted-in numeric wind objects). */
export async function buildObjects(root: string, manifest: ManifestV5, remote?: { store: Pick<ObjectStorage, 'get'>; signal?: AbortSignal }): Promise<ForecastObject[]> {
  return [...forecastObjects(manifest), ...(await windObjects(root, manifest, remote))];
}

/** List separately stored frame receipts in provenance index order. */
export function provenanceObjects(value: ReturnType<typeof parseProvenance>) {
  return value.version === 2 ? value.frames.map(frame => ({ ...frame, contentType: 'application/json' as const })) : [];
}
