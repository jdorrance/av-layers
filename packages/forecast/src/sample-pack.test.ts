import { expect, it } from 'vitest';
import { CELL_BYTES, LAYER_IDS, setBit, STATUS_OUTSIDE, type Grid } from '@av/contracts';
import { cellsFromRange, packCells, planSample, sampleCells, type GridField } from './sampler.js';
import { packedCellsFromRange, planPackedSample, prepareSamplePackLayout } from './sample-pack.js';

it('indexes output and halo blocks deterministically without retaining mutable masks or padding bits', () => {
  const output = new Uint8Array(9), halo = new Uint8Array(9);
  for (const [i, index] of [0, 7, 8, 31, 32, 33, 63, 65].entries()) setBit(i % 2 ? halo : output, index);
  halo[8] |= 0xfc;
  const layout = prepareSamplePackLayout({ width: 33, height: 2, wrapLongitude: true }, output, halo);
  output.fill(0); halo.fill(0);
  expect(layout.storedCells).toBe(72);
  expect(layout.blockCount).toBe(3);
  expect(layout.indexBytes).toBe(12);
  expect(layout.blockFor(31)).toEqual({ row: 0, column: 16, width: 17, height: 2, cellOffset: 34 });
  expect(layout.blockFor(65)).toEqual({ row: 0, column: 32, width: 2, height: 2, cellOffset: 68 });
  expect(() => layout.blockFor(-1)).toThrow('out of range');
  expect(() => layout.blockFor(66)).toThrow('out of range');
  expect(() => prepareSamplePackLayout(layout.grid, new Uint8Array(8), halo)).toThrow('coverage size');
});

it.each([{ width: 3, height: 3, wrapLongitude: true }, { width: 1, height: 2, wrapLongitude: true }, { width: 5, height: 3, wrapLongitude: false }])('preserves exact scalar results across subsets, missing/tied cells and edge blocks: %j', dimensions => {
  const grid: Grid = { ...dimensions, lon0: 0, lat0: dimensions.height - 1, dx: 1, dy: -1 };
  const count = grid.width * grid.height, output = new Uint8Array(Math.ceil(count / 8)), halo = new Uint8Array(output.length);
  for (let i = 0; i < count; i++) if (i !== 2 && i !== 5) setBit(output, i);
  if (count > 2) setBit(halo, 2);
  const layout = prepareSamplePackLayout(grid, output, halo, 2);
  const fields: GridField[] = LAYER_IDS.map((_, channel) => {
    const values = new Float32Array(count), flags = new Uint8Array(count).fill(STATUS_OUTSIDE);
    for (let i = 0; i < count; i++) if (i !== 2 && i !== 5) { values[i] = (i + 1) * 0.1 + channel; flags[i] = 0; }
    if (count > 3) { values[3] = NaN; flags[3] = 2; }
    if (channel < 2) { flags[1] = 1 | 4; if (count > 4) flags[4] = 8; }
    return { values, flags };
  });
  const flats = fields.map(packCells), bytes = new Uint8Array(layout.storedCells * 3 * CELL_BYTES);
  for (let slot = 0; slot < layout.blockSlots; slot++) {
    const block = layout.block(slot);
    if (!block) continue;
    for (let y = 0; y < block.height; y++) for (let x = 0; x < block.width; x++) for (let channel = 0; channel < 3; channel++) {
      const index = (block.row + y) * grid.width + (block.column + x) % grid.width;
      bytes.set(flats[channel].subarray(index * CELL_BYTES, (index + 1) * CELL_BYTES), ((block.cellOffset + y * block.width + x) * 3 + channel) * CELL_BYTES);
    }
  }
  for (const y of [0, 0.5, grid.height - 1]) for (const x of [0, 0.5, grid.width - 1, grid.wrapLongitude ? grid.width - 0.5 : grid.width - 1, grid.width > 2 ? 1 + 1e-12 : 0]) {
    const sample = planSample(grid, grid.lat0 - y, x)!;
    if (!sample) continue;
    for (const channels of [[0, 1, 2], [2], [2, 0]]) {
      const packed = planPackedSample(layout, sample, 3, channels);
      const range = packed.byteRange, selected = bytes.subarray(range.offset, range.offset + range.length);
      for (const channel of channels) {
        const expected = cellsFromRange(sample, flats[channel].subarray(sample.byteRange.offset, sample.byteRange.offset + sample.byteRange.length));
        const actual = packedCellsFromRange(packed, selected, channel);
        expect(actual).toEqual(expected);
        expect(sampleCells(sample, actual, LAYER_IDS[channel])).toEqual(sampleCells(sample, expected, LAYER_IDS[channel]));
      }
    }
  }
});

it('keeps halo-only owner blocks and chooses the first contributor before longitude wrap', () => {
  const grid: Grid = { width: 4, height: 4, lon0: 0, lat0: 3, dx: 1, dy: -1, wrapLongitude: true };
  const output = new Uint8Array(2), halo = new Uint8Array(2);
  setBit(output, 6); setBit(halo, 5); setBit(halo, 7);
  const layout = prepareSamplePackLayout(grid, output, halo, 2);
  const boundary = planPackedSample(layout, planSample(grid, 1.75, 1.75)!, 24, [0, 23]);
  expect(boundary.contributorRanks[0]).toBe(layout.blockFor(5)!.cellOffset + 4);
  const wrapped = planPackedSample(layout, planSample(grid, 2, 3.5)!, 24, [0, 23]);
  expect(wrapped.contributorRanks[1] - wrapped.contributorRanks[0]).toBe(1);
});

it('rejects malformed selections, absent owner blocks and incorrect range bodies', () => {
  const grid: Grid = { width: 2, height: 1, lon0: 0, lat0: 0, dx: 1, dy: -1, wrapLongitude: true };
  const layout = prepareSamplePackLayout(grid, Uint8Array.of(1), Uint8Array.of(0), 1), sample = planSample(grid, 0, 0)!;
  const plan = planPackedSample(layout, sample, 3, [0, 2]);
  for (const channels of [[], [3], [0, 0], [-1]]) expect(() => planPackedSample(layout, sample, 3, channels)).toThrow('channels');
  expect(() => packedCellsFromRange(plan, new Uint8Array(5), 0)).toThrow('byte count');
  expect(() => packedCellsFromRange(plan, new Uint8Array(15), 1)).toThrow('not requested');
  expect(() => planPackedSample(layout, sample, 0, [0])).toThrow('channel count');
  expect(() => planPackedSample(layout, planSample(grid, 0, 1)!, 3, [0])).toThrow('owner block');
});
