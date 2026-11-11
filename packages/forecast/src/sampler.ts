import { CELL_BYTES, getBit, gridSchema, isCovered, lambertConformalGridSchema, prepareGridGeometry, snapGridCoordinate, sparseCoverageLookup, withinGeographicBounds, LAYERS, STATUS_MASK, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_MASK, type CoverageMask, type GeographicBounds, type Grid, type GridGeometry, type LambertConformalGrid, type LayerId, type LayerSpec, type SparseCoverage } from '@av/contracts';

export interface GridField { values: Float32Array; flags: Uint8Array }
export interface PackedGridField extends GridField { coverage: SparseCoverage }
export interface SparseSamplingMask { grid: Grid; bounds?: GeographicBounds; tiles: Uint8Array; maxZoom: number; coverage: SparseCoverage }
export type SamplingMask = CoverageMask | SparseSamplingMask;
export interface Cell { value: number; flags: number }
export interface Contributor { index: number; row: number; column: number; weight: number }
export interface SamplePlan { contributors: Contributor[]; byteRange: { offset: number; length: number } }
export interface Sample { value: number | null; status: number; support: number; interpolated: boolean }

export function validateSamplingField(grid: Grid, field: GridField, mask?: SamplingMask): void {
  if (!(field.values instanceof Float32Array) || !(field.flags instanceof Uint8Array)) throw new RangeError('Invalid field arrays');
  const coverage = 'coverage' in field ? (field as PackedGridField).coverage : undefined;
  if (coverage) {
    if (coverage.width !== grid.width || coverage.height !== grid.height || coverage.wrapLongitude !== grid.wrapLongitude ||
        field.values.length !== coverage.offsets[coverage.offsets.length - 1] || field.flags.length !== field.values.length ||
        (mask && (!('coverage' in mask) || mask.coverage !== coverage))) throw new RangeError('Packed field does not match coverage');
  } else if (field.values.length !== grid.width * grid.height || field.flags.length !== field.values.length || (mask && 'coverage' in mask)) {
    throw new RangeError('field size differs from grid');
  }
}

export function fieldOffset(field: GridField, index: number, width: number): number {
  if (!('coverage' in field)) return index;
  const offset = sparseCoverageLookup((field as PackedGridField).coverage, index % width, Math.floor(index / width))?.offset;
  if (offset === undefined) throw new RangeError('Sampling contributor is outside active coverage');
  return offset;
}

function outputAt(mask: SamplingMask, column: number, row: number): boolean {
  return 'coverage' in mask ? sparseCoverageLookup(mask.coverage, column, row)?.output === true : getBit(mask.output, row * mask.grid.width + column);
}

function validateSamplingMask(mask: SamplingMask): void {
  const { grid } = mask;
  if (!gridSchema.safeParse(grid).success) throw new RangeError('Invalid prepared grid');
  if ('coverage' in mask) {
    if (mask.coverage.width !== grid.width || mask.coverage.height !== grid.height || mask.coverage.wrapLongitude !== grid.wrapLongitude) throw new RangeError('Coverage size differs from grid');
  } else if (mask.output.length !== Math.ceil(grid.width * grid.height / 8)) throw new RangeError('Coverage size differs from grid');
}

export const QUAD_OFFSETS = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
const snap = snapGridCoordinate;
/** One 256px tile at four quarter-pixel coordinates; reject oversized geometry before allocating. */
export const MAX_PREPARED_SAMPLES = 512 * 512;

function reductionBuffer(length: number) {
  return { values: new Float64Array(length), flags: new Uint8Array(length), weights: new Float64Array(length), rows: new Float64Array(length), columns: new Float64Array(length) };
}

/** Bound repeated packed-offset lookup to 12 KiB per sampler; weather values remain live. */
function quadOffsets(field: GridField, width: number) {
  const keys = new Float64Array(512).fill(-1), offsets = new Uint32Array(512 * 4);
  return {
    offsets,
    locate(r0: number, c0: number, r1: number, c1: number): number {
      const key = r0 + c0, slot = (Math.imul(r0, 0x9e3779b1) ^ c0) & 511, start = slot * 4;
      if (keys[slot] !== key) {
        keys[slot] = -1;
        try {
          offsets[start] = fieldOffset(field, r0 + c0, width); offsets[start + 1] = fieldOffset(field, r0 + c1, width);
          offsets[start + 2] = fieldOffset(field, r1 + c0, width); offsets[start + 3] = fieldOffset(field, r1 + c1, width);
          keys[slot] = key;
        } catch { return -1; }
      }
      return start;
    }
  };
}

/** The common four-known-cell case avoids scratch-array writes and three loops.
 * Keep both the weight products and the accumulation order identical to reduceCells.
 * Missing contributors, invalid flags and non-finite values use that reference path.
 */
function reduceKnownQuad(field: GridField, a: number, b: number, c: number, d: number, fx: number, fy: number, spec: LayerSpec, useStoredMslNoLift: boolean, out: Sample): boolean {
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
  const left = 1 - fx, top = 1 - fy;
  let w00 = top * left, w10 = top * fx, w01 = fy * left, w11 = fy * fx;
  if (spec.supportsNoLift && (combined & STATUS_NO_LIFT) !== 0) {
    const na = (fa & STATUS_MASK) === STATUS_NO_LIFT, nb = (fb & STATUS_MASK) === STATUS_NO_LIFT;
    const nc = (fc & STATUS_MASK) === STATUS_NO_LIFT, nd = (fd & STATUS_MASK) === STATUS_NO_LIFT;
    const noLiftWeight = (na ? w00 : 0) + (nb ? w10 : 0) + (nc ? w01 : 0) + (nd ? w11 : 0);
    if (noLiftWeight > 0.5) {
      out.value = spec.noLiftSampleValue; out.status = STATUS_NO_LIFT; return true;
    }
    if (!useStoredMslNoLift && !spec.zeroOnNoLiftInterpolation) {
      const validWeight = 1 - noLiftWeight;
      w00 = na ? 0 : w00 / validWeight;
      w10 = nb ? 0 : w10 / validWeight;
      w01 = nc ? 0 : w01 / validWeight;
      w11 = nd ? 0 : w11 / validWeight;
    }
  }
  if (spec.zeroOnNoLiftInterpolation) {
    if (fa & STATUS_NO_LIFT) va = 0;
    if (fb & STATUS_NO_LIFT) vb = 0;
    if (fc & STATUS_NO_LIFT) vc = 0;
    if (fd & STATUS_NO_LIFT) vd = 0;
  }
  let value = 0;
  value += va * w00;
  value += vb * w10;
  value += vc * w01;
  value += vd * w11;
  out.value = value; out.status = STATUS_VALID;
  return true;
}

function reduceCells(cells: ReturnType<typeof reductionBuffer>, count: number, spec: LayerSpec, useStoredMslNoLift: boolean, out: Sample): void {
  const { values, flags, weights, rows, columns } = cells;
  let missing = false, finite = true, allNoLift = true, support = 0, noLiftWeight = 0;
  for (let i = 0; i < count; i++) {
    const flag = flags[i], status = flag & STATUS_MASK;
    if ((!spec.supportsNoLift && status === STATUS_NO_LIFT) || (!spec.supportsLiftFlags && (flag & SUPPORT_MASK) !== 0)) {
      throw new RangeError('rain cell has lift status or support');
    }
    missing ||= status >= STATUS_UNAVAILABLE;
    finite &&= Number.isFinite(values[i]);
    allNoLift &&= status === STATUS_NO_LIFT;
    if (status === STATUS_NO_LIFT) noLiftWeight += weights[i];
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
  if (spec.supportsNoLift && (allNoLift || noLiftWeight > 0.5)) { out.value = spec.noLiftSampleValue; out.status = STATUS_NO_LIFT; return; }
  const renormalizeMsl = !useStoredMslNoLift && spec.supportsNoLift && !spec.zeroOnNoLiftInterpolation && count === 4 && noLiftWeight > 0;
  const validWeight = 1 - noLiftWeight;
  let value = 0;
  for (let i = 0; i < count; i++) {
    const isNoLift = (flags[i] & STATUS_MASK) === STATUS_NO_LIFT;
    if (renormalizeMsl) {
      value += isNoLift ? 0 : values[i] * (weights[i] / validWeight);
    } else {
      value += (spec.zeroOnNoLiftInterpolation && isNoLift ? 0 : values[i]) * weights[i];
    }
  }
  out.value = value; out.status = STATUS_VALID;
}

interface LocatedCell { column: number; row: number; fractionX: number; fractionY: number }
function locate(grid: Grid, geometry: GridGeometry | null, lat: number, lon: number): LocatedCell | null {
  let x: number, y: number;
  if (grid.kind === 'regular-latlon') {
    if (![grid.lon0, grid.lat0, grid.dx, grid.dy].every(Number.isFinite) || grid.dx === 0 || grid.dy === 0 || lat < -90 || lat > 90) return null;
    x = snap((lon - grid.lon0) / grid.dx);
    y = snap((lat - grid.lat0) / grid.dy);
    if (grid.wrapLongitude) x = snap(((x % grid.width) + grid.width) % grid.width);
  } else {
    if (!geometry) return null;
    const point = geometry.geographicToGrid(lat, lon);
    if (!point) return null;
    ({ x, y } = point);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if ((!grid.wrapLongitude && (x < 0 || x > grid.width - 1)) || y < 0 || y > grid.height - 1) return null;
  const column = Math.floor(x), row = Math.floor(y);
  return { column, row, fractionX: x - column, fractionY: y - row };
}

const lambertGridFields = lambertConformalGridSchema.keyof().options;
const lambertGeometries = new WeakMap<LambertConformalGrid, { snapshot: LambertConformalGrid; geometry: GridGeometry }>();
function lambertGeometry(grid: Grid): GridGeometry | null {
  if (grid.kind !== 'lambert-conformal') return null;
  const cached = lambertGeometries.get(grid);
  if (cached && lambertGridFields.every(field => grid[field] === cached.snapshot[field])) return cached.geometry;
  const snapshot = Object.fromEntries(lambertGridFields.map(field => [field, grid[field]])) as LambertConformalGrid;
  const geometry = prepareGridGeometry(snapshot);
  lambertGeometries.set(grid, { snapshot, geometry });
  return geometry;
}

export function planSample(grid: Grid, lat: number, lon: number): SamplePlan | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isSafeInteger(grid.width) || !Number.isSafeInteger(grid.height) || grid.width <= 0 || grid.height <= 0) return null;
  let geometry: GridGeometry | null;
  try { geometry = lambertGeometry(grid); } catch { return null; }
  const located = locate(grid, geometry, lat, lon);
  if (!located) return null;
  const { column: x0, row: y0, fractionX: fx, fractionY: fy } = located;
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

/** The build's sampling marker selects the no-lift interpolation used by its tiles. */
export function sampleCells(plan: SamplePlan, cells: readonly Cell[], layer: LayerId | LayerSpec, useStoredMslNoLift: boolean): Sample {
  if (!plan.contributors.length || cells.length !== plan.contributors.length) throw new RangeError('cell count does not match sample plan');
  const scratch = reductionBuffer(cells.length);
  for (let i = 0; i < cells.length; i++) {
    scratch.values[i] = typeof cells[i].value === 'number' ? cells[i].value : NaN;
    scratch.flags[i] = cells[i].flags;
    const contributor = plan.contributors[i];
    scratch.weights[i] = contributor.weight; scratch.rows[i] = contributor.row; scratch.columns[i] = contributor.column;
  }
  const result: Sample = { value: null, status: STATUS_OUTSIDE, support: 0, interpolated: false };
  reduceCells(scratch, cells.length, typeof layer === 'string' ? LAYERS[layer] : layer, useStoredMslNoLift, result);
  return result;
}

export function samplingCovered(mask: SamplingMask, lat: number, lon: number): boolean {
  if (!('coverage' in mask)) return isCovered(mask, lat, lon);
  if (!withinGeographicBounds(lat, lon, mask.bounds)) return false;
  let geometry: GridGeometry | null;
  try { geometry = lambertGeometry(mask.grid); } catch { return false; }
  const located = locate(mask.grid, geometry, lat, lon);
  if (!located) return false;
  const { column, row, fractionX: fx, fractionY: fy } = located;
  const next = mask.grid.wrapLongitude ? (column + 1) % mask.grid.width : column + 1;
  return outputAt(mask, fx < 0.5 ? column : fx > 0.5 ? next : Math.min(column, next), fy <= 0.5 ? row : Math.min(mask.grid.height - 1, row + 1));
}

export function sampleGrid(grid: Grid, field: GridField | PackedGridField, lat: number, lon: number, layer: LayerId | LayerSpec, mask: SamplingMask | undefined, useStoredMslNoLift: boolean): Sample {
  const outside: Sample = { value: null, status: STATUS_OUTSIDE, support: 0, interpolated: false };
  if (mask && !samplingCovered(mask, lat, lon)) return outside;
  const plan = planSample(grid, lat, lon);
  if (!plan) return outside;
  validateSamplingField(grid, field, mask);
  return sampleCells(plan, plan.contributors.map(c => { const i = fieldOffset(field, c.index, grid.width); return { value: field.values[i], flags: field.flags[i] }; }), layer, useStoredMslNoLift);
}

/** Build-owned geometry for a Cartesian set of coordinates. No field values are retained. */
export interface PreparedGridSampling {
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly contributors: Uint32Array;
  bind(field: GridField, layer: LayerId | LayerSpec, useStoredMslNoLift: boolean): (x: number, y: number, out: Sample) => void;
}

export interface PreparedGridAxis {
  readonly lower: Float64Array;
  readonly upper: Float64Array;
  readonly fraction: Float64Array;
  readonly byteLength: number;
}

export interface GridSamplingAxes { readonly rows: PreparedGridAxis; readonly columns: PreparedGridAxis }

function prepareAxis(coordinates: Float64Array, origin: number, step: number, size: number, wrap: boolean, column: boolean): PreparedGridAxis {
  const lower = new Float64Array(coordinates.length), upper = new Float64Array(coordinates.length), fraction = new Float64Array(coordinates.length);
  for (let i = 0; i < coordinates.length; i++) {
    let coordinate = snap((coordinates[i] - origin) / step);
    if (wrap) coordinate = snap(((coordinate % size) + size) % size);
    if (!Number.isFinite(coordinate) || (!wrap && (coordinate < 0 || coordinate > size - 1))) { lower[i] = NaN; continue; }
    lower[i] = Math.floor(coordinate);
    upper[i] = column ? (lower[i] + 1) % size : lower[i] + 1;
    fraction[i] = coordinate - lower[i];
  }
  return { lower, upper, fraction, byteLength: coordinates.length * 3 * Float64Array.BYTES_PER_ELEMENT };
}

export function prepareGridAxis(mask: SamplingMask, coordinates: Float64Array, axis: 'row' | 'column'): PreparedGridAxis {
  const grid = mask.grid;
  if (grid.kind !== 'regular-latlon') throw new RangeError('Separable axes require a regular grid');
  const column = axis === 'column';
  const prepared = prepareAxis(coordinates, column ? grid.lon0 : grid.lat0, column ? grid.dx : grid.dy, column ? grid.width : grid.height, column && grid.wrapLongitude, column);
  if (column) {
    for (let x = 0; x < coordinates.length; x++) if (!withinGeographicBounds(mask.bounds?.[1] ?? 0, coordinates[x], mask.bounds)) prepared.lower[x] = NaN;
  } else {
    for (let y = 0; y < coordinates.length; y++) if (!withinGeographicBounds(coordinates[y], mask.bounds?.[0] ?? 0, mask.bounds)) prepared.lower[y] = NaN;
  }
  return prepared;
}

export function prepareGridSampling(mask: SamplingMask, latitudes: Float64Array, longitudes: Float64Array, axes?: GridSamplingAxes): PreparedGridSampling {
  const grid = mask.grid;
  if (axes) {
    if (grid.kind !== 'regular-latlon') throw new RangeError('Separable axes require a regular grid');
    return prepareSeparableSampling(mask, axes.rows, axes.columns);
  }
  const width = longitudes.length, height = latitudes.length, total = width * height;
  if (!Number.isSafeInteger(total) || width < 1 || height < 1 || total > MAX_PREPARED_SAMPLES) throw new RangeError('Prepared sampling coordinate budget exceeded');
  validateSamplingMask(mask);
  if (grid.kind === 'lambert-conformal') return prepareProjectedSampling(mask, latitudes, longitudes);
  return prepareSeparableSampling(mask, prepareGridAxis(mask, latitudes, 'row'), prepareGridAxis(mask, longitudes, 'column'));
}

function prepareSeparableSampling(mask: SamplingMask, rows: PreparedGridAxis, columns: PreparedGridAxis): PreparedGridSampling {
  const grid = mask.grid, width = columns.lower.length, height = rows.lower.length, total = width * height;
  if (!Number.isSafeInteger(total) || width < 1 || height < 1 || total > MAX_PREPARED_SAMPLES) throw new RangeError('Prepared sampling coordinate budget exceeded');
  validateSamplingMask(mask);
  const covered = new Uint8Array(Math.ceil(total / 8));
  const contributorSet = new Set<number>();
  const columnGroups = new Uint32Array(width), coveredColumns = new Uint8Array(width), contributed = new Uint8Array(width);
  for (let x = 1; x < width; x++) {
    columnGroups[x] = columns.lower[x] === columns.lower[x - 1] && columns.upper[x] === columns.upper[x - 1] ? columnGroups[x - 1] : x;
  }
  let coveredRow = -1, contributorRow = -1;
  let hasCoverage = false;
  for (let y = 0; y < height; y++) {
    const r0 = rows.lower[y], r1 = rows.upper[y], fy = rows.fraction[y];
    if (!Number.isFinite(r0)) continue;
    const row = fy <= 0.5 ? r0 : Math.min(grid.height - 1, r1);
    if (row !== coveredRow) {
      let previousColumn = -1, output = false;
      for (let x = 0; x < width; x++) {
        const c0 = columns.lower[x], c1 = columns.upper[x], fx = columns.fraction[x];
        if (!Number.isFinite(c0)) { coveredColumns[x] = 0; continue; }
        const col = fx < 0.5 ? c0 : fx > 0.5 ? c1 : Math.min(c0, c1);
        if (col !== previousColumn) { output = outputAt(mask, col, row); previousColumn = col; }
        coveredColumns[x] = Number(output);
      }
      coveredRow = row;
    }
    if (r0 !== contributorRow) { contributed.fill(0); contributorRow = r0; }
    for (let x = 0, index = y * width; x < width; x++, index++) {
      if (!coveredColumns[x]) continue;
      covered[index >> 3] |= 1 << (index & 7);
      hasCoverage = true;
      const fx = columns.fraction[x], group = columnGroups[x], needed = (fx === 0 ? 5 : 15) & (fy === 0 ? 3 : 15);
      const added = needed & ~contributed[group];
      if (!added) continue;
      const c0 = columns.lower[x], c1 = columns.upper[x];
      if (added & 1) contributorSet.add(r0 * grid.width + c0);
      if (added & 2) contributorSet.add(r0 * grid.width + c1);
      if (added & 4) contributorSet.add(r1 * grid.width + c0);
      if (added & 8) contributorSet.add(r1 * grid.width + c1);
      contributed[group] |= needed;
    }
  }
  const contributors = Uint32Array.from(contributorSet);
  return {
    width, height, contributors, byteLength: (width + height) * 3 * Float64Array.BYTES_PER_ELEMENT + covered.byteLength + contributors.byteLength,
    bind(field, layer, useStoredMslNoLift) {
      if (hasCoverage) validateSamplingField(grid, field, mask);
      const scratch = reductionBuffer(4), spec = typeof layer === 'string' ? LAYERS[layer] : layer;
      const packed = 'coverage' in field;
      const quads = packed ? quadOffsets(field, grid.width) : undefined;
      return (x, y, out) => {
        const coverageIndex = y * width + x;
        if (!(covered[coverageIndex >> 3] & (1 << (coverageIndex & 7)))) { out.value = null; out.status = STATUS_OUTSIDE; out.support = 0; out.interpolated = false; return; }
        const fx = columns.fraction[x], fy = rows.fraction[y];
        let cachedQuad = -1;
        if (fx !== 0 && fy !== 0) {
          const r0 = rows.lower[y] * grid.width, r1 = rows.upper[y] * grid.width, c0 = columns.lower[x], c1 = columns.upper[x];
          if (!packed) {
            if (reduceKnownQuad(field, r0 + c0, r0 + c1, r1 + c0, r1 + c1, fx, fy, spec, useStoredMslNoLift, out)) return;
          } else {
            const start = quads!.locate(r0, c0, r1, c1), offsets = quads!.offsets;
            cachedQuad = start;
            if (start >= 0 && reduceKnownQuad(field, offsets[start], offsets[start + 1], offsets[start + 2], offsets[start + 3], fx, fy, spec, useStoredMslNoLift, out)) return;
          }
        }
        let count = 0;
        for (const [dx, dy] of QUAD_OFFSETS) {
          if ((dx && fx === 0) || (dy && fy === 0)) continue;
          const row = dy === 0 ? rows.lower[y] : rows.upper[y], column = dx === 0 ? columns.lower[x] : columns.upper[x], index = row * grid.width + column;
          const offset = cachedQuad >= 0 ? quads!.offsets[cachedQuad + count] : fieldOffset(field, index, grid.width);
          scratch.values[count] = field.values[offset]; scratch.flags[count] = field.flags[offset];
          scratch.weights[count] = (dy === 0 ? 1 - fy : fy) * (dx === 0 ? 1 - fx : fx);
          scratch.rows[count] = row; scratch.columns[count] = column; count++;
        }
        reduceCells(scratch, count, spec, useStoredMslNoLift, out);
      };
    }
  };
}

function locatedSampleCache() { return { nearest: -1, output: false, quad: -1, contributed: 0 }; }

function recordLocatedSample(
  grid: Grid,
  mask: SamplingMask,
  column: number,
  row: number,
  fx: number,
  fy: number,
  index: number,
  lowerX: Uint32Array,
  lowerY: Uint32Array,
  fractionX: Float64Array,
  fractionY: Float64Array,
  covered: Uint8Array,
  contributorSet: Set<number>,
  cache: ReturnType<typeof locatedSampleCache>
): void {
  const upperColumn = grid.wrapLongitude ? (column + 1) % grid.width : column + 1, upperRow = row + 1;
  const nearestColumn = fx < 0.5 ? column : fx > 0.5 ? upperColumn : Math.min(column, upperColumn);
  const nearestRow = fy <= 0.5 ? row : Math.min(grid.height - 1, upperRow);
  const nearest = nearestRow * grid.width + nearestColumn;
  if (nearest !== cache.nearest) { cache.nearest = nearest; cache.output = outputAt(mask, nearestColumn, nearestRow); }
  if (!cache.output) return;
  covered[index >> 3] |= 1 << (index & 7);
  lowerX[index] = column; lowerY[index] = row; fractionX[index] = fx; fractionY[index] = fy;
  const quad = row * grid.width + column;
  if (cache.quad !== quad) { cache.quad = quad; cache.contributed = 0; }
  const needed = (fx === 0 ? 5 : 15) & (fy === 0 ? 3 : 15), added = needed & ~cache.contributed;
  if (added & 1) contributorSet.add(quad);
  if (added & 2) contributorSet.add(row * grid.width + upperColumn);
  if (added & 4) contributorSet.add(upperRow * grid.width + column);
  if (added & 8) contributorSet.add(upperRow * grid.width + upperColumn);
  cache.contributed |= needed;
}

/** Locate one admitted geographic pair and record its covered cell, fractions and contributors. */
function prepareLocatedSample(
  grid: Grid,
  geometry: GridGeometry | null,
  mask: SamplingMask,
  lat: number,
  lon: number,
  index: number,
  lowerX: Uint32Array,
  lowerY: Uint32Array,
  fractionX: Float64Array,
  fractionY: Float64Array,
  covered: Uint8Array,
  contributorSet: Set<number>,
  cache: ReturnType<typeof locatedSampleCache>
): void {
  const located = locate(grid, geometry, lat, lon);
  if (!located) return;
  recordLocatedSample(grid, mask, located.column, located.row, located.fractionX, located.fractionY, index, lowerX, lowerY, fractionX, fractionY, covered, contributorSet, cache);
}

const RAD = Math.PI / 180;
const wrapRadians = (value: number) => ((value + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

/** Projected coordinates are not separable in grid space, but spherical Lambert rho(lat) and theta(lon) factor along the axes. */
function prepareProjectedSampling(mask: SamplingMask, latitudes: Float64Array, longitudes: Float64Array): PreparedGridSampling {
  const grid = mask.grid;
  if (grid.kind !== 'lambert-conformal') throw new RangeError('Projected sampling requires a Lambert grid');
  const width = longitudes.length, height = latitudes.length, total = width * height;
  const lowerX = new Uint32Array(total), lowerY = new Uint32Array(total);
  const fractionX = new Float64Array(total), fractionY = new Float64Array(total);
  const covered = new Uint8Array(Math.ceil(total / 8)), contributorSet = new Set<number>();
  const cache = locatedSampleCache();
  const p1 = grid.standardParallel1Deg * RAD, p2 = grid.standardParallel2Deg * RAD;
  const t1 = Math.tan(Math.PI / 4 + p1 / 2), t2 = Math.tan(Math.PI / 4 + p2 / 2);
  const n = Math.abs(p1 - p2) < 1e-14 ? Math.sin(p1) : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(t2 / t1);
  const f = Math.cos(p1) * t1 ** n / n;
  const rho0 = grid.earthRadiusM * f / Math.tan(Math.PI / 4 + grid.latitudeOfOriginDeg * RAD / 2) ** n;
  const sinTheta = new Float64Array(width), cosTheta = new Float64Array(width), allowedColumns = new Uint8Array(width);
  for (let x = 0; x < width; x++) {
    const lon = longitudes[x];
    if (!withinGeographicBounds(mask.bounds?.[1] ?? 0, lon, mask.bounds) || !Number.isFinite(lon)) continue;
    const theta = n * wrapRadians((lon - grid.centralMeridianDeg) * RAD);
    sinTheta[x] = Math.sin(theta);
    cosTheta[x] = Math.cos(theta);
    allowedColumns[x] = 1;
  }
  for (let y = 0; y < height; y++) {
    const lat = latitudes[y];
    if (!withinGeographicBounds(lat, mask.bounds?.[0] ?? 0, mask.bounds) || !Number.isFinite(lat) || Math.abs(lat) >= 90) continue;
    const rho = grid.earthRadiusM * f / Math.tan(Math.PI / 4 + lat * RAD / 2) ** n;
    if (!Number.isFinite(rho)) continue;
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) if (allowedColumns[x]) {
      const gx = snap((rho * sinTheta[x] - grid.x0M) / grid.dxM);
      const gy = snap((rho0 - rho * cosTheta[x] - grid.y0M) / grid.dyM);
      if (!Number.isFinite(gx) || !Number.isFinite(gy) || gx < 0 || gx > grid.width - 1 || gy < 0 || gy > grid.height - 1) continue;
      const column = Math.floor(gx), row = Math.floor(gy);
      recordLocatedSample(grid, mask, column, row, gx - column, gy - row, rowOffset + x, lowerX, lowerY, fractionX, fractionY, covered, contributorSet, cache);
    }
  }
  return preparedFromCells(mask, width, lowerX, lowerY, fractionX, fractionY, covered, contributorSet, grid.wrapLongitude);
}

/** One latitude/longitude pair per retained sample; coordinates outside the mask are skipped. */
export function preparePointSampling(mask: SamplingMask, latitudes: Float64Array, longitudes: Float64Array): PreparedGridSampling {
  const grid = mask.grid, total = latitudes.length;
  if (latitudes.length !== longitudes.length || total < 1 || total > MAX_PREPARED_SAMPLES) throw new RangeError('Prepared sampling coordinate budget exceeded');
  validateSamplingMask(mask);
  const geometry = lambertGeometry(grid);
  const lowerX = new Uint32Array(total), lowerY = new Uint32Array(total);
  const fractionX = new Float64Array(total), fractionY = new Float64Array(total);
  const covered = new Uint8Array(Math.ceil(total / 8)), contributorSet = new Set<number>();
  const cache = locatedSampleCache();
  for (let index = 0; index < total; index++) {
    if (!withinGeographicBounds(latitudes[index], longitudes[index], mask.bounds)) continue;
    prepareLocatedSample(grid, geometry, mask, latitudes[index], longitudes[index], index, lowerX, lowerY, fractionX, fractionY, covered, contributorSet, cache);
  }
  return preparedFromCells(mask, total, lowerX, lowerY, fractionX, fractionY, covered, contributorSet, grid.wrapLongitude);
}

function preparedFromCells(mask: SamplingMask, width: number, lowerX: Uint32Array, lowerY: Uint32Array, fractionX: Float64Array, fractionY: Float64Array, covered: Uint8Array, contributorSet: Set<number>, wrap: boolean): PreparedGridSampling {
  const grid = mask.grid, total = lowerX.length, contributors = Uint32Array.from(contributorSet);
  return {
    width, height: total / width, contributors,
    byteLength: total * (2 * Uint32Array.BYTES_PER_ELEMENT + 2 * Float64Array.BYTES_PER_ELEMENT) + covered.byteLength + contributors.byteLength,
    bind(field, layer, useStoredMslNoLift) {
      if (contributors.length) validateSamplingField(grid, field, mask);
      const scratch = reductionBuffer(4), spec = typeof layer === 'string' ? LAYERS[layer] : layer;
      const packed = 'coverage' in field;
      const quads = packed ? quadOffsets(field, grid.width) : undefined;
      return (x, y, out) => {
        const index = y * width + x;
        if (!(covered[index >> 3] & (1 << (index & 7)))) { out.value = null; out.status = STATUS_OUTSIDE; out.support = 0; out.interpolated = false; return; }
        const fx = fractionX[index], fy = fractionY[index];
        const column = lowerX[index], row = lowerY[index];
        const nextColumn = wrap && column + 1 === grid.width ? 0 : column + 1, nextRow = row + 1;
        let cachedQuad = -1;
        if (fx !== 0 && fy !== 0) {
          const r0 = row * grid.width, r1 = nextRow * grid.width;
          if (!packed) {
            if (reduceKnownQuad(field, r0 + column, r0 + nextColumn, r1 + column, r1 + nextColumn, fx, fy, spec, useStoredMslNoLift, out)) return;
          } else {
            const start = quads!.locate(r0, column, r1, nextColumn), offsets = quads!.offsets;
            cachedQuad = start;
            if (start >= 0 && reduceKnownQuad(field, offsets[start], offsets[start + 1], offsets[start + 2], offsets[start + 3], fx, fy, spec, useStoredMslNoLift, out)) return;
          }
        }
        let count = 0;
        for (const [dx, dy] of QUAD_OFFSETS) {
          if ((dx && fx === 0) || (dy && fy === 0)) continue;
          const sourceRow = dy === 0 ? row : nextRow, sourceColumn = dx === 0 ? column : nextColumn, source = sourceRow * grid.width + sourceColumn;
          const offset = cachedQuad >= 0 ? quads!.offsets[cachedQuad + count] : fieldOffset(field, source, grid.width);
          scratch.values[count] = field.values[offset]; scratch.flags[count] = field.flags[offset];
          scratch.weights[count] = (dy ? fy : 1 - fy) * (dx ? fx : 1 - fx);
          scratch.rows[count] = sourceRow; scratch.columns[count] = sourceColumn; count++;
        }
        reduceCells(scratch, count, spec, useStoredMslNoLift, out);
      };
    }
  };
}
