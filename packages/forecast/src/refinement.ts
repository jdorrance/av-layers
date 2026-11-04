import {
  getBit,
  gridSchema,
  MAX_GRID_CELLS,
  prepareGridGeometry,
  STATUS_MASK,
  STATUS_NO_LIFT,
  STATUS_OUTSIDE,
  STATUS_UNAVAILABLE,
  STATUS_VALID,
  SUPPORT_MASK,
  type CoverageMask
} from '@av/contracts';
import { buildIntervalDaylightTimestampsMs, createMaskDaylightTester } from './daylight.js';
import { usableLiftDepthM } from '@av/soaring/velocity';
import { FRAME_BRANCH, type FrameDiagnostics } from './frame.js';
import { planSample, type GridField } from './sampler.js';
export { prepareTerrainColumns, terrainColumnCapacity, terrainColumnDaylightBufferBytes } from './terrain-column.js';
export type { PreparedTerrainColumns, TerrainColumnDerivation, TerrainColumnMetrics, TerrainColumnProbe, TerrainColumnEvaluationOptions, TerrainColumnClearance } from './terrain-column.js';

const CONTRIBUTORS_PER_CELL = 4;

/** Retained native contributor mapping; excludes terrain and derived output arrays. */
export function terrainClearanceMappingBytes(activeCells: number): number {
  if (!Number.isSafeInteger(activeCells) || activeCells < 0 || activeCells > MAX_GRID_CELLS) {
    throw new RangeError('Terrain clearance active cell budget exceeded');
  }
  return activeCells * (Uint32Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT
    + CONTRIBUTORS_PER_CELL * (Uint32Array.BYTES_PER_ELEMENT + Float64Array.BYTES_PER_ELEMENT));
}

export interface TerrainClearanceFields {
  readonly 'usable-lift-msl': GridField;
  readonly 'usable-lift-agl': GridField;
}

export interface PreparedTerrainClearance {
  /** Retained mapping arrays only; each derived field owns another five bytes per target cell. */
  readonly byteLength: number;
  derive(
    diagnostics: FrameDiagnostics,
    sourceFlags: Uint8Array,
    terrain: { elevationM: Float32Array; valid: Uint8Array },
    time: { intervalStart: string; validTime: string },
    daylightOnly?: boolean
  ): TerrainClearanceFields;
}

function admitMask(mask: CoverageMask) {
  const grid = gridSchema.parse(mask.grid), cells = grid.width * grid.height;
  const bytes = Math.ceil(cells / 8);
  if (cells > MAX_GRID_CELLS) throw new RangeError('Terrain clearance grid budget exceeded');
  if (!(mask.output instanceof Uint8Array) || !(mask.halo instanceof Uint8Array)
      || mask.output.length !== bytes || mask.halo.length !== bytes) {
    throw new RangeError('Terrain clearance coverage size differs from grid');
  }
  return { grid, cells };
}

/** Compile native contributors once. Masks and geometry are captured, weather and DEM arrays are not. */
export function prepareTerrainClearance(sourceMask: CoverageMask, targetMask: CoverageMask): PreparedTerrainClearance {
  const source = admitMask(sourceMask), target = admitMask(targetMask);
  let activeCount = 0;
  for (let index = 0; index < target.cells; index++) {
    if (getBit(targetMask.output, index) || getBit(targetMask.halo, index)) activeCount++;
  }
  const targets = new Uint32Array(activeCount), counts = new Uint8Array(activeCount);
  const indices = new Uint32Array(activeCount * CONTRIBUTORS_PER_CELL), weights = new Float64Array(activeCount * CONTRIBUTORS_PER_CELL);
  const geometry = prepareGridGeometry(target.grid);
  let active = 0;
  for (let index = 0; index < target.cells; index++) {
    if (!getBit(targetMask.output, index) && !getBit(targetMask.halo, index)) continue;
    const slot = active++;
    targets[slot] = index;
    const point = geometry.gridToGeographic(index % target.grid.width, Math.floor(index / target.grid.width));
    const plan = point && planSample(source.grid, point.lat, point.lon);
    if (!plan) continue;
    let count = 0, complete = true;
    for (const contributor of plan.contributors) {
      if (contributor.weight <= 0) continue;
      if (!getBit(sourceMask.output, contributor.index) && !getBit(sourceMask.halo, contributor.index)) {
        complete = false;
        break;
      }
      const offset = slot * CONTRIBUTORS_PER_CELL + count++;
      indices[offset] = contributor.index;
      weights[offset] = contributor.weight;
    }
    if (complete) counts[slot] = count;
  }

  return {
    byteLength: terrainClearanceMappingBytes(activeCount),
    derive(diagnostics, sourceFlags, terrain, time, daylightOnly = true) {
      if (!(diagnostics.ceilingMslM instanceof Float32Array) || !(diagnostics.buoyancyM2S3 instanceof Float32Array)
          || !(diagnostics.branch instanceof Uint8Array) || !(sourceFlags instanceof Uint8Array)
          || diagnostics.ceilingMslM.length !== source.cells || diagnostics.buoyancyM2S3.length !== source.cells
          || diagnostics.branch.length !== source.cells || sourceFlags.length !== source.cells
          || !(terrain.elevationM instanceof Float32Array) || !(terrain.valid instanceof Uint8Array)
          || terrain.elevationM.length !== target.cells || terrain.valid.length !== target.cells) {
        throw new RangeError('Terrain clearance input size or type differs from grid');
      }
      let timestamps: readonly number[] = [];
      if (daylightOnly) {
        const startMs = Date.parse(time.intervalStart), endMs = Date.parse(time.validTime);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
          throw new RangeError('Terrain clearance requires a valid daylight interval');
        }
        timestamps = buildIntervalDaylightTimestampsMs(startMs, endMs);
      }
      const isDaylight = createMaskDaylightTester(target.grid, timestamps);
      const mslValues = new Float32Array(target.cells), mslFlags = new Uint8Array(target.cells).fill(STATUS_OUTSIDE);
      const aglValues = new Float32Array(target.cells), aglFlags = new Uint8Array(target.cells).fill(STATUS_OUTSIDE);
      for (let slot = 0; slot < targets.length; slot++) {
        const index = targets[slot], elevation = terrain.elevationM[index], count = counts[slot];
        mslValues[index] = NaN; aglValues[index] = NaN;
        mslFlags[index] = STATUS_UNAVAILABLE; aglFlags[index] = STATUS_UNAVAILABLE;
        if (!count || terrain.valid[index] !== 1 || !Number.isFinite(elevation)) continue;
        if (!isDaylight(index)) {
          mslValues[index] = elevation; aglValues[index] = 0;
          mslFlags[index] = STATUS_NO_LIFT; aglFlags[index] = STATUS_NO_LIFT;
          continue;
        }
        let support = 0, ceiling = 0, buoyancy = 0, complete = true, branches = 0;
        for (let contributor = 0; contributor < count; contributor++) {
          const offset = slot * CONTRIBUTORS_PER_CELL + contributor, sourceIndex = indices[offset];
          const flag = sourceFlags[sourceIndex], nextStatus = flag & STATUS_MASK;
          const value = diagnostics.ceilingMslM[sourceIndex], b = diagnostics.buoyancyM2S3[sourceIndex];
          const branch = diagnostics.branch[sourceIndex];
          const zeroDepth = branch === FRAME_BRANCH.nonConvective || branch === FRAME_BRANCH.surfaceStable;
          const convective = branch === FRAME_BRANCH.parcelCrossing || branch === FRAME_BRANCH.profileTop;
          if (nextStatus >= STATUS_UNAVAILABLE || (flag & ~(STATUS_MASK | SUPPORT_MASK)) !== 0
              || (!zeroDepth && !convective) || (zeroDepth && (nextStatus !== STATUS_NO_LIFT || b !== 0))
              || !Number.isFinite(value) || !Number.isFinite(b) || b < 0) {
            complete = false;
            break;
          }
          branches |= zeroDepth ? 1 : 2;
          support |= flag & SUPPORT_MASK;
          ceiling += value * weights[offset];
          buoyancy += b * weights[offset];
        }
        if (!complete || branches === 3) continue;
        if (branches === 1) {
          mslValues[index] = elevation; aglValues[index] = 0;
          mslFlags[index] = STATUS_NO_LIFT | support; aglFlags[index] = STATUS_NO_LIFT | support;
          continue;
        }
        const depth = Math.max(0, ceiling - elevation);
        const velocity = Math.cbrt(buoyancy * depth);
        if (!Number.isFinite(depth) || !Number.isFinite(velocity)) continue;
        const clearance = Math.fround(usableLiftDepthM(depth, velocity) ?? 0);
        const msl = Math.fround(elevation + clearance);
        if (!Number.isFinite(clearance) || !Number.isFinite(msl)) continue;
        const flags = (clearance > 0 ? STATUS_VALID : STATUS_NO_LIFT) | support;
        aglValues[index] = clearance; aglFlags[index] = flags;
        mslValues[index] = msl; mslFlags[index] = flags;
      }
      return {
        'usable-lift-msl': { values: mslValues, flags: mslFlags },
        'usable-lift-agl': { values: aglValues, flags: aglFlags }
      };
    }
  };
}
