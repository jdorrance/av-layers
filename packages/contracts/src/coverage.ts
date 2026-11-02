import { z } from 'zod';
import { geographicToGrid, gridSchema, snapGridCoordinate, withinGeographicBounds, type GeographicBounds, type Grid } from './geometry.js';
import { MAX_NATIVE_ZOOM, SAMPLE_BLOCK_SIZE } from './format.js';

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
export function isCovered(mask: CoverageMask, lat: number, lon: number): boolean {
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
  if (!Number.isFinite(x) || !Number.isFinite(y) || (!grid.wrapLongitude && (x < -0.5 || x > grid.width - 0.5)) || y < -0.5 || y > grid.height - 0.5) return false;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const c0 = grid.wrapLongitude ? ((x0 % grid.width) + grid.width) % grid.width : x0;
  const c1 = grid.wrapLongitude ? (((x0 + 1) % grid.width) + grid.width) % grid.width : x0 + 1;
  const col = fx === 0 ? c0 : fx < 0.5 ? c0 : fx > 0.5 ? c1 : Math.min(c0, c1);
  const row = fy <= 0.5 ? Math.max(0, y0) : Math.min(grid.height - 1, y0 + 1);
  if (col < 0 || col >= grid.width || row < 0 || row >= grid.height) return false;
  return getBit(mask.output, row * grid.width + col);
}
export function isTileCovered(mask: CoverageMask, z: number, x: number, y: number): boolean {
  if (!Number.isInteger(z) || z < 0 || z > mask.maxZoom || z > 24 || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return false;
  return getBit(mask.tiles, (4 ** z - 1) / 3 + y * 2 ** z + x);
}
export function expectedTiles(mask: CoverageMask, z: number): { z: number; x: number; y: number }[] {
  if (!Number.isInteger(z) || z < 0 || z > mask.maxZoom || z > 24) return [];
  const span = 2 ** z, total = span * span, result: { z: number; x: number; y: number }[] = [];
  for (let i = 0; i < total; i++) {
    const x = i % span, y = (i - x) / span;
    if (isTileCovered(mask, z, x, y)) result.push({ z, x, y });
  }
  return result;
}
