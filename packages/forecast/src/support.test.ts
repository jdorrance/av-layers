import { describe, expect, it } from 'vitest';
import { getBit, setBit } from '@av/contracts';
import { BILINEAR_SUPPORT, COLUMN_SUPPORT, MAX_SUPPORT_CELLS, composeSupport, expandSupport, planFieldSupport, unionSupport, type SupportGrid, type SupportOffset } from './support.js';

const grid: SupportGrid = { width: 9, height: 9, wrapLongitude: false };
const mask = (indices: number[], g = grid) => { const bits = new Uint8Array(Math.ceil(g.width * g.height / 8)); for (const i of indices) setBit(bits, i); return bits; };
const indices = (bits: Uint8Array, g = grid) => Array.from({ length: g.width * g.height }, (_, i) => i).filter(i => getBit(bits, i));
const cross: readonly SupportOffset[] = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]];

describe('composable native-grid support', () => {
  it('separates public, derived and primitive masks and composes derivative/interpolation support', () => {
    const output = mask([40]), saved = new Uint8Array(output);
    const column = planFieldSupport(grid, output, BILINEAR_SUPPORT, COLUMN_SUPPORT);
    const derivative = planFieldSupport(grid, output, BILINEAR_SUPPORT, cross);
    expect(indices(column.derived)).toHaveLength(9);
    expect(column.input).toEqual(column.derived);
    expect(indices(derivative.input)).toHaveLength(21);
    expect(derivative.input).toEqual(expandSupport(grid, output, composeSupport(BILINEAR_SUPPORT, cross)).required);
    expect(indices(derivative.unavailableOutput)).toEqual([]);
    expect(output).toEqual(saved);
    expect(indices(output)).toEqual([40]);
    expect(unionSupport(grid, [column.input, derivative.input])).toEqual(derivative.input);
  });

  it('wraps only periodic longitude, never latitude or regional edges', () => {
    const regional = planFieldSupport(grid, mask([36]), COLUMN_SUPPORT, [[0, -1], [0, 1]]);
    expect(indices(regional.unavailableOutput)).toEqual([36]);
    expect(indices(regional.input)).toEqual([37]);
    const periodic = { ...grid, wrapLongitude: true };
    const wrapped = planFieldSupport(periodic, mask([36]), COLUMN_SUPPORT, [[0, -1], [0, 1]]);
    expect(indices(wrapped.input)).toEqual([37, 44]);
    expect(indices(wrapped.unavailableOutput)).toEqual([]);
    expect(indices(planFieldSupport(periodic, mask([4]), BILINEAR_SUPPORT, cross).unavailableOutput)).toEqual([4]);
    // The interpolated derived cell at column zero needs a missing column -1 input.
    expect(indices(planFieldSupport(grid, mask([37]), BILINEAR_SUPPORT, cross).unavailableOutput)).toEqual([37]);
  });

  it('matches whole-domain analytic stencil results after chunk support expansion', () => {
    // Fixture-only stencil: d(2*x + 3*y)/dx = 2; no new forecast product.
    const field = Float64Array.from({ length: 81 }, (_, i) => 2 * (i % 9) + 3 * Math.floor(i / 9));
    const derivative = (i: number, source: Float64Array) => (source[i + 1] - source[i - 1]) / 2;
    const chunks = [[20, 21, 29, 30], [22, 23, 31, 32]];
    for (const chunk of chunks) {
      const support = planFieldSupport(grid, mask(chunk), BILINEAR_SUPPORT, [[0, -1], [0, 1]]);
      const selected = new Float64Array(81).fill(NaN);
      for (const i of indices(support.input)) selected[i] = field[i];
      for (const i of indices(support.derived)) {
        expect(derivative(i, selected)).toBe(2);
        expect(derivative(i, selected)).toBe(derivative(i, field));
      }
      selected[chunk[0] - 1] = NaN;
      expect(Number.isNaN(derivative(chunk[0], selected))).toBe(true);
    }
  });

  it('bounds masks/composition and ignores unused padding bits', () => {
    expect(() => expandSupport({ width: MAX_SUPPORT_CELLS + 1, height: 1, wrapLongitude: false }, new Uint8Array(), COLUMN_SUPPORT)).toThrow('budget');
    expect(() => expandSupport(grid, new Uint8Array(1), COLUMN_SUPPORT)).toThrow('size');
    expect(() => expandSupport(grid, mask([40]), [[0, 0.5]])).toThrow('offsets');
    expect(() => composeSupport([[Number.MAX_SAFE_INTEGER, 0]], [[1, 0]])).toThrow('overflow');
    expect(() => composeSupport(Array.from({ length: 4096 }, (_, i) => [0, i] as const), Array(4096).fill([0, 0]))).toThrow('budget');
    const one = { width: 1, height: 1, wrapLongitude: false };
    expect(unionSupport(one, [Uint8Array.of(255)])).toEqual(Uint8Array.of(1));
    expect(expandSupport(one, Uint8Array.of(255), COLUMN_SUPPORT).required).toEqual(Uint8Array.of(1));
  });
});
