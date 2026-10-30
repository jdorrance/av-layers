import { CELL_BYTES, isCovered, LAYERS, STATUS_MASK, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_VALID, SUPPORT_MASK, type CoverageMask, type Grid, type LayerId } from '@av/contracts';

export interface GridField { values: Float32Array; flags: Uint8Array }
export interface Cell { value: number; flags: number }
export interface Contributor { index: number; row: number; column: number; weight: number }
export interface SamplePlan { contributors: Contributor[]; byteRange: { offset: number; length: number } }
export interface Sample { value: number | null; status: number; support: number; interpolated: boolean }
const snap = (n: number) => Math.abs(n - Math.round(n)) <= 1e-10 ? Math.round(n) : n;
export function planSample(grid: Grid, lat: number, lon: number): SamplePlan | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isInteger(grid.width) || !Number.isInteger(grid.height) || grid.width <= 0 || grid.height <= 0 || !Number.isFinite(grid.dx) || !Number.isFinite(grid.dy) || grid.dx === 0 || grid.dy === 0) return null;
  let x = snap((lon - grid.lon0) / grid.dx);
  const y = snap((lat - grid.lat0) / grid.dy);
  if (grid.wrapLongitude) x = snap(((x % grid.width) + grid.width) % grid.width);
  if ((!grid.wrapLongitude && (x < 0 || x > grid.width - 1)) || y < 0 || y > grid.height - 1) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const cols = fx === 0 ? [{ column: x0 % grid.width, weight: 1 }] : [{ column: x0, weight: 1 - fx }, { column: (x0 + 1) % grid.width, weight: fx }];
  const rows = fy === 0 ? [{ row: y0, weight: 1 }] : [{ row: y0, weight: 1 - fy }, { row: y0 + 1, weight: fy }];
  const contributors = rows.flatMap(row => cols.map(col => ({ row: row.row, column: col.column, index: row.row * grid.width + col.column, weight: row.weight * col.weight })));
  const indices = contributors.map(c => c.index), first = Math.min(...indices), last = Math.max(...indices);
  return { contributors, byteRange: { offset: first * CELL_BYTES, length: (last - first + 1) * CELL_BYTES } };
}
export function packCells(field: GridField): Uint8Array {
  if (field.values.length !== field.flags.length) throw new RangeError('field lengths differ');
  const bytes = new Uint8Array(field.values.length * CELL_BYTES), view = new DataView(bytes.buffer);
  for (let i = 0; i < field.values.length; i++) { view.setFloat32(i * CELL_BYTES, field.values[i], true); view.setUint8(i * CELL_BYTES + 4, field.flags[i]); }
  return bytes;
}
export function unpackCells(bytes: Uint8Array): GridField {
  if (bytes.byteLength % CELL_BYTES !== 0) throw new RangeError('invalid cell byte count');
  const values = new Float32Array(bytes.byteLength / CELL_BYTES), flags = new Uint8Array(values.length), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < values.length; i++) { values[i] = view.getFloat32(i * CELL_BYTES, true); flags[i] = view.getUint8(i * CELL_BYTES + 4); }
  return { values, flags };
}
export function cellsFromRange(plan: SamplePlan, bytes: Uint8Array): Cell[] {
  if (bytes.byteLength !== plan.byteRange.length) throw new RangeError('unexpected range byte count');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return plan.contributors.map(c => { const offset = c.index * CELL_BYTES - plan.byteRange.offset; if (offset < 0 || offset + CELL_BYTES > bytes.byteLength) throw new RangeError('cell outside range'); return { value: view.getFloat32(offset, true), flags: view.getUint8(offset + 4) }; });
}
export function sampleCells(plan: SamplePlan, cells: readonly Cell[], layer: LayerId): Sample {
  if (!plan.contributors.length || cells.length !== plan.contributors.length) throw new RangeError('cell count does not match sample plan');
  const spec = LAYERS[layer];
  if (cells.some(cell => (!spec.supportsNoLift && (cell.flags & STATUS_MASK) === STATUS_NO_LIFT) || (!spec.supportsLiftFlags && (cell.flags & SUPPORT_MASK) !== 0))) {
    throw new RangeError('rain cell has lift status or support');
  }
  const known = (cell: Cell) => (cell.flags & STATUS_MASK) === STATUS_VALID || (spec.supportsNoLift && (cell.flags & STATUS_MASK) === STATUS_NO_LIFT);
  const result = (cell: Cell): Sample => {
    const status = cell.flags & STATUS_MASK;
    if (status === STATUS_VALID && !Number.isFinite(cell.value)) throw new RangeError('valid cell has non-finite value');
    return {
      value: status === STATUS_VALID ? cell.value : status === STATUS_NO_LIFT ? spec.noLiftSampleValue : null,
      status,
      support: cell.flags & SUPPORT_MASK,
      interpolated: false
    };
  };
  if (cells.some(cell => !known(cell))) {
    let nearest = 0;
    for (let i = 1; i < cells.length; i++) { const a = plan.contributors[i], b = plan.contributors[nearest]; if (a.weight > b.weight || (a.weight === b.weight && (a.row < b.row || (a.row === b.row && a.column < b.column)))) nearest = i; }
    return result(cells[nearest]);
  }
  if (cells.some(cell => !Number.isFinite(cell.value))) throw new RangeError('known cell has non-finite value');
  if (cells.length === 1) return result(cells[0]);
  const support = cells.reduce((bits, cell) => bits | (cell.flags & SUPPORT_MASK), 0);
  if (spec.supportsNoLift && cells.every(cell => (cell.flags & STATUS_MASK) === STATUS_NO_LIFT)) {
    return { value: spec.noLiftSampleValue, status: STATUS_NO_LIFT, support, interpolated: true };
  }
  return {
    value: cells.reduce((sum, cell, i) => sum + (spec.zeroOnNoLiftInterpolation && (cell.flags & STATUS_MASK) === STATUS_NO_LIFT ? 0 : cell.value) * plan.contributors[i].weight, 0),
    status: STATUS_VALID,
    support,
    interpolated: true
  };
}
export function sampleGrid(grid: Grid, field: GridField, lat: number, lon: number, layer: LayerId, mask?: CoverageMask): Sample {
  const outside: Sample = { value: null, status: STATUS_OUTSIDE, support: 0, interpolated: false };
  if (mask && !isCovered(mask, lat, lon)) return outside;
  const plan = planSample(grid, lat, lon);
  if (!plan) return outside;
  if (field.values.length !== grid.width * grid.height || field.flags.length !== field.values.length) throw new RangeError('field size differs from grid');
  return sampleCells(plan, plan.contributors.map(c => ({ value: field.values[c.index], flags: field.flags[c.index] })), layer);
}
