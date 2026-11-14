import { CELL_BYTES, forecastStartsPerDay, LAYERS, MAX_GRID_CELLS, MAX_RETAINED_BUILDS, sameGrid, RETENTION_DAYS, type CoverageMask, type ManifestV5, type ProductDefinition } from '@av/contracts';

/** Admission budgets, not predictions about an unknown runner or upstream service. */
export const BUILD_BUDGETS = {
  gridCells: MAX_GRID_CELLS,
  tiles: 5_000_000,
  samplePackBytes: 256 * 1024 * 1024,
  numericBytes: 64 * 1024 ** 3,
  elapsedMs: 180 * 60_000,
  workingSetBytes: 2 * 1024 ** 3,
  peakRssBytes: 4 * 1024 ** 3
} as const;

export const LEGACY_FORECAST_ELAPSED_MS = 90 * 60_000;
export const MAX_BUILD_LIFETIME_MS = 6 * 3_600_000;

export function forecastPlanDeadline(plan: { createdAt: string; deadlineAt?: string }): number {
  return plan.deadlineAt === undefined ? Date.parse(plan.createdAt) + LEGACY_FORECAST_ELAPSED_MS : Date.parse(plan.deadlineAt);
}

export function isForecastPlanDeadline(createdAt: string, deadline: number): boolean {
  const elapsed = deadline - Date.parse(createdAt);
  return elapsed === BUILD_BUDGETS.elapsedMs || elapsed === LEGACY_FORECAST_ELAPSED_MS;
}
export const MAX_V5_SHARD_BYTES = 64 * 1024 * 1024;
// Worst-case 40-frame GFS group receipt fits within 8,192 object entries (<= 127 numeric objects/frame dense, ~35/frame sparse).
export const MAX_FORECAST_RECEIPT_ENTRIES = 8192;

interface FrameResources { maxLevels: number; auxiliarySurfaceFields?: number; auxiliaryLevelFields?: number }
export function normalizedFrameBytes(activeCells: number, verticalCoordinate: ProductDefinition['capabilities']['verticalCoordinate'], resources: FrameResources): number {
  const { maxLevels, auxiliarySurfaceFields = 0, auxiliaryLevelFields = 0 } = resources;
  if (!Number.isSafeInteger(activeCells) || activeCells < 0 || !Number.isSafeInteger(maxLevels) || maxLevels < 1 || maxLevels > 256
      || ![auxiliarySurfaceFields, auxiliaryLevelFields].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 32)) throw new RangeError('Invalid normalized frame dimensions');
  const fieldsPerLevel = (verticalCoordinate === 'model-levels' ? 3 : 2) + auxiliaryLevelFields;
  const bytes = activeCells * (7 + auxiliarySurfaceFields + fieldsPerLevel * maxLevels) * CELL_BYTES;
  if (!Number.isSafeInteger(bytes)) throw new RangeError('Unsafe normalized frame bytes');
  return bytes;
}

interface RetentionScenario { cadenceHours?: number; retentionDays?: number; expectedRunsPerDay?: number }

/** Project retained builds from configured starts or an operator's interval. */
export function estimateRetention(schedule: readonly string[], { cadenceHours, retentionDays = RETENTION_DAYS, expectedRunsPerDay }: RetentionScenario = {}) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0 ||
    (cadenceHours !== undefined && (!Number.isFinite(cadenceHours) || cadenceHours <= 0))) throw new RangeError('Invalid capacity scenario');
  const runsPerDay = cadenceHours !== undefined ? 0 : schedule.length ? forecastStartsPerDay(schedule) : expectedRunsPerDay ?? 0;
  if (cadenceHours === undefined && (!Number.isSafeInteger(runsPerDay) || runsPerDay <= 0)) throw new RangeError('Retention requires positive runs per day');
  const retainedPerModel = cadenceHours === undefined
    ? Math.ceil(retentionDays) * runsPerDay
    : Math.ceil(retentionDays * 24 / cadenceHours);
  if (!Number.isSafeInteger(retainedPerModel)) throw new RangeError('Invalid capacity scenario');
  return {
    cadenceHours: cadenceHours ?? 24 / runsPerDay, retentionDays,
    retainedPerModel, retentionBasis: cadenceHours !== undefined ? 'cadence-override' : schedule.length ? 'schedule' : 'expected-runs',
    violations: retainedPerModel >= MAX_RETAINED_BUILDS ? ['retention leaves no room for a replacement build'] : []
  };
}

export function assertForecastInputs(mask: CoverageMask, product: ProductDefinition): void {
  if (!Array.isArray(product.layers) || !product.layers.length || new Set(product.layers).size !== product.layers.length || product.layers.some(layer => !Object.hasOwn(LAYERS, layer))) throw new Error('Product requires unique implemented scalar layers');
  if (!Array.isArray(product.frameHours) || !product.frameHours.length || product.frameHours.some((hour, index) => !Number.isSafeInteger(hour) || (index > 0 && hour <= product.frameHours[index - 1]))) throw new Error('Product requires strictly ascending integer frame hours');
  if (!Number.isFinite(product.intervalHours) || product.intervalHours <= 0 || product.intervalHours > product.frameHours[0]) throw new Error('Product interval must be positive and not exceed its first frame');
  if (mask.maxZoom < product.maxNativeZoom || !sameGrid(mask.grid, product.grid)) throw new Error('Coverage does not match the trusted product');
  if (!mask.output.some(Boolean)) throw new Error('Coverage must contain output and active cells before acquisition');
  if (mask.grid.width * mask.grid.height > BUILD_BUDGETS.gridCells) throw new Error('Grid-cell budget exceeded');
}

function rendererTileCount(renderer: unknown): number {
  if (!renderer || typeof renderer !== 'object' || Array.isArray(renderer)) return NaN;
  const shards = 'shards' in renderer ? renderer.shards : [renderer];
  if (!Array.isArray(shards) || !shards.length) return NaN;
  let total = 0;
  for (const shard of shards) {
    if (!shard || typeof shard !== 'object' || Array.isArray(shard)) return NaN;
    for (const kind of ['native', 'fine'] as const) {
      const surface = shard[kind];
      if (!surface || typeof surface !== 'object' || Array.isArray(surface) || !Number.isSafeInteger(surface.tiles) || surface.tiles < 0) return NaN;
      total += surface.tiles;
    }
  }
  return Number.isSafeInteger(total) ? total : NaN;
}

/** Check observed build resources before publication. */
export function checkPerformance(manifest: ManifestV5) {
  const failures: string[] = [];
  const metric = (key: string): number => {
    const value = manifest.metrics[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) { failures.push(`missing or invalid ${key}`); return NaN; }
    return value;
  };
  const elapsedMs = metric('elapsedMs'), peakRssBytes = metric('peakRssBytes');
  const counts = manifest.metrics.tiles;
  const maxZoom = Math.max(...manifest.surfaces.map(surface => surface.coverage.maxZoom));
  const validCounts = Array.isArray(counts) && counts.length === maxZoom + 1 && counts.every(n => Number.isSafeInteger(n) && n >= 0);
  let tiles: number;
  if (manifest.metrics.renderer !== undefined) {
    tiles = rendererTileCount(manifest.metrics.renderer);
    if (!Number.isSafeInteger(tiles) || tiles < manifest.artifacts.length) failures.push('missing or invalid renderer tile counts');
    const capacity = manifest.metrics.capacity;
    if (capacity && typeof capacity === 'object' && 'tiles' in capacity &&
        (!Number.isSafeInteger(capacity.tiles) || capacity.tiles !== tiles)) failures.push('rendered tile count differs from admitted coverage');
  } else {
    // Older single-surface v5 records share one coverage mask across every archive.
    if (!validCounts || manifest.surfaces.length !== 1) failures.push('missing or invalid tile counts');
    tiles = validCounts ? counts.reduce((sum: number, count: number) => sum + count, 0) * manifest.artifacts.length : NaN;
    if (!Number.isSafeInteger(tiles)) failures.push('unsafe tile count');
  }
  let samplePackBytes = 0, emittedSampleBytes = 0, profileBytes = 0, gridCells = 0, fineGridCells = 0;
  for (const surface of manifest.surfaces) {
    const cells = surface.grid.width * surface.grid.height;
    if (surface.kind === 'native') gridCells += cells;
    else fineGridCells += cells;
    const shardBytes = surface.samples.storedCells * surface.samples.channelCount * CELL_BYTES;
    if (!Number.isSafeInteger(shardBytes) || !Number.isSafeInteger(surface.samples.storedCells) || !Number.isSafeInteger(surface.samples.channelCount)) failures.push('unsafe v5 sample size');
    for (const shard of surface.samples.shards) {
      const channels = 'frameCount' in shard ? shard.frameCount * surface.layers.length : surface.samples.channelCount;
      const bytes = shard.storedCells * channels * CELL_BYTES;
      if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(shard.bytes) || shard.bytes <= 0 || bytes !== shard.bytes) { failures.push('invalid v5 shard size'); continue; }
      samplePackBytes = Math.max(samplePackBytes, shard.bytes);
      emittedSampleBytes += shard.bytes;
      if (shard.bytes > MAX_V5_SHARD_BYTES) failures.push(`samplePackBytes: ${shard.bytes} exceeds ${MAX_V5_SHARD_BYTES}`);
    }
    for (const group of surface.profiles?.groups ?? []) for (const shard of group.shards) {
      const bytes = shard.storedCells * group.frameCount * surface.profiles!.recordBytes;
      if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(shard.bytes) || bytes <= 0 || bytes !== shard.bytes) { failures.push('invalid v5 profile shard size'); continue; }
      profileBytes += bytes;
      if (bytes > MAX_V5_SHARD_BYTES) failures.push(`profile shard bytes: ${bytes} exceeds ${MAX_V5_SHARD_BYTES}`);
    }
  }
  const numericBytes = emittedSampleBytes + profileBytes;
  if (!Number.isSafeInteger(numericBytes)) failures.push('unsafe v5 numeric bytes');
  const observed = { elapsedMs, peakRssBytes, tiles, samplePackBytes, emittedSampleBytes, profileBytes, numericBytes, gridCells, fineGridCells };
  for (const key of ['gridCells', 'tiles', 'elapsedMs', 'peakRssBytes', 'numericBytes'] as const) {
    if (observed[key] > BUILD_BUDGETS[key]) failures.push(`${key}: ${observed[key]} exceeds ${BUILD_BUDGETS[key]}`);
  }
  return { version: 1, buildId: manifest.buildId, cycle: manifest.cycle, observed, budgets: { ...BUILD_BUDGETS, samplePackBytes: MAX_V5_SHARD_BYTES }, passed: failures.length === 0, failures };
}
