import { gridSchema, snapGridCoordinate, type Grid, type LambertConformalGrid, type RegularLatLonGrid } from './geometry.js';

const MAX_UINT32_CELLS = 0xffffffff;

export interface WholeDomainGrid<T extends Grid = Grid> {
  readonly k: number;
  readonly native: T;
  readonly fine: T;
}

export function planWholeDomainGrid(rawNative: RegularLatLonGrid, k: number): WholeDomainGrid<RegularLatLonGrid>;
export function planWholeDomainGrid(rawNative: LambertConformalGrid, k: number): WholeDomainGrid<LambertConformalGrid>;
export function planWholeDomainGrid(rawNative: Grid, k: number): WholeDomainGrid;
export function planWholeDomainGrid(rawNative: Grid, k: number): WholeDomainGrid {
  if (!Number.isSafeInteger(k) || k < 1) throw new RangeError('Whole-domain subdivision factor must be a positive integer');
  const native = gridSchema.parse(rawNative);
  const nativeCells = native.width * native.height;
  if (!Number.isSafeInteger(nativeCells) || nativeCells >= MAX_UINT32_CELLS) throw new RangeError('Whole-domain native grid exceeds the admitted index space');
  const width = native.wrapLongitude ? native.width * k : (native.width - 1) * k + 1;
  const height = (native.height - 1) * k + 1;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || !Number.isSafeInteger(width * height) || width * height >= MAX_UINT32_CELLS) {
    throw new RangeError('Whole-domain fine grid exceeds the admitted index space');
  }
  const spacing = native.kind === 'regular-latlon' ? { dx: native.dx / k, dy: native.dy / k } : { dxM: native.dxM / k, dyM: native.dyM / k };
  if (Object.values(spacing).some(step => !Number.isFinite(step) || step === 0)) throw new RangeError('Whole-domain fine spacing underflows');
  const fine = gridSchema.parse({ ...native, width, height, ...spacing });
  return { k, native, fine };
}

export function wholeDomainDonorSupport(plan: WholeDomainGrid, activeFineIndices: Iterable<number>): Uint8Array {
  const { k, native, fine } = plan;
  const nativeCells = native.width * native.height, fineCells = fine.width * fine.height;
  if (activeFineIndices === null || activeFineIndices === undefined || typeof (activeFineIndices as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') throw new RangeError('Whole-domain targets must be iterable');
  const required = new Uint8Array(Math.ceil(nativeCells / 8));
  for (const target of activeFineIndices) {
    if (!Number.isSafeInteger(target) || target < 0 || target >= fineCells) throw new RangeError('Whole-domain target index outside the fine grid');
    const x = target % fine.width, y = (target - x) / fine.width;
    let nx = snapGridCoordinate(x / k);
    const ny = snapGridCoordinate(y / k);
    if (native.wrapLongitude) nx = snapGridCoordinate(((nx % native.width) + native.width) % native.width);
    const column = Math.floor(nx), row = Math.floor(ny);
    const fx = nx - column, fy = ny - row;
    const column1 = fx === 0 ? column : native.wrapLongitude ? (column + 1) % native.width : column + 1;
    const row1 = fy === 0 ? row : row + 1;
    mark(required, row * native.width + column, nativeCells);
    if (fx !== 0) mark(required, row * native.width + column1, nativeCells);
    if (fy !== 0) mark(required, row1 * native.width + column, nativeCells);
    if (fx !== 0 && fy !== 0) mark(required, row1 * native.width + column1, nativeCells);
  }
  return required;
}

function mark(required: Uint8Array, index: number, cells: number): void {
  if (index < 0 || index >= cells) throw new RangeError('Whole-domain donor index outside the native grid');
  required[index >> 3] |= 1 << (index & 7);
}

export function assertWholeDomainDonorsActive(plan: WholeDomainGrid, required: Uint8Array, activeIndices: Uint32Array): void {
  const { native } = plan, cells = native.width * native.height;
  if (!(required instanceof Uint8Array) || required.length !== Math.ceil(cells / 8)) throw new RangeError('Whole-domain donor support size differs from the native grid');
  if (!(activeIndices instanceof Uint32Array) || !activeIndices.length) throw new RangeError('Whole-domain donor support requires active native indices');
  for (let i = 0; i < activeIndices.length; i++) {
    const index = activeIndices[i];
    if (index >= cells || (i > 0 && index <= activeIndices[i - 1])) throw new RangeError('Whole-domain donor support requires sorted unique active native indices');
  }
  for (let byte = 0; byte < required.length; byte++) {
    let bits = required[byte];
    if (byte === required.length - 1 && cells % 8) bits &= (1 << (cells % 8)) - 1;
    while (bits) {
      const index = byte * 8 + 31 - Math.clz32(bits & -bits);
      let low = 0, high = activeIndices.length;
      while (low < high) { const middle = (low + high) >>> 1; if (activeIndices[middle] < index) low = middle + 1; else high = middle; }
      if (activeIndices[low] !== index) throw new RangeError(`Whole-domain donor ${index} is not an active native index`);
      bits &= bits - 1;
    }
  }
}
