import { parentPort, workerData } from 'node:worker_threads';
import { createRasterizer } from './raster.js';
import type { RasterResult, RasterWorkerData, RasterWorkerMessage } from './raster-pool.js';

const port = parentPort!;
const data = workerData as RasterWorkerData, renderer = createRasterizer(data.mask, data.geometryCacheBytes, undefined, data.patches, data.liftInterpolation);
port.on('message', (message: RasterWorkerMessage) => {
  try {
    if ('type' in message) {
      data.fields = message.fields;
      data.layers = message.layers;
      data.patchFields = message.patchFields;
      port.postMessage({ updated: message.id });
      return;
    }
    const result = renderer.renderTilePixels(data.fields[message.field], data.layers[message.field], message.z, message.x, message.y, data.patchFields[message.field]);
    if (!(result.rgba.buffer instanceof ArrayBuffer)) throw new Error('Raster output must own its transferable buffer');
    port.postMessage({ id: message.id, ...result, metrics: renderer.metrics() } satisfies RasterResult, [result.rgba.buffer]);
  } catch (error) { port.postMessage({ id: message.id, error: error instanceof Error ? error : new Error(String(error)) }); }
});
port.postMessage({ ready: true });
