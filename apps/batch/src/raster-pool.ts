import { availableParallelism } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createSparseCoverage, MAX_MODEL_WORKERS, MAX_TILE_BYTES, RASTER_TILE_SIZE, type LayerId, type PaletteInterpolation } from '@av/contracts';
import { validateSamplingField, type GridField, type SamplingMask } from '@av/forecast';
import { BUILD_BUDGETS } from './capacity.js';
import type { RasterMetrics, RasterPixels } from './raster.js';
export type { RasterMetrics, RasterPixels } from './raster.js';

export const MAX_RASTER_WORKERS = MAX_MODEL_WORKERS;
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
export function rasterWorkerCount(cpus = availableParallelism(), ceiling = MAX_RASTER_WORKERS): number {
  if (!Number.isSafeInteger(cpus) || cpus < 1) throw new RangeError('Invalid available CPU count');
  if (!Number.isSafeInteger(ceiling) || ceiling < 0 || ceiling > MAX_RASTER_WORKERS) throw new RangeError('Invalid worker ceiling');
  return cpus === 1 ? 0 : Math.min(ceiling, cpus);
}
export interface RasterWorkerData { mask: SamplingMask; fields: GridField[]; layers: LayerId[]; geometryCacheBytes: number; liftInterpolation?: PaletteInterpolation }
export interface RasterJob { id: number; field: number; z: number; x: number; y: number }
export interface RasterResult extends RasterPixels { id: number; metrics: RasterMetrics }

function sharedBytes(bytes: Uint8Array): Uint8Array<SharedArrayBuffer> {
  if (bytes.buffer instanceof SharedArrayBuffer) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Uint8Array(new SharedArrayBuffer(bytes.byteLength)); result.set(bytes); return result;
}

function sharedWords(words: Uint32Array): Uint32Array<SharedArrayBuffer> {
  if (words.buffer instanceof SharedArrayBuffer) return new Uint32Array(words.buffer, words.byteOffset, words.length);
  const result = new Uint32Array(new SharedArrayBuffer(words.byteLength)); result.set(words); return result;
}

/** One frame, immutable shared inputs, bounded admission and tile-to-worker affinity. */
export async function createRasterPool(mask: SamplingMask, targets: readonly { field: GridField; layer: LayerId }[], options: {
  workers: number; geometryCacheBytes: number; maxPending: number; signal?: AbortSignal;
  onMetrics?: (worker: number, metrics: RasterMetrics) => void;
  liftInterpolation?: PaletteInterpolation;
  maxSharedInputBytes?: number;
}) {
  const { workers: count, maxPending, geometryCacheBytes, signal, maxSharedInputBytes = MAX_RASTER_SHARED_INPUT_BYTES } = options;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RASTER_WORKERS || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 32
      || !Number.isSafeInteger(geometryCacheBytes) || geometryCacheBytes < 0 || !Number.isSafeInteger(maxSharedInputBytes) || maxSharedInputBytes < 0 || maxSharedInputBytes > BUILD_BUDGETS.peakRssBytes || targets.length < 1 || targets.length > 3) throw new RangeError('Invalid raster pool limits');
  signal?.throwIfAborted();
  for (const { field } of targets) validateSamplingField(mask.grid, field, mask);
  if ('coverage' in mask) createSparseCoverage(mask.coverage);
  const maskViews = 'coverage' in mask
    ? [mask.coverage.blockIds, mask.coverage.offsets, mask.coverage.output, mask.coverage.halo]
    : [mask.output, mask.halo];
  const inputViews = [...targets.flatMap(({ field }) => [field.values, field.flags]), mask.tiles, ...maskViews];
  const sharedInputBytes = inputViews.reduce((sum, view) => sum + view.byteLength, 0);
  if (!Number.isSafeInteger(sharedInputBytes) || sharedInputBytes > maxSharedInputBytes) throw new RasterCapacityError('Raster shared input byte budget exceeded');
  const copiedInputBytes = inputViews.reduce((sum, view) => sum + (view.buffer instanceof SharedArrayBuffer ? 0 : view.byteLength), 0);
  const admittedPeakBytes = process.memoryUsage.rss() + copiedInputBytes + count * RASTER_WORKER_RESERVE_BYTES + geometryCacheBytes + maxPending * (RASTER_TILE_SIZE * RASTER_TILE_SIZE * 4 + MAX_TILE_BYTES);
  if (!Number.isSafeInteger(admittedPeakBytes) || admittedPeakBytes > BUILD_BUDGETS.peakRssBytes) throw new RasterCapacityError('Raster process working-set budget exceeded');
  const tiles = sharedBytes(mask.tiles);
  const sharedMask: SamplingMask = 'coverage' in mask ? { ...mask, tiles, coverage: {
    ...mask.coverage, blockIds: sharedWords(mask.coverage.blockIds), offsets: sharedWords(mask.coverage.offsets),
    output: sharedBytes(mask.coverage.output), halo: sharedBytes(mask.coverage.halo)
  } } : { ...mask, tiles, output: sharedBytes(mask.output), halo: sharedBytes(mask.halo) };
  const fields: GridField[] = targets.map(({ field }) => {
    const values = sharedBytes(new Uint8Array(field.values.buffer, field.values.byteOffset, field.values.byteLength));
    return { values: new Float32Array(values.buffer, values.byteOffset, field.values.length), flags: sharedBytes(field.flags),
      ...('coverage' in sharedMask ? { coverage: sharedMask.coverage } : {}) };
  });
  const layers = targets.map(target => target.layer);
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
      const data: RasterWorkerData = { mask: sharedMask, fields, layers, geometryCacheBytes: Math.floor(geometryCacheBytes / count), liftInterpolation: options.liftInterpolation };
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
    sharedInputBytes, copiedInputBytes, admittedPeakBytes, close,
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
