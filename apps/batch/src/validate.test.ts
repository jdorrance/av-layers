import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CELL_BYTES, getBit, GFS_GRID, isCovered, manifestSchema, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID } from '@av/contracts';
import { packCells, sampleGrid, unpackCells } from '@av/forecast';
import { deriveFrame } from './build.js';
import type { GfsFrameAcquisition } from './noaa/types.js';
import { publish } from './publication.js';
import { loadCoverage, sha256, validateBuild, validateSamples, verifyCoverage } from './validate.js';

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
      // No sample/archive files exist: accidentally reaching those reads yields ENOENT,
      // which cannot satisfy these precise provenance errors.
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
        code: 'ENOENT', path: join(root, manifest.artifacts[0]!.samplesKey)
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('packed sample validation', () => {
  it('admits derived halo cells but rejects true outsiders and preserves public coverage', async () => {
    const mask = await loadCoverage(), coverageHash = await verifyCoverage(mask);
    const hashes = [mask.output, mask.halo, mask.tiles].map(sha256);
    const { width, height } = GFS_GRID;
    let output = -1, halo = -1;
    for (let row = 100; row < height - 100 && output < 0; row++) for (let col = 1; col < width - 1; col++) {
      const index = row * width + col;
      if (getBit(mask.output, index) && getBit(mask.halo, index + 1)) { output = index; halo = index + 1; break; }
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
});
