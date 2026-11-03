import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MODEL_IDS, getProduct, manifestSchema, sampleResponseSchema, setBit, type CoverageMask } from '@av/contracts';
import { prepareSamplePackLayout } from '@av/forecast';
import { OFFLINE_PRODUCT } from '@av/contracts/fixture-product';
import { readCoverage, writeCoverage } from '../apps/batch/src/coverage.js';
import { createSamplePackBuilder } from '../apps/batch/src/sample-pack.js';
import { fixturePatch } from '../tests/forecast-fixture.js';
import { generateOfflineFixture } from './dev-fixture.js';
import { openLocalPreviewStore, seedLocalBuild, type LocalPreviewStore } from './sample-preview.js';

const temporary: string[] = [];
let base: string, relativeManifest: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'av-offline-base-'));
  // Use 06:00 UTC (North American nighttime) to verify the synthetic dev fixture remains populated at night
  const nightNow = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 + 6 * 3_600_000).getTime();
  vi.setSystemTime(nightNow);
  try {
    relativeManifest = relative(base, await generateOfflineFixture(base, nightNow));
  } finally {
    vi.useRealTimers();
  }
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

async function refinedFixture() {
  const local = await fixture(), patch = fixturePatch(local.manifest);
  patch.grid = { ...patch.grid, kind: 'lambert-conformal', centralMeridianDeg: -100, latitudeOfOriginDeg: 40,
    standardParallel1Deg: 40, standardParallel2Deg: 40, x0M: -1000, y0M: 1000, dxM: 1000, dyM: -1000, wrapLongitude: false };
  patch.descriptors.bounds = [-100.008, 39.992, -99.992, 40.008];
  patch.geometry = { type: 'Polygon', coordinates: [[[-100.008, 39.992], [-99.992, 39.992], [-99.992, 40.008], [-100.008, 40.008], [-100.008, 39.992]]] };
  const baseMask = await readCoverage(local.root, local.manifest.coverage.hash);
  const mask: CoverageMask = { grid: patch.grid, bounds: patch.descriptors.bounds, output: new Uint8Array(2),
    halo: Uint8Array.of(255, 1), tiles: baseMask.tiles, maxZoom: baseMask.maxZoom };
  setBit(mask.output, 4); setBit(mask.halo, 4, false);
  const hash = await writeCoverage(local.root, mask, { coverageId: patch.coverage.id,
    coverageDescription: 'Synthetic refinement with one output cell and interpolation halo', bounds: patch.descriptors.bounds, supportHaloCells: 1 });
  patch.coverage = { ...patch.coverage, hash, maskKey: `coverage/${hash}/manifest.json` };
  const layout = prepareSamplePackLayout(mask.grid, mask.output, mask.halo), pack = createSamplePackBuilder(layout, local.manifest.frames.length);
  try {
    for (let channel = 0; channel < local.manifest.frames.length; channel++) {
      pack.writeChannel(channel, { values: new Float32Array(9).fill(900 + channel * 100), flags: new Uint8Array(9) });
    }
    patch.samples = { ...patch.samples, storedCells: layout.storedCells, ...await pack.finish(join(local.root, patch.samples.key)) };
  } finally { pack.close(); }
  local.manifest = manifestSchema.parse({ ...local.manifest, version: 4, patches: [patch] });
  await writeFile(local.manifestPath, JSON.stringify(local.manifest));
  return local;
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
    expect(Math.abs(Date.parse(manifest.cycle) - Date.now())).toBeLessThan(86_400_000);
    expect((manifest.metrics.frames as Record<string, Record<string, { valid: number }>>).f001['precip-rate'].valid).toBe(40);
    expect(MODEL_IDS).toEqual(['gfs', 'icon-eu']);
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

  it('seeds and repairs every refined coverage dependency before updating the local pointer', async () => {
    const local = await refinedFixture(), memory = memoryStore(), patch = local.manifest.patches![0];
    await seedLocalBuild(local, memory.open);
    const prefix = `coverage/${patch.coverage.hash}`;
    for (const name of ['manifest.json', 'output.bin', 'halo.bin', 'tiles.bin']) {
      expect(memory.objects.has(`${prefix}/${name}`)).toBe(true);
      expect(memory.writes.indexOf(`${prefix}/${name}`)).toBeLessThan(memory.writes.indexOf(relativeManifest));
    }
    const missing = `${prefix}/output.bin`;
    memory.objects.delete(missing); memory.writes.length = 0;
    await seedLocalBuild(local, memory.open);
    expect(memory.writes).toEqual([missing, 'catalog/gfs/latest.json']);
  });

  it.each(['missing', 'corrupt', 'mismatched-bounds'])('rejects %s patch coverage before opening local R2', async problem => {
    const local = await refinedFixture(), memory = memoryStore(), patch = local.manifest.patches![0];
    if (problem === 'missing') await rm(join(local.root, patch.coverage.maskKey));
    else if (problem === 'corrupt') await writeFile(join(local.root, `coverage/${patch.coverage.hash}/output.bin`), Uint8Array.of(0, 0));
    else { patch.descriptors.bounds[0] -= 0.001; await writeFile(local.manifestPath, JSON.stringify(local.manifest)); }
    await expect(seedLocalBuild(local, memory.open)).rejects.toThrow(/ENOENT|bitset|binding/);
    expect(memory.open).not.toHaveBeenCalled();
  });

  it('serves a fine-zone sample through the real local Worker after seeding a v4 build', async () => {
    const local = await refinedFixture();
    await seedLocalBuild(local);
    const { unstable_dev } = await import('wrangler');
    const worker = await unstable_dev(fileURLToPath(new URL('../apps/api/test/fixture-worker.ts', import.meta.url)), {
      config: fileURLToPath(new URL('../apps/api/wrangler.json', import.meta.url)),
      local: true, ip: '127.0.0.1', port: 0, inspectorPort: 0, persist: true, persistTo: local.persistTo,
      vars: { AV_LOCAL_DEVELOPMENT: 'true' }, envFiles: [], logLevel: 'error',
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false, enableContainers: false }
    });
    try {
      const response = await fetch(`http://${worker.address}:${worker.port}/v1/models/gfs/runs/${local.manifest.buildId}/sample?lat=40&lon=-100&frame=all&layers=usable-lift-agl,precip-rate`);
      expect(response.status).toBe(200);
      const result = sampleResponseSchema.parse(await response.json());
      expect(result.frames.map(frame => frame.layers['usable-lift-agl'])).toEqual([900, 1000].map(value => ({
        value, status: 'valid', support: 0, interpolated: false, patchId: local.manifest.patches![0].id
      })));
      expect(result.frames[0].layers['precip-rate'].value).toBe(2.75);
      expect(result.frames[0].layers['precip-rate'].patchId).toBeUndefined();
    } finally { await worker.stop(); }
  });
});
