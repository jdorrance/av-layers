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
import { planSample, type GridField } from './sampler.js';

export interface PreparedTerrainClearance {
  /** Retained mapping arrays only; each derived field owns another five bytes per target cell. */
  readonly byteLength: number;
  derive(
    sourceMsl: GridField,
    terrain: { elevationM: Float32Array; valid: Uint8Array },
    time: { intervalStart: string; validTime: string },
    daylightOnly?: boolean
  ): GridField;
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
  const indices = new Uint32Array(activeCount * 4), weights = new Float64Array(activeCount * 4);
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
      const offset = slot * 4 + count++;
      indices[offset] = contributor.index;
      weights[offset] = contributor.weight;
    }
    if (complete) counts[slot] = count;
  }

  return {
    byteLength: targets.byteLength + counts.byteLength + indices.byteLength + weights.byteLength,
    derive(sourceMsl, terrain, time, daylightOnly = true) {
      if (!(sourceMsl.values instanceof Float32Array) || !(sourceMsl.flags instanceof Uint8Array)
          || sourceMsl.values.length !== source.cells || sourceMsl.flags.length !== source.cells
          || !(terrain.elevationM instanceof Float32Array) || !(terrain.valid instanceof Uint8Array)
          || terrain.elevationM.length !== target.cells || terrain.valid.length !== target.cells) {
        throw new RangeError('Terrain clearance input size or type differs from grid');
      }
      const timestamps = daylightOnly
        ? buildIntervalDaylightTimestampsMs(Date.parse(time.intervalStart), Date.parse(time.validTime))
        : [];
      const isDaylight = createMaskDaylightTester(target.grid, timestamps);
      const values = new Float32Array(target.cells), flags = new Uint8Array(target.cells).fill(STATUS_OUTSIDE);
      for (let slot = 0; slot < targets.length; slot++) {
        const index = targets[slot], elevation = terrain.elevationM[index], count = counts[slot];
        values[index] = NaN;
        flags[index] = STATUS_UNAVAILABLE;
        if (!count || terrain.valid[index] !== 1 || !Number.isFinite(elevation)) continue;
        if (!isDaylight(index)) {
          values[index] = 0;
          flags[index] = STATUS_NO_LIFT;
          continue;
        }
        let status = -1, support = 0, ceiling = 0, complete = true;
        for (let contributor = 0; contributor < count; contributor++) {
          const offset = slot * 4 + contributor, sourceIndex = indices[offset];
          const flag = sourceMsl.flags[sourceIndex], nextStatus = flag & STATUS_MASK;
          const value = sourceMsl.values[sourceIndex];
          if (nextStatus >= STATUS_UNAVAILABLE || (flag & ~(STATUS_MASK | SUPPORT_MASK)) !== 0
              || !Number.isFinite(value) || (status !== -1 && status !== nextStatus)) {
            complete = false;
            break;
          }
          status = nextStatus;
          support |= flag & SUPPORT_MASK;
          ceiling += value * weights[offset];
        }
        if (!complete) continue;
        const clearance = Math.fround(status === STATUS_NO_LIFT ? 0 : Math.max(0, ceiling - elevation));
        // Float32 output must remain finite even for finite but physically invalid input magnitudes.
        if (!Number.isFinite(clearance)) continue;
        values[index] = clearance;
        flags[index] = (clearance > 0 ? STATUS_VALID : STATUS_NO_LIFT) | support;
      }
      return { values, flags };
    }
  };
}
