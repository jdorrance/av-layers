import { DEFAULT_PROBE_TIMEOUT_MS, type Manifest } from '@av/contracts';
import { ApiClient } from '@av/contracts/client';

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

export interface RetryOptions { retries?: number; delayMs?: number }
export async function retryProbe(label: string, check: () => Promise<void>, options: RetryOptions = {}): Promise<void> {
  let last = '';
  for (let attempt = 0; attempt <= (options.retries ?? 12); attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 5000));
    try { await check(); return; }
    catch (error) { last = error instanceof Error ? error.message : String(error); }
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
export async function verifyWorkerReadiness(options: WorkerReadinessOptions): Promise<void> {
  await retryProbe('Worker readiness', async () => {
    const response = await (options.fetchImpl ?? fetch)(options.url, {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`status ${response.status}`); }
    validateHealthContract(JSON.parse(new TextDecoder().decode(await readResponseBytes(response, 16 * 1024))), options.expectedDeploymentId);
  }, options);
}

/** One live serving check for deployment and monitoring, pinned to a single immutable build. */
export async function probeApi(options: {
  baseUrl: string; model: string; expectedDeploymentId?: string; requireLive?: boolean;
  fetchImpl?: typeof fetch; now?: () => number; observeManifest?: (manifest: Manifest) => void;
}): Promise<Manifest> {
  const baseUrl = options.baseUrl.replace(/\/+$/, ''), fetchImpl = options.fetchImpl ?? fetch;
  await verifyWorkerReadiness({ url: `${baseUrl}/healthz`, expectedDeploymentId: options.expectedDeploymentId, fetchImpl });
  const get = async (path: string, accept: string) => {
    const response = await fetchImpl(`${baseUrl}${path}`, { headers: { accept }, signal: AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`${response.status} ${path}`); }
    return { response, bytes: await readResponseBytes(response) };
  };
  const json = async (path: string) => JSON.parse(new TextDecoder().decode((await get(path, 'application/json')).bytes));
  const catalog = await json('/v1/catalog') as { models?: Array<{ model?: string; available?: boolean; error?: string }> };
  invariant(Array.isArray(catalog.models) && catalog.models.some(item => item.model === options.model && item.available === true), `Catalog reports no publication for ${options.model}`);
  const client = new ApiClient({ baseUrl, fetchImpl, requestTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS, now: options.now });
  const build = await client.latest(options.model, { requireLive: options.requireLive ?? true });
  const { manifest } = build, frame = manifest.frames[0].id;
  options.observeManifest?.(manifest);
  const runs = await json(`/v1/models/${options.model}/runs`) as { retained?: Array<{ buildId?: string }> };
  invariant(Array.isArray(runs.retained) && runs.retained.some(item => item.buildId === manifest.buildId), '/runs omitted the latest build');
  await client.sample(build, { lat: 32.9, lon: -117.25, frames: [frame] });
  const { response, bytes } = await get(`/tiles/${options.model}/${manifest.buildId}/${manifest.layers[0]}/${frame}/0/0/0.webp`, 'image/webp');
  invariant(response.headers.get('content-type') === 'image/webp', 'tile did not return image/webp');
  invariant(response.headers.get('access-control-allow-origin') === '*', 'tile omitted CORS');
  invariant(response.headers.get('cache-control')?.includes('max-age='), 'tile omitted bounded cache-control');
  const decoder = new TextDecoder();
  invariant(bytes.length >= 25 && decoder.decode(bytes.subarray(0, 4)) === 'RIFF' && decoder.decode(bytes.subarray(8, 12)) === 'WEBP', 'tile body is not WebP');
  return manifest;
}
