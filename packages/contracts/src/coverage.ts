import { z } from 'zod';
import { geographicToGrid, gridSchema, prepareGridGeometry, snapGridCoordinate, withinGeographicBounds, type GeographicBounds, type Grid } from './geometry.js';
import { MAX_NATIVE_ZOOM, SAMPLE_BLOCK_SIZE } from './format.js';
import { createSparseCoverage, sparseCoverageLookup, type SparseCoverage } from './sparse-coverage.js';

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

export function normalizeLon(lon: number): number {
  if (!Number.isFinite(lon)) return lon;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 && lon > 0 ? 180 : Object.is(wrapped, -0) ? 0 : wrapped;
}

export interface CoverageMask { grid: Grid; bounds?: GeographicBounds; output: Uint8Array; halo: Uint8Array; tiles: Uint8Array; maxZoom: number }
export interface SparseCoverageMask { grid: Grid; bounds?: GeographicBounds; coverage: SparseCoverage; tiles: Uint8Array; maxZoom: number }

export function assertSparseCoverageHalo(coverage: SparseCoverage): void {
  createSparseCoverage(coverage);
  const { width, height, wrapLongitude, blockIds, output, halo } = coverage;
  const size = SAMPLE_BLOCK_SIZE, columns = Math.ceil(width / size);
  const findBlock = (id: number): number => {
    let lo = 0, hi = blockIds.length;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (blockIds[mid] < id) lo = mid + 1; else hi = mid; }
    return lo < blockIds.length && blockIds[lo] === id ? lo : -1;
  };
  const rowBits = (column: number, row: number): number => {
    if (row < 0 || row >= height) return 0;
    const block = findBlock(Math.floor(row / size) * columns + column);
    if (block < 0) return 0;
    const index = block * 32 + (row % size) * 2;
    return output[index] | (output[index + 1] << 8);
  };
  for (let block = 0; block < blockIds.length; block++) {
    const column = blockIds[block] % columns, x0 = column * size, y0 = Math.floor(blockIds[block] / columns) * size;
    const blockWidth = Math.min(size, width - x0), blockHeight = Math.min(size, height - y0), valid = (1 << blockWidth) - 1;
    for (let row = 0; row < blockHeight; row++) {
      const y = y0 + row, index = block * 32 + row * 2, own = output[index] | (output[index + 1] << 8);
      let expanded = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const bits = rowBits(column, y + dy);
        expanded |= bits | (bits << 1) | (bits >>> 1);
        if (sparseCoverageLookup(coverage, x0 - 1, y + dy)?.output) expanded |= 1;
        if (sparseCoverageLookup(coverage, x0 + blockWidth, y + dy)?.output) expanded |= 1 << (blockWidth - 1);
      }
      const actual = halo[index] | (halo[index + 1] << 8);
      if (((expanded & valid) & ~own) !== actual) throw new Error('Sparse coverage halo mismatch');
      if (row === 0 || row === blockHeight - 1 || (own & 1) || (own & (1 << (blockWidth - 1)))) {
        for (let x = 0; x < blockWidth; x++) {
          if (!(own & (1 << x)) || (row !== 0 && row !== blockHeight - 1 && x !== 0 && x !== blockWidth - 1)) continue;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x0 + x + dx, ny = y + dy;
            if (ny < 0 || ny >= height || (!wrapLongitude && (nx < 0 || nx >= width))) continue;
            const wrapped = ((nx % width) + width) % width;
            if ((Math.floor(wrapped / size) !== column || Math.floor(ny / size) !== Math.floor(y0 / size)) && !sparseCoverageLookup(coverage, nx, ny)) throw new Error('Sparse coverage halo mismatch');
          }
        }
      }
    }
  }
}
export function getBit(bits: Uint8Array, index: number): boolean {
  return Number.isSafeInteger(index) && index >= 0 && index < bits.length * 8 && (bits[index >> 3] & (1 << (index & 7))) !== 0;
}
export function setBit(bits: Uint8Array, index: number, value = true): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= bits.length * 8) throw new RangeError('bit index out of bounds');
  const i = index >> 3, bit = 1 << (index & 7);
  bits[i] = value ? bits[i] | bit : bits[i] & ~bit;
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
function coveredCoordinate(mask: CoverageMask | SparseCoverageMask, x: number, y: number): boolean {
  const { grid } = mask;
  if (!Number.isFinite(x) || !Number.isFinite(y) || (!grid.wrapLongitude && (x < -0.5 || x > grid.width - 0.5)) || y < -0.5 || y > grid.height - 0.5) return false;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const c0 = grid.wrapLongitude ? ((x0 % grid.width) + grid.width) % grid.width : x0;
  const c1 = grid.wrapLongitude ? (((x0 + 1) % grid.width) + grid.width) % grid.width : x0 + 1;
  const col = fx === 0 ? c0 : fx < 0.5 ? c0 : fx > 0.5 ? c1 : Math.min(c0, c1);
  const row = fy <= 0.5 ? Math.max(0, y0) : Math.min(grid.height - 1, y0 + 1);
  if (col < 0 || col >= grid.width || row < 0 || row >= grid.height) return false;
  return 'coverage' in mask ? sparseCoverageLookup(mask.coverage, col, row)?.output === true : getBit(mask.output, row * grid.width + col);
}
export function isCovered(mask: CoverageMask | SparseCoverageMask, lat: number, lon: number): boolean {
  if (!withinGeographicBounds(lat, lon, mask.bounds)) return false;
  const { grid } = mask;
  // Keep the regular-grid hot path allocation-free except for the result-free arithmetic.
  let x: number, y: number;
  if (grid.kind === 'regular-latlon') {
    x = snapGridCoordinate((lon - grid.lon0) / grid.dx);
    y = snapGridCoordinate((lat - grid.lat0) / grid.dy);
    if (grid.wrapLongitude) x = snapGridCoordinate(((x % grid.width) + grid.width) % grid.width);
  } else {
    const point = geographicToGrid(grid, lat, lon);
    if (!point) return false;
    ({ x, y } = point);
  }
  return coveredCoordinate(mask, x, y);
}
/** Compile projected coordinates once while preserving the same nearest-cell ownership as isCovered. */
export function prepareCoverageTester(mask: CoverageMask | SparseCoverageMask): (lat: number, lon: number) => boolean {
  if (mask.grid.kind === 'regular-latlon') return (lat, lon) => isCovered(mask, lat, lon);
  const geometry = prepareGridGeometry(mask.grid);
  return (lat, lon) => {
    if (!withinGeographicBounds(lat, lon, mask.bounds)) return false;
    const point = geometry.geographicToGrid(lat, lon);
    return !!point && coveredCoordinate(mask, point.x, point.y);
  };
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
