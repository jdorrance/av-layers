import { pathToFileURL } from 'node:url';
import { type LayerId } from '@av/contracts';
import { ApiClient } from '@av/contracts/client';

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
}

async function get(url: string, accept: string): Promise<Response> {
  const response = await fetch(url, { headers: { accept }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${response.status} ${url}: ${(await response.text()).slice(0, 300)}`);
  return response;
}

export function validateHealthContract(health: unknown, expectedDeploymentId?: string): void {
  invariant(health !== null && typeof health === 'object' && 'ok' in health && health.ok === true, '/healthz did not return ok:true');
  if (expectedDeploymentId !== undefined) {
    invariant(expectedDeploymentId.length > 0 && 'deploymentId' in health && health.deploymentId === expectedDeploymentId, '/healthz did not return the expected Worker deployment marker');
  }
}

export interface WorkerReadinessOptions {
  url: string;
  expectedDeploymentId?: string;
  fetchImpl?: typeof fetch;
  retries?: number;
  delayMs?: number;
  timeoutMs?: number;
}

export async function verifyWorkerReadiness(options: WorkerReadinessOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = options.retries ?? 3;
  const delay = options.delayMs ?? 5000;
  let last = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const response = await fetchImpl(options.url, {
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
      });
      if (!response.ok) {
        last = `status ${response.status}`;
        await response.body?.cancel();
        continue;
      }
      validateHealthContract(await response.json(), options.expectedDeploymentId);
      return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Worker readiness verification failed: ${last} (${options.url})`);
}

async function main(): Promise<void> {
  const baseUrl = (arg('base-url') ?? (() => { throw new Error('--base-url is required'); })()).replace(/\/+$/, '');
  const model = arg('model') ?? 'gfs';
  const lat = arg('lat') ?? '32.9';
  const lon = arg('lon') ?? '-117.25';
  const expectedDeploymentId = arg('expected-deployment-id');

  await verifyWorkerReadiness({ url: `${baseUrl}/healthz`, expectedDeploymentId });

  const catalog = await get(`${baseUrl}/v1/catalog`, 'application/json');
  const catalogBody = await catalog.json() as { models?: Array<{ model?: string; available?: boolean }> };
  invariant(Array.isArray(catalogBody.models), '/v1/catalog did not return models');
  const entry = catalogBody.models.find(item => item.model === model);
  invariant(entry?.available === true, `/v1/catalog reports no available publication for ${model}. Publish a forecast for this environment first. In GitHub Actions, start Forecast sample on current main, then Deploy Worker and Pages.`);

  const client = new ApiClient({ baseUrl, requestTimeoutMs: 30_000 });
  const build = await client.latest(model);
  const { manifest } = build;

  const runs = await get(`${baseUrl}/v1/models/${model}/runs`, 'application/json');
  const runBody = await runs.json() as { retained?: Array<{ buildId?: string }> };
  invariant(Array.isArray(runBody.retained) && runBody.retained.some(item => item.buildId === manifest.buildId), '/runs omitted the latest build');

  const frame = arg('frame') ?? manifest.frames[0]!.id;
  const requestedLayers = (arg('layers') ?? manifest.layers.join(',')).split(',').filter(Boolean);
  invariant(manifest.frames.some(item => item.id === frame), `unknown frame ${frame}`);
  invariant(requestedLayers.every(layer => (manifest.layers as string[]).includes(layer)), 'requested layer not published');

  await client.sample(build, { lat: Number(lat), lon: Number(lon), frames: [frame], layers: requestedLayers as LayerId[] });

  const tileUrl = `${baseUrl}/tiles/${model}/${manifest.buildId}/${manifest.layers[0]}/${frame}/0/0/0.webp`;
  const tile = await get(tileUrl, 'image/webp');
  invariant(tile.headers.get('content-type') === 'image/webp', 'tile did not return image/webp');
  invariant(tile.headers.get('access-control-allow-origin') === '*', 'tile omitted CORS');
  invariant(tile.headers.get('cache-control')?.includes('max-age='), 'tile omitted bounded cache-control');
  const bytes = new Uint8Array(await tile.arrayBuffer());
  const decoder = new TextDecoder();
  invariant(decoder.decode(bytes.subarray(0, 4)) === 'RIFF' && decoder.decode(bytes.subarray(8, 12)) === 'WEBP', 'tile body is not WebP');

  console.log(`smoke-api: ok ${baseUrl} ${model} ${manifest.buildId} frame ${frame}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`smoke-api: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
