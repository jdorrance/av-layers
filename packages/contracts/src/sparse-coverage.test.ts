import { describe, expect, it } from 'vitest';
import { createSparseCoverage, decodeSparseCoverage, encodeSparseCoverage, sparseCoverageFromDense, sparseCoverageLookup, type SparseCoverage } from './sparse-coverage.js';

const gridHash = 'a1'.repeat(32);

function dense(width: number, height: number, wrapLongitude: boolean, points: [number, number][]) {
  const output = new Uint8Array(Math.ceil(width * height / 8)), halo = new Uint8Array(output.length);
  const set = (bits: Uint8Array, x: number, y: number) => { const index = y * width + x; bits[Math.floor(index / 8)] |= 1 << (index % 8); };
  const has = (bits: Uint8Array, x: number, y: number) => { const index = y * width + x; return (bits[Math.floor(index / 8)] & (1 << (index % 8))) !== 0; };
  for (const [x, y] of points) set(output, x, y);
  for (const [x, y] of points) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const px = wrapLongitude ? ((x + dx) % width + width) % width : x + dx, py = y + dy;
    if (px >= 0 && px < width && py >= 0 && py < height && !has(output, px, py)) set(halo, px, py);
  }
  return { width, height, wrapLongitude, gridHash, output, halo, has };
}

function clone(value: SparseCoverage): SparseCoverage {
  return { ...value, blockIds: value.blockIds.slice(), offsets: value.offsets.slice(), output: value.output.slice(), halo: value.halo.slice() };
}

describe('sparse coverage', () => {
  it.each([false, true])('matches dense masks and packed offsets with wrap=%s', wrap => {
    const reference = dense(35, 20, wrap, [[0, 0], [15, 15], [16, 16], [34, 19], [25, 1]]);
    const coverage = sparseCoverageFromDense(reference);
    expect([...coverage.blockIds]).toEqual([...coverage.blockIds].sort((a, b) => a - b));
    const offsets: number[] = [];
    const active: { x: number; y: number }[] = [];
    for (let y = 0; y < reference.height; y++) for (let x = 0; x < reference.width; x++) {
      const result = sparseCoverageLookup(coverage, x, y), output = reference.has(reference.output, x, y), halo = reference.has(reference.halo, x, y);
      if (!output && !halo) expect(result).toBeNull();
      else {
        expect(result).toMatchObject({ output, halo });
        offsets.push(result!.offset);
        active.push({ x, y });
      }
    }
    expect(offsets.sort((a, b) => a - b)).toEqual(Array.from({ length: offsets.length }, (_, i) => i));
    const columns = Math.ceil(reference.width / 16);
    active.sort((a, b) => (Math.floor(a.y / 16) * columns + Math.floor(a.x / 16)) - (Math.floor(b.y / 16) * columns + Math.floor(b.x / 16)) || (a.y % 16) - (b.y % 16) || (a.x % 16) - (b.x % 16));
    for (let i = 0; i < active.length; i++) expect(sparseCoverageLookup(coverage, active[i].x, active[i].y)?.offset).toBe(i);
    expect(coverage.offsets[coverage.offsets.length - 1]).toBe(offsets.length);
    if (wrap) {
      expect(sparseCoverageLookup(coverage, -1, 0)).toEqual(sparseCoverageLookup(coverage, 34, 0));
      expect(sparseCoverageLookup(coverage, 35, 19)).toEqual(sparseCoverageLookup(coverage, 0, 19));
      expect(sparseCoverageLookup(coverage, 70, 0)).toEqual(sparseCoverageLookup(coverage, 0, 0));
    } else {
      expect(sparseCoverageLookup(coverage, -1, 0)).toBeNull();
      expect(sparseCoverageLookup(coverage, 35, 0)).toBeNull();
    }
    for (const [x, y] of [[0, -1], [0, 20], [0.5, 0], [Infinity, 0], [Number.MAX_SAFE_INTEGER + 1, 0]]) expect(sparseCoverageLookup(coverage, x, y)).toBeNull();
  });

  it('uses block-major then local row-major order and supports empty masks', () => {
    const input = dense(33, 18, false, [[32, 17], [16, 0], [0, 17], [15, 0]]);
    input.halo.fill(0);
    const coverage = sparseCoverageFromDense(input);
    expect([...coverage.blockIds]).toEqual([0, 1, 3, 5]);
    expect([...coverage.offsets]).toEqual([0, 1, 2, 3, 4]);
    expect([[15, 0], [16, 0], [0, 17], [32, 17]].map(([x, y]) => sparseCoverageLookup(coverage, x, y)?.offset)).toEqual([0, 1, 2, 3]);
    const empty = sparseCoverageFromDense(dense(1, 1, false, []));
    expect([...empty.offsets]).toEqual([0]);
    expect(sparseCoverageLookup(empty, 0, 0)).toBeNull();
    expect(decodeSparseCoverage(encodeSparseCoverage(empty))).toEqual(empty);
  });

  it('encodes deterministically and binds the grid identity', () => {
    const input = dense(19, 17, true, [[0, 0], [18, 16]]), first = sparseCoverageFromDense(input), second = sparseCoverageFromDense(input);
    const bytes = encodeSparseCoverage(first);
    expect(bytes).toEqual(encodeSparseCoverage(second));
    expect(decodeSparseCoverage(bytes, gridHash)).toEqual(first);
    expect(encodeSparseCoverage(decodeSparseCoverage(bytes))).toEqual(bytes);
    expect(() => decodeSparseCoverage(bytes, 'b'.repeat(64))).toThrow('identity');
    const wrapped = new Uint8Array(bytes.length + 4); wrapped.set(bytes, 2);
    expect(decodeSparseCoverage(wrapped.subarray(2, -2))).toEqual(first);
  });

  it('rejects malformed dimensions and dense masks', () => {
    const valid = dense(17, 17, false, [[0, 0]]);
    for (const [width, height] of [[0, 1], [1.5, 1], [65536, 65536], [Infinity, 1], [-1, 1]]) {
      expect(() => sparseCoverageFromDense({ ...valid, width, height })).toThrow();
    }
    expect(() => sparseCoverageFromDense({ ...valid, output: new Uint8Array(0) })).toThrow();
    const overlap = dense(1, 1, false, [[0, 0]]); overlap.halo[0] = 1;
    expect(() => sparseCoverageFromDense(overlap)).toThrow();
    const padding = dense(1, 1, false, []); padding.output[0] = 2;
    expect(() => sparseCoverageFromDense(padding)).toThrow();
    expect(() => sparseCoverageFromDense({ ...valid, gridHash: 'bad' })).toThrow();
  });

  it('rejects malformed directories, masks, and offsets', () => {
    const valid = sparseCoverageFromDense(dense(33, 18, false, [[0, 0], [32, 17]]));
    const variants: ((c: SparseCoverage) => void)[] = [
      c => { c.blockIds[1] = c.blockIds[0]; },
      c => { c.blockIds[0] = 0xffffffff; },
      c => { c.offsets[0] = 1; },
      c => { c.offsets[1]++; },
      c => { c.offsets[c.offsets.length - 1]++; },
      c => { c.output = c.output.subarray(1); },
      c => { c.halo[0] |= c.output[0]; },
      c => { c.output[c.output.length - 1] |= 0x80; },
      c => { c.output.fill(0, 0, 32); c.halo.fill(0, 0, 32); },
      c => { c.wrapLongitude = 1 as unknown as boolean; }
    ];
    for (const mutate of variants) {
      const corrupt = clone(valid); mutate(corrupt);
      expect(() => createSparseCoverage(corrupt)).toThrow();
      expect(() => encodeSparseCoverage(corrupt)).toThrow();
    }
  });

  it('rejects truncated, oversized, and corrupt serialized directories', () => {
    const valid = encodeSparseCoverage(sparseCoverageFromDense(dense(33, 18, false, [[0, 0], [32, 17]])));
    expect(() => decodeSparseCoverage(valid.subarray(0, 59))).toThrow();
    expect(() => decodeSparseCoverage(valid.subarray(0, valid.length - 1))).toThrow();
    expect(() => decodeSparseCoverage(new Uint8Array(valid.length + 1))).toThrow();
    for (const [offset, value] of [[0, 0], [4, 2], [8, 0], [16, 2], [20, 0xffffffff], [24, 0xffffffff], [60, 0xffffffff], [64, 1]]) {
      const corrupt = valid.slice(); new DataView(corrupt.buffer).setUint32(offset, value, true);
      expect(() => decodeSparseCoverage(corrupt)).toThrow();
    }
  });
});
