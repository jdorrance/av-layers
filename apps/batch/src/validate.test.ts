import { INDEXED_GRID, INDEXED_PRODUCT, SPLIT_PRODUCT } from '../../../tests/model-fixtures.js';
import { loadCoverage } from './coverage.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CELL_BYTES, createWholeDomainDescriptors, createRecipeIdentity, getBit, isCovered, setBit, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, validateSampleFlags, type CoverageMask, type ProductDefinition } from '@av/contracts';
import { packCells, prepareShardedSamplePackLayout, resolveProductFrameHours, sampleGrid, unpackCells } from '@av/forecast';
import { deriveFrame } from '@av/forecast';
import { describeCoverage } from './coverage.js';
import type { NormalizedFrame } from '@av/forecast';
import { fixtureManifestV5 } from '../../../tests/forecast-fixture.js';
import { forecastFrame } from './frame-build.js';
import { createShardedSamplePackWriter } from './sample-pack-v5.js';
import { runConcurrent, sha256, validateBuild, validateSampleGroup } from './validate.js';
import { nativeSparseMask } from './whole-domain/coverage.js';

describe('build provenance validation', () => {
  async function fixture(registered: ProductDefinition = INDEXED_PRODUCT, useAllHours = false) {
    const product = { ...registered, id: `${registered.id}-validation-fixture`, mapEndHour: undefined };
    const mask = await loadCoverage(product), cycle = '2026-10-30T00:00:00.000Z';
    const hours = useAllHours ? product.frameHours : resolveProductFrameHours(product, mask, cycle);
    const manifest = fixtureManifestV5({ model: product.modelId, cycle,
      descriptors: createWholeDomainDescriptors(product), recipe: createRecipeIdentity(product, 'a'.repeat(64)),
      frames: hours.map(hour => forecastFrame(cycle, hour, product.intervalHours)), layers: [...product.layers] });
    for (const surface of manifest.surfaces) surface.coverage.maxZoom = mask.maxZoom;
    const root = await mkdtemp(join(tmpdir(), 'av-validate-'));
    const key = `builds/${manifest.model}/${manifest.buildId}/provenance.json`;
    const receipt = { version: 1, model: manifest.model, buildId: manifest.buildId, cycle: manifest.cycle, frames: [] };
    const bytes = Buffer.from(JSON.stringify(receipt));
    manifest.source = { provider: 'fixture', provenanceKey: key, provenanceSha256: sha256(bytes) };
    await mkdir(dirname(join(root, key)), { recursive: true });
    await writeFile(join(root, key), bytes);
    return { root, manifest, mask, product, key, receipt };
  }

  it.each(['missing key', 'missing hash', 'wrong key', 'invalid hash'])('rejects an invalid reference: %s', async defect => {
    const { root, manifest, mask, product } = await fixture();
    try {
      if (defect === 'missing key') delete (manifest.source as Record<string, unknown>).provenanceKey;
      if (defect === 'missing hash') delete (manifest.source as Record<string, unknown>).provenanceSha256;
      if (defect === 'wrong key') manifest.source.provenanceKey = 'builds/gfs/another/provenance.json';
      if (defect === 'invalid hash') manifest.source.provenanceSha256 = 'invalid';
      await expect(validateBuild(root, manifest, mask, product)).rejects.toMatchObject(defect === 'wrong key' ? { message: 'Invalid provenance reference' } : { name: 'ZodError' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['missing', 'corrupt'])('rejects the %s receipt itself, not a missing forecast artifact', async defect => {
    const { root, manifest, mask, product, key } = await fixture();
    try {
      if (defect === 'missing') await rm(join(root, key));
      else await writeFile(join(root, key), 'corrupt receipt');
      await expect(validateBuild(root, manifest, mask, product)).rejects.toMatchObject(defect === 'missing'
        ? { code: 'ENOENT', path: join(root, key) }
        : { message: `Invalid provenance hash ${key}` });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['cycle', 'model', 'buildId', 'version'] as const)('rejects a hash-valid wrong %s before reading artifacts', async field => {
    const { root, manifest, mask, product, key, receipt } = await fixture();
    try {
      const values = { cycle: '2026-10-29T00:00:00.000Z', model: 'hrrr', buildId: 'another', version: 99 };
      const bytes = Buffer.from(JSON.stringify({ ...receipt, [field]: values[field] }));
      manifest.source.provenanceSha256 = sha256(bytes);
      await writeFile(join(root, key), bytes);
      const expected = field === 'version'
        ? { name: 'ZodError', issues: expect.arrayContaining([expect.objectContaining({ path: ['version'] })]) }
        : { message: 'Provenance does not match manifest' };
      await expect(validateBuild(root, manifest, mask, product)).rejects.toMatchObject(expected);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects hash-valid invalid JSON before artifact reads', async () => {
    const { root, manifest, mask, product, key } = await fixture();
    try {
      const bytes = Buffer.from('not JSON');
      manifest.source.provenanceSha256 = sha256(bytes);
      await writeFile(join(root, key), bytes);
      await expect(validateBuild(root, manifest, mask, product)).rejects.toBeInstanceOf(SyntaxError);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('admits valid sidecar provenance and continues to artifact validation', async () => {
    const { root, manifest, mask, product } = await fixture();
    try {
      await expect(validateBuild(root, manifest, mask, product)).rejects.toMatchObject({ code: 'ENOENT', path: join(root, manifest.surfaces[0]!.coverage.maskKey) });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects unfiltered night frames for a regional-daylight product', async () => {
    const { root, manifest, mask, product } = await fixture(SPLIT_PRODUCT, true);
    try {
      await expect(validateBuild(root, manifest, mask, product)).rejects.toThrow('Incomplete frame set');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects legacy inline provenance without the required immutable sidecar', async () => {
    const { root, manifest, mask, product, receipt } = await fixture();
    try {
      const raw = { ...manifest, source: { provider: 'noaa', frames: receipt.frames } };
      await expect(validateBuild(root, raw, mask, product)).rejects.toMatchObject({ name: 'ZodError' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('packed sample and concurrent archive validation', () => {
  it('drains started concurrent work before rejecting and stops dequeuing', async () => {
    let fail!: () => void, finish!: () => void, settled = false;
    const failure = new Promise<void>(resolve => { fail = resolve; });
    const completion = new Promise<void>(resolve => { finish = resolve; });
    const started: number[] = [];
    const work = runConcurrent([0, 1, 2, 3], 2, async item => {
      started.push(item);
      if (item === 0) { await failure; throw new Error('corrupt WebP'); }
      await completion;
    }).catch(error => { settled = true; return error; });
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    fail(); await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    expect(await work).toMatchObject({ message: 'corrupt WebP' });
    expect(started).toEqual([0, 1]);
  });

  it('admits derived halo cells but rejects true outsiders and preserves public coverage', async () => {
    const mask = await loadCoverage(INDEXED_PRODUCT), coverageHash = describeCoverage(mask, INDEXED_PRODUCT).hash;
    const hashes = [mask.output, mask.halo, mask.tiles].map(sha256);
    const { width, height } = INDEXED_GRID;
    let output = -1, halo = -1;
    for (let index = 100 * width; index < (height - 100) * width; index++) {
      const col = index % width;
      if (col > 0 && col < width - 1 && getBit(mask.output, index) && getBit(mask.halo, index + 1)) {
        output = index; halo = index + 1; break;
      }
    }
    expect(output).toBeGreaterThanOrEqual(0);
    const values = (n: number) => new Float32Array([n, n]);
    const missing = () => new Uint8Array(2);
    const input = { activeIndices: new Uint32Array([output, halo]), terrainM: values(0), surfacePressurePa: values(100000), temp2mK: values(293), specificHumidity2mKgKg: values(0.008), sensibleHeatFluxWm2: values(200), latentHeatFluxWm2: values(100), precipitationMmPerHour: new Float32Array([2, 4]), pressureLevelsHpa: [], hgtM: [], tempK: [], missing: { terrain: missing(), surfacePressure: missing(), temp2m: missing(), humidity2m: missing(), sensibleHeatFlux: missing(), latentHeatFlux: missing(), precipitation: missing(), hgt: [], temp: [] } } as unknown as NormalizedFrame;
    const field = deriveFrame(input, mask, { layers: ['precip-rate'] })['precip-rate']!;
    let outside = -1;
    for (let i = 0; i < width * height; i++) {
      if (i !== output && i !== halo && (getBit(mask.output, i) || getBit(mask.halo, i))) field.flags[i] = STATUS_UNAVAILABLE;
      if (outside < 0 && !getBit(mask.output, i) && !getBit(mask.halo, i)) outside = i;
    }
    expect(outside).toBeGreaterThanOrEqual(0);
    const dir = await mkdtemp(join(tmpdir(), 'av-validate-'));
    try {
      const path = join(dir, 'samples.bin');
      await writeFile(path, packCells(field));
      const bytes = await readFile(path);
      expect(bytes.length).toBe(width * height * CELL_BYTES);
      expect(() => validateSampleFlags(bytes, width * height * CELL_BYTES, 'precip-rate', mask, path)).not.toThrow();
      const restored = unpackCells(bytes), lat = INDEXED_GRID.lat0 + Math.floor(output / width) * INDEXED_GRID.dy, lon = INDEXED_GRID.lon0 + (output % width) * INDEXED_GRID.dx;
      expect(isCovered(mask, lat, lon + 0.1)).toBe(true);
      const sample = sampleGrid(INDEXED_GRID, restored, lat, lon + 0.1, 'precip-rate', mask, false);
      expect(sample).toMatchObject({ status: STATUS_VALID, interpolated: true });
      expect(sample.value).toBeCloseTo(2.8);
      expect(isCovered(mask, lat, lon + 0.25)).toBe(false);
      expect(sampleGrid(INDEXED_GRID, restored, lat, lon + 0.25, 'precip-rate', mask, false).status).toBe(STATUS_OUTSIDE);
      bytes[outside * CELL_BYTES + 4] = STATUS_VALID;
      expect(() => validateSampleFlags(bytes, width * height * CELL_BYTES, 'precip-rate', mask, path)).toThrow('Sample coverage mismatch');
      bytes[outside * CELL_BYTES + 4] = STATUS_OUTSIDE;
      bytes[output * CELL_BYTES + 4] = STATUS_OUTSIDE;
      expect(() => validateSampleFlags(bytes, width * height * CELL_BYTES, 'precip-rate', mask, path)).toThrow('Sample coverage mismatch');
      expect([mask.output, mask.halo, mask.tiles].map(sha256)).toEqual(hashes);
      expect(describeCoverage(mask, INDEXED_PRODUCT).hash).toBe(coverageHash);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('checks sparse records for invalid flags, coverage, length and digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'av-validate-pack-'));
    try {
      const grid = { kind: 'regular-latlon' as const, earthRadiusM: 6371229, width: 4, height: 3, lon0: -180, lat0: 1, dx: 90, dy: -1, wrapLongitude: false };
      const mask: CoverageMask = { grid, output: new Uint8Array(2), halo: new Uint8Array(2), tiles: Uint8Array.of(1), maxZoom: 0 };
      setBit(mask.output, 0); setBit(mask.halo, 3);
      const coverage = nativeSparseMask(mask).coverage;
      const layout = prepareShardedSamplePackLayout(grid, coverage.blockIds, 1);
      const writer = createShardedSamplePackWriter(layout, coverage, { root, model: 'gfs', buildId: 'test', surfaceId: 'native' });
      const flags = new Uint8Array(12).fill(STATUS_OUTSIDE); flags[0] = 0; flags[3] = 0;
      await writer.writeChannel(0, { values: new Float32Array(12).fill(2), flags });
      const [shard] = await writer.finish();
      const path = join(root, shard!.key), original = await readFile(path);
      const descriptors = createWholeDomainDescriptors(INDEXED_PRODUCT);
      const validate = (sha256 = shard!.sha256, channels = 1) => validateSampleGroup(root, { grid, layers: ['precip-rate'] }, coverage, descriptors,
        { channels, shards: [{ ...shard!, sha256 }] });
      await expect(validate()).resolves.toBeUndefined();
      for (const [offset, flag, message] of [[4, 1, 'lift flags'], [9, 0, 'coverage'], [4, 128, 'lift flags']] as const) {
        const corrupt = Buffer.from(original); corrupt[offset] = flag; await writeFile(path, corrupt);
        await expect(validate(sha256(corrupt))).rejects.toThrow(message);
      }
      const corrupt = Buffer.from(original); corrupt.writeFloatLE(NaN, 0); await writeFile(path, corrupt);
      await expect(validate(sha256(corrupt))).rejects.toThrow('non-finite');
      await writeFile(path, original.subarray(0, -1));
      await expect(validate()).rejects.toThrow('changed length');
      await writeFile(path, original);
      await expect(validate('0'.repeat(64))).rejects.toThrow('hash');
      await expect(validate(undefined, 2)).rejects.toThrow('layout');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
