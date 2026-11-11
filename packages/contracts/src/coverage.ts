import { getBit } from './bits.js';
export { getBit, setBit } from './bits.js';
import { z } from 'zod';
import { gridSchema } from './grid-schema.js';
import type { Grid } from './geometry.js';
import type { CoverageMask } from './coverage-query.js';
export { isCovered, prepareCoverageTester, type CoverageMask, type SparseCoverageMask } from './coverage-query.js';
export { normalizeLon } from './geometry.js';
import { MAX_NATIVE_ZOOM, SAMPLE_BLOCK_SIZE } from './format.js';
import { createSparseCoverage, type SparseCoverage } from './sparse-coverage.js';

export const MAX_COVERAGE_DESCRIPTOR_BYTES = 128 * 1024;
export const MAX_COVERAGE_BITSET_BYTES = 512 * 1024;
export const MAX_GRID_CELLS = 4_000_000;

const blob = z.object({ bytes: z.number().int().positive().max(MAX_COVERAGE_BITSET_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
/** Hash the exact UTF-8 descriptor bytes; all bitsets live beneath that content identity. */
export const coverageDescriptorSchema = z.object({
  version: z.literal(1), id: z.string().min(1).max(128), grid: gridSchema,
  bounds: z.tuple([z.number().finite(), z.number().min(-90).max(90), z.number().finite(), z.number().min(-90).max(90)]),
  policy: z.string().min(1).max(4096), maxZoom: z.number().int().min(0).max(MAX_NATIVE_ZOOM),
  supportHaloCells: z.number().int().min(0).max(64),
  sampleLayout: z.object({ format: z.literal('cell-major-blocks-v1'), blockSize: z.literal(SAMPLE_BLOCK_SIZE) }),
  files: z.object({ output: blob, halo: blob, tiles: blob })
}).superRefine((value, context) => {
  const cells = value.grid.width * value.grid.height;
  const cellBytes = Math.ceil(cells / 8), tileBytes = Math.ceil(((4 ** (value.maxZoom + 1) - 1) / 3) / 8);
  if (!Number.isSafeInteger(cells) || cells > MAX_GRID_CELLS || value.files.output.bytes !== cellBytes || value.files.halo.bytes !== cellBytes || value.files.tiles.bytes !== tileBytes) {
    context.addIssue({ code: 'custom', message: 'Coverage bitset dimensions exceed the admitted layout or disagree with the grid' });
  }
  const [west, south, east, north] = value.bounds;
  if (west < -180 || west > 180 || east < -180 || east > 180 || west == east || south >= north) context.addIssue({ code: 'custom', message: 'Invalid coverage bounds' });
});
export type CoverageDescriptor = z.infer<typeof coverageDescriptorSchema>;
export const MAX_SPARSE_COVERAGE_BYTES = 256 * 1024 * 1024;
export const sparseCoverageDescriptorSchema = z.strictObject({
  version: z.literal(2), id: z.string().min(1).max(128), grid: gridSchema,
  gridHash: z.string().regex(/^[a-f0-9]{64}$/),
  bounds: z.tuple([z.number().finite(), z.number().min(-90).max(90), z.number().finite(), z.number().min(-90).max(90)]),
  policy: z.string().min(1).max(4096), maxZoom: z.number().int().min(0).max(MAX_NATIVE_ZOOM),
  supportHaloCells: z.literal(1),
  sampleLayout: z.strictObject({ format: z.literal('cell-major-block-shards-v1'), blockSize: z.literal(SAMPLE_BLOCK_SIZE) }),
  files: z.strictObject({
    sparse: z.strictObject({ bytes: z.number().int().min(60).max(MAX_SPARSE_COVERAGE_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
    tiles: blob
  })
}).superRefine((value, context) => {
  const [west, south, east, north] = value.bounds;
  const tileBytes = Math.ceil(((4 ** (value.maxZoom + 1) - 1) / 3) / 8);
  if (west < -180 || west > 180 || east < -180 || east > 180 || west === east || south >= north || value.files.tiles.bytes !== tileBytes || (value.files.sparse.bytes - 60) % 72 !== 0) {
    context.addIssue({ code: 'custom', message: 'Invalid sparse coverage dimensions or bounds' });
  }
});
export type SparseCoverageDescriptor = z.infer<typeof sparseCoverageDescriptorSchema>;
export const canonicalGridJson = (grid: Grid): string => JSON.stringify(gridSchema.parse(grid));
export const coveragePrefix = (hash: string): string => {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid coverage hash');
  return `coverage/${hash}`;
};

export function assertSparseCoverageHalo(coverage: SparseCoverage): void {
  createSparseCoverage(coverage);
  const { width, height, wrapLongitude, blockIds, output, halo } = coverage;
  const size = SAMPLE_BLOCK_SIZE, columns = Math.ceil(width / size), blockRows = Math.ceil(height / size);
  const blockIndex = new Int32Array(columns * blockRows);
  blockIndex.fill(-1);
  for (let block = 0; block < blockIds.length; block++) blockIndex[blockIds[block]!] = block;
  const outputAt = (x: number, y: number): boolean => {
    if (y < 0 || y >= height) return false;
    if (wrapLongitude) x = ((x % width) + width) % width;
    else if (x < 0 || x >= width) return false;
    const block = blockIndex[Math.floor(y / size) * columns + Math.floor(x / size)]!;
    if (block < 0) return false;
    const local = (y % size) * size + (x % size), byte = block * 32 + (local >> 3), bit = 1 << (local & 7);
    return (output[byte]! & bit) !== 0;
  };
  const rowBits = (column: number, row: number): number => {
    if (row < 0 || row >= height) return 0;
    const block = blockIndex[Math.floor(row / size) * columns + column]!;
    if (block < 0) return 0;
    const index = block * 32 + (row % size) * 2;
    return output[index]! | (output[index + 1]! << 8);
  };
  const requireBlock = (column: number, row: number): void => {
    if (row < 0 || row >= blockRows) return;
    if (wrapLongitude) column = ((column % columns) + columns) % columns;
    else if (column < 0 || column >= columns) return;
    if (blockIndex[row * columns + column]! < 0) throw new Error('Sparse coverage halo mismatch');
  };
  for (let block = 0; block < blockIds.length; block++) {
    const column = blockIds[block]! % columns, blockRow = Math.floor(blockIds[block]! / columns), x0 = column * size, y0 = blockRow * size;
    const blockWidth = Math.min(size, width - x0), blockHeight = Math.min(size, height - y0), valid = (1 << blockWidth) - 1;
    let left = false, right = false;
    for (let row = 0; row < blockHeight; row++) {
      const y = y0 + row, index = block * 32 + row * 2, own = output[index]! | (output[index + 1]! << 8);
      left ||= (own & 1) !== 0;
      right ||= (own & (1 << (blockWidth - 1))) !== 0;
      let expanded = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const bits = rowBits(column, y + dy);
        expanded |= bits | (bits << 1) | (bits >>> 1);
        if (outputAt(x0 - 1, y + dy)) expanded |= 1;
        if (outputAt(x0 + blockWidth, y + dy)) expanded |= 1 << (blockWidth - 1);
      }
      const actual = halo[index]! | (halo[index + 1]! << 8);
      if (((expanded & valid) & ~own) !== actual) throw new Error('Sparse coverage halo mismatch');
    }
    // Edge output requires adjacent blocks; the row checks verify their halo cells.
    if (left) requireBlock(column - 1, blockRow);
    if (right) requireBlock(column + 1, blockRow);
    const top = output[block * 32]! | (output[block * 32 + 1]! << 8);
    const bottomIndex = block * 32 + (blockHeight - 1) * 2, bottom = output[bottomIndex]! | (output[bottomIndex + 1]! << 8);
    if (top) {
      requireBlock(column, blockRow - 1);
      if (top & 1) requireBlock(column - 1, blockRow - 1);
      if (top & (1 << (blockWidth - 1))) requireBlock(column + 1, blockRow - 1);
    }
    if (bottom) {
      requireBlock(column, blockRow + 1);
      if (bottom & 1) requireBlock(column - 1, blockRow + 1);
      if (bottom & (1 << (blockWidth - 1))) requireBlock(column + 1, blockRow + 1);
    }
  }
}
/** Stable row-major index lists reused across acquisition, derivation and summaries. */
export function coverageIndices(mask: CoverageMask): { output: Uint32Array; active: Uint32Array } {
  const size = mask.grid.width * mask.grid.height, out: number[] = [], act: number[] = [];
  for (let i = 0; i < size; i++) {
    const isOut = getBit(mask.output, i);
    if (isOut) out.push(i);
    if (isOut || getBit(mask.halo, i)) act.push(i);
  }
  return { output: Uint32Array.from(out), active: Uint32Array.from(act) };
}
export function isTileCovered(mask: Pick<CoverageMask, 'tiles' | 'maxZoom'>, z: number, x: number, y: number): boolean {
  if (!Number.isInteger(z) || z < 0 || z > mask.maxZoom || z > 24 || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return false;
  return getBit(mask.tiles, (4 ** z - 1) / 3 + y * 2 ** z + x);
}
/** Select rendered levels without changing the immutable coverage or its cell layout. */
export function coverageAtZoom<T extends Pick<CoverageMask, 'tiles' | 'maxZoom'>>(mask: T, zoom: number): T {
  if (!Number.isSafeInteger(zoom) || !Number.isSafeInteger(mask.maxZoom) || zoom < 0 || zoom > mask.maxZoom || mask.maxZoom > MAX_NATIVE_ZOOM) throw new RangeError('Invalid coverage zoom');
  const bits = (4 ** (zoom + 1) - 1) / 3, bytes = Math.ceil(bits / 8);
  if (mask.tiles.byteLength < bytes) throw new RangeError('Incomplete coverage pyramid');
  if (zoom === mask.maxZoom) return mask;
  const tiles = Uint8Array.from(mask.tiles.subarray(0, bytes));
  if (bits % 8) tiles[bytes - 1] &= (1 << (bits % 8)) - 1;
  return { ...mask, maxZoom: zoom, tiles };
}
export function expectedTiles(mask: Pick<CoverageMask, 'tiles' | 'maxZoom'>, z: number): { z: number; x: number; y: number }[] {
  if (!Number.isInteger(z) || z < 0 || z > mask.maxZoom || z > 24) return [];
  const span = 2 ** z, total = span * span, result: { z: number; x: number; y: number }[] = [];
  for (let i = 0; i < total; i++) {
    const x = i % span, y = (i - x) / span;
    if (isTileCovered(mask, z, x, y)) result.push({ z, x, y });
  }
  return result;
}
