import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { DEFAULT_REQUEST_TIMEOUT_MS, latestV5Schema, renderedFrames } from '@av/contracts';
import { createRasterTileProtocol } from '@av/client';

const api = new URL(process.argv[2] ?? 'http://127.0.0.1:8798');
if (api.hostname !== '127.0.0.1' || !['http:', 'https:'].includes(api.protocol)) throw new Error('Benchmark requires a local fixture API');
const latest = latestV5Schema.parse(await (await fetch(new URL('/v1/models/gfs/latest?expand=manifest', api), { signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS) })).json());
if (!latest.manifest) throw new Error('Expanded manifest required');
let requests = 0, active = 0, peak = 0, failures = 0;
const server = createServer(async (request, response) => {
  requests++; active++; peak = Math.max(peak, active);
  try {
    await delay(40);
    const result = await fetch(new URL(request.url!, api), { signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS) });
    if (result.status !== 200) failures++;
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch { failures++; response.writeHead(502); response.end(); }
  finally { active--; }
});
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing benchmark listener');
const base = `http://127.0.0.1:${address.port}`, manifest = latest.manifest;
const urls = renderedFrames(manifest).slice(0, 2).flatMap(frame => Array.from({ length: 16 }, (_, i) => `${base}/tiles/gfs/${manifest.buildId}/usable-lift-agl/${frame.id}/2/${i % 4}/${Math.floor(i / 4)}.webp`));
const results = [];
try {
  for (const concurrency of [2, 4, 8, 12]) {
    const durations = [], heaps = [];
    requests = 0; peak = 0; failures = 0;
    let warmMs = 0, cachedBytes = 0;
    for (let repeat = 0; repeat < 3; repeat++) {
      const protocol = createRasterTileProtocol(base, { maxActive: concurrency });
      protocol.setBuildExpiry(manifest.buildId, Date.parse(manifest.expiresAt));
      const load = () => Promise.all(urls.map(url => protocol.load({ url: protocol.url(url) }, new AbortController())));
      const start = performance.now(); await load(); durations.push(performance.now() - start);
      const warmStart = performance.now(); await load(); warmMs += performance.now() - warmStart;
      cachedBytes = protocol.stats().cachedBytes; heaps.push(process.memoryUsage().heapUsed);
      protocol.dispose();
    }
    durations.sort((a, b) => a - b);
    results.push({ concurrency, viewportTiles: urls.length, coldMedianMs: durations[1], coldMaxMs: durations[2], warmMeanMs: warmMs / 3,
      requests, expectedRequests: urls.length * 3, peakProxyRequests: peak, failures, cachedBytes, maxProcessHeapBytes: Math.max(...heaps) });
  }
} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
console.log(JSON.stringify({ scope: 'local synthetic Worker with 40 ms injected delay per HTTP request; warm Worker metadata/directories; three cold-client then cached-client repetitions per limit', buildId: manifest.buildId, results }));
