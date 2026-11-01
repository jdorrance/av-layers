import { parentPort, workerData } from 'node:worker_threads';
import { createRasterizer } from './raster.js';
import type { RasterJob, RasterResult, RasterWorkerData } from './raster-pool.js';

const port = parentPort!;
const data = workerData as RasterWorkerData, renderer = createRasterizer(data.mask, data.geometryCacheBytes);
port.on('message', (job: RasterJob) => {
  try {
    const result = renderer.renderTilePixels(data.fields[job.field], data.layers[job.field], job.z, job.x, job.y);
    if (!(result.rgba.buffer instanceof ArrayBuffer)) throw new Error('Raster output must own its transferable buffer');
    port.postMessage({ id: job.id, ...result, metrics: renderer.metrics() } satisfies RasterResult, [result.rgba.buffer]);
  } catch (error) { port.postMessage({ id: job.id, error: error instanceof Error ? error : new Error(String(error)) }); }
});
port.postMessage({ ready: true });
