import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { STATUS_OUTSIDE, type SparseCoverage, type WholeDomainGrid } from '@av/contracts';
import type { GridField } from '@av/forecast';
import type { NormalizedFrame } from '@av/forecast/inputs';
import type { PreparedPackedTerrainColumns, TerrainColumnDerivation, TerrainColumnNativeClearance } from '@av/forecast/refinement';
import { MAX_PACKED_COLUMN_BYTES } from './capacity.js';
import { MAX_RASTER_WORKERS, RASTER_WORKER_RESOURCE_LIMITS } from '../raster-pool.js';

type Output = { 'usable-lift-msl': GridField; 'usable-lift-agl': GridField };
export interface DerivePoolInput {
  plan: WholeDomainGrid; coverage: SparseCoverage; activeIndices: Uint32Array; maxLevels: number;
  terrain: { elevationM: Float32Array; valid: Uint8Array }; output: Output; workers: number;
  /** Bytes copied into shared buffers for the frame and native clearance together. */
  maxFrameCopyBytes: number; signal?: AbortSignal;
}
export interface DeriveJob {
  generation: number; frame: NormalizedFrame; time: { intervalStart: string; validTime: string };
  daylightOnly?: boolean; nativeClearance?: TerrainColumnNativeClearance; deadlineAt?: number;
}
export interface DeriveWorkerData extends Omit<DerivePoolInput, 'signal' | 'workers' | 'maxFrameCopyBytes'> { index: number; count: number; maxBytes: number }
export interface DeriveWorkerJob extends DeriveJob { phase: 'derive'; jobId: number }
export type DeriveWorkerMessage = { ready: true } | { generation: number; phase: 'derive'; jobId: number; result: Omit<TerrainColumnDerivation, 'fields'> } | { generation: number; phase: 'derive'; jobId: number; error: Error };

function share<T>(value: T): T {
  if (value instanceof Float32Array || value instanceof Uint32Array || value instanceof Uint8Array) {
    if (value.buffer instanceof SharedArrayBuffer) return value;
    const copy = new SharedArrayBuffer(value.byteLength);
    new Uint8Array(copy).set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    if (value instanceof Float32Array) return new Float32Array(copy) as T;
    if (value instanceof Uint32Array) return new Uint32Array(copy) as T;
    return new Uint8Array(copy) as T;
  }
  if (Array.isArray(value)) return value.map(share) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, share(item)])) as T;
  return value;
}

function copyBytes(value: unknown): number {
  if (ArrayBuffer.isView(value)) return value.buffer instanceof SharedArrayBuffer ? 0 : value.byteLength;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + copyBytes(item), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce<number>((sum, item) => sum + copyBytes(item), 0);
  return 0;
}

export async function createWholeDomainDerivePool(input: DerivePoolInput) {
  const { workers: count, signal, output } = input;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RASTER_WORKERS) throw new RangeError('Invalid derive worker count');
  if (!Number.isSafeInteger(input.maxFrameCopyBytes) || input.maxFrameCopyBytes < 0) throw new RangeError('Invalid derive frame copy budget');
  signal?.throwIfAborted();
  for (const field of Object.values(output)) if (!(field.values.buffer instanceof SharedArrayBuffer) || !(field.flags.buffer instanceof SharedArrayBuffer)) throw new RangeError('Derive output must use shared buffers');
  const data = share({ plan: input.plan, coverage: input.coverage, activeIndices: input.activeIndices,
    maxLevels: input.maxLevels, terrain: { elevationM: input.terrain.elevationM, valid: input.terrain.valid }, output });
  const workers: Worker[] = [];
  let failed: Error | undefined, closing: Promise<void> | undefined, active = false, nextGeneration = 0, jobId = 0;
  const pending = new Map<number, { resolve: (value: Omit<TerrainColumnDerivation, 'fields'>) => void; reject: (error: Error) => void }>();
  const ready = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  const close = () => {
    if (!closing) {
      signal?.removeEventListener('abort', abort);
      closing = Promise.all(workers.map(worker => worker.terminate())).then(() => undefined);
    }
    return closing;
  };
  const fail = (error: unknown) => {
    if (failed) return;
    failed = error instanceof Error ? error : new Error(String(error));
    void close().then(() => {
      for (const waiter of ready.values()) waiter.reject(failed!);
      for (const waiter of pending.values()) waiter.reject(failed!);
      ready.clear(); pending.clear();
    });
  };
  const abort = () => fail(signal?.reason ?? new Error('Derive pool aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await Promise.all(Array.from({ length: count }, (_, index) => new Promise<void>((resolve, reject) => {
      ready.set(index, { resolve, reject });
      const worker = new Worker('import("node:worker_threads").then(async ({workerData}) => { const {tsImport} = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); })', {
        eval: true, resourceLimits: { ...RASTER_WORKER_RESOURCE_LIMITS },
        workerData: { ...data, index, count, maxBytes: MAX_PACKED_COLUMN_BYTES, loader: pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href, entry: new URL('./derive-worker.ts', import.meta.url).href }
      });
      workers.push(worker);
      worker.on('error', fail);
      worker.on('exit', code => { if (!closing) fail(new Error(`Derive worker unexpectedly exited ${code}`)); });
      worker.on('message', (message: DeriveWorkerMessage) => {
        if ('ready' in message) { ready.get(index)?.resolve(); ready.delete(index); return; }
        if (!active || message.phase !== 'derive' || message.generation !== nextGeneration || message.jobId !== jobId || !pending.has(index)) {
          fail(new Error('Unexpected derive worker generation or job')); return;
        }
        if ('error' in message) { fail(message.error); return; }
        pending.get(index)!.resolve(message.result); pending.delete(index);
      });
    })));
    if (failed) throw failed;
    signal?.throwIfAborted();
  } catch (error) { await close(); throw error; }
  return {
    async derive(job: DeriveJob): Promise<ReturnType<PreparedPackedTerrainColumns['derive']>> {
      if (failed) throw failed;
      if (closing) throw new Error('Derive pool closed');
      if (active || job.generation !== nextGeneration) throw new Error('Invalid derive generation');
      const frame = { ...job.frame };
      delete frame.auxSurface; delete frame.auxLevels; frame.receipt = {};
      if (copyBytes(frame) + copyBytes(job.nativeClearance) > input.maxFrameCopyBytes) throw new RangeError('Derive frame copy budget exceeded');
      if (job.deadlineAt !== undefined && (!Number.isFinite(job.deadlineAt) || Date.now() >= job.deadlineAt)) throw new Error('Terrain column deadline exceeded');
      signal?.throwIfAborted();
      active = true; jobId++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        for (const field of Object.values(output)) { field.values.fill(NaN); field.flags.fill(STATUS_OUTSIDE); }
        const shared = share({ ...job, frame, phase: 'derive' as const, jobId });
        if (job.deadlineAt !== undefined) timer = setTimeout(() => fail(new Error('Terrain column deadline exceeded')), Math.max(0, job.deadlineAt - Date.now()));
        const results = await Promise.all(workers.map((worker, index) => new Promise<Omit<TerrainColumnDerivation, 'fields'>>((resolve, reject) => {
          pending.set(index, { resolve, reject });
          try { worker.postMessage(shared); } catch (error) { fail(error); }
        })));
        const metrics = { ...results[0]!.metrics };
        for (const result of results.slice(1)) for (const key of Object.keys(metrics) as (keyof typeof metrics)[]) metrics[key] = (metrics[key] ?? 0) + (result.metrics[key] ?? 0);
        const probes = results.flatMap(result => result.probes);
        nextGeneration++;
        return { fields: { 'usable-lift-msl': { ...output['usable-lift-msl'], coverage: input.coverage }, 'usable-lift-agl': { ...output['usable-lift-agl'], coverage: input.coverage } }, metrics, probes, daylightBufferBytes: results[0]!.daylightBufferBytes };
      } catch (error) { fail(error); await close(); throw failed ?? error; }
      finally { if (timer) clearTimeout(timer); active = false; }
    },
    async close() { if (!failed && (active || ready.size)) fail(new Error('Derive pool closed')); await close(); }
  };
}
