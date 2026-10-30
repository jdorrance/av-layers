import { describe, expect, it } from 'vitest';
import { LAYER_IDS, setBit, type CoverageMask, type Grid, type LayerId } from '@av/contracts';
import { prepareGridSampling, sampleCells, sampleGrid, type GridField, type Sample } from './sampler.js';

function outcome<T>(fn: () => T): T | { error: string } {
  try { return fn(); } catch (error) { return { error: (error as Error).message }; }
}
function maskFor(grid: Grid, output = 255): CoverageMask {
  return { grid, output: new Uint8Array(Math.ceil(grid.width * grid.height / 8)).fill(output), halo: new Uint8Array(Math.ceil(grid.width * grid.height / 8)), tiles: Uint8Array.of(1), maxZoom: 0 };
}

describe('prepared grid sampling parity', () => {
  it('preserves scalar results and errors over irregular axes, flags, and grid boundaries', () => {
    let seed = 81471;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let n = 0; n < 160; n++) {
      const width = 1 + Math.floor(random() * 8), height = 1 + Math.floor(random() * 8);
      const grid: Grid = { width, height, lon0: -180, lat0: 65, dx: 360 / width, dy: -120 / height, wrapLongitude: n % 2 === 0 };
      const field: GridField = {
        values: Float32Array.from({ length: width * height }, () => random() < 0.08 ? NaN : random() * 9000 - 100),
        flags: Uint8Array.from({ length: width * height }, () => [0, 1, 2, 3, 4, 5, 8, 9, 12, 13, 16, 17][Math.floor(random() * 12)])
      };
      const mask = maskFor(grid, 0);
      for (let i = 0; i < width * height; i++) if (random() < 0.8) setBit(mask.output, i);
      const lats = Float64Array.from([65, -55, 65 - 1e-11, 65 + 1e-9, ...Array.from({ length: 10 }, (_, i) => grid.lat0 + (i % 3 === 0 ? Math.floor(random() * height) : random() * (height + 2) - 1) * grid.dy)]);
      const lons = Float64Array.from([-180, 180, -180 + 1e-11, -180 - 1e-9, ...Array.from({ length: 10 }, (_, i) => grid.lon0 + (i % 3 === 0 ? Math.floor(random() * width) : random() * (width + 2) - 1) * grid.dx)]);
      const prepared = prepareGridSampling(mask, lats, lons);
      expect(prepared.byteLength).toBe((lats.length + lons.length) * 24 + Math.ceil(lats.length * lons.length / 8));
      for (const layer of LAYER_IDS) {
        const sample = prepared.bind(field, layer), out: Sample = { value: 99, status: 0, support: 255, interpolated: true };
        for (let i = 0; i < lats.length * lons.length; i++) {
          const x = i % lons.length, y = (i - x) / lons.length;
          const expected = outcome(() => sampleGrid(grid, field, lats[y], lons[x], layer, mask));
          expect(outcome(() => { sample(x, y, out); return { ...out }; })).toEqual(expected);
        }
      }
    }
  }, 30000);

  it('keeps duplicate wrapped contributors, exact ties and non-wrap/latitude rejection', () => {
    for (const grid of [
      { width: 1, height: 2, lon0: 0, lat0: 1, dx: 1, dy: -1, wrapLongitude: true },
      { width: 2, height: 2, lon0: 0, lat0: 1, dx: -1, dy: -1, wrapLongitude: false },
      { width: 2, height: 1, lon0: 0, lat0: 0, dx: 1, dy: -1, wrapLongitude: false }
    ]) {
      const mask = maskFor(grid), lats = Float64Array.of(0, 0.25, 0.5, 1, 1 + 1e-11), lons = Float64Array.of(-1, -0.5, -1e-11, 0, 0.5, 1, 1.5);
      for (let combination = 0; combination < 256; combination++) {
        const field = { values: Float32Array.from({ length: grid.width * grid.height }, (_, i) => i % 2 ? -0 : 300), flags: Uint8Array.from({ length: grid.width * grid.height }, (_, i) => (combination >> (i * 2)) & 3) };
        const prepared = prepareGridSampling(mask, lats, lons);
        for (const layer of LAYER_IDS) {
          const sample = prepared.bind(field, layer), out = { value: null, status: 3, support: 0, interpolated: false } as Sample;
          for (let i = 0; i < lats.length * lons.length; i++) {
            const x = i % lons.length, y = (i - x) / lons.length;
            expect(outcome(() => { sample(x, y, out); return { ...out }; })).toEqual(outcome(() => sampleGrid(grid, field, lats[y], lons[x], layer, mask)));
          }
        }
      }
    }
  }, 30000);

  it('validates field dimensions and sample plan counts', () => {
    const plan = { contributors: Array.from({ length: 5 }, (_, i) => ({ row: 0, column: i, index: i, weight: 0.2 })), byteRange: { offset: 0, length: 25 } };
    const fiveCellResult = sampleCells(plan, Array.from({ length: 5 }, (_, i) => ({ value: i - 2, flags: 0 })), 'usable-lift-msl');
    expect(fiveCellResult).toMatchObject({ status: 0, interpolated: true });
    expect(fiveCellResult.value).toBeCloseTo(0, 15);
    expect(() => sampleCells(plan, [{ value: '1' as unknown as number, flags: 0 }, ...Array.from({ length: 4 }, () => ({ value: 1, flags: 0 }))], 'usable-lift-msl')).toThrow('known cell has non-finite value');
    expect(() => sampleCells(plan, [{ value: NaN, flags: 0 }, { value: NaN, flags: 2 }, { value: 1, flags: 4 }, { value: 0, flags: 1 }, { value: 3, flags: 0 }], 'usable-lift-msl')).toThrow('valid cell has non-finite value');
    const grid = { width: 2, height: 2, lon0: 0, lat0: 1, dx: 1, dy: -1, wrapLongitude: false };
    const prepared = prepareGridSampling(maskFor(grid), Float64Array.of(1), Float64Array.of(0));
    expect(() => prepared.bind({ values: new Float32Array(1), flags: new Uint8Array(1) }, 'precip-rate')).toThrow('field size differs from grid');
    expect(outcome(() => sampleCells({ ...plan, contributors: [] }, [], 'precip-rate' as LayerId))).toEqual({ error: 'cell count does not match sample plan' });
  });
});
