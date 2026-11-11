import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getProduct } from '@av/contracts/models';
import { parseProvenance } from '@av/contracts';
import { OFFLINE_PRODUCT } from '@av/contracts/fixture-product';
import { offlinePreviewFixture } from './fixtures/offline-preview.js';
import { seedLocalBuild, type LocalPreviewStore } from './sample-preview.js';

type Fixture = Awaited<ReturnType<typeof offlinePreviewFixture>>;
type Local = Awaited<ReturnType<Fixture['copy']>>;
let base: Fixture;
const copies: Local[] = [];
beforeAll(async () => { base = await offlinePreviewFixture(); });
afterAll(async () => { await base?.dispose(); });
afterEach(async () => { await Promise.all(copies.splice(0).map(copy => copy.dispose())); });
async function fixture() {
  const copy = await base.copy();
  copies.push(copy);
  return copy;
}

function memoryStore() {
  const objects = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }>();
  const writes: string[] = [], dispose = vi.fn(async () => {});
  const store: LocalPreviewStore = {
    async head(key) { const item = objects.get(key); return item ? { size: item.bytes.byteLength, customMetadata: item.customMetadata } : null; },
    async put(key, bytes, options) { writes.push(key); objects.set(key, { bytes: new Uint8Array(bytes), customMetadata: options.customMetadata }); },
    dispose
  };
  return { store, objects, writes, dispose, open: vi.fn(async () => store) };
}

describe('offline fixture and local seeding', () => {
  it('builds current timestamps, deterministic fields and a clearly labeled unregistered recipe', async () => {
    const local = await fixture(), { manifest, native } = local;
    expect(manifest.descriptors.attribution).toBe(OFFLINE_PRODUCT.attribution);
    expect(native.grid.width * native.grid.height).toBe(40);
    expect(manifest.frames).toHaveLength(2);
    expect(manifest.layers).toHaveLength(4);
    expect(native.profiles?.groups).toHaveLength(1);
    const diagnostics = JSON.parse(await readFile(join(dirname(local.manifestPath), 'diagnostics.json'), 'utf8'));
    expect(diagnostics.acquisition).toEqual({ fixture: true, networkRequests: 0 });
    expect(diagnostics.frames.f001['precip-rate'].valid).toBe(40);
    expect(Date.parse(manifest.expiresAt)).toBeGreaterThan(Date.now());
    expect(Math.abs(Date.parse(manifest.cycle) - Date.now())).toBeLessThan(86_400_000);
    expect(getProduct(manifest.model)!.id).not.toBe(OFFLINE_PRODUCT.id);
  });

  it('seeds each dependency before the immutable manifest and latest pointer in one session', async () => {
    const local = await fixture(), memory = memoryStore();
    const result = await seedLocalBuild(local, memory.open);
    expect(memory.open).toHaveBeenCalledOnce();
    expect(memory.dispose).toHaveBeenCalledOnce();
    const { manifest, native, fine } = local;
    const index = parseProvenance(JSON.parse(await readFile(join(local.root, manifest.source.provenanceKey), 'utf8')), manifest);
    if (index.version !== 2) throw new Error('Fixture did not write indexed provenance');
    const dependencies = [
      ...[native, fine].flatMap(surface => ['manifest.json', 'sparse.bin', 'tiles.bin'].map(name => `coverage/${surface.coverage.hash}/${name}`)),
      ...['manifest.json', 'elevation-0.f32', 'valid-0.u8'].map(name => `${dirname(fine.terrain!.key)}/${name}`),
      manifest.source.provenanceKey, ...index.frames.map(frame => frame.key),
      ...manifest.artifacts.map(artifact => artifact.tilesKey),
      ...[native, fine].flatMap(surface => surface.samples.shards.map(shard => shard.key)),
      ...native.profiles!.groups.flatMap(group => group.shards.map(shard => shard.key))
    ];
    expect(result.uploadedObjects).toBe(dependencies.length + 2);
    expect(memory.writes.slice(0, -2).sort()).toEqual(dependencies.sort());
    expect(memory.writes.at(-2)).toBe(relative(local.root, local.manifestPath));
    expect(memory.writes.at(-1)).toBe(local.pointerKey);
    expect(JSON.parse(Buffer.from(memory.objects.get(local.pointerKey)!.bytes).toString()).latestBuildId).toBe(manifest.buildId);
    for (const object of memory.objects.values()) expect(object.customMetadata.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects an unknown recipe before opening the store', async () => {
    const local = await fixture(), memory = memoryStore();
    await expect(seedLocalBuild({ ...local, trustedProduct: undefined }, memory.open)).rejects.toThrow('Unsupported local build recipe or model');
    expect(memory.open).not.toHaveBeenCalled();
  });

  it.each([
    ['native coverage', local => `coverage/${local.native.coverage.hash}/sparse.bin`],
    ['fine coverage', local => local.fine.coverage.maskKey],
    ['terrain descriptor', local => local.fine.terrain!.key],
    ['terrain array', local => `${dirname(local.fine.terrain!.key)}/elevation-0.f32`],
    ['provenance index', local => local.manifest.source.provenanceKey],
    ['frame provenance', local => `${dirname(relative(local.root, local.manifestPath))}/provenance/f001.json`],
    ['scalar shard', local => local.native.samples.shards[0].key],
    ['profile shard', local => local.native.profiles!.groups[0].shards[0].key],
    ['PMTiles', local => local.manifest.artifacts[0].tilesKey]
  ] satisfies [string, (local: Local) => string][])('rejects missing or corrupt %s before opening local R2', async (_name, key) => {
    const local = await fixture(), memory = memoryStore(), path = join(local.root, key(local));
    await writeFile(path, 'corrupt');
    await expect(seedLocalBuild(local, memory.open)).rejects.toThrow();
    await rm(path);
    await expect(seedLocalBuild(local, memory.open)).rejects.toThrow();
    expect(memory.open).not.toHaveBeenCalled();
  });

  it.each(['provenance cycle', 'manifest expiry'])('rejects incorrect %s before opening local R2', async problem => {
    const local = await fixture(), memory = memoryStore(), { manifest } = local;
    if (problem === 'provenance cycle') {
      const provenancePath = join(local.root, manifest.source.provenanceKey), value = JSON.parse(await readFile(provenancePath, 'utf8'));
      value.cycle = new Date(Date.parse(manifest.cycle) - 3_600_000).toISOString();
      const bytes = Buffer.from(JSON.stringify(value));
      await writeFile(provenancePath, bytes);
      manifest.source.provenanceSha256 = createHash('sha256').update(bytes).digest('hex');
    } else {
      manifest.expiresAt = new Date(Date.now() - 1000).toISOString();
    }
    await writeFile(local.manifestPath, JSON.stringify(manifest));
    await expect(seedLocalBuild(local, memory.open)).rejects.toThrow();
    expect(memory.open).not.toHaveBeenCalled();
  });

  it('reuses verified objects, repairs missing dependencies even with a marker, and rewrites the pointer', async () => {
    const local = await fixture(), memory = memoryStore();
    const { uploadedObjects } = await seedLocalBuild(local, memory.open);
    memory.writes.length = 0;
    expect(await seedLocalBuild(local, memory.open)).toMatchObject({ uploadedObjects: 1, reusedObjects: uploadedObjects - 1 });
    expect(memory.writes).toEqual([local.pointerKey]);
    for (const key of [`coverage/${local.native.coverage.hash}/sparse.bin`, `coverage/${local.fine.coverage.hash}/sparse.bin`]) {
      memory.objects.delete(key);
      memory.writes.length = 0;
      expect(await seedLocalBuild(local, memory.open)).toMatchObject({ uploadedObjects: 2, reusedObjects: uploadedObjects - 2 });
      expect(memory.writes).toEqual([key, local.pointerKey]);
    }
    memory.objects.clear();
    expect(await seedLocalBuild(local, memory.open)).toMatchObject({ uploadedObjects, reusedObjects: 0 });
    expect(await seedLocalBuild({ ...local, reseed: true }, memory.open)).toMatchObject({ uploadedObjects, reusedObjects: 0 });
  });

  it('closes an interrupted store without exposing a new manifest, pointer or completion marker; a rerun completes', async () => {
    const local = await fixture(), memory = memoryStore(), originalPut = memory.store.put;
    memory.store.put = async (key, bytes, options) => {
      if (key === local.native.samples.shards[0].key) throw new Error('interrupted upload');
      return originalPut(key, bytes, options);
    };
    await expect(seedLocalBuild(local, memory.open)).rejects.toThrow('interrupted upload');
    expect(memory.dispose).toHaveBeenCalledOnce();
    expect(memory.objects.has(relative(local.root, local.manifestPath))).toBe(false);
    expect(memory.objects.has(local.pointerKey)).toBe(false);
    await expect(readdir(join(local.persistTo, '.sample-preview'))).rejects.toThrow();
    memory.store.put = originalPut;
    await seedLocalBuild(local, memory.open);
    expect(memory.objects.has(local.pointerKey)).toBe(true);
    expect(memory.dispose).toHaveBeenCalledTimes(2);
  });
});
