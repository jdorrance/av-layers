import { CELL_BYTES, coverageIndices, expectedTiles, GFS_PRODUCT, MAX_RETAINED_BUILDS, MAX_SAMPLE_RANGE_BYTES, MAX_SAMPLE_VALUES, RETENTION_DAYS, SAMPLE_BLOCK_SIZE, type CoverageMask, type Manifest, type ProductDefinition } from '@av/contracts';
import { prepareSamplePackLayout } from '@av/forecast';

/** Admission budgets, not predictions about an unknown runner or upstream service. */
export const BUILD_BUDGETS = {
  gridCells: 4_000_000,
  tiles: 100_000,
  samplePackBytes: 256 * 1024 * 1024,
  elapsedMs: 20 * 60_000,
  peakRssBytes: 2 * 1024 ** 3
} as const;

export interface CapacityScenario {
  frames?: number;
  layers?: number;
  models?: number;
  nativeZoom?: number;
  cadenceHours?: number;
  retentionDays?: number;
}

/** Project deeper levels conservatively; exact coverage must be regenerated before admission. */
export function estimateCapacity(mask: CoverageMask, product: ProductDefinition, storedCells: number, scenario: CapacityScenario = {}) {
  const frames = scenario.frames ?? product.frameHours.length, layers = scenario.layers ?? product.layers.length;
  const models = scenario.models ?? 1, nativeZoom = scenario.nativeZoom ?? product.maxNativeZoom;
  const cadenceHours = scenario.cadenceHours ?? 12, retentionDays = scenario.retentionDays ?? RETENTION_DAYS;
  if ([frames, layers, models, nativeZoom].some(n => !Number.isSafeInteger(n)) || frames < 1 || layers < 1 || models < 1 || nativeZoom < 0 || nativeZoom > 24 || !Number.isFinite(cadenceHours) || cadenceHours <= 0 || !Number.isFinite(retentionDays) || retentionDays <= 0) throw new RangeError('Invalid capacity scenario');
  if (mask.maxZoom > product.maxNativeZoom || mask.maxZoom > 8) throw new Error('Coverage exceeds the admitted native zoom');
  const tilesByZoom = Array.from({ length: nativeZoom + 1 }, (_, z) => z <= mask.maxZoom
    ? expectedTiles(mask, z).length
    : expectedTiles(mask, mask.maxZoom).length * 4 ** (z - mask.maxZoom));
  const channels = frames * layers, tiles = tilesByZoom.reduce((sum, n) => sum + n, 0) * channels * models;
  const samplePackBytes = storedCells * channels * CELL_BYTES;
  const retainedPerModel = Math.ceil(retentionDays * 24 / cadenceHours);
  // A two-by-two neighborhood spans at most B + 3 cell records in a (B + 1)-wide block.
  const pointRangeBytes = (SAMPLE_BLOCK_SIZE + 3) * channels * CELL_BYTES;
  const violations: string[] = [];
  if (nativeZoom > product.maxNativeZoom) violations.push('native zoom exceeds the trusted product; regenerate coverage and prove a benefit before raising it');
  if (mask.grid.width * mask.grid.height > BUILD_BUDGETS.gridCells) violations.push('grid-cell budget exceeded');
  if (!Number.isSafeInteger(tiles) || tiles > BUILD_BUDGETS.tiles) violations.push('tile budget exceeded');
  if (!Number.isSafeInteger(samplePackBytes) || samplePackBytes > BUILD_BUDGETS.samplePackBytes) violations.push('sample-pack budget exceeded');
  if (channels > MAX_SAMPLE_VALUES) violations.push('all-frame point response exceeds the result budget; define bounded products before adding channels');
  if (pointRangeBytes > MAX_SAMPLE_RANGE_BYTES) violations.push('point range exceeds the byte budget');
  if (retainedPerModel >= MAX_RETAINED_BUILDS) violations.push('retention leaves no room for a replacement build');
  return {
    frames, layers, models, nativeZoom, cadenceHours, retentionDays, channels, tilesByZoom, tiles,
    quarterSamples: tiles * 256 * 256 * 4,
    samplePackBytes, totalSamplePackBytes: samplePackBytes * models,
    point: { reads: 1, worstCaseRangeBytes: pointRangeBytes, values: channels },
    retainedPerModel, retainedSampleBytes: retainedPerModel * samplePackBytes * models,
    archiveObjectsPerBuild: channels * models,
    bounds: { projectedZooms: nativeZoom > mask.maxZoom, excludesArchiveBytes: true },
    budgets: BUILD_BUDGETS, violations
  };
}

/** Prepare reusable geometry/counts and reject resource growth before acquiring weather. */
export function prepareBuild(mask: CoverageMask, product: ProductDefinition = GFS_PRODUCT) {
  if (mask.maxZoom !== product.maxNativeZoom || JSON.stringify(mask.grid) !== JSON.stringify(product.grid)) throw new Error('Coverage does not match the trusted product');
  if (mask.grid.width * mask.grid.height > BUILD_BUDGETS.gridCells) throw new Error('Grid-cell budget exceeded');
  const indices = coverageIndices(mask), layout = prepareSamplePackLayout(mask.grid, mask.output, mask.halo);
  const capacity = estimateCapacity(mask, product, layout.storedCells);
  if (capacity.violations.length) throw new Error(`Build exceeds capacity: ${capacity.violations.join('; ')}`);
  return { indices, layout, capacity };
}

/** Gate recorded build metrics against the same budgets used by build admission. */
export function checkPerformance(manifest: Manifest) {
  const failures: string[] = [];
  const metric = (key: string): number => {
    const value = manifest.metrics[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) { failures.push(`missing or invalid ${key}`); return NaN; }
    return value;
  };
  const elapsedMs = metric('elapsedMs'), peakRssBytes = metric('peakRssBytes');
  const counts = manifest.metrics.tiles;
  const validCounts = Array.isArray(counts) && counts.length === manifest.coverage.maxZoom + 1 && counts.every(n => Number.isSafeInteger(n) && n >= 0);
  if (!validCounts) failures.push('missing or invalid tile counts');
  const tiles = validCounts ? counts.reduce((sum: number, count: number) => sum + count, 0) * manifest.artifacts.length : NaN;
  const observed = { elapsedMs, peakRssBytes, tiles, samplePackBytes: manifest.samples.bytes, gridCells: manifest.grid.width * manifest.grid.height };
  for (const key of Object.keys(BUILD_BUDGETS) as (keyof typeof BUILD_BUDGETS)[]) {
    if (observed[key] > BUILD_BUDGETS[key]) failures.push(`${key}: ${observed[key]} exceeds ${BUILD_BUDGETS[key]}`);
  }
  return { version: 1, buildId: manifest.buildId, cycle: manifest.cycle, observed, budgets: BUILD_BUDGETS, passed: failures.length === 0, failures };
}
