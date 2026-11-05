import {
  coverageIndices,
  LIFT_METHOD_PARAMETERS,
  prepareGridGeometry,
  type CoverageMask,
  type Grid,
  type ProductDefinition
} from '@av/contracts';
import { anyProjectedSampleInDaylight, createGridDaylightTester, prepareProjectedDaylightSamples } from '@av/solar/grid';

interface ResolveProductFrameHoursOptions {
  /** When false, returns all candidate product.frameHours without solar filtering. */
  readonly daylightOnly?: boolean;
  /** Minimum solar elevation angle in degrees considered daylight (default: -0.833°). */
  readonly minimumSolarElevationDeg?: number;
  /** Optional precomputed output cell indices from coverageIndices(mask).output. */
  readonly outputIndices?: Uint32Array;
}

export function buildIntervalDaylightTimestampsMs(
  startMs: number,
  endMs: number
): readonly number[] {
  if (!Number.isFinite(endMs)) {
    return [];
  }
  if (Number.isFinite(startMs) && startMs < endMs) {
    return [startMs, 0.5 * (startMs + endMs), endMs];
  }
  return [endMs];
}

export function createMaskDaylightTester(
  grid: Grid,
  timestampsMs: readonly number[],
  minimumSolarElevationDeg: number = LIFT_METHOD_PARAMETERS.minimumSolarElevationDeg
): (cellIndex: number) => boolean {
  if (timestampsMs.length === 0) {
    return () => true;
  }
  if (grid.kind === 'regular-latlon') {
    return createGridDaylightTester(grid, timestampsMs, minimumSolarElevationDeg);
  }
  const geom = prepareGridGeometry(grid);
  return createGridDaylightTester(
    {
      kind: 'projected',
      width: grid.width,
      height: grid.height,
      gridToGeographic: (col, row) => geom.gridToGeographic(col, row)
    },
    timestampsMs,
    minimumSolarElevationDeg
  );
}

/**
 * Resolve the published output forecast hours for a product and run cycle before acquisition.
 *
 * Driven declaratively by `product.capabilities.daylightFrames`:
 * - `'all-hours'`: publishes all configured `product.frameHours`.
 * - `'regional-daylight'`: omits forecast hours where zero output cells in the coverage mask
 *   are in daylight across the trailing interval `[start, midpoint, end]`.
 *
 * Overnight batch jobs still retain tomorrow's daytime forecast frames within the candidate
 * horizon, and adapters still fetch preceding-hour (`h - 1`) flux companions when needed.
 */
export function resolveProductFrameHours(
  product: Pick<ProductDefinition, 'frameHours' | 'intervalHours' | 'capabilities'>,
  mask: CoverageMask,
  cycle: string,
  options?: ResolveProductFrameHoursOptions
): number[] {
  const candidates = [...product.frameHours];
  const cycleMs = Date.parse(cycle);
  if (!Number.isFinite(cycleMs)) throw new Error('Invalid forecast cycle for daylight selection');
  if (options?.daylightOnly === false || product.capabilities.daylightFrames === 'all-hours') {
    return candidates;
  }

  const outputIndices = options?.outputIndices ?? coverageIndices(mask).output;
  if (outputIndices.length === 0) {
    return candidates;
  }

  const minimumSolarElevationDeg =
    options?.minimumSolarElevationDeg ?? LIFT_METHOD_PARAMETERS.minimumSolarElevationDeg;
  const geometry = mask.grid.kind === 'regular-latlon' ? undefined : prepareGridGeometry(mask.grid);
  const projected = geometry ? prepareProjectedDaylightSamples({
    kind: 'projected', width: mask.grid.width, height: mask.grid.height,
    gridToGeographic: (column, row) => geometry.gridToGeographic(column, row)
  }, outputIndices) : undefined;

  const selected: number[] = [];
  for (const hour of candidates) {
    const endMs = cycleMs + hour * 3_600_000;
    const startMs = cycleMs + (hour - product.intervalHours) * 3_600_000;
    const timestampsMs = buildIntervalDaylightTimestampsMs(startMs, endMs);
    let anyDaylight = false;
    if (projected) anyDaylight = anyProjectedSampleInDaylight(projected, timestampsMs, minimumSolarElevationDeg);
    else {
      const isDaylight = createMaskDaylightTester(mask.grid, timestampsMs, minimumSolarElevationDeg);
      for (let i = 0; i < outputIndices.length; i += 1) {
        if (isDaylight(outputIndices[i]!)) { anyDaylight = true; break; }
      }
    }
    if (anyDaylight) selected.push(hour);
  }

  return selected.length > 0 ? selected : candidates;
}
