import { describe, expect, it } from 'vitest';
import fixture from '../../contracts/src/fixtures/lambert.json';
import { gridSchema, isCovered, setBit, STATUS_UNAVAILABLE, type CoverageMask, type LambertConformalGrid } from '@av/contracts';
import { MAX_PREPARED_SAMPLES, planSample, prepareGridSampling, sampleGrid, type Sample } from './sampler.js';
import { packedCellsFromRange, planPackedSample, prepareSamplePackLayout } from './sample-pack.js';

const grid = gridSchema.parse(fixture.grid) as LambertConformalGrid;
const count = grid.width * grid.height;
const mask: CoverageMask = { grid, output: new Uint8Array(Math.ceil(count / 8)).fill(255), halo: new Uint8Array(Math.ceil(count / 8)), tiles: Uint8Array.of(1), maxZoom: 0 };
const field = { values: Float32Array.from({ length: count }, (_, i) => 2 * (i % grid.width) + 3 * Math.floor(i / grid.width)), flags: new Uint8Array(count) };

describe('offline projected-grid scalar fixture', () => {
  it('samples an analytic native field at independent geographic control points', () => {
    for (const p of fixture.controlPoints) {
      const expected = 2 * ((p.xM - grid.x0M) / grid.dxM) + 3 * ((p.yM - grid.y0M) / grid.dyM);
      expect(sampleGrid(grid, field, p.lat, p.lon, 'precip-rate', mask).value).toBeCloseTo(expected, 10);
      expect(isCovered(mask, p.lat, p.lon)).toBe(true);
    }
    expect(planSample(grid, 0, 0)).toBeNull();
    expect(isCovered(mask, 0, 0)).toBe(false);
    expect(isCovered({ ...mask, bounds: [-110, 35, -95, 50] }, 45, -90)).toBe(false);
  });

  it('retains exact prepared/reference parity and the contributor fast path under missingness', () => {
    const latitudes = Float64Array.of(30, 40, 45, 60, 80), longitudes = Float64Array.of(-120, -100, -90, -70, 0);
    const restricted = { ...mask, output: new Uint8Array(mask.output) };
    setBit(restricted.output, 10 * grid.width + 20, false);
    const values = new Float32Array(field.values), flags = new Uint8Array(field.flags);
    flags[15 * grid.width + 28] = STATUS_UNAVAILABLE;
    values[15 * grid.width + 28] = NaN;
    const prepared = prepareGridSampling(restricted, latitudes, longitudes), sampled = prepared.bind({ values, flags }, 'precip-rate');
    const actualContributors = new Set<number>();
    for (let y = 0; y < latitudes.length; y++) for (let x = 0; x < longitudes.length; x++) {
      const out: Sample = { value: 999, status: 0, support: 31, interpolated: true };
      sampled(x, y, out);
      expect(out).toEqual(sampleGrid(grid, { values, flags }, latitudes[y], longitudes[x], 'precip-rate', restricted));
      if (isCovered(restricted, latitudes[y], longitudes[x])) for (const c of planSample(grid, latitudes[y], longitudes[x])?.contributors ?? []) actualContributors.add(c.index);
    }
    expect([...prepared.contributors].sort((a, b) => a - b)).toEqual([...actualContributors].sort((a, b) => a - b));
    expect(prepared.byteLength).toBe(latitudes.length * longitudes.length * 32 + Math.ceil(latitudes.length * longitudes.length / 8) + prepared.contributors.byteLength);
  });

  it('reuses index-space scalar packing without changing the wire record or doing geographic regridding', () => {
    const layout = prepareSamplePackLayout(grid, mask.output, mask.halo), bytes = new Uint8Array(layout.storedCells * 5), view = new DataView(bytes.buffer);
    for (let slot = 0; slot < layout.blockSlots; slot++) {
      const block = layout.block(slot)!;
      for (let y = 0; y < block.height; y++) for (let x = 0; x < block.width; x++) {
        const index = (block.row + y) * grid.width + block.column + x;
        view.setFloat32((block.cellOffset + y * block.width + x) * 5, field.values[index], true);
      }
    }
    const plan = planSample(grid, 45, -90)!, packed = planPackedSample(layout, plan, 1, [0]);
    const body = bytes.subarray(packed.byteRange.offset, packed.byteRange.offset + packed.byteRange.length);
    expect(packedCellsFromRange(packed, body, 0)).toEqual(plan.contributors.map(c => ({ value: field.values[c.index], flags: 0 })));
    expect(packed.byteRange.length).toBeLessThanOrEqual(19 * 5);
  });

  it('rejects oversized prepared geometry before projection/allocation and validates mask dimensions', () => {
    expect(() => prepareGridSampling(mask, new Float64Array(513), new Float64Array(512))).toThrow('budget');
    expect(MAX_PREPARED_SAMPLES).toBe(512 * 512);
    expect(() => prepareGridSampling({ ...mask, output: new Uint8Array(1) }, Float64Array.of(45), Float64Array.of(-90))).toThrow('Coverage size');
    expect(() => prepareGridSampling(mask, Float64Array.of(45), Float64Array.of(-90)).bind({ values: new Float32Array(1), flags: new Uint8Array(1) }, 'precip-rate')).toThrow('field size');
  });
});
