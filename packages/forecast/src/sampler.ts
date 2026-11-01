import { CELL_BYTES, getBit, gridSchema, isCovered, prepareGridGeometry, snapGridCoordinate, withinGeographicBounds, LAYERS, STATUS_MASK, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_MASK, type CoverageMask, type Grid, type LayerId, type LayerSpec } from '@av/contracts';

export interface GridField { values: Float32Array; flags: Uint8Array }
export interface Cell { value: number; flags: number }
export interface Contributor { index: number; row: number; column: number; weight: number }
export interface SamplePlan { contributors: Contributor[]; byteRange: { offset: number; length: number } }
export interface Sample { value: number | null; status: number; support: number; interpolated: boolean }

export const QUAD_OFFSETS = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
const snap = snapGridCoordinate;
/** One 256px tile at four quarter-pixel coordinates; reject oversized geometry before allocating. */
export const MAX_PREPARED_SAMPLES = 512 * 512;

function reductionBuffer(length: number) {
  return { values: new Float64Array(length), flags: new Uint8Array(length), weights: new Float64Array(length), rows: new Float64Array(length), columns: new Float64Array(length) };
}

/** The common four-known-cell case avoids scratch-array writes and three loops.
 * Keep both the weight products and the accumulation order identical to reduceCells.
 * Missing contributors, invalid flags and non-finite values use that reference path.
 */
function reduceKnownQuad(field: GridField, a: number, b: number, c: number, d: number, fx: number, fy: number, spec: LayerSpec, out: Sample): boolean {
  const { flags, values } = field;
  const fa = flags[a], fb = flags[b], fc = flags[c], fd = flags[d], combined = fa | fb | fc | fd;
  if ((combined & STATUS_MASK) >= STATUS_UNAVAILABLE || (!spec.supportsNoLift && (combined & STATUS_NO_LIFT) !== 0)
      || (!spec.supportsLiftFlags && (combined & SUPPORT_MASK) !== 0)) return false;
  let va = values[a], vb = values[b], vc = values[c], vd = values[d];
  if (!Number.isFinite(va) || !Number.isFinite(vb) || !Number.isFinite(vc) || !Number.isFinite(vd)) return false;
  out.support = combined & SUPPORT_MASK; out.interpolated = true;
  if ((fa & fb & fc & fd & STATUS_MASK) === STATUS_NO_LIFT) {
    out.value = spec.noLiftSampleValue; out.status = STATUS_NO_LIFT; return true;
  }
  if (spec.zeroOnNoLiftInterpolation) {
    if (fa & STATUS_NO_LIFT) va = 0;
    if (fb & STATUS_NO_LIFT) vb = 0;
    if (fc & STATUS_NO_LIFT) vc = 0;
    if (fd & STATUS_NO_LIFT) vd = 0;
  }
  const left = 1 - fx, top = 1 - fy;
  let value = 0;
  value += va * (top * left);
  value += vb * (top * fx);
  value += vc * (fy * left);
  value += vd * (fy * fx);
  out.value = value; out.status = STATUS_VALID;
  return true;
}

function reduceCells(cells: ReturnType<typeof reductionBuffer>, count: number, spec: LayerSpec, out: Sample): void {
  const { values, flags, weights, rows, columns } = cells;
  let missing = false, finite = true, allNoLift = true, support = 0;
  for (let i = 0; i < count; i++) {
    const flag = flags[i], status = flag & STATUS_MASK;
    if ((!spec.supportsNoLift && status === STATUS_NO_LIFT) || (!spec.supportsLiftFlags && (flag & SUPPORT_MASK) !== 0)) {
      throw new RangeError('rain cell has lift status or support');
    }
    missing ||= status >= STATUS_UNAVAILABLE;
    finite &&= Number.isFinite(values[i]);
    allNoLift &&= status === STATUS_NO_LIFT;
    support |= flag & SUPPORT_MASK;
  }
  if (missing) {
    let nearest = 0;
    for (let i = 1; i < count; i++) {
      const better = weights[i] > weights[nearest] || (weights[i] === weights[nearest] && (rows[i] < rows[nearest] || (rows[i] === rows[nearest] && columns[i] < columns[nearest])));
      if (better) nearest = i;
    }
    const flag = flags[nearest], status = flag & STATUS_MASK;
    if (status === STATUS_VALID && !Number.isFinite(values[nearest])) throw new RangeError('valid cell has non-finite value');
    out.value = status === STATUS_VALID ? values[nearest] : status === STATUS_NO_LIFT ? spec.noLiftSampleValue : null;
    out.status = status; out.support = flag & SUPPORT_MASK; out.interpolated = false;
    return;
  }
  if (!finite) throw new RangeError('known cell has non-finite value');
  if (count === 1) {
    const status = flags[0] & STATUS_MASK;
    out.value = status === STATUS_VALID ? values[0] : spec.noLiftSampleValue;
    out.status = status; out.support = support; out.interpolated = false;
    return;
  }
  out.support = support; out.interpolated = true;
  if (spec.supportsNoLift && allNoLift) { out.value = spec.noLiftSampleValue; out.status = STATUS_NO_LIFT; return; }
  let value = 0;
  for (let i = 0; i < count; i++) value += (spec.zeroOnNoLiftInterpolation && (flags[i] & STATUS_MASK) === STATUS_NO_LIFT ? 0 : values[i]) * weights[i];
  out.value = value; out.status = STATUS_VALID;
}

export function planSample(grid: Grid, lat: number, lon: number): SamplePlan | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isSafeInteger(grid.width) || !Number.isSafeInteger(grid.height) || grid.width <= 0 || grid.height <= 0) return null;
  let x: number, y: number;
  if (grid.kind === 'regular-latlon') {
    if (![grid.lon0, grid.lat0, grid.dx, grid.dy].every(Number.isFinite) || grid.dx === 0 || grid.dy === 0 || lat < -90 || lat > 90) return null;
    x = snap((lon - grid.lon0) / grid.dx);
    y = snap((lat - grid.lat0) / grid.dy);
    if (grid.wrapLongitude) x = snap(((x % grid.width) + grid.width) % grid.width);
  } else {
    const point = prepareGridGeometry(grid).geographicToGrid(lat, lon);
    if (!point) return null;
    ({ x, y } = point);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if ((!grid.wrapLongitude && (x < 0 || x > grid.width - 1)) || y < 0 || y > grid.height - 1) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const contributors: Contributor[] = [];
  let first = Infinity, last = -Infinity;
  for (const [dx, dy] of QUAD_OFFSETS) {
    if ((dx && fx === 0) || (dy && fy === 0)) continue;
    const row = dy === 0 ? y0 : y0 + 1, column = (dx === 0 ? x0 : x0 + 1) % grid.width, index = row * grid.width + column;
    contributors.push({ row, column, index, weight: (dy === 0 ? 1 - fy : fy) * (dx === 0 ? 1 - fx : fx) });
    first = Math.min(first, index); last = Math.max(last, index);
  }
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
  return plan.contributors.map(c => {
    const offset = c.index * CELL_BYTES - plan.byteRange.offset;
    if (offset < 0 || offset + CELL_BYTES > bytes.byteLength) throw new RangeError('cell outside range');
    return { value: view.getFloat32(offset, true), flags: view.getUint8(offset + 4) };
  });
}

export function sampleCells(plan: SamplePlan, cells: readonly Cell[], layer: LayerId | LayerSpec): Sample {
  if (!plan.contributors.length || cells.length !== plan.contributors.length) throw new RangeError('cell count does not match sample plan');
  const scratch = reductionBuffer(cells.length);
  for (let i = 0; i < cells.length; i++) {
    scratch.values[i] = typeof cells[i].value === 'number' ? cells[i].value : NaN;
    scratch.flags[i] = cells[i].flags;
    const contributor = plan.contributors[i];
    scratch.weights[i] = contributor.weight; scratch.rows[i] = contributor.row; scratch.columns[i] = contributor.column;
  }
  const result: Sample = { value: null, status: STATUS_OUTSIDE, support: 0, interpolated: false };
  reduceCells(scratch, cells.length, typeof layer === 'string' ? LAYERS[layer] : layer, result);
  return result;
}

export function sampleGrid(grid: Grid, field: GridField, lat: number, lon: number, layer: LayerId | LayerSpec, mask?: CoverageMask): Sample {
  const outside: Sample = { value: null, status: STATUS_OUTSIDE, support: 0, interpolated: false };
  if (mask && !isCovered(mask, lat, lon)) return outside;
  const plan = planSample(grid, lat, lon);
  if (!plan) return outside;
  if (field.values.length !== grid.width * grid.height || field.flags.length !== field.values.length) throw new RangeError('field size differs from grid');
  return sampleCells(plan, plan.contributors.map(c => ({ value: field.values[c.index], flags: field.flags[c.index] })), layer);
}

/** Build-owned geometry for a Cartesian set of coordinates. No field values are retained. */
export interface PreparedGridSampling {
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly contributors: Uint32Array;
  bind(field: GridField, layer: LayerId | LayerSpec): (x: number, y: number, out: Sample) => void;
}

function prepareAxis(coordinates: Float64Array, origin: number, step: number, size: number, wrap: boolean, column: boolean) {
  const lower = new Float64Array(coordinates.length), upper = new Float64Array(coordinates.length), fraction = new Float64Array(coordinates.length);
  for (let i = 0; i < coordinates.length; i++) {
    let coordinate = snap((coordinates[i] - origin) / step);
    if (wrap) coordinate = snap(((coordinate % size) + size) % size);
    if (!Number.isFinite(coordinate) || (!wrap && (coordinate < 0 || coordinate > size - 1))) { lower[i] = NaN; continue; }
    lower[i] = Math.floor(coordinate);
    upper[i] = column ? (lower[i] + 1) % size : lower[i] + 1;
    fraction[i] = coordinate - lower[i];
  }
  return { lower, upper, fraction };
}

export function prepareGridSampling(mask: CoverageMask, latitudes: Float64Array, longitudes: Float64Array): PreparedGridSampling {
  const grid = mask.grid, width = longitudes.length, height = latitudes.length, total = width * height;
  if (!Number.isSafeInteger(total) || width < 1 || height < 1 || total > MAX_PREPARED_SAMPLES) throw new RangeError('Prepared sampling coordinate budget exceeded');
  if (!gridSchema.safeParse(grid).success) throw new RangeError('Invalid prepared grid');
  if (mask.output.length !== Math.ceil(grid.width * grid.height / 8)) throw new RangeError('Coverage size differs from grid');
  if (grid.kind === 'lambert-conformal') return prepareProjectedSampling(mask, latitudes, longitudes);
  const rows = prepareAxis(latitudes, grid.lat0, grid.dy, grid.height, false, false);
  const columns = prepareAxis(longitudes, grid.lon0, grid.dx, grid.width, grid.wrapLongitude, true);
  // The regular grid and geographic policy are separable; apply each axis once,
  // rather than repeating policy checks for every quarter-pixel combination.
  for (let y = 0; y < height; y++) if (!withinGeographicBounds(latitudes[y], mask.bounds?.[0] ?? 0, mask.bounds)) rows.lower[y] = NaN;
  for (let x = 0; x < width; x++) if (!withinGeographicBounds(mask.bounds?.[1] ?? 0, longitudes[x], mask.bounds)) columns.lower[x] = NaN;
  const covered = new Uint8Array(Math.ceil(total / 8));
  const contributorSet = new Set<number>();
  let hasCoverage = false;
  for (let index = 0; index < total; index++) {
    const x = index % width, y = (index - x) / width;
    if (!Number.isFinite(rows.lower[y]) || !Number.isFinite(columns.lower[x])) continue;
    const fy = rows.fraction[y], fx = columns.fraction[x];
    const row = fy <= 0.5 ? rows.lower[y] : Math.min(grid.height - 1, rows.upper[y]);
    const c0 = columns.lower[x], c1 = columns.upper[x];
    const col = fx < 0.5 ? c0 : fx > 0.5 ? c1 : Math.min(c0, c1);
    if (getBit(mask.output, row * grid.width + col)) {
      covered[index >> 3] |= 1 << (index & 7);
      hasCoverage = true;
      for (const [dx, dy] of QUAD_OFFSETS) {
        if ((dx && fx === 0) || (dy && fy === 0)) continue;
        contributorSet.add((dy === 0 ? rows.lower[y] : rows.upper[y]) * grid.width + (dx === 0 ? c0 : c1));
      }
    }
  }
  const contributors = Uint32Array.from(contributorSet);
  return {
    width, height, contributors, byteLength: (width + height) * 3 * Float64Array.BYTES_PER_ELEMENT + covered.byteLength + contributors.byteLength,
    bind(field, layer) {
      if (hasCoverage && (field.values.length !== grid.width * grid.height || field.flags.length !== field.values.length)) throw new RangeError('field size differs from grid');
      const scratch = reductionBuffer(4), spec = typeof layer === 'string' ? LAYERS[layer] : layer;
      return (x, y, out) => {
        const coverageIndex = y * width + x;
        if (!(covered[coverageIndex >> 3] & (1 << (coverageIndex & 7)))) { out.value = null; out.status = STATUS_OUTSIDE; out.support = 0; out.interpolated = false; return; }
        const fx = columns.fraction[x], fy = rows.fraction[y];
        if (fx !== 0 && fy !== 0) {
          const r0 = rows.lower[y] * grid.width, r1 = rows.upper[y] * grid.width, c0 = columns.lower[x], c1 = columns.upper[x];
          if (reduceKnownQuad(field, r0 + c0, r0 + c1, r1 + c0, r1 + c1, fx, fy, spec, out)) return;
        }
        let count = 0;
        for (const [dx, dy] of QUAD_OFFSETS) {
          if ((dx && fx === 0) || (dy && fy === 0)) continue;
          const row = dy === 0 ? rows.lower[y] : rows.upper[y], column = dx === 0 ? columns.lower[x] : columns.upper[x], index = row * grid.width + column;
          scratch.values[count] = field.values[index]; scratch.flags[count] = field.flags[index];
          scratch.weights[count] = (dy === 0 ? 1 - fy : fy) * (dx === 0 ? 1 - fx : fx);
          scratch.rows[count] = row; scratch.columns[count] = column; count++;
        }
        reduceCells(scratch, count, spec, out);
      };
    }
  };
}

/** Projected coordinates are not separable. Retain only four numbers per requested coordinate. */
function prepareProjectedSampling(mask: CoverageMask, latitudes: Float64Array, longitudes: Float64Array): PreparedGridSampling {
  const grid = mask.grid, geometry = prepareGridGeometry(grid);
  const width = longitudes.length, height = latitudes.length, total = width * height;
  const lowerX = new Float64Array(total), lowerY = new Float64Array(total);
  const fractionX = new Float64Array(total), fractionY = new Float64Array(total);
  const covered = new Uint8Array(Math.ceil(total / 8)), contributorSet = new Set<number>();
  for (let index = 0; index < total; index++) {
    const x = index % width, y = (index - x) / width, lat = latitudes[y], lon = longitudes[x];
    if (!withinGeographicBounds(lat, lon, mask.bounds)) continue;
    const point = geometry.geographicToGrid(lat, lon);
    if (!point || point.x < 0 || point.x > grid.width - 1 || point.y < 0 || point.y > grid.height - 1) continue;
    const column = Math.floor(point.x), row = Math.floor(point.y), fx = point.x - column, fy = point.y - row;
    const nearestColumn = fx <= 0.5 ? column : column + 1, nearestRow = fy <= 0.5 ? row : row + 1;
    if (!getBit(mask.output, nearestRow * grid.width + nearestColumn)) continue;
    covered[index >> 3] |= 1 << (index & 7);
    lowerX[index] = column; lowerY[index] = row; fractionX[index] = fx; fractionY[index] = fy;
    for (const [dx, dy] of QUAD_OFFSETS) {
      if ((dx && fx === 0) || (dy && fy === 0)) continue;
      contributorSet.add((row + dy) * grid.width + column + dx);
    }
  }
  const contributors = Uint32Array.from(contributorSet);
  return {
    width, height, contributors,
    byteLength: total * 4 * Float64Array.BYTES_PER_ELEMENT + covered.byteLength + contributors.byteLength,
    bind(field, layer) {
      if (contributors.length && (field.values.length !== grid.width * grid.height || field.flags.length !== field.values.length)) throw new RangeError('field size differs from grid');
      const scratch = reductionBuffer(4), spec = typeof layer === 'string' ? LAYERS[layer] : layer;
      return (x, y, out) => {
        const index = y * width + x;
        if (!(covered[index >> 3] & (1 << (index & 7)))) { out.value = null; out.status = STATUS_OUTSIDE; out.support = 0; out.interpolated = false; return; }
        const fx = fractionX[index], fy = fractionY[index];
        if (fx !== 0 && fy !== 0) {
          const a = lowerY[index] * grid.width + lowerX[index], c = a + grid.width;
          if (reduceKnownQuad(field, a, a + 1, c, c + 1, fx, fy, spec, out)) return;
        }
        let count = 0;
        for (const [dx, dy] of QUAD_OFFSETS) {
          if ((dx && fx === 0) || (dy && fy === 0)) continue;
          const row = lowerY[index] + dy, column = lowerX[index] + dx, source = row * grid.width + column;
          scratch.values[count] = field.values[source]; scratch.flags[count] = field.flags[source];
          scratch.weights[count] = (dy ? fy : 1 - fy) * (dx ? fx : 1 - fx);
          scratch.rows[count] = row; scratch.columns[count] = column; count++;
        }
        reduceCells(scratch, count, spec, out);
      };
    }
  };
}
