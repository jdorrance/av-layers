import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MODEL_IDS, getProduct, manifestSchema } from '@av/contracts';
import { OFFLINE_PRODUCT } from '@av/contracts/fixture-product';
import { generateOfflineFixture } from './dev-fixture.js';
import { openLocalPreviewStore, seedLocalBuild, type LocalPreviewStore } from './sample-preview.js';

const temporary: string[] = [];
let base: string, relativeManifest: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'av-offline-base-'));
  relativeManifest = relative(base, await generateOfflineFixture(base));
});
afterAll(async () => { await rm(base, { recursive: true, force: true }); });
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'av-local-preview-')); temporary.push(root);
  await cp(base, root, { recursive: true });
  const manifestPath = join(root, relativeManifest), persistTo = join(root, 'state');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  return { root, manifest, manifestPath, persistTo };
}

function memoryStore() {
  const objects = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }>(), writes: string[] = [];
  const dispose = vi.fn(async () => {});
  const store: LocalPreviewStore = {
    async head(key) { const item = objects.get(key); return item ? { size: item.bytes.byteLength, customMetadata: item.customMetadata } : null; },
    async put(key, bytes, options) { writes.push(key); objects.set(key, { bytes: new Uint8Array(bytes), customMetadata: options.customMetadata }); },
    dispose
  };
  return { store, objects, writes, dispose, open: vi.fn(async () => store) };
}

describe('offline fixture and local seeding', () => {
  it('builds current timestamps, deterministic fields and a clearly labeled unregistered recipe', async () => {
    const { manifest } = await fixture();
    expect(manifest.descriptors.attribution).toBe(OFFLINE_PRODUCT.attribution);
    expect(manifest.grid.width * manifest.grid.height).toBe(40);
    expect(manifest.frames).toHaveLength(2);
    expect(manifest.layers).toHaveLength(3);
    expect(manifest.metrics.acquisition).toEqual({ fixture: true, networkRequests: 0 });
    expect(Date.parse(manifest.expiresAt)).toBeGreaterThan(Date.now());
    expect(Math.abs(Date.parse(manifest.cycle) - Date.now())).toBeLessThan(3600000);
    expect(MODEL_IDS).toEqual(['gfs']);
    expect(getProduct('gfs')!.id).not.toBe(OFFLINE_PRODUCT.id);
  });

  it('seeds coverage and provenance before the immutable manifest and latest pointer in one session', async () => {
    const local = await fixture(), memory = memoryStore();
    const result = await seedLocalBuild(local, memory.open);
    expect(memory.open).toHaveBeenCalledOnce();
    expect(memory.dispose).toHaveBeenCalledOnce();
    expect(result.uploadedObjects).toBe(14);
    expect(memory.writes.slice(0, 4)).toEqual(['output.bin', 'halo.bin', 'tiles.bin', 'manifest.json'].map(name => `coverage/${local.manifest.coverage.hash}/${name}`));
    expect(memory.writes[4]).toBe(local.manifest.source.provenanceKey);
    expect(memory.writes.at(-2)).toBe(relativeManifest);
    expect(memory.writes.at(-1)).toBe('catalog/gfs/latest.json');
    expect(JSON.parse(Buffer.from(memory.objects.get('catalog/gfs/latest.json')!.bytes).toString()).latestBuildId).toBe(local.manifest.buildId);
  });

  it('reuses verified objects, repairs missing dependencies even with a marker, and rewrites the pointer', async () => {
    const local = await fixture(), memory = memoryStore();
    await seedLocalBuild(local, memory.open);
    memory.writes.length = 0;
    expect(await seedLocalBuild(local, memory.open)).toMatchObject({ uploadedObjects: 1, reusedObjects: 13 });
    expect(memory.writes).toEqual(['catalog/gfs/latest.json']);
    const missingKey = `coverage/${local.manifest.coverage.hash}/output.bin`;
    memory.objects.delete(missingKey); memory.writes.length = 0;
    expect(await seedLocalBuild(local, memory.open)).toMatchObject({ uploadedObjects: 2, reusedObjects: 12 });
    expect(memory.writes).toEqual([missingKey, 'catalog/gfs/latest.json']);
    memory.objects.clear();
    expect(await seedLocalBuild(local, memory.open)).toMatchObject({ uploadedObjects: 14, reusedObjects: 0 });
    expect(await seedLocalBuild({ ...local, reseed: true }, memory.open)).toMatchObject({ uploadedObjects: 14, reusedObjects: 0 });
  });

  it('closes an interrupted store without exposing a new manifest, pointer or completion marker; a rerun completes', async () => {
    const local = await fixture(), memory = memoryStore(), originalPut = memory.store.put;
    memory.store.put = async (key, bytes, options) => { if (key === local.manifest.samples.key) throw new Error('interrupted upload'); return originalPut(key, bytes, options); };
    await expect(seedLocalBuild(local, memory.open)).rejects.toThrow('interrupted upload');
    expect(memory.dispose).toHaveBeenCalledOnce();
    expect(memory.objects.has(relativeManifest)).toBe(false);
    expect(memory.objects.has('catalog/gfs/latest.json')).toBe(false);
    await expect(readdir(join(local.persistTo, '.sample-preview'))).rejects.toThrow();
    memory.store.put = originalPut;
    expect(await seedLocalBuild(local, memory.open)).toMatchObject({ uploadedObjects: 14 });
    expect(memory.dispose).toHaveBeenCalledTimes(2);
  });

  it.each(['missing provenance', 'corrupt provenance', 'wrong provenance cycle', 'corrupt coverage', 'corrupt artifact', 'expired manifest'] as const)('rejects %s before opening local R2', async problem => {
    const local = await fixture(), memory = memoryStore();
    const provenancePath = join(local.root, local.manifest.source.provenanceKey as string);
    if (problem === 'missing provenance') await rm(provenancePath);
    if (problem === 'corrupt provenance') await writeFile(provenancePath, 'corrupt');
    if (problem === 'wrong provenance cycle') {
      const receipt = JSON.parse(await readFile(provenancePath, 'utf8'));
      receipt.cycle = new Date(Date.parse(local.manifest.cycle) - 3600000).toISOString();
      const bytes = Buffer.from(JSON.stringify(receipt)); await writeFile(provenancePath, bytes);
      local.manifest.source.provenanceSha256 = createHash('sha256').update(bytes).digest('hex');
      await writeFile(local.manifestPath, JSON.stringify(local.manifest));
    }
    if (problem === 'corrupt coverage') await writeFile(join(local.root, `coverage/${local.manifest.coverage.hash}/output.bin`), Uint8Array.of(0));
    if (problem === 'corrupt artifact') await writeFile(join(local.root, local.manifest.samples.key), 'corrupt');
    if (problem === 'expired manifest') { local.manifest.expiresAt = new Date(Date.now() - 1000).toISOString(); await writeFile(local.manifestPath, JSON.stringify(local.manifest)); }
    await expect(seedLocalBuild(local, memory.open)).rejects.toThrow();
    expect(memory.open).not.toHaveBeenCalled();
  });

  it('persists through real local workerd teardown and reopens with no repeated immutable uploads', async () => {
    const local = await fixture();
    expect(await seedLocalBuild(local)).toMatchObject({ uploadedObjects: 14 });
    expect(await seedLocalBuild(local)).toMatchObject({ uploadedObjects: 1, reusedObjects: 13 });
    const reopened = await openLocalPreviewStore(local.persistTo);
    try {
      expect(await reopened.head('catalog/gfs/latest.json')).not.toBeNull();
      expect((await reopened.head(local.manifest.samples.key))?.size).toBe(local.manifest.samples.bytes);
    } finally { await reopened.dispose(); }
  });
});
