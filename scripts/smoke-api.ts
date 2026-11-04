import { DEFAULT_PROBE_TIMEOUT_MS, type LayerId, type PublishedManifest } from '@av/contracts';
import { ApiClient, type PinnedBuild } from '@av/contracts/client';

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

function sampleCandidates(manifest: PublishedManifest): Array<readonly [number, number]> {
  const [west, south, east, north] = manifest.descriptors.bounds;
  const candidates: Array<readonly [number, number]> = [[(south + north) / 2, (west + east) / 2], ...SAMPLE_CANDIDATES];
  return candidates.filter(([lat, lon], index) => lat >= south && lat <= north && lon >= west && lon <= east
    && candidates.findIndex(([otherLat, otherLon]) => otherLat === lat && otherLon === lon) === index);
}

function hitsCoverage(payload: SamplePayload, layers: readonly LayerId[]): boolean {
  return payload.frames.some(frame => layers.some(layer => frame.layers[layer]?.status !== 'outside-domain'));
}

async function coveredPoint(client: ApiClient, build: PinnedBuild, layers: readonly LayerId[], signal?: AbortSignal) {
  const frame = build.manifest.frames[0]!.id;
  for (const [lat, lon] of sampleCandidates(build.manifest)) {
    const payload = await client.sample(build, { lat, lon, frames: [frame], layers, signal });
    if (hitsCoverage(payload, layers)) return { lat, lon };
  }
  throw new Error(`Sample probe did not reach output coverage for ${layers.join(',')}`);
}

async function probeSamples(client: ApiClient, build: PinnedBuild, signal?: AbortSignal): Promise<void> {
  const { manifest } = build, frames = manifest.frames.map(frame => frame.id);
  const sample = (lat: number, lon: number, layers: readonly LayerId[], selection: 'all' | readonly string[]) =>
    client.sample(build, { lat, lon, frames: selection, layers, signal });
  if (manifest.version === 5) {
    const kinds = new Set(manifest.surfaces.map(surface => surface.kind));
    if (manifest.model === 'gfs') invariant(kinds.has('native') && kinds.has('fine'), 'GFS v5 requires native precipitation and fine lift surfaces');
    for (const surface of manifest.surfaces) {
      invariant(surface.layers.length > 0, `Surface ${surface.id} has no layers`);
      const point = await coveredPoint(client, build, surface.layers, signal);
      if (frames.length > 1) await sample(point.lat, point.lon, surface.layers, frames);
      await sample(point.lat, point.lon, surface.layers, 'all');
    }
    return;
  }
  await coveredPoint(client, build, manifest.layers, signal);
}

/** One live serving check for deployment and monitoring, pinned to a single immutable build. */
export async function probeApi(options: {
  baseUrl: string; model: string; expectedDeploymentId?: string; requireLive?: boolean;
  expectedModels?: readonly string[]; expectedBuild?: Pick<PublishedManifest, 'buildId' | 'frames' | 'layers'>; signal?: AbortSignal;
  fetchImpl?: typeof fetch; now?: () => number; observeManifest?: (manifest: PublishedManifest) => void;
}): Promise<PublishedManifest> {
  const baseUrl = options.baseUrl.replace(/\/+$/, ''), fetchImpl = options.fetchImpl ?? fetch;
  await verifyWorkerReadiness({ url: `${baseUrl}/healthz`, expectedDeploymentId: options.expectedDeploymentId, fetchImpl, signal: options.signal });
  const get = async (path: string, accept: string) => {
    const response = await fetchImpl(`${baseUrl}${path}`, { headers: { accept }, cache: 'no-store', signal: probeSignal(options.signal) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`${response.status} ${path}`); }
    return { response, bytes: await readResponseBytes(response) };
  };
  const json = async (path: string) => JSON.parse(new TextDecoder().decode((await get(path, 'application/json')).bytes));
  const catalog = await json('/v1/catalog') as { models?: Array<{ model?: string; available?: boolean; error?: string }> };
  invariant(Array.isArray(catalog.models) && catalog.models.some(item => item.model === options.model && item.available === true), `Catalog reports no publication for ${options.model}`);
  invariant(options.expectedModels?.every(model => catalog.models?.some(item => item.model === model)) ?? true, 'Catalog omitted a registered forecast model');
  const client = new ApiClient({ baseUrl, fetchImpl, requestTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS, now: options.now });
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
  const { response, bytes } = await get(`/tiles/${options.model}/${manifest.buildId}/${manifest.layers[0]}/${frame}/0/0/0.webp`, 'image/webp');
  invariant(response.headers.get('content-type') === 'image/webp', 'tile did not return image/webp');
  invariant(response.headers.get('access-control-allow-origin') === '*', 'tile omitted CORS');
  invariant(response.headers.get('cache-control')?.includes('max-age='), 'tile omitted bounded cache-control');
  const decoder = new TextDecoder();
  invariant(bytes.length >= 25 && decoder.decode(bytes.subarray(0, 4)) === 'RIFF' && decoder.decode(bytes.subarray(8, 12)) === 'WEBP', 'tile body is not WebP');
  return manifest;
}

export async function verifyPublishedForecast(options: RetryOptions & { baseUrl: string; manifest: PublishedManifest; fetchImpl?: typeof fetch }): Promise<void> {
  const signal = probeSignal(options.signal, 60_000);
  await retryProbe('Published forecast', async () => {
    await probeApi({ baseUrl: options.baseUrl, model: options.manifest.model, expectedBuild: options.manifest, fetchImpl: options.fetchImpl, signal });
  }, { ...options, signal });
}
