import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CELL_BYTES, getBit, GFS_GRID, isCovered, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID } from '@av/contracts';
import { packCells, sampleGrid, unpackCells } from '@av/forecast';
import { deriveFrame } from './build.js';
import type { GfsFrameAcquisition } from './noaa/types.js';
import { loadCoverage, sha256, validateSamples, verifyCoverage } from './validate.js';

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
