import { parentPort, workerData } from 'node:worker_threads';
import { preparePackedTerrainColumns } from '@av/forecast/refinement';
import type { DeriveWorkerData, DeriveWorkerJob, DeriveWorkerMessage } from './derive-pool.js';

const port = parentPort!;
const data = workerData as DeriveWorkerData;
const columns = preparePackedTerrainColumns(data.plan, data.coverage, data.activeIndices, data.maxLevels,
  { maxBytes: data.maxBytes, expectedGridHash: data.coverage.gridHash, clearanceFallback: 'unsupported', partition: { index: data.index, count: data.count } });
port.on('message', (job: DeriveWorkerJob) => {
  try {
    const { metrics, probes, daylightBufferBytes } = columns.derive(job.frame, data.terrain, job.time,
      { daylightOnly: job.daylightOnly, nativeClearance: job.nativeClearance, output: data.output });
    port.postMessage({ generation: job.generation, phase: job.phase, jobId: job.jobId, result: { metrics, probes, daylightBufferBytes } } satisfies DeriveWorkerMessage);
  } catch (error) { port.postMessage({ generation: job.generation, phase: job.phase, jobId: job.jobId, error: error instanceof Error ? error : new Error(String(error)) } satisfies DeriveWorkerMessage); }
});
port.postMessage({ ready: true } satisfies DeriveWorkerMessage);
