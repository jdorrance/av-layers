import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getProduct, manifestSchema, manifestV5Schema, sampleResponseSchema, setBit, createSparseCoverage, encodeSparseCoverage, canonicalGridJson, type CoverageMask, type ManifestV5 } from '@av/contracts';
import { prepareSamplePackLayout } from '@av/forecast';
import { OFFLINE_PRODUCT } from '@av/contracts/fixture-product';
import { readCoverage, writeCoverage } from '../apps/batch/src/coverage.js';
import { createSamplePackBuilder } from '../apps/batch/src/sample-pack.js';
import { fixturePatch } from '../tests/forecast-fixture.js';
import { generateOfflineFixture, offlineFixtureProduct } from './dev-fixture.js';
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
  return { root, manifest, manifestPath, persistTo, pointerKey: `catalog/${manifest.model}/latest.json`, trustedProduct: offlineFixtureProduct() };
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

async function v5Fixture() {
  const local = await fixture(), base = local.manifest, outputRoot = local.root;
  const gridHash = createHash('sha256').update(canonicalGridJson(base.grid)).digest('hex');
  const output = new Uint8Array(32), halo = new Uint8Array(32); output[0] = 1; setBit(halo, 1); setBit(halo, 16); setBit(halo, 17);
  const coverage = createSparseCoverage({ width: base.grid.width, height: base.grid.height, wrapLongitude: base.grid.wrapLongitude, gridHash,
    blockIds: Uint32Array.of(0), offsets: Uint32Array.of(0, 4), output, halo });
  const sparse = encodeSparseCoverage(coverage), tiles = new Uint8Array(Math.ceil(((4 ** (base.coverage.maxZoom + 1) - 1) / 3) / 8)); tiles[0] = 1;
  const descriptor = Buffer.from(JSON.stringify({ version: 2, id: base.coverage.id, grid: base.grid, gridHash, bounds: base.descriptors.bounds,
    policy: 'fixture', maxZoom: base.coverage.maxZoom, supportHaloCells: 1, sampleLayout: { format: 'cell-major-block-shards-v1', blockSize: 16 },
    files: { sparse: { bytes: sparse.length, sha256: createHash('sha256').update(sparse).digest('hex') },
      tiles: { bytes: tiles.length, sha256: createHash('sha256').update(tiles).digest('hex') } } }));
  const coverageHash = createHash('sha256').update(descriptor).digest('hex'), coveragePrefix = `coverage/${coverageHash}`;
  const coverageDir = join(outputRoot, coveragePrefix);
  await mkdir(coverageDir, { recursive: true });
  await writeFile(join(coverageDir, 'manifest.json'), descriptor);
  await writeFile(join(coverageDir, 'sparse.bin'), sparse);
  await writeFile(join(coverageDir, 'tiles.bin'), tiles);
  const elevation = Uint8Array.of(0, 0, 0, 0), valid = Uint8Array.of(1);
  const terrainDataId = 'd'.repeat(64), terrainChunk = `terrain/prepared/${'e'.repeat(64)}`;
  const terrainManifest = Buffer.from(JSON.stringify({ version: 2, dataId: terrainDataId, grid: base.grid, gridHash, coverageHash, layoutVersion: 1, cells: 1,
    files: { elevationM: [{ key: `${terrainChunk}/elevation-0.f32`, bytes: elevation.length, sha256: createHash('sha256').update(elevation).digest('hex') }],
      valid: [{ key: `${terrainChunk}/valid-0.u8`, bytes: valid.length, sha256: createHash('sha256').update(valid).digest('hex') }] } }));
  const terrainSha = createHash('sha256').update(terrainManifest).digest('hex'), terrainKey = `terrain/prepared/${terrainSha}/manifest.json`;
  const terrainDir = join(outputRoot, `terrain/prepared/${terrainSha}`);
  await mkdir(terrainDir, { recursive: true });
  await writeFile(join(outputRoot, terrainKey), terrainManifest);
  await mkdir(join(outputRoot, terrainChunk), { recursive: true });
  await writeFile(join(outputRoot, `${terrainChunk}/elevation-0.f32`), elevation);
  await writeFile(join(outputRoot, `${terrainChunk}/valid-0.u8`), valid);
  const surface = (id: 'native' | 'fine', layers: ManifestV5['layers']) => {
    const channelCount = base.frames.length * layers.length, bytes = Buffer.alloc(channelCount * 5, 1);
    const shard = { firstBlock: 0, blockCount: 1, storedCells: 1, bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'), key: `builds/${base.model}/${base.buildId}/surfaces/${id}/samples/0.bin` };
    return { id, kind: id, grid: base.grid, gridHash,
      coverage: { id: base.coverage.id, hash: coverageHash, maskKey: `${coveragePrefix}/manifest.json`, maxZoom: base.coverage.maxZoom, gridHash }, layers,
      samples: { format: 'cell-major-block-shards-v1' as const, blockSize: 16 as const, channelOrder: 'frame-then-layer' as const, channelCount,
        coverageHash, blockCount: 1, storedCells: 1, shards: [shard] },
      ...(id === 'fine' ? { terrain: { dataId: terrainDataId, key: terrainKey, sha256: terrainSha, verticalDatum: 'EGM2008', surface: 'DSM',
        gridHash, coverageHash, layoutVersion: 1 as const } } : {}), bytes };
  };
  const native = surface('native', ['precip-rate']), fine = surface('fine', ['usable-lift-msl', 'usable-lift-agl']);
  for (const current of [native, fine]) {
    const path = join(outputRoot, current.samples.shards[0]!.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, current.bytes);
  }
  const { bytes: _native, ...nativeSurface } = native, { bytes: _fine, ...fineSurface } = fine;
  const manifest = manifestV5Schema.parse({ version: 5, descriptors: base.descriptors, recipe: base.recipe, model: base.model, buildId: base.buildId,
    cycle: base.cycle, createdAt: base.createdAt, expiresAt: base.expiresAt, method: base.method, frames: base.frames, layers: base.layers,
    artifacts: base.artifacts, source: base.source, tool: base.tool, palettes: base.palettes, metrics: base.metrics,
    surfaces: [nativeSurface, fineSurface] });
  await writeFile(local.manifestPath, JSON.stringify(manifest));
  const validate = async () => ({ root: outputRoot, manifest });
  return { ...local, manifest, outputRoot, validate, coveragePrefix, terrainKey, terrainChunk, shardKey: fineSurface.samples.shards[0]!.key };
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
    expect(getProduct(manifest.model)!.id).not.toBe(OFFLINE_PRODUCT.id);
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
    expect(memory.writes.at(-1)).toBe(local.pointerKey);
    expect(JSON.parse(Buffer.from(memory.objects.get(local.pointerKey)!.bytes).toString()).latestBuildId).toBe(local.manifest.buildId);
  });

  it('rejects an unknown recipe instead of reporting record-only validation', async () => {
    const local = await fixture(), memory = memoryStore();
    await expect(seedLocalBuild({ ...local, trustedProduct: undefined }, memory.open)).rejects.toThrow('Unsupported local build recipe or model');
    expect(memory.open).not.toHaveBeenCalled();
  });

  it.each(['missing coverage', 'corrupt coverage', 'missing provenance', 'corrupt provenance', 'missing samples', 'corrupt samples', 'missing pmtiles', 'corrupt pmtiles'] as const)('rejects %s before opening local R2 with a trusted fixture product', async problem => {
    const local = await fixture(), memory = memoryStore(), provenance = local.manifest.source.provenanceKey as string, artifact = local.manifest.artifacts[0];
    if (problem === 'missing coverage') await rm(join(local.root, `coverage/${local.manifest.coverage.hash}/output.bin`));
    if (problem === 'corrupt coverage') await writeFile(join(local.root, `coverage/${local.manifest.coverage.hash}/output.bin`), Uint8Array.of(0));
    if (problem === 'missing provenance') await rm(join(local.root, provenance));
    if (problem === 'corrupt provenance') await writeFile(join(local.root, provenance), 'corrupt');
    if (problem === 'missing samples') await rm(join(local.root, local.manifest.samples.key));
    if (problem === 'corrupt samples') await writeFile(join(local.root, local.manifest.samples.key), 'corrupt');
    if (problem === 'missing pmtiles') await rm(join(local.root, artifact.tilesKey));
    if (problem === 'corrupt pmtiles') await writeFile(join(local.root, artifact.tilesKey), 'corrupt');
    await expect(seedLocalBuild(local, memory.open)).rejects.toThrow();
    expect(memory.open).not.toHaveBeenCalled();
  });

  it('reuses verified objects, repairs missing dependencies even with a marker, and rewrites the pointer', async () => {
    const local = await fixture(), memory = memoryStore();
    await seedLocalBuild(local, memory.open);
    memory.writes.length = 0;
    expect(await seedLocalBuild(local, memory.open)).toMatchObject({ uploadedObjects: 1, reusedObjects: 13 });
    expect(memory.writes).toEqual([local.pointerKey]);
    const missingKey = `coverage/${local.manifest.coverage.hash}/output.bin`;
    memory.objects.delete(missingKey); memory.writes.length = 0;
    expect(await seedLocalBuild(local, memory.open)).toMatchObject({ uploadedObjects: 2, reusedObjects: 12 });
    expect(memory.writes).toEqual([missingKey, local.pointerKey]);
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
    expect(memory.objects.has(local.pointerKey)).toBe(false);
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
      expect(await reopened.head(local.pointerKey)).not.toBeNull();
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
    expect(memory.writes).toEqual([missing, local.pointerKey]);
  });

  it.each(['missing', 'corrupt', 'mismatched-bounds'])('rejects %s patch coverage before opening local R2', async problem => {
    const local = await refinedFixture(), memory = memoryStore(), patch = local.manifest.patches![0];
    if (problem === 'missing') await rm(join(local.root, patch.coverage.maskKey));
    else if (problem === 'corrupt') await writeFile(join(local.root, `coverage/${patch.coverage.hash}/output.bin`), Uint8Array.of(0, 0));
    else { patch.descriptors.bounds[0] -= 0.001; await writeFile(local.manifestPath, JSON.stringify(local.manifest)); }
    await expect(seedLocalBuild(local, memory.open)).rejects.toThrow(/ENOENT|bitset|binding/);
    expect(memory.open).not.toHaveBeenCalled();
  });

  it('seeds v5 coverage, terrain, sample shards, PMTiles and provenance before the pointer', async () => {
    const local = await v5Fixture(), memory = memoryStore();
    const result = await seedLocalBuild(local, memory.open, local.validate);
    expect(result.manifest.version).toBe(5);
    for (const key of [`${local.coveragePrefix}/manifest.json`, `${local.coveragePrefix}/sparse.bin`, `${local.coveragePrefix}/tiles.bin`,
      local.terrainKey, `${local.terrainChunk}/elevation-0.f32`, `${local.terrainChunk}/valid-0.u8`, local.shardKey,
      ...local.manifest.artifacts.map(artifact => artifact.tilesKey), local.manifest.source.provenanceKey!]) {
      expect(memory.objects.has(key)).toBe(true);
      expect(memory.writes.indexOf(key)).toBeLessThan(memory.writes.indexOf(relativeManifest));
    }
    expect(memory.writes.at(-1)).toBe(local.pointerKey);
    expect(memory.writes.at(-2)).toBe(relativeManifest);
    for (const key of [...memory.objects.keys()]) expect(memory.objects.get(key)!.customMetadata.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(['missing coverage', 'corrupt coverage', 'missing terrain', 'corrupt terrain', 'corrupt shard'] as const)('rejects v5 %s before opening local R2 or writing the pointer', async problem => {
    const local = await v5Fixture(), memory = memoryStore();
    if (problem === 'missing coverage') await rm(join(local.outputRoot, `${local.coveragePrefix}/sparse.bin`));
    if (problem === 'corrupt coverage') await writeFile(join(local.outputRoot, `${local.coveragePrefix}/sparse.bin`), Uint8Array.of(9));
    if (problem === 'missing terrain') await rm(join(local.outputRoot, `${local.terrainChunk}/elevation-0.f32`));
    if (problem === 'corrupt terrain') await writeFile(join(local.outputRoot, local.terrainKey), 'corrupt');
    if (problem === 'corrupt shard') await writeFile(join(local.outputRoot, local.shardKey), 'corrupt');
    await expect(seedLocalBuild(local, memory.open, local.validate)).rejects.toThrow();
    expect(memory.open).not.toHaveBeenCalled();
    expect(memory.objects.has(local.pointerKey)).toBe(false);
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
      const response = await fetch(`http://${worker.address}:${worker.port}/v1/models/${local.manifest.model}/runs/${local.manifest.buildId}/sample?lat=40&lon=-100&frame=all&layers=usable-lift-agl,precip-rate`);
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
