import { getBit, setBit, type Grid } from '@av/contracts';

/** Row/column offsets on the same native mass grid, not metres or another grid's cells. */
export type SupportOffset = readonly [row: number, column: number];
export type SupportGrid = Pick<Grid, 'width' | 'height' | 'wrapLongitude'>;
export const MAX_SUPPORT_CELLS = 4_000_000;
const MAX_OFFSETS = 4096;
const MAX_COMPOSITION_PAIRS = 1_000_000;
const MAX_SUPPORT_VISITS = 64_000_000;
export const COLUMN_SUPPORT: readonly SupportOffset[] = [[0, 0]];
/** Queries whose nearest native cell is public can interpolate to any adjacent cell. */
export const BILINEAR_SUPPORT: readonly SupportOffset[] = [
  [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 0], [0, 1], [1, -1], [1, 0], [1, 1]
];

function validateOffsets(offsets: readonly SupportOffset[]): void {
  if (!offsets.length || offsets.length > MAX_OFFSETS || offsets.some(([row, column]) => !Number.isSafeInteger(row) || !Number.isSafeInteger(column))) throw new RangeError('Invalid or oversized support offsets');
}

/** Compose sequential same-grid operations. Branches are combined with unionSupport. */
export function composeSupport(...stages: readonly (readonly SupportOffset[])[]): SupportOffset[] {
  let result: SupportOffset[] = [[0, 0]];
  for (const stage of stages) {
    validateOffsets(stage);
    if (result.length * stage.length > MAX_COMPOSITION_PAIRS) throw new RangeError('Support composition budget exceeded');
    const unique = new Map<string, SupportOffset>();
    for (const [row, column] of result) for (const [dy, dx] of stage) {
      const next = [row + dy, column + dx] as const;
      if (!next.every(Number.isSafeInteger)) throw new RangeError('Support offset overflow');
      unique.set(`${next[0]},${next[1]}`, next);
      if (unique.size > MAX_OFFSETS) throw new RangeError('Support offset budget exceeded');
    }
    result = [...unique.values()];
  }
  return result.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function cellCount(grid: SupportGrid): number {
  const count = grid.width * grid.height;
  if (![grid.width, grid.height, count].every(Number.isSafeInteger) || grid.width < 1 || grid.height < 1 || count > MAX_SUPPORT_CELLS) throw new RangeError('Support grid budget exceeded');
  return count;
}

function neighbor(grid: SupportGrid, row: number, column: number, [dy, dx]: SupportOffset): number | null {
  const y = row + dy;
  let x = column + dx;
  if (!Number.isSafeInteger(y) || !Number.isSafeInteger(x) || y < 0 || y >= grid.height) return null;
  if (grid.wrapLongitude) x = ((x % grid.width) + grid.width) % grid.width;
  if (x < 0 || x >= grid.width) return null;
  return y * grid.width + x;
}

export interface ExpandedSupport {
  /** Union of in-domain cells required to evaluate the target cells. */
  required: Uint8Array;
  /** Target cells whose complete support leaves the native grid; never extrapolate or clamp. */
  unavailableTargets: Uint8Array;
}

export function expandSupport(grid: SupportGrid, targets: Uint8Array, offsets: readonly SupportOffset[]): ExpandedSupport {
  const count = cellCount(grid), length = Math.ceil(count / 8);
  if (targets.length !== length) throw new RangeError('Support mask size differs from grid');
  validateOffsets(offsets);
  let targetCount = 0;
  for (let i = 0; i < targets.length; i++) {
    let bits = targets[i];
    if (i === targets.length - 1 && count % 8) bits &= (1 << (count % 8)) - 1;
    while (bits) { bits &= bits - 1; targetCount++; }
  }
  if (targetCount * offsets.length > MAX_SUPPORT_VISITS) throw new RangeError('Support evaluation budget exceeded');
  const required = new Uint8Array(length), unavailableTargets = new Uint8Array(length);
  for (let index = 0; index < count; index++) {
    if (!getBit(targets, index)) continue;
    const row = Math.floor(index / grid.width), column = index % grid.width;
    for (const offset of offsets) {
      const source = neighbor(grid, row, column, offset);
      if (source === null) setBit(unavailableTargets, index);
      else setBit(required, source);
    }
  }
  return { required, unavailableTargets };
}

/** Union independent input dependencies without modifying their masks or public coverage. */
export function unionSupport(grid: SupportGrid, masks: readonly Uint8Array[]): Uint8Array {
  const count = cellCount(grid), length = Math.ceil(count / 8), result = new Uint8Array(length);
  for (const mask of masks) {
    if (mask.length !== length) throw new RangeError('Support mask size differs from grid');
    for (let i = 0; i < length; i++) result[i] |= mask[i];
  }
  if (count % 8) result[length - 1] &= (1 << (count % 8)) - 1;
  return result;
}

/** Plan one primitive field's support; call per dependency and union shared primitive inputs. */
export function planFieldSupport(grid: SupportGrid, output: Uint8Array, interpolation: readonly SupportOffset[], operator: readonly SupportOffset[]) {
  const derived = expandSupport(grid, output, interpolation);
  const input = expandSupport(grid, derived.required, operator);
  const unavailableOutput = new Uint8Array(derived.unavailableTargets);
  const count = cellCount(grid);
  for (let index = 0; index < count; index++) {
    if (!getBit(output, index)) continue;
    const row = Math.floor(index / grid.width), column = index % grid.width;
    for (const offset of interpolation) {
      const source = neighbor(grid, row, column, offset);
      if (source === null || getBit(input.unavailableTargets, source)) { setBit(unavailableOutput, index); break; }
    }
  }
  return { derived: derived.required, input: input.required, unavailableDerived: input.unavailableTargets, unavailableOutput };
}
