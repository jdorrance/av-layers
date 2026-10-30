import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CELL_BYTES, getBit, GFS_GRID, isCovered, manifestSchema, setBit, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, type CoverageMask, type Manifest } from '@av/contracts';
import { packCells, prepareSamplePackLayout, sampleGrid, unpackCells } from '@av/forecast';
import { deriveFrame } from './build.js';
import type { GfsFrameAcquisition } from './noaa/types.js';
import { publish } from './publication.js';
import { writeSamplePack } from './sample-pack.js';
import { loadCoverage, runConcurrent, sha256, validateBuild, validateSamplePack, validateSamples, verifyCoverage } from './validate.js';

describe('build provenance validation', () => {
  async function fixture() {
    const manifest = manifestSchema.parse(JSON.parse(await readFile(new URL('../../../scripts/fixtures/manifest.contract.json', import.meta.url), 'utf8')));
    const mask = await loadCoverage();
    manifest.coverage.hash = await verifyCoverage(mask);
    manifest.createdAt = manifest.cycle;
    manifest.expiresAt = new Date(Date.parse(manifest.createdAt) + 7 * 86400000).toISOString();
    const root = await mkdtemp(join(tmpdir(), 'av-validate-'));
    const key = `builds/${manifest.model}/${manifest.buildId}/provenance.json`;
    const receipt = { version: 1, model: manifest.model, buildId: manifest.buildId, cycle: manifest.cycle, frames: [] };
    const bytes = Buffer.from(JSON.stringify(receipt));
    manifest.source = { provenanceKey: key, provenanceSha256: sha256(bytes) };
    await mkdir(dirname(join(root, key)), { recursive: true });
    await writeFile(join(root, key), bytes);
    return { root, manifest, mask, key, receipt };
  }

  it.each(['missing key', 'missing hash', 'wrong key', 'invalid hash'])('rejects an invalid reference: %s', async defect => {
    const { root, manifest, mask } = await fixture();
    try {
      if (defect === 'missing key') delete manifest.source.provenanceKey;
      if (defect === 'missing hash') delete manifest.source.provenanceSha256;
      if (defect === 'wrong key') manifest.source.provenanceKey = 'builds/gfs/another/provenance.json';
      if (defect === 'invalid hash') manifest.source.provenanceSha256 = 'invalid';
      await expect(validateBuild(root, manifest, mask)).rejects.toMatchObject({ message: 'Invalid provenance reference' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['missing', 'corrupt'])('rejects the %s receipt itself, not a missing forecast artifact', async defect => {
    const { root, manifest, mask, key } = await fixture();
    try {
      if (defect === 'missing') await rm(join(root, key));
      else await writeFile(join(root, key), 'corrupt receipt');
      await expect(validateBuild(root, manifest, mask)).rejects.toMatchObject(defect === 'missing'
        ? { code: 'ENOENT', path: join(root, key) }
        : { message: `Invalid provenance hash ${key}` });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['cycle', 'model', 'buildId', 'version'] as const)('rejects a hash-valid wrong %s before reading artifacts or uploading objects', async field => {
    const { root, manifest, mask, key, receipt } = await fixture();
    try {
      const values = { cycle: '2026-10-29T00:00:00.000Z', model: 'hrrr', buildId: 'another', version: 2 };
      const bytes = Buffer.from(JSON.stringify({ ...receipt, [field]: values[field] }));
      manifest.source.provenanceSha256 = sha256(bytes);
      await writeFile(join(root, key), bytes);
      const expected = field === 'version'
        ? { name: 'ZodError', issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_value', path: ['version'] })]) }
        : { message: 'Provenance does not match manifest' };
      await expect(validateBuild(root, manifest, mask)).rejects.toMatchObject(expected);
      const store = { get: vi.fn(async () => null), head: vi.fn(async () => null), put: vi.fn(async () => {}), list: vi.fn(async () => []), delete: vi.fn(async () => {}) };
      await expect(publish(store, root, manifest, { now: () => Date.parse(manifest.createdAt) + 1000 })).rejects.toMatchObject(expected);
      expect(store.put).not.toHaveBeenCalled();
      expect(store.head).not.toHaveBeenCalled();
      expect(store.get).toHaveBeenCalledExactlyOnceWith('catalog/gfs/latest.json');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects hash-valid invalid JSON before artifact reads', async () => {
    const { root, manifest, mask, key } = await fixture();
    try {
      const bytes = Buffer.from('not JSON');
      manifest.source.provenanceSha256 = sha256(bytes);
      await writeFile(join(root, key), bytes);
      await expect(validateBuild(root, manifest, mask)).rejects.toBeInstanceOf(SyntaxError);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['sidecar', 'inline'] as const)('admits valid %s provenance and continues to artifact validation', async kind => {
    const { root, manifest, mask, receipt } = await fixture();
    try {
      if (kind === 'inline') manifest.source = { provider: 'NOAA', frames: receipt.frames };
      await expect(validateBuild(root, manifest, mask)).rejects.toMatchObject({
        code: 'ENOENT', path: join(root, manifest.samples.key)
      });
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
    const mask = await loadCoverage(), coverageHash = await verifyCoverage(mask);
    const hashes = [mask.output, mask.halo, mask.tiles].map(sha256);
    const { width, height } = GFS_GRID;
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
    const input = { activeIndices: new Uint32Array([output, halo]), terrainM: values(0), surfacePressurePa: values(100000), temp2mK: values(293), specificHumidity2mKgKg: values(0.008), pblHeightM: values(300), sensibleHeatFluxWm2: values(200), latentHeatFluxWm2: values(100), precipitationMmPerHour: new Float32Array([2, 4]), pressureLevelsHpa: [], hgtM: [], tempK: [], missing: { terrain: missing(), surfacePressure: missing(), temp2m: missing(), humidity2m: missing(), pbl: missing(), sensibleHeatFlux: missing(), latentHeatFlux: missing(), precipitation: missing(), hgt: [], temp: [] } } as unknown as GfsFrameAcquisition;
    const field = deriveFrame(input, mask)['precip-rate'];
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
      expect(() => validateSamples(bytes, mask, 'precip-rate', path)).not.toThrow();
      const restored = unpackCells(bytes), lat = GFS_GRID.lat0 + Math.floor(output / width) * GFS_GRID.dy, lon = GFS_GRID.lon0 + (output % width) * GFS_GRID.dx;
      expect(isCovered(mask, lat, lon + 0.1)).toBe(true);
      const sample = sampleGrid(GFS_GRID, restored, lat, lon + 0.1, 'precip-rate', mask);
      expect(sample).toMatchObject({ status: STATUS_VALID, interpolated: true });
      expect(sample.value).toBeCloseTo(2.8);
      expect(isCovered(mask, lat, lon + 0.25)).toBe(false);
      expect(sampleGrid(GFS_GRID, restored, lat, lon + 0.25, 'precip-rate', mask).status).toBe(STATUS_OUTSIDE);
      bytes[outside * CELL_BYTES + 4] = STATUS_VALID;
      expect(() => validateSamples(bytes, mask, 'precip-rate', path)).toThrow('Sample coverage mismatch');
      bytes[outside * CELL_BYTES + 4] = STATUS_OUTSIDE;
      bytes[output * CELL_BYTES + 4] = STATUS_OUTSIDE;
      expect(() => validateSamples(bytes, mask, 'precip-rate', path)).toThrow('Sample coverage mismatch');
      expect([mask.output, mask.halo, mask.tiles].map(sha256)).toEqual(hashes);
      expect(await verifyCoverage(mask)).toBe(coverageHash);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('checks channels, values, flags, coverage, length and digest including wrap halos', async () => {
    const root = await mkdtemp(join(tmpdir(), 'av-validate-pack-'));
    try {
      const mask: CoverageMask = { grid: { width: 4, height: 3, lon0: -180, lat0: 1, dx: 90, dy: -1, wrapLongitude: true }, output: new Uint8Array(2), halo: new Uint8Array(2), tiles: new Uint8Array(1), maxZoom: 0 };
      setBit(mask.output, 0); setBit(mask.halo, 3);
      const flags = new Uint8Array(12).fill(STATUS_OUTSIDE); flags[0] = 0; flags[3] = 0;
      const input = join(root, 'flat.bin'), output = join(root, 'pack.bin');
      await writeFile(input, packCells({ values: new Float32Array(12).fill(2), flags }));
      const layout = prepareSamplePackLayout(mask.grid, mask.output, mask.halo);
      const packed = await writeSamplePack(output, [input], layout);
      const manifest = { frames: [{ id: 'f003' }], layers: ['precip-rate'], samples: { format: 'cell-major-blocks-v1', blockSize: 16, storedCells: layout.storedCells, channelCount: 1, key: 'samples.bin', ...packed } } as unknown as Manifest;
      await expect(validateSamplePack(output, manifest, mask)).resolves.toBeUndefined();
      const original = await readFile(output);
      for (const [offset, flag, message] of [[4, 1, 'lift flags'], [9, 0, 'coverage'], [4, 128, 'support bits']] as const) {
        const corrupt = Buffer.from(original); corrupt[offset] = flag; await writeFile(output, corrupt);
        await expect(validateSamplePack(output, { ...manifest, samples: { ...manifest.samples, sha256: sha256(corrupt) } }, mask)).rejects.toThrow(message);
      }
      const corrupt = Buffer.from(original); corrupt.writeFloatLE(NaN, 0); await writeFile(output, corrupt);
      await expect(validateSamplePack(output, manifest, mask)).rejects.toThrow('non-finite');
      await writeFile(output, original.subarray(0, -1));
      await expect(validateSamplePack(output, manifest, mask)).rejects.toThrow('Invalid samples');
      await writeFile(output, original);
      await expect(validateSamplePack(output, { ...manifest, samples: { ...manifest.samples, sha256: '0'.repeat(64) } }, mask)).rejects.toThrow('hash');
      await expect(validateSamplePack(output, { ...manifest, samples: { ...manifest.samples, channelCount: 2 } }, mask)).rejects.toThrow('layout');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects self-hashed divergent horizontal, vertical, wrap and bit-exact halo copies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'av-pack-boundaries-'));
    try {
      const grid = { width: 33, height: 33, lon0: 0, lat0: 32, dx: 1, dy: -1, wrapLongitude: true };
      const mask: CoverageMask = { grid, output: new Uint8Array(Math.ceil(1089 / 8)).fill(255), halo: new Uint8Array(Math.ceil(1089 / 8)), tiles: Uint8Array.of(1), maxZoom: 0 };
      const layout = prepareSamplePackLayout(grid, mask.output, mask.halo), input = join(root, 'flat.bin'), path = join(root, 'samples.bin');
      const flat = Buffer.from(packCells({ values: new Float32Array(1089).fill(2), flags: new Uint8Array(1089) }));
      flat.writeUInt32LE(0x80000000, 0);
      flat.writeUInt32LE(0x7fc01234, 5); flat[9] = 2;
      await writeFile(input, flat);
      const packed = await writeSamplePack(path, [input], layout);
      const manifest = { frames: [{ id: 'f003' }], layers: ['precip-rate'], samples: { format: 'cell-major-blocks-v1', blockSize: 16, storedCells: layout.storedCells, channelCount: 1, key: 'samples.bin', ...packed } } as unknown as Manifest;
      await expect(validateSamplePack(path, manifest, mask)).resolves.toBeUndefined();
      const original = await readFile(path);
      const cases = [
        { rank: 16, bits: 0x40400000 },
        { rank: 16 * 17 + 2, bits: 0x40400000 },
        { rank: layout.block(2)!.cellOffset + 1, bits: 0 },
        { rank: layout.block(3)!.cellOffset + 1, bits: 0x7fc05678 }
      ];
      const verticalNan = (16 * grid.width + 1) * 5;
      flat.writeUInt32LE(0x7fc01234, verticalNan); flat[verticalNan + 4] = 2;
      await writeFile(input, flat); await rm(path);
      const updated = await writeSamplePack(path, [input], layout), withNan = await readFile(path);
      for (const [i, entry] of cases.entries()) {
        const bytes = Buffer.from(i === 3 ? withNan : original); bytes.writeUInt32LE(entry.bits, entry.rank * 5);
        await writeFile(path, bytes);
        await expect(validateSamplePack(path, { ...manifest, samples: { ...manifest.samples, ...updated, sha256: sha256(bytes) } }, mask)).rejects.toThrow('Duplicate sample cell differs');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
