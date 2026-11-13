import { DEFAULT_PROBE_TIMEOUT_MS, MAX_PROVENANCE_BYTES, maxProfileFrames, parseFrameProvenance, parseProvenance,
  renderedFrames, renderedLayers, type LayerId, type ManifestV5 } from '@av/contracts';
import { ApiClient, type ApiClientMetric, type PinnedBuild } from '@av/client';
import { PRODUCTS } from '@av/contracts/models';

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function validateApiBaseUrl(value: string | undefined): URL {
  if (!value) throw new Error('API_BASE_URL is required');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('API_BASE_URL must be a root HTTPS URL without credentials, query or fragment');
  return url;
}

/** Shared by the deployment and hourly probes; abort deadlines remain active while reading. */
export async function readResponseBytes(response: Response, limit = 1024 * 1024): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel(); throw new Error('Response exceeds byte limit');
  }
  if (!response.body) throw new Error('Response body is missing');
  const reader = response.body.getReader(), bytes = new Uint8Array(limit);
  let used = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return bytes.subarray(0, used);
      if (used + value.byteLength > limit) throw new Error('Response exceeds byte limit');
      bytes.set(value, used); used += value.byteLength;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export interface RetryOptions { retries?: number; delayMs?: number; signal?: AbortSignal }
export async function retryProbe(label: string, check: () => Promise<void>, options: RetryOptions = {}): Promise<void> {
  let last = '';
  for (let attempt = 0; attempt <= (options.retries ?? 12); attempt++) {
    options.signal?.throwIfAborted();
    if (attempt) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { options.signal?.removeEventListener('abort', abort); resolve(); }, options.delayMs ?? 5000);
      const abort = () => { clearTimeout(timer); reject(options.signal?.reason); };
      options.signal?.addEventListener('abort', abort, { once: true });
    });
    options.signal?.throwIfAborted();
    try { await check(); return; }
    catch (error) { options.signal?.throwIfAborted(); last = error instanceof Error ? error.message : String(error); }
  }
  throw new Error(`${label} verification failed: ${last}`);
}

export function validateHealthContract(health: unknown, expectedDeploymentId?: string): void {
  invariant(health !== null && typeof health === 'object' && 'ok' in health && health.ok === true, '/healthz did not return ok:true');
  if (expectedDeploymentId !== undefined) {
    invariant(expectedDeploymentId.length > 0 && 'deploymentId' in health && health.deploymentId === expectedDeploymentId, '/healthz did not return the expected Worker deployment marker');
  }
}

export interface WorkerReadinessOptions extends RetryOptions {
  url: string; expectedDeploymentId?: string; fetchImpl?: typeof fetch; timeoutMs?: number;
}
const probeSignal = (signal?: AbortSignal, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): AbortSignal =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

export async function verifyWorkerReadiness(options: WorkerReadinessOptions): Promise<void> {
  await retryProbe('Worker readiness', async () => {
    const response = await (options.fetchImpl ?? fetch)(options.url, {
      headers: { accept: 'application/json' }, signal: probeSignal(options.signal, options.timeoutMs)
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`status ${response.status}`); }
    validateHealthContract(JSON.parse(new TextDecoder().decode(await readResponseBytes(response, 16 * 1024))), options.expectedDeploymentId);
  }, options);
}

type SamplePayload = Awaited<ReturnType<ApiClient['sample']>>;

const SAMPLE_CANDIDATES = [[40.5, 44.5], [50, 10], [39, -98]] as const;

function sampleCandidates(manifest: ManifestV5): Array<readonly [number, number]> {
  const [west, south, east, north] = manifest.descriptors.bounds;
  const candidates: Array<readonly [number, number]> = [[(south + north) / 2, (west + east) / 2], ...SAMPLE_CANDIDATES];
  return candidates.filter(([lat, lon], index) => lat >= south && lat <= north && lon >= west && lon <= east
    && candidates.findIndex(([otherLat, otherLon]) => otherLat === lat && otherLon === lon) === index);
}

async function coveredPoint(client: ApiClient, build: PinnedBuild, layers: readonly LayerId[], signal?: AbortSignal) {
  const frame = build.manifest.frames[0]!.id;
  for (const [lat, lon] of sampleCandidates(build.manifest)) {
    const payload = await client.sample(build, { lat, lon, frames: [frame], layers, signal });
    if (payload.frames.some(frame => layers.some(layer => {
      const value: SamplePayload['frames'][number]['layers'][string] | undefined = frame.layers[layer];
      return value && value.status !== 'outside-domain';
    }))) return { lat, lon };
  }
  throw new Error(`Sample probe did not reach output coverage for ${layers.join(',')}`);
}

async function probeSamples(client: ApiClient, build: PinnedBuild, signal?: AbortSignal): Promise<void> {
  const { manifest } = build, frames = manifest.frames.map(frame => frame.id);
  const sample = (lat: number, lon: number, layers: readonly LayerId[], selection: 'all' | readonly string[]) =>
    client.sample(build, { lat, lon, frames: selection, layers, signal });
  for (const surface of manifest.surfaces) {
    invariant(surface.layers.length > 0, `Surface ${surface.id} has no layers`);
    const point = await coveredPoint(client, build, surface.layers, signal);
    const available = surface.kind === 'fine' ? renderedFrames(manifest).map(frame => frame.id) : frames;
    const pageSize = Math.floor(manifest.descriptors.maxSampleValues / surface.layers.length);
    invariant(pageSize > 0, 'Surface layers exceed the point value budget');
    for (let start = 0; start < available.length; start += pageSize) await sample(point.lat, point.lon, surface.layers, available.slice(start, start + pageSize));
    if (available.length === frames.length && frames.length <= pageSize) await sample(point.lat, point.lon, surface.layers, 'all');
    if (surface.kind === 'native' && surface.profiles) {
      const profilePage = Math.max(1, maxProfileFrames(surface.profiles.levelCount, surface.layers.length));
      for (let start = 0; start < frames.length; start += profilePage) {
        const payload = await client.profile(build, { ...point, frames: frames.slice(start, start + profilePage), layers: surface.layers, signal });
        invariant(payload.cell !== null && payload.frames.some(frame => frame.profile.status === 'valid' && frame.profile.levels.length > 0), 'Covered native profile probe found no atmospheric levels');
      }
      await client.samples(build, { points: [point, point], frames: [frames.at(-1)!], layers: surface.layers, signal });
    }
  }
}

const measuredRoutes = ['latest', 'sample', 'samples', 'profile', 'tile', 'provenance'] as const;
type MeasuredRoute = typeof measuredRoutes[number];
export interface ProbeReading {
  status: number; elapsedMs: number; responseCache?: string; r2Reads?: number; r2Bytes?: number;
  serverTimingMs?: Partial<Record<'worker' | 'admit' | 'r2', number>>;
}

function requestReading(path: string, response: Response, startedAt: number): [MeasuredRoute, ProbeReading] | undefined {
  const name = path.startsWith('/tiles/') ? 'tile' : path.slice(path.lastIndexOf('/') + 1);
  const route = measuredRoutes.find(route => route === name);
  if (!route) return;
  const counter = (name: string) => {
    const raw = response.headers.get(name);
    const value = raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(value) ? value : undefined;
  };
  const cache = response.headers.get('x-av-response-cache');
  const timings = (response.headers.get('server-timing') ?? '').matchAll(/(?:^|,)\s*(worker|admit|r2);dur=(\d+(?:\.\d+)?)(?=\s*(?:,|$))/g);
  const serverTimingMs = Object.fromEntries(Array.from(timings, ([, name, value]) => [name, Number(value)]).filter(([, value]) => Number.isFinite(value)));
  return [route, { status: response.status, elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    responseCache: cache && ['hit', 'miss', 'bypass', 'not-applicable'].includes(cache) ? cache : undefined,
    r2Reads: counter('x-av-r2-reads'), r2Bytes: counter('x-av-r2-bytes'),
    ...(Object.keys(serverTimingMs).length ? { serverTimingMs } : {}) }];
}

/** One live serving check for deployment and monitoring, pinned to a single immutable build. */
export async function probeApi(options: {
  baseUrl: string; model: string; expectedDeploymentId?: string; requireLive?: boolean;
  expectedBuild?: Pick<ManifestV5, 'buildId' | 'frames' | 'layers'>; signal?: AbortSignal;
  fetchImpl?: typeof fetch; now?: () => number; observeManifest?: (manifest: ManifestV5) => void;
  observeProbe?: (route: MeasuredRoute, reading: ProbeReading) => void;
  observeClient?: (metric: ApiClientMetric) => void;
}): Promise<ManifestV5> {
  const baseUrl = options.baseUrl.replace(/\/+$/, ''), request = options.fetchImpl ?? fetch;
  const fetchImpl: typeof fetch = options.observeProbe ? async (input, init) => {
    const startedAt = performance.now(), response = await request(input, init);
    const observation = requestReading(new URL(input instanceof Request ? input.url : input).pathname, response, startedAt);
    if (observation) options.observeProbe!(...observation);
    return response;
  } : request;
  await verifyWorkerReadiness({ url: `${baseUrl}/healthz`, expectedDeploymentId: options.expectedDeploymentId, fetchImpl, signal: options.signal });
  const get = async (path: string, accept: string, limit?: number) => {
    const response = await fetchImpl(`${baseUrl}${path}`, { headers: { accept }, cache: 'no-store', signal: probeSignal(options.signal) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`${response.status} ${path}`); }
    return { response, bytes: await readResponseBytes(response, limit) };
  };
  const json = async (path: string, limit?: number) => JSON.parse(new TextDecoder().decode((await get(path, 'application/json', limit)).bytes));
  const catalog = await json('/v1/catalog') as { models?: Array<{ model?: string; available?: boolean; error?: string }> };
  invariant(Array.isArray(catalog.models) && catalog.models.some(item => item.model === options.model && item.available === true), `Catalog reports no publication for ${options.model}`);
  const client = new ApiClient({ baseUrl, fetchImpl, requestTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS, now: options.now, onMetric: options.observeClient });
  const build = await client.latest(options.model, { requireLive: options.requireLive ?? true, signal: options.signal });
  const { manifest } = build, frame = manifest.frames[0].id;
  if (options.expectedBuild) {
    invariant(manifest.buildId === options.expectedBuild.buildId, 'Latest API build has not reached the published build');
    invariant(JSON.stringify(manifest.frames) === JSON.stringify(options.expectedBuild.frames) && JSON.stringify(manifest.layers) === JSON.stringify(options.expectedBuild.layers), 'Published frame or layer listing differs from the API');
  }
  options.observeManifest?.(manifest);
  const runs = await json(`/v1/models/${options.model}/runs`) as { retained?: Array<{ buildId?: string }> };
  invariant(Array.isArray(runs.retained) && runs.retained.some(item => item.buildId === manifest.buildId), '/runs omitted the latest build');
  await probeSamples(client, build, options.signal);
  const provenancePath = `/v1/models/${options.model}/runs/${manifest.buildId}/provenance`;
  const provenance = parseProvenance(await json(provenancePath, MAX_PROVENANCE_BYTES), manifest);
  if (provenance.version === 2) {
    const reference = provenance.frames[0]!;
    parseFrameProvenance(await json(`${provenancePath}?frame=${encodeURIComponent(reference.frame)}`, reference.bytes), manifest, manifest.frames[0]!);
  }
  const tileLayer = renderedLayers(manifest.layers, manifest.descriptors.layers)[0];
  invariant(tileLayer, 'Publication has no rendered layer');
  const { response, bytes } = await get(`/tiles/${options.model}/${manifest.buildId}/${tileLayer}/${frame}/0/0/0.webp`, 'image/webp');
  invariant(response.headers.get('content-type') === 'image/webp', 'tile did not return image/webp');
  invariant(response.headers.get('access-control-allow-origin') === '*', 'tile omitted CORS');
  invariant(response.headers.get('cache-control')?.includes('max-age='), 'tile omitted bounded cache-control');
  const decoder = new TextDecoder();
  invariant(bytes.length >= 25 && decoder.decode(bytes.subarray(0, 4)) === 'RIFF' && decoder.decode(bytes.subarray(8, 12)) === 'WEBP', 'tile body is not WebP');
  return manifest;
}

/** Deployment checks every registered model, accepting absent event-driven publications. */
export async function verifyApiDeployment(options: {
  baseUrl: string; expectedDeploymentId: string; signal?: AbortSignal; fetchImpl?: typeof fetch;
}): Promise<void> {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  await verifyWorkerReadiness({ ...options, url: `${baseUrl}/healthz` });
  const client = new ApiClient({ baseUrl, fetchImpl: options.fetchImpl, requestTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS });
  const catalog = await client.catalog({ signal: options.signal });
  invariant(new Set(catalog.map(entry => entry.model)).size === catalog.length, 'Catalog repeats a forecast model');
  const published = PRODUCTS.filter(product => {
    const entry = catalog.find(entry => entry.model === product.modelId);
    invariant(entry, `Catalog omitted registered forecast model ${product.modelId}`);
    if (entry.available) return true;
    invariant(product.execution.schedule.length === 0 && entry.error === 'publication-unavailable',
      `Catalog reports no publication for ${product.modelId}: ${entry.error ?? 'unknown error'}`);
    console.log(`Deployment: ${product.modelId} has no publication; awaiting an external forecast cycle`);
    return false;
  });
  for (const product of published) await probeApi({ ...options, baseUrl, model: product.modelId });
}

export async function verifyPublishedForecast(options: RetryOptions & { baseUrl: string; manifest: Pick<ManifestV5, 'model' | 'buildId' | 'frames' | 'layers'>; fetchImpl?: typeof fetch }): Promise<void> {
  const signal = probeSignal(options.signal, 60_000);
  await retryProbe('Published forecast', async () => {
    await probeApi({ baseUrl: options.baseUrl, model: options.manifest.model, expectedBuild: options.manifest, fetchImpl: options.fetchImpl, signal });
  }, { ...options, signal });
}
