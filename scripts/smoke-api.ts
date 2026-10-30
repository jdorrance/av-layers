import { pathToFileURL } from 'node:url';
import { manifestSchema, LAYER_IDS, type Manifest } from '@av/contracts';

export const SAMPLE_STATUSES = ['valid', 'no-usable-lift', 'unavailable', 'outside-domain'] as const;
export type SampleStatus = typeof SAMPLE_STATUSES[number];

export interface SampleCell {
  value: unknown;
  status: unknown;
  support: unknown;
  interpolated: unknown;
}

export interface SampleContract {
  model?: unknown;
  buildId?: unknown;
  frames?: Array<{ id?: unknown; layers?: Record<string, SampleCell> }>;
  coverage?: unknown;
  method?: unknown;
  source?: unknown;
  expiresAt?: unknown;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function isSampleStatus(value: unknown): value is SampleStatus {
  return typeof value === 'string' && (SAMPLE_STATUSES as readonly string[]).includes(value);
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

export function validateSampleContract(sample: SampleContract, model: string, buildId: string, frame: string, requestedLayers: string[]): void {
  invariant(sample.model === model, '/sample did not echo model');
  invariant(sample.buildId === buildId, '/sample did not echo build');
  invariant(Array.isArray(sample.frames), '/sample omitted frames');
  invariant(sample.frames.length === 1, '/sample did not return exactly one frame');
  invariant(sample.frames[0]?.id === frame, '/sample returned the wrong frame');
  for (const layer of requestedLayers) {
    const cell = sample.frames[0]?.layers?.[layer];
    invariant(cell, `/sample omitted ${layer}`);
    invariant('value' in cell, `/sample omitted ${layer} value`);
    invariant(isSampleStatus(cell.status), `/sample returned invalid ${layer} status`);
    invariant(typeof cell.support === 'number', `/sample omitted ${layer} support`);
    invariant(typeof cell.interpolated === 'boolean', `/sample omitted ${layer} interpolated`);
  }
  invariant(sample.coverage, '/sample omitted coverage');
  invariant(sample.method, '/sample omitted method');
  invariant(sample.source, '/sample omitted source');
  invariant(sample.expiresAt, '/sample omitted expiry');
}

async function main(): Promise<void> {
  const baseUrl = (arg('base-url') ?? (() => { throw new Error('--base-url is required'); })()).replace(/\/+$/, '');
  const model = arg('model') ?? 'gfs';
  const lat = arg('lat') ?? '32.9';
  const lon = arg('lon') ?? '-117.25';
  const expectedDeploymentId = arg('expected-deployment-id');

  const health = await get(`${baseUrl}/healthz`, 'application/json');
  validateHealthContract(await health.json(), expectedDeploymentId);

  const catalog = await get(`${baseUrl}/v1/catalog`, 'application/json');
  const catalogBody = await catalog.json() as { models?: Array<{ model?: string; available?: boolean }> };
  invariant(Array.isArray(catalogBody.models), '/v1/catalog did not return models');
  const entry = catalogBody.models.find(item => item.model === model);
  invariant(entry?.available === true, `/v1/catalog reports no available publication for ${model}`);

  const latestResponse = await get(`${baseUrl}/v1/models/${model}/latest?expand=manifest`, 'application/json');
  const latest = await latestResponse.json() as { pointer?: unknown; manifest?: unknown; templates?: Record<string, string>; freshness?: unknown };
  invariant(latest.pointer && latest.manifest, '/latest?expand=manifest omitted pointer or manifest');
  const manifest: Manifest = manifestSchema.parse(latest.manifest);
  invariant(manifest.layers.every(layer => layer in (latest.templates ?? {})), '/latest templates omit a published layer');
  invariant(latest.freshness && typeof latest.freshness === 'object', '/latest omitted freshness');

  const runs = await get(`${baseUrl}/v1/models/${model}/runs`, 'application/json');
  const runBody = await runs.json() as { retained?: Array<{ buildId?: string }> };
  invariant(Array.isArray(runBody.retained) && runBody.retained.some(item => item.buildId === manifest.buildId), '/runs omitted the latest build');

  const frame = arg('frame') ?? manifest.frames[0]!.id;
  const requestedLayers = (arg('layers') ?? LAYER_IDS.join(',')).split(',').filter(Boolean);
  invariant(manifest.frames.some(item => item.id === frame), `unknown frame ${frame}`);
  invariant(requestedLayers.every(layer => (manifest.layers as string[]).includes(layer)), 'requested layer not published');

  const sampleUrl = `${baseUrl}/v1/models/${model}/runs/${manifest.buildId}/sample?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&frame=${encodeURIComponent(frame)}&layers=${encodeURIComponent(requestedLayers.join(','))}`;
  const sampleResponse = await get(sampleUrl, 'application/json');
  validateSampleContract(await sampleResponse.json() as SampleContract, model, manifest.buildId, frame, requestedLayers);

  const tileUrl = `${baseUrl}/tiles/${model}/${manifest.buildId}/${manifest.layers[0]}/${frame}/0/0/0.webp`;
  const tile = await get(tileUrl, 'image/webp');
  invariant(tile.headers.get('content-type') === 'image/webp', 'tile did not return image/webp');
  invariant(tile.headers.get('access-control-allow-origin') === '*', 'tile omitted CORS');
  invariant(tile.headers.get('cache-control')?.includes('max-age='), 'tile omitted bounded cache-control');

  console.log(`smoke-api: ok ${baseUrl} ${model} ${manifest.buildId} frame ${frame}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`smoke-api: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
