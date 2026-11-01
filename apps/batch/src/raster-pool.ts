import { availableParallelism } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { CoverageMask, LayerId } from '@av/contracts';
import type { GridField } from '@av/forecast';
import type { RasterMetrics, RasterPixels } from './raster.js';
export type { RasterMetrics, RasterPixels } from './raster.js';

export const MAX_RASTER_WORKERS = 3;
export const MAX_RASTER_SHARED_INPUT_BYTES = 64 * 1024 * 1024;
/** Admission reserve, not a hard RSS limit. Raster buffers are budgeted separately. */
export const RASTER_WORKER_RESERVE_BYTES = 128 * 1024 * 1024;
export function rasterWorkerCount(cpus = availableParallelism()): number {
  if (!Number.isSafeInteger(cpus) || cpus < 1) throw new RangeError('Invalid available CPU count');
  return cpus === 1 ? 0 : Math.min(MAX_RASTER_WORKERS, cpus);
}
export interface RasterWorkerData { mask: CoverageMask; fields: GridField[]; layers: LayerId[]; geometryCacheBytes: number }
export interface RasterJob { id: number; field: number; z: number; x: number; y: number }
export interface RasterResult extends RasterPixels { id: number; metrics: RasterMetrics }

function sharedBytes(bytes: Uint8Array): Uint8Array<SharedArrayBuffer> {
  const result = new Uint8Array(new SharedArrayBuffer(bytes.byteLength)); result.set(bytes); return result;
}

/** One frame, immutable shared inputs, bounded admission and tile-to-worker affinity. */
export async function createRasterPool(mask: CoverageMask, targets: readonly { field: GridField; layer: LayerId }[], options: {
  workers: number; geometryCacheBytes: number; maxPending: number; signal?: AbortSignal;
  onMetrics?: (worker: number, metrics: RasterMetrics) => void;
}) {
  const { workers: count, maxPending, geometryCacheBytes, signal } = options;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RASTER_WORKERS || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 32
      || !Number.isSafeInteger(geometryCacheBytes) || geometryCacheBytes < 0 || targets.length < 1 || targets.length > 3) throw new RangeError('Invalid raster pool limits');
  signal?.throwIfAborted();
  const cells = mask.grid.width * mask.grid.height;
  for (const { field } of targets) if (!(field.values instanceof Float32Array) || !(field.flags instanceof Uint8Array) || field.values.length !== cells || field.flags.length !== cells) throw new RangeError('Raster field does not match its grid');
  const sharedInputBytes = targets.reduce((sum, { field }) => sum + field.values.byteLength + field.flags.byteLength, 0) + mask.output.byteLength + mask.halo.byteLength + mask.tiles.byteLength;
  if (!Number.isSafeInteger(sharedInputBytes) || sharedInputBytes > MAX_RASTER_SHARED_INPUT_BYTES) throw new RangeError('Raster shared input byte budget exceeded');
  const fields = targets.map(({ field }) => ({ values: new Float32Array(sharedBytes(new Uint8Array(field.values.buffer, field.values.byteOffset, field.values.byteLength)).buffer), flags: sharedBytes(field.flags) }));
  const sharedMask = { ...mask, output: sharedBytes(mask.output), halo: sharedBytes(mask.halo), tiles: sharedBytes(mask.tiles) };
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
      const data: RasterWorkerData = { mask: sharedMask, fields, layers: targets.map(target => target.layer), geometryCacheBytes: Math.floor(geometryCacheBytes / count) };
      const worker = new Worker('import("node:worker_threads").then(async ({workerData}) => { const {tsImport} = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); })', {
        eval: true, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
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
    sharedInputBytes, close,
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
