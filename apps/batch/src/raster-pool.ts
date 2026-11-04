import { availableParallelism } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createSparseCoverage, MAX_TILE_BYTES, RASTER_TILE_SIZE, type LayerId, type PaletteInterpolation, type SparseCoverage } from '@av/contracts';
import { validateSamplingField, type GridField, type PackedGridField, type SamplingMask } from '@av/forecast';
import { BUILD_BUDGETS } from './capacity.js';
import { validateRasterPatchFields, type RasterMetrics, type RasterPixels, type RasterPatch, type RasterPatchFields } from './raster.js';
export type { RasterMetrics, RasterPixels } from './raster.js';

export const MAX_RASTER_WORKERS = 3;
export const MAX_RASTER_SHARED_INPUT_BYTES = 64 * 1024 * 1024;
export const RASTER_WORKER_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4
} as const);
export const RASTER_WORKER_NATIVE_RESERVE_MB = 44;
/** Admission reserve per worker: 84 MiB V8 heap/stack ceiling plus 44 MiB native/off-heap allowance. */
export const RASTER_WORKER_RESERVE_BYTES =
  (RASTER_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb +
    RASTER_WORKER_RESOURCE_LIMITS.maxYoungGenerationSizeMb +
    RASTER_WORKER_RESOURCE_LIMITS.stackSizeMb +
    RASTER_WORKER_NATIVE_RESERVE_MB) *
  1024 *
  1024;
export class RasterCapacityError extends RangeError {}
export function rasterWorkerCount(cpus = availableParallelism()): number {
  if (!Number.isSafeInteger(cpus) || cpus < 1) throw new RangeError('Invalid available CPU count');
  return cpus === 1 ? 0 : Math.min(MAX_RASTER_WORKERS, cpus);
}
export interface RasterWorkerData { mask: SamplingMask; fields: GridField[]; layers: LayerId[]; geometryCacheBytes: number; patches: RasterPatch<SamplingMask>[]; patchFields: RasterPatchFields[]; liftInterpolation?: PaletteInterpolation }
export interface RasterJob { id: number; field: number; z: number; x: number; y: number }
export interface RasterResult extends RasterPixels { id: number; metrics: RasterMetrics }

function sharedBytes(bytes: Uint8Array): Uint8Array<SharedArrayBuffer> {
  const result = new Uint8Array(new SharedArrayBuffer(bytes.byteLength)); result.set(bytes); return result;
}

/** One frame, immutable shared inputs, bounded admission and tile-to-worker affinity. */
export async function createRasterPool(mask: SamplingMask, targets: readonly { field: GridField; layer: LayerId; patches?: RasterPatchFields }[], options: {
  workers: number; geometryCacheBytes: number; maxPending: number; signal?: AbortSignal;
  onMetrics?: (worker: number, metrics: RasterMetrics) => void;
  patches?: readonly RasterPatch<SamplingMask>[];
  liftInterpolation?: PaletteInterpolation;
  maxSharedInputBytes?: number;
}) {
  const { workers: count, maxPending, geometryCacheBytes, signal, maxSharedInputBytes = MAX_RASTER_SHARED_INPUT_BYTES } = options;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RASTER_WORKERS || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 32
      || !Number.isSafeInteger(geometryCacheBytes) || geometryCacheBytes < 0 || !Number.isSafeInteger(maxSharedInputBytes) || maxSharedInputBytes < 0 || maxSharedInputBytes > BUILD_BUDGETS.peakRssBytes || targets.length < 1 || targets.length > 3) throw new RangeError('Invalid raster pool limits');
  signal?.throwIfAborted();
  for (const { field } of targets) validateSamplingField(mask.grid, field, mask);
  const patches = options.patches ?? [];
  for (const target of targets) validateRasterPatchFields(patches, target.layer, target.patches);
  const coverages = new Set<SparseCoverage>();
  const maskBytes = (mask: SamplingMask) => {
    if (!('coverage' in mask)) return mask.output.byteLength + mask.halo.byteLength + mask.tiles.byteLength;
    const coverage = mask.coverage;
    if (coverages.has(coverage)) return mask.tiles.byteLength;
    createSparseCoverage(coverage); coverages.add(coverage);
    return mask.tiles.byteLength + coverage.blockIds.byteLength + coverage.offsets.byteLength + coverage.output.byteLength + coverage.halo.byteLength;
  };
  const fieldBytes = (field: GridField) => field.values.byteLength + field.flags.byteLength;
  const sharedInputBytes = targets.reduce((sum, target) => sum + fieldBytes(target.field) + Object.values(target.patches ?? {}).reduce((bytes, field) => bytes + fieldBytes(field), 0), 0) + maskBytes(mask) + patches.reduce((sum, patch) => sum + maskBytes(patch.mask), 0);
  if (!Number.isSafeInteger(sharedInputBytes) || sharedInputBytes > maxSharedInputBytes) throw new RasterCapacityError('Raster shared input byte budget exceeded');
  const admittedPeakBytes = process.memoryUsage.rss() + sharedInputBytes + count * RASTER_WORKER_RESERVE_BYTES + geometryCacheBytes + maxPending * (RASTER_TILE_SIZE * RASTER_TILE_SIZE * 4 + MAX_TILE_BYTES);
  if (!Number.isSafeInteger(admittedPeakBytes) || admittedPeakBytes > BUILD_BUDGETS.peakRssBytes) throw new RasterCapacityError('Raster process working-set budget exceeded');
  const sharedCoverages = new Map<SparseCoverage, SparseCoverage>();
  const shareCoverage = (coverage: SparseCoverage): SparseCoverage => {
    const found = sharedCoverages.get(coverage);
    if (found) return found;
    const result = { ...coverage, blockIds: new Uint32Array(sharedBytes(new Uint8Array(coverage.blockIds.buffer, coverage.blockIds.byteOffset, coverage.blockIds.byteLength)).buffer), offsets: new Uint32Array(sharedBytes(new Uint8Array(coverage.offsets.buffer, coverage.offsets.byteOffset, coverage.offsets.byteLength)).buffer), output: sharedBytes(coverage.output), halo: sharedBytes(coverage.halo) };
    sharedCoverages.set(coverage, result); return result;
  };
  const shareField = (field: GridField): GridField => ({ values: new Float32Array(sharedBytes(new Uint8Array(field.values.buffer, field.values.byteOffset, field.values.byteLength)).buffer), flags: sharedBytes(field.flags), ...('coverage' in field ? { coverage: shareCoverage((field as PackedGridField).coverage) } : {}) });
  const shareMask = (mask: SamplingMask): SamplingMask => 'coverage' in mask ? { ...mask, coverage: shareCoverage(mask.coverage), tiles: sharedBytes(mask.tiles) } : { ...mask, output: sharedBytes(mask.output), halo: sharedBytes(mask.halo), tiles: sharedBytes(mask.tiles) };
  const fields = targets.map(({ field }) => shareField(field)), sharedMask = shareMask(mask);
  const sharedPatches = patches.map(patch => ({ ...patch, mask: shareMask(patch.mask) }));
  const patchFields = targets.map(target => Object.fromEntries(Object.entries(target.patches ?? {}).map(([id, field]) => [id, shareField(field)])));
  const workers: Worker[] = [], waiting = new Map<number, { resolve: (value: RasterPixels) => void; reject: (error: Error) => void }>();
  const initialization: ((error: Error) => void)[] = [];
  let nextId = 0, failed: Error | undefined, closing: Promise<void> | undefined;
  const fail = (error: unknown) => {
    failed ??= error instanceof Error ? error : new Error(String(error));
    for (const reject of initialization) reject(failed);
    for (const promise of waiting.values()) promise.reject(failed);
    waiting.clear();
  };
  const abort = () => fail(signal?.reason ?? new Error('Raster pool aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  const close = (): Promise<void> => {
    if (closing) return closing;
    fail(new Error('Raster pool closed')); signal?.removeEventListener('abort', abort);
    closing = Promise.all(workers.map(worker => worker.terminate())).then(() => undefined);
    return closing;
  };
  const deadline = setTimeout(() => fail(new Error('Raster worker initialization timed out')), 30_000); deadline.unref();
  try {
    await Promise.all(Array.from({ length: count }, (_, index) => new Promise<void>((resolve, reject) => {
      initialization.push(reject);
      const data: RasterWorkerData = { mask: sharedMask, fields, layers: targets.map(target => target.layer), geometryCacheBytes: Math.floor(geometryCacheBytes / count), patches: sharedPatches, patchFields, liftInterpolation: options.liftInterpolation };
      const worker = new Worker('import("node:worker_threads").then(async ({workerData}) => { const {tsImport} = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); })', {
        eval: true, resourceLimits: { ...RASTER_WORKER_RESOURCE_LIMITS },
        workerData: { ...data, loader: pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href, entry: new URL('./raster-worker.ts', import.meta.url).href }
      });
      workers.push(worker);
      worker.on('error', fail);
      worker.on('exit', code => { if (!closing) fail(new Error(`Raster worker unexpectedly exited ${code}`)); });
      worker.on('message', (message: RasterResult | { ready: true } | { id: number; error: Error }) => {
        if ('ready' in message) { resolve(); return; }
        if ('error' in message) { fail(message.error); return; }
        try {
          options.onMetrics?.(index, message.metrics);
          const promise = waiting.get(message.id); waiting.delete(message.id); promise?.resolve(message);
        } catch (error) { fail(error); }
      });
    })));
    if (failed) throw failed;
    signal?.throwIfAborted();
  } catch (error) { await close(); throw error; }
  finally { clearTimeout(deadline); initialization.length = 0; }
  return {
    sharedInputBytes, admittedPeakBytes, close,
    render(tileIndex: number, field: number, z: number, x: number, y: number): Promise<RasterPixels> {
      return new Promise((resolve, reject) => {
        if (failed) { reject(failed); return; }
        if (waiting.size >= maxPending) { reject(new Error('Raster pending job budget exceeded')); return; }
        if (!Number.isSafeInteger(tileIndex) || tileIndex < 0 || !Number.isSafeInteger(field) || field < 0 || field >= targets.length) { reject(new RangeError('Invalid raster job')); return; }
        const id = nextId++;
        waiting.set(id, { resolve, reject });
        try { workers[tileIndex % count].postMessage({ id, field, z, x, y } satisfies RasterJob); }
        catch (error) { fail(error); }
      });
    }
  };
}
