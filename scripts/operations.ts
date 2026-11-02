import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { getProduct } from '@av/contracts';
import { MAX_FORECAST_SHARDS } from '../apps/batch/src/parallel.js';
import { workflowAuthority } from '../apps/batch/src/authority.js';
import { r2Storage } from '../apps/batch/src/storage.js';
import { assertCurrentMain, downloadForecastArtifact, finalizeAndPublish, planForecast, resumePublication, runForecastShard } from './publication-workflow.js';
import { probeApi, readResponseBytes, retryProbe, type RetryOptions } from './smoke-api.js';

export type EnvironmentName = 'staging' | 'production';
export type WranglerConfig = Record<EnvironmentName, { name: string; bucket: string }>;
export interface CiEnvironment {
  targetEnv: EnvironmentName; accountId: string; apiToken: string;
  pagesProjectName: string; apiBaseUrl: string;
}
export interface PublicationEnvironment {
  targetEnv: EnvironmentName; accountId: string; r2Bucket: string;
  r2AccessKeyId: string; r2SecretAccessKey: string;
}
const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
function environment(env: NodeJS.ProcessEnv): { targetEnv: EnvironmentName; accountId: string } {
  const targetEnv = env.TARGET_ENV;
  if (targetEnv !== 'staging' && targetEnv !== 'production') throw new Error('TARGET_ENV must be staging or production');
  const accountId = required(env, 'CLOUDFLARE_ACCOUNT_ID');
  if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32 character hex account ID');
  return { targetEnv, accountId };
}

/** Deployment and publication use the same checked-in destination definitions as Wrangler. */
export function loadWranglerConfig(path = fileURLToPath(new URL('../apps/api/wrangler.json', import.meta.url))): WranglerConfig {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    env?: Record<string, { name?: string; r2_buckets?: Array<{ binding?: string; bucket_name?: string }> }>;
  };
  const read = (name: EnvironmentName) => {
    const value = parsed.env?.[name], bucket = value?.r2_buckets?.find(item => item.binding === 'BUCKET')?.bucket_name;
    if (!value?.name || !bucket) throw new Error(`Wrangler configuration is missing ${name} name or BUCKET binding`);
    return { name: value.name, bucket };
  };
  return { staging: read('staging'), production: read('production') };
}

export function validateCiEnvironment(env: NodeJS.ProcessEnv, config = loadWranglerConfig()): CiEnvironment {
  const common = environment(env), apiToken = required(env, 'CLOUDFLARE_API_TOKEN');
  const pagesProjectName = required(env, 'PAGES_PROJECT_NAME');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/.test(pagesProjectName)) throw new Error('PAGES_PROJECT_NAME must be a lowercase project slug');
  const url = new URL(required(env, 'API_BASE_URL'));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('API_BASE_URL must be a root HTTPS URL without credentials, query or fragment');
  const workerName = config[common.targetEnv].name;
  if (url.hostname.endsWith('.workers.dev') && !url.hostname.startsWith(`${workerName}.`)) throw new Error(`API_BASE_URL must name Worker ${workerName}`);
  return { ...common, apiToken, pagesProjectName, apiBaseUrl: url.origin };
}

export function validatePublicationEnvironment(env: NodeJS.ProcessEnv, config = loadWranglerConfig()): PublicationEnvironment {
  const common = environment(env);
  return { ...common, r2Bucket: config[common.targetEnv].bucket,
    r2AccessKeyId: required(env, 'R2_ACCESS_KEY_ID'), r2SecretAccessKey: required(env, 'R2_SECRET_ACCESS_KEY') };
}

/** Query the canonical Pages hostname, including Cloudflare's possible collision suffix. */
export async function verifyPagesProduction(env: CiEnvironment, fetchImpl: typeof fetch = fetch): Promise<{ url: string }> {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.accountId}/pages/projects/${env.pagesProjectName}`, {
    headers: { authorization: `Bearer ${env.apiToken}` }, signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Reading Pages project failed with status ${response.status}`); }
  const body = JSON.parse(new TextDecoder().decode(await readResponseBytes(response))) as { success?: boolean; result?: { name?: string; production_branch?: string; subdomain?: string } };
  const project = body.result;
  if (body.success !== true || project?.name !== env.pagesProjectName || project.production_branch !== 'main' || typeof project.subdomain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.pages\.dev$/.test(project.subdomain)) throw new Error('Pages project must match the configured name, main branch and canonical pages.dev hostname');
  return { url: `https://${project.subdomain}` };
}

export function deploymentMarker(expectedDeploymentId: string): string {
  if (!/^[0-9a-f]{40}-\d{1,20}-\d{1,10}$/i.test(expectedDeploymentId)) throw new Error('EXPECTED_DEPLOYMENT_ID must be a commit SHA, run ID and run attempt');
  return `name="build-deployment" content="${expectedDeploymentId}"`;
}
export async function verifyPagesRevision(options: RetryOptions & {
  url: string; expectedDeploymentId: string; fetchImpl?: typeof fetch; timeoutMs?: number;
}): Promise<void> {
  const marker = deploymentMarker(options.expectedDeploymentId);
  await retryProbe('Pages revision', async () => {
    const response = await (options.fetchImpl ?? fetch)(options.url, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`status ${response.status}`); }
    if (!new TextDecoder().decode(await readResponseBytes(response)).includes(marker)) throw new Error('served HTML does not contain the expected revision marker');
  }, options);
}

export async function verifyWindyPluginBundle(options: RetryOptions & {
  url: string; expectedApiBaseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number;
}): Promise<void> {
  const target = `${options.url.replace(/\/+$/, '')}/windy-plugin/plugin.min.js`;
  await retryProbe('Windy plugin bundle', async () => {
    const response = await (options.fetchImpl ?? fetch)(target, { headers: { accept: 'text/javascript,*/*' }, signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`status ${response.status}`); }
    if (response.headers.get('access-control-allow-origin') !== 'https://www.windy.com') {
      await response.body?.cancel();
      throw new Error('Windy plugin bundle is missing CORS header for https://www.windy.com');
    }
    const script = new TextDecoder().decode(await readResponseBytes(response, 512 * 1024));
    if (!script.includes('windy-plugin-av-layer')) throw new Error('Windy plugin bundle does not contain windy-plugin-av-layer');
    if (options.expectedApiBaseUrl && !script.includes(options.expectedApiBaseUrl)) throw new Error('Windy plugin bundle does not contain the expected API base URL');
  }, options);
}

const OPERATIONS = ['deploy', 'forecast-plan', 'forecast-shard', 'forecast', 'maintenance'] as const;
type Operation = typeof OPERATIONS[number];
const OPERATION_USAGE = `Usage: pnpm operations ${OPERATIONS.join('|')}`;
export function validateOperationInputs(command: string, env: NodeJS.ProcessEnv = process.env): asserts command is Operation {
  if (!(OPERATIONS as readonly string[]).includes(command)) throw new Error(OPERATION_USAGE);
  if (!['staging', 'production'].includes(env.TARGET_ENV ?? '')) throw new Error('TARGET_ENV must be staging or production');
  if (command !== 'deploy' && !getProduct(env.MODEL ?? 'gfs')) throw new Error('Unknown forecast model');
  if (command.startsWith('forecast') && env.RESUME_RUN_ID) {
    if (command !== 'forecast') throw new Error('Only forecast accepts resume-run-id');
    if (!/^[1-9]\d{0,19}$/.test(env.RESUME_RUN_ID)) throw new Error('resume-run-id must be numeric');
  }
  if (command === 'forecast-shard' && (!/^(0|[1-9]\d*)$/.test(env.SHARD_ID ?? '') || Number(env.SHARD_ID) >= MAX_FORECAST_SHARDS)) throw new Error(`SHARD_ID must identify one of at most ${MAX_FORECAST_SHARDS} forecast shards`);
  if (command === 'maintenance') {
    if (env.ACTION !== 'rollback' && env.ACTION !== 'cleanup') throw new Error('Maintenance action must be rollback or cleanup');
    if (env.ACTION === 'rollback' && !/^\d{8}T\d{6}Z-[a-f0-9-]{36}$/.test(env.BUILD_ID ?? '')) throw new Error('Invalid rollback build ID');
    if (env.ACTION === 'cleanup' && env.BUILD_ID) throw new Error('Only rollback accepts a build ID');
  }
}

/** Each child is a normal package command; cancellation stops its complete process group. */
async function pnpm(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const child = spawn('pnpm', args, { stdio: 'inherit', env, detached: true });
  let cancelled = false, killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (signal: NodeJS.Signals): void => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  const abort = (): void => { cancelled = true; stop('SIGTERM'); killTimer ??= setTimeout(() => stop('SIGKILL'), 10_000); };
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const code = await new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('close', accept); });
    if (cancelled || code !== 0) throw new Error(cancelled ? 'Operation interrupted' : `pnpm ${args.join(' ')} exited ${code}`);
  } finally {
    if (killTimer) clearTimeout(killTimer);
    if (cancelled) stop('SIGKILL');
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
  }
}

export async function runOperation(command: string): Promise<void> {
  validateOperationInputs(command);
  await assertCurrentMain();
  if (command === 'forecast-shard') {
    await pnpm(['tools:pmtiles']);
    await runForecastShard(Number(process.env.SHARD_ID));
    return;
  }
  if (command !== 'deploy') {
    const config = validatePublicationEnvironment(process.env);
    const store = r2Storage({ ...process.env, R2_BUCKET: config.r2Bucket });
    if (command === 'forecast-plan') {
      const shards = await planForecast(store);
      if (process.env.GITHUB_OUTPUT) {
        const artifact = `forecast-plan-${process.env.MODEL ?? 'gfs'}-${required(process.env, 'GITHUB_RUN_ID')}-${required(process.env, 'GITHUB_RUN_ATTEMPT')}`;
        appendFileSync(process.env.GITHUB_OUTPUT, `ready=${shards !== null}\nshards=${JSON.stringify(shards ?? [])}\nartifact=${artifact}\n`);
      }
    } else if (command === 'forecast') {
      if (process.env.RESUME_RUN_ID) await resumePublication(await downloadForecastArtifact(process.env.RESUME_RUN_ID), store);
      else await finalizeAndPublish(store);
    } else {
      const { maintenanceWorkflow } = await import('../apps/batch/src/maintenance.js');
      console.log(JSON.stringify(await maintenanceWorkflow({ action: process.env.ACTION as 'rollback' | 'cleanup', model: process.env.MODEL ?? 'gfs', buildId: process.env.BUILD_ID || undefined, authority: workflowAuthority(), store })));
    }
    return;
  }
  const cloud = validateCiEnvironment(process.env);
  const deploymentId = `${required(process.env, 'GITHUB_SHA')}-${required(process.env, 'GITHUB_RUN_ID')}-${required(process.env, 'GITHUB_RUN_ATTEMPT')}`;
  deploymentMarker(deploymentId);
  const pages = await verifyPagesProduction(cloud);
  await pnpm(['--filter', '@av/preview', 'build'], { ...process.env, AV_API_BASE: cloud.apiBaseUrl, VITE_BUILD_REVISION: deploymentId });
  await assertCurrentMain();
  await pnpm(['--filter', '@av/api', 'exec', 'wrangler', 'deploy', '--env', cloud.targetEnv, '--var', `AV_DEPLOYMENT_ID:${deploymentId}`]);
  await probeApi({ baseUrl: cloud.apiBaseUrl, model: process.env.MODEL ?? 'gfs', expectedDeploymentId: deploymentId });
  await pnpm(['exec', 'wrangler', 'pages', 'deploy', 'apps/preview/dist', '--project-name', cloud.pagesProjectName, '--branch', 'main']);
  await verifyPagesRevision({ url: pages.url, expectedDeploymentId: deploymentId });
  await verifyWindyPluginBundle({ url: pages.url, expectedApiBaseUrl: cloud.apiBaseUrl });
  console.log(`Deployed ${cloud.targetEnv}: ${cloud.apiBaseUrl} and ${pages.url}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Deployed ${cloud.targetEnv}\n\nAPI: ${cloud.apiBaseUrl}\n\nPages: ${pages.url}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) { console.error(OPERATION_USAGE); process.exitCode = 1; }
  else runOperation(process.argv[2]!).catch(error => { console.error(error); process.exitCode = 1; });
}
