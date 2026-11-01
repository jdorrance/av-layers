import { pathToFileURL } from 'node:url';
import { ApiClient, frameTileUrl } from '@av/contracts/client';

export interface Observation { name: string; elapsedMs: number; status: number; responseBytes: number; workerMs: number | null; r2Reads: number | null; r2Bytes: number | null; cacheHits: number | null; coalesced: number | null; responseCache: string | null }
export function summarize(observations: Observation[]) {
  const sorted = observations.map(item => item.elapsedMs).sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return { requests: observations.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), errorRate: observations.filter(item => item.status !== 200).length / Math.max(1, observations.length), responseCaches: Object.fromEntries([...new Set(observations.map(item => item.responseCache ?? 'unavailable'))].map(state => [state, observations.filter(item => (item.responseCache ?? 'unavailable') === state).length])), maxMs: sorted.at(-1) ?? 0, statuses: Object.fromEntries([...new Set(observations.map(item => item.status))].map(status => [status, observations.filter(item => item.status === status).length])), observations };
}
function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`), value = index < 0 ? fallback : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} is required`);
  return value;
}
async function main(): Promise<void> {
  const base = option('base-url').replace(/\/+$/, ''), model = option('model', 'gfs');
  const lat = Number(option('lat', '32.9')), lon = Number(option('lon', '-117.25'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) throw new Error('Choose finite covered coordinates within Web Mercator bounds');
  const observations: Observation[] = [];
  async function observe(name: string, url: string, init: RequestInit = {}): Promise<{ response: Response; bytes: Uint8Array }> {
    const start = performance.now();
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const number = (header: string) => response.headers.has(header) ? Number(response.headers.get(header)) : null;
    const timing = /worker;dur=([\d.]+)/.exec(response.headers.get('server-timing') ?? '');
    observations.push({ name, elapsedMs: Math.round((performance.now() - start) * 100) / 100, status: response.status, responseBytes: bytes.length, workerMs: timing ? Number(timing[1]) : null, r2Reads: number('x-av-r2-reads'), r2Bytes: number('x-av-r2-bytes'), cacheHits: number('x-av-cache-hits'), coalesced: number('x-av-coalesced'), responseCache: response.headers.get('x-av-response-cache') });
    return { response, bytes };
  }
  const health = await observe('health', `${base}/healthz`);
  if (health.response.status !== 200) throw new Error('Worker health check failed');
  const deployment = JSON.parse(new TextDecoder().decode(health.bytes));
  const latestUrl = `${base}/v1/models/${model}/latest?expand=manifest`;
  const initial = await Promise.all(Array.from({ length: 8 }, () => observe('metadata-first-observed-burst', latestUrl)));
  if (initial.some(result => result.response.status !== 200)) throw new Error('Expanded metadata burst failed');
  const client = new ApiClient({ baseUrl: base, fetchImpl: async () => new Response(initial[0].bytes.buffer as ArrayBuffer) });
  const build = await client.latest(model);
  const frame = build.manifest.frames[0], layer = build.manifest.layers[0];
  const z = Math.min(5, build.maxNativeZoom), n = 2 ** z;
  const x = Math.min(n - 1, Math.floor((lon + 180) / 360 * n));
  const y = Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n);
  const tile = frameTileUrl(build.templates[layer], frame.id).replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  const sample = `${base}/v1/models/${model}/runs/${build.manifest.buildId}/sample?lat=${lat}&lon=${lon}&frame=all`;
  if (process.argv.includes('--load')) {
    const mode = option('mode', 'warm'), duration = Number(option('duration-seconds', '300'));
    if (!['warm', 'uncached'].includes(mode) || !Number.isInteger(duration) || duration < 1 || duration > 300) throw new Error('Load mode must be warm|uncached and duration-seconds an integer in 1..300');
    const location = option('location', 'unspecified');
    if (duration === 300 && location === 'unspecified') throw new Error('Qualification requires --location identifying the measurement region or runner');
    const expectedCache = mode === 'warm' ? 'hit' : 'bypass';
    await observe('warmup-tile', tile); await observe('warmup-sample', sample);
    await new Promise(resolve => setTimeout(resolve, 100));
    for (const [name, url] of [['tile', tile], ['sample', sample]]) {
      const verification = await observe(`warmup-verify-${name}`, url);
      if (verification.response.status !== 200 || verification.response.headers.get('x-av-response-cache') !== expectedCache) throw new Error(`Expected ${expectedCache} response-cache evidence for ${name}. Check AV_RESPONSE_CACHE and waitUntil cache writes.`);
    }
    const qualificationStart = observations.length, count = duration * 10, start = performance.now();
    const active = new Set<Promise<unknown>>(); let maxConcurrent = 0, dropped = 0;
    for (let index = 0; index < count; index++) {
      const delay = start + index * 100 - performance.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      const slot = index % 50, name = slot < 45 ? 'tile' : slot < 47 ? 'sample' : 'metadata';
      if (active.size >= 20) {
        dropped++;
        observations.push({ name, status: 0, elapsedMs: 0, responseBytes: 0, workerMs: null, r2Reads: null, r2Bytes: null, cacheHits: null, coalesced: null, responseCache: null });
        continue;
      }
      const requestStart = performance.now();
      const pending = observe(name, name === 'tile' ? tile : name === 'sample' ? sample : latestUrl).catch(() => {
        observations.push({ name, status: 0, elapsedMs: performance.now() - requestStart, responseBytes: 0, workerMs: null, r2Reads: null, r2Bytes: null, cacheHits: null, coalesced: null, responseCache: null });
      }).finally(() => active.delete(pending));
      active.add(pending); maxConcurrent = Math.max(maxConcurrent, active.size);
    }
    await Promise.all(active);
    const load = observations.slice(qualificationStart), groups = Object.fromEntries(['tile', 'sample', 'metadata'].map(name => [name, summarize(load.filter(item => item.name === name))]));
    const cacheEvidence = load.filter(item => item.name !== 'metadata').every(item => item.responseCache === expectedCache);
    const unexpectedErrors = load.filter(item => item.status !== 200).length;
    const latencyPassed = Object.entries(groups).every(([name, group]) => group.p95Ms <= (mode === 'warm' || name === 'metadata' ? 250 : 1500));
    const countsPassed = duration === 300 && groups.tile.requests >= 100 && groups.sample.requests >= 100;
    const measurementsPassed = cacheEvidence && latencyPassed && unexpectedErrors / count < 0.001 && dropped === 0;
    console.log(JSON.stringify({ capturedAt: new Date().toISOString(), baseUrl: base, deployment, mode, durationSeconds: duration, requestsPerSecond: 10, mix: { tile: 0.9, sample: 0.04, metadata: 0.06 }, maxConcurrent, dropped, buildId: build.manifest.buildId, recipeHash: build.manifest.recipe.hash, coverageHash: build.manifest.coverage.hash, location, measurement: 'Full-body client wall latency; response cache mode verified per request. Metadata was warmed first. No fresh-isolate or deployed-memory claim.', cacheEvidence, countsPassed, measurementsPassed, qualifiedLoad: countsPassed && measurementsPassed, unexpectedErrorRate: unexpectedErrors / count, groups }, null, 2));
    if (!measurementsPassed) process.exitCode = 1;
    return;
  }
  const firstTile = await observe('tile-first-observed', tile);
  await observe('tile-warm-head', tile, { method: 'HEAD' });
  await observe('tile-conditional', tile, { headers: { 'if-none-match': firstTile.response.headers.get('etag') ?? '' } });
  await observe('sample-first-observed', sample);
  await Promise.all(Array.from({ length: 8 }, () => observe('sample-warm-burst', sample)));
  await observe('sample-outside', `${base}/v1/models/${model}/runs/${build.manifest.buildId}/sample?lat=90&lon=0&frame=all`);
  await Promise.all(Array.from({ length: 8 }, (_, index) => observe('unknown-build-burst', `${base}/v1/models/${model}/runs/not-retained-${index}`)));
  const unexpected = observations.filter(item => item.name === 'unknown-build-burst' ? item.status !== 404 : item.name === 'tile-conditional' ? ![200, 304].includes(item.status) : item.status !== 200);
  const groups = Object.fromEntries([...new Set(observations.map(item => item.name))].map(name => [name, summarize(observations.filter(item => item.name === name))]));
  console.log(JSON.stringify({ capturedAt: new Date().toISOString(), baseUrl: base, deployment, node: process.version, model, buildId: build.manifest.buildId, recipeHash: build.manifest.recipe.hash, coverageHash: build.manifest.coverage.hash, measurement: 'Client wall time and response bytes; Worker elapsed time includes I/O. First-observed does not imply a cold isolate. Missing counters are null. CPU and resident memory require platform telemetry.', groups, unexpected }, null, 2));
  if (unexpected.length) process.exitCode = 1;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
