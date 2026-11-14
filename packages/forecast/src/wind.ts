import { STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID } from '@av/contracts/layers';
import { WIND_CHUNK_LIMIT } from '@av/contracts/wind-data';
import type { NormalizedFrame } from './inputs.ts';
import { nearerContributor, sampleCells, type Cell, type SamplePlan } from './sampler.ts';

export type WindVector = { u: number; v: number };
type WindLevel = { height: number; wind: WindVector } | null;
interface WindColumn { surface: WindVector | null; levels: WindLevel[] }

const HEADER = 12, MAX_LEVELS = 256;

export function normalizedWindColumn(frame: NormalizedFrame, slot: number): WindColumn {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= frame.activeIndices.length) throw new RangeError('Invalid frame slot');
  const read = (field: { values: Float32Array; missing: Uint8Array } | undefined): number | null =>
    field && !field.missing[slot] && Number.isFinite(field.values[slot]) ? field.values[slot] : null;
  const pair = (u: number | null, v: number | null): WindVector | null => u === null || v === null ? null : { u, v };
  const terrain = frame.missing.terrain[slot] ? NaN : frame.terrainM[slot];
  const groundPressure = frame.missing.surfacePressure[slot] ? NaN : frame.surfacePressurePa[slot];
  const surface = pair(read(frame.auxSurface?.u10mMps), read(frame.auxSurface?.v10mMps));
  const groundValid = Number.isFinite(terrain) && Number.isFinite(groundPressure) && groundPressure > 0;
  const surfaceHeight = Math.fround(terrain + 10);
  let canAnchor = groundValid && surface !== null && surfaceHeight > terrain;
  // A spare slot retains every missing native interval when adding the 10 m anchor.
  const levels: WindLevel[] = [null];
  for (let i = 0; i < frame.hgtM.length; i++) {
    const height = frame.missing.hgt[i][slot] ? NaN : frame.hgtM[i][slot];
    const pressure = frame.pressurePa ? (frame.missing.pressure![i][slot] ? NaN : frame.pressurePa[i][slot]) : frame.pressureLevelsHpa![i] * 100;
    const wind = pair(read(frame.auxLevels?.uWindMps?.[i]), read(frame.auxLevels?.vWindMps?.[i]));
    const level = groundValid && Number.isFinite(pressure) && pressure > 0 && pressure < groundPressure && Number.isFinite(height) && height > terrain && wind ? { height, wind } : null;
    levels.push(level);
    if (canAnchor && !((Number.isFinite(pressure) && pressure >= groundPressure) || (Number.isFinite(height) && height <= terrain))) {
      if (level && surfaceHeight < height) levels[i] = { height: surfaceHeight, wind: surface! };
      canAnchor = false;
    }
  }
  return { surface, levels };
}

export function encodeWindColumns(columns: readonly (WindColumn | null)[], levelCount?: number): Uint8Array {
  const levels = columns.find(column => column !== null)?.levels.length ?? levelCount;
  if (!columns.length || levels === undefined || levels < 1 || levels > MAX_LEVELS || columns.some(column => column && column.levels.length !== levels)) throw new RangeError('Invalid wind dimensions');
  const length = HEADER + columns.length * (9 + 13 * levels);
  if (!Number.isSafeInteger(length) || length > WIND_CHUNK_LIMIT) throw new RangeError('Wind chunk exceeds byte budget');
  const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x32444e57, true); view.setUint16(4, 1, true); view.setUint16(6, levels, true); view.setUint32(8, columns.length, true);
  let offset = HEADER;
  const write = (wind: WindVector | null, status: number) => {
    if (wind) {
      if (!Number.isFinite(wind.u) || !Number.isFinite(wind.v) || !Number.isFinite(Math.fround(wind.u)) || !Number.isFinite(Math.fround(wind.v))) throw new RangeError('Invalid wind vector');
      view.setFloat32(offset, wind.u, true); view.setFloat32(offset + 4, wind.v, true);
    }
    view.setUint8(offset + 8, status); offset += 9;
  };
  for (const column of columns) {
    write(column?.surface ?? null, column ? column.surface ? STATUS_VALID : STATUS_UNAVAILABLE : STATUS_OUTSIDE);
    let previous = -Infinity;
    for (let i = 0; i < levels; i++) {
      const level = column?.levels[i];
      if (level) {
        const height = Math.fround(level.height);
        if (!Number.isFinite(height) || height <= previous) throw new RangeError('Invalid wind heights');
        view.setFloat32(offset, height, true); previous = height;
      }
      offset += 4;
      write(level?.wind ?? null, column ? level ? STATUS_VALID : STATUS_UNAVAILABLE : STATUS_OUTSIDE);
    }
  }
  return bytes;
}

export interface PackedWindChunk { view: DataView; count: number; levels: number }

export function decodePackedWindChunk(bytes: Uint8Array): PackedWindChunk {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEADER || bytes.byteLength > WIND_CHUNK_LIMIT) throw new RangeError('Invalid wind chunk length');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), levels = view.getUint16(6, true), count = view.getUint32(8, true);
  if (view.getUint32(0, true) !== 0x32444e57 || view.getUint16(4, true) !== 1 || levels < 1 || levels > MAX_LEVELS || count < 1 || HEADER + count * (9 + 13 * levels) !== bytes.byteLength) throw new RangeError('Invalid wind chunk header');
  let offset = HEADER;
  const validateVector = (): number => {
    const u = view.getFloat32(offset, true), v = view.getFloat32(offset + 4, true), status = view.getUint8(offset + 8); offset += 9;
    if ((status !== STATUS_VALID && status !== STATUS_UNAVAILABLE && status !== STATUS_OUTSIDE) || !Number.isFinite(u) || !Number.isFinite(v) || (status !== STATUS_VALID && (u !== 0 || v !== 0))) throw new RangeError('Invalid wind status or vector');
    return status;
  };
  for (let i = 0; i < count; i++) {
    const surface = validateVector();
    let previous = -Infinity;
    for (let j = 0; j < levels; j++) {
      const height = view.getFloat32(offset, true); offset += 4;
      const status = validateVector();
      if ((surface === STATUS_OUTSIDE) !== (status === STATUS_OUTSIDE) || !Number.isFinite(height) || (status !== STATUS_VALID && height !== 0) || (status === STATUS_VALID && height <= previous)) throw new RangeError('Invalid wind level');
      if (status === STATUS_VALID) previous = height;
    }
  }
  return { view, count, levels };
}

export function samplePackedWindColumns(plan: SamplePlan, chunks: readonly (PackedWindChunk | undefined)[], offsets: ArrayLike<number>, height: number | 'surface') {
  if (!plan.contributors.length || chunks.length !== plan.contributors.length || offsets.length !== chunks.length) throw new RangeError('Column count does not match plan');
  let u = 0, v = 0, validWeight = 0, validCount = 0, missing = false, nearest = 0, nearestStatus = STATUS_OUTSIDE, nearestU = 0, nearestV = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i], c = plan.contributors[i], best = plan.contributors[nearest];
    if (!chunk || offsets[i] < 0 || offsets[i] >= chunk.count) throw new RangeError('Column outside wind chunk');
    const view = chunk.view, start = HEADER + offsets[i] * (9 + 13 * chunk.levels), surfaceStatus = view.getUint8(start + 8);
    let status = surfaceStatus === STATUS_OUTSIDE ? STATUS_OUTSIDE : STATUS_UNAVAILABLE, cu = 0, cv = 0, underground = false;
    if (height === 'surface') {
      if ((status = surfaceStatus) === STATUS_VALID) { cu = view.getFloat32(start, true); cv = view.getFloat32(start + 4, true); }
    } else if (surfaceStatus !== STATUS_OUTSIDE && Number.isFinite(height)) {
      for (let j = 0, first = true; j < chunk.levels; j++) {
        const pos = start + 9 + j * 13;
        if (view.getUint8(pos + 12) !== STATUS_VALID) continue;
        const h0 = view.getFloat32(pos, true), a = view.getFloat32(pos + 4, true), b = view.getFloat32(pos + 8, true);
        const nextValid = j + 1 < chunk.levels && view.getUint8(pos + 25) === STATUS_VALID;
        if (first) {
          first = false;
          if (height < h0) {
            underground = surfaceStatus === STATUS_VALID && (j <= 1 || (nextValid && a === view.getFloat32(start, true) && b === view.getFloat32(start + 4, true)));
            break;
          }
        }
        if (height === h0) { status = STATUS_VALID; cu = a; cv = b; break; }
        if (nextValid) {
          const h1 = view.getFloat32(pos + 13, true);
          if (h0 < height && height < h1) {
            const t = (height - h0) / (h1 - h0);
            status = STATUS_VALID; cu = a + t * (view.getFloat32(pos + 17, true) - a); cv = b + t * (view.getFloat32(pos + 21, true) - b); break;
          }
        }
      }
    }
    if (status === STATUS_VALID) { if (c.weight > 0) { u += cu * c.weight; v += cv * c.weight; validWeight += c.weight; validCount++; } }
    else if (!underground) missing = true;
    if (i === 0 || nearerContributor(c.weight, c.row, c.column, best.weight, best.row, best.column)) {
      nearest = i; nearestStatus = status; nearestU = cu; nearestV = cv;
    }
  }
  if (missing || !validCount || validWeight <= 0) return { u: nearestStatus === STATUS_VALID ? nearestU : null, v: nearestStatus === STATUS_VALID ? nearestV : null, status: nearestStatus, interpolated: false };
  const s = validCount === chunks.length ? 1 : 1 / validWeight;
  return { u: u * s, v: v * s, status: STATUS_VALID, interpolated: validCount > 1 };
}

const TERRAIN_SAMPLE_SPEC = {
  supportsNoLift: false, noLiftSampleValue: null, supportsLiftFlags: false, zeroOnNoLiftInterpolation: false
} as const;

export function windTargetHeight(plan: SamplePlan, cells: readonly Cell[], mode: { agl: number } | { lift: true }, useStoredMslNoLift: boolean) {
  if ('lift' in mode) return sampleCells(plan, cells, 'usable-lift-msl', useStoredMslNoLift);
  if (!Number.isFinite(mode.agl) || mode.agl < 0) throw new RangeError('Invalid AGL height');
  const terrain = sampleCells(plan, cells, TERRAIN_SAMPLE_SPEC, false);
  return { ...terrain, value: terrain.value === null ? null : terrain.value + mode.agl };
}
