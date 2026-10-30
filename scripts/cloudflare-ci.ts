import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
export const R2_BUCKET_NOT_FOUND_CODE = 10006;
export const PAGES_PROJECT_NOT_FOUND_CODE = 8000007;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type EnvironmentName = 'staging' | 'production';

export interface CiEnvironment {
  targetEnv: EnvironmentName;
  accountId: string;
  apiToken: string;
  r2Bucket: string;
  pagesProjectName: string;
  apiBaseUrl: string;
}

export interface PublicationEnvironment {
  targetEnv: EnvironmentName;
  accountId: string;
  r2Bucket: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
}

export interface WranglerEnvironment {
  name: string;
  bucket: string;
}

export type WranglerConfig = Record<EnvironmentName, WranglerEnvironment>;

interface CloudflareEnvelope {
  success?: unknown;
  result?: unknown;
  errors?: unknown;
}

interface CloudflareResult {
  status: number;
  body: CloudflareEnvelope;
}

interface ManagedDomain {
  enabled: boolean;
}

interface PagesProject {
  name: string;
  subdomain: string;
  production_branch: 'main';
}

export interface ProvisionSummary {
  environment: EnvironmentName;
  bucket: string;
  bucketCreated: boolean;
  bucketPublicDevUrlEnabled: boolean;
  pagesProject: string;
  pagesProjectCreated: boolean;
  pagesUrl: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const required = (env: Record<string, string | undefined>, name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const sameValue = (actual: string, expected: string, name: string): void => {
  if (actual !== expected) throw new Error(`${name} must equal ${expected}`);
};

const recordValue = (value: unknown, action: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${action} returned a malformed result`);
  return value as Record<string, unknown>;
};

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const values = parts.map(part => /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN);
  return values.every(value => Number.isInteger(value) && value >= 0 && value <= 255) ? values : null;
}

function isNonPublicIpv4(values: number[]): boolean {
  const [first, second] = values;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second! >= 64 && second! <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second! >= 16 && second! <= 31)
    || (first === 192 && (second === 0 || second === 168))
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51)
    || (first === 203 && second === 0)
    || first! >= 224;
}

function isNonPublicIpv6(host: string): boolean {
  const value = host.toLowerCase();
  if (value.includes('%') || value === '::' || value === '::1') return true;
  if (/^fe[89ab]/.test(value) || /^f[cd]/.test(value) || /^ff/.test(value)) return true;
  if (value.startsWith('::ffff:')) return true;
  const groups = value.split(':');
  if (groups.length === 8) {
    const numbers = groups.map(group => Number.parseInt(group || '0', 16));
    if (numbers.slice(0, 7).every(number => number === 0) && (numbers[7] === 0 || numbers[7] === 1)) return true;
  }
  return false;
}

function validatePublicApiUrl(raw: string, workerName: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('API_BASE_URL must be an absolute HTTPS URL');
  }
  if (url.protocol !== 'https:') throw new Error('API_BASE_URL must use HTTPS');
  if (url.username || url.password) throw new Error('API_BASE_URL must not contain credentials');
  if (url.search || url.hash) throw new Error('API_BASE_URL must not contain a query or fragment');
  if (url.pathname !== '/') throw new Error('API_BASE_URL must be a root URL without a path');
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const ipv4 = parseIpv4(host);
  if (ipv4) {
    if (isNonPublicIpv4(ipv4)) throw new Error('API_BASE_URL must not target a localhost, private, or loopback address');
  } else if (host.includes(':')) {
    if (isNonPublicIpv6(host)) throw new Error('API_BASE_URL must not target a localhost, private, or loopback address');
  } else if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) {
    throw new Error('API_BASE_URL must target a public host');
  }
  if (host.endsWith('.workers.dev')) {
    const prefix = `${workerName.toLowerCase()}.`;
    if (!host.startsWith(prefix)) throw new Error(`API_BASE_URL workers.dev host must start with ${prefix}`);
    const accountSubdomain = host.slice(prefix.length, -'.workers.dev'.length);
    if (!accountSubdomain || !/^[a-z0-9-]+$/.test(accountSubdomain)) {
      throw new Error('API_BASE_URL workers.dev host must include a non-empty account subdomain');
    }
  }
  return url.origin;
}

export function loadWranglerConfig(path = fileURLToPath(new URL('../apps/api/wrangler.jsonc', import.meta.url))): WranglerConfig {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    env?: Record<string, { name?: string; r2_buckets?: Array<{ binding?: string; bucket_name?: string }> }>;
  };
  const environment = (name: EnvironmentName): WranglerEnvironment => {
    const value = parsed.env?.[name];
    const bucket = value?.r2_buckets?.find(item => item.binding === 'BUCKET')?.bucket_name;
    if (!value?.name || !bucket) throw new Error(`wrangler.jsonc is missing ${name} name or BUCKET binding`);
    return { name: value.name, bucket };
  };
  return { staging: environment('staging'), production: environment('production') };
}

export function validateCiEnvironment(
  env: Record<string, string | undefined>,
  config: WranglerConfig = loadWranglerConfig()
): CiEnvironment {
  const targetEnv = required(env, 'TARGET_ENV');
  if (targetEnv !== 'staging' && targetEnv !== 'production') throw new Error('TARGET_ENV must be staging or production');
  const accountId = required(env, 'CLOUDFLARE_ACCOUNT_ID');
  if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32 character hex account ID');
  const apiToken = required(env, 'CLOUDFLARE_API_TOKEN');
  if (/[\s]/.test(apiToken)) throw new Error('CLOUDFLARE_API_TOKEN must not contain whitespace');
  const r2Bucket = required(env, 'R2_BUCKET');
  sameValue(r2Bucket, config[targetEnv].bucket, `R2_BUCKET for ${targetEnv}`);
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(r2Bucket)) throw new Error('R2_BUCKET must be a lowercase bucket slug');
  const pagesProjectName = required(env, 'PAGES_PROJECT_NAME');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/.test(pagesProjectName)) throw new Error('PAGES_PROJECT_NAME must be a lowercase project slug');
  if (targetEnv === 'staging' && !pagesProjectName.endsWith('-staging')) throw new Error('staging PAGES_PROJECT_NAME must end with -staging');
  if (targetEnv === 'production' && pagesProjectName.endsWith('-staging')) throw new Error('production PAGES_PROJECT_NAME must not end with -staging');
  const apiBaseUrl = validatePublicApiUrl(required(env, 'API_BASE_URL'), config[targetEnv].name);
  return { targetEnv, accountId, apiToken, r2Bucket, pagesProjectName, apiBaseUrl };
}

export function validatePublicationEnvironment(
  env: Record<string, string | undefined>,
  config: WranglerConfig = loadWranglerConfig()
): PublicationEnvironment {
  const targetEnv = required(env, 'TARGET_ENV');
  if (targetEnv !== 'staging' && targetEnv !== 'production') throw new Error('TARGET_ENV must be staging or production');
  const accountId = required(env, 'CLOUDFLARE_ACCOUNT_ID');
  if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32 character hex account ID');
  const r2AccountId = required(env, 'R2_ACCOUNT_ID');
  if (!/^[0-9a-f]{32}$/i.test(r2AccountId)) throw new Error('R2_ACCOUNT_ID must be a 32 character hex account ID');
  sameValue(r2AccountId, accountId, 'R2_ACCOUNT_ID must match CLOUDFLARE_ACCOUNT_ID');
  const r2Bucket = required(env, 'R2_BUCKET');
  sameValue(r2Bucket, config[targetEnv].bucket, `R2_BUCKET for ${targetEnv}`);
  const r2AccessKeyId = required(env, 'R2_ACCESS_KEY_ID');
  if (/\s/.test(r2AccessKeyId)) throw new Error('R2_ACCESS_KEY_ID must not contain whitespace');
  const r2SecretAccessKey = required(env, 'R2_SECRET_ACCESS_KEY');
  if (/\s/.test(r2SecretAccessKey)) throw new Error('R2_SECRET_ACCESS_KEY must not contain whitespace');
  return { targetEnv, accountId, r2Bucket, r2AccessKeyId, r2SecretAccessKey };
}

async function readResponseText(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('Cloudflare API response exceeded the size limit');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Cloudflare API response exceeded the size limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function request(
  fetchImpl: FetchLike,
  path: string,
  apiToken: string,
  init: RequestInit = {}
): Promise<CloudflareResult> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${apiToken}`);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetchImpl(`${CLOUDFLARE_API_BASE}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await readResponseText(response);
  let body: CloudflareEnvelope = {};
  if (text) {
    try {
      body = JSON.parse(text) as CloudflareEnvelope;
    } catch {
      throw new Error(`Cloudflare API returned non-JSON content with status ${response.status}`);
    }
  }
  return { status: response.status, body };
}

function errorCodes(result: CloudflareResult): number[] {
  if (!Array.isArray(result.body.errors)) return [];
  return result.body.errors.flatMap(error => {
    if (!error || typeof error !== 'object') return [];
    const code = (error as { code?: unknown }).code;
    return typeof code === 'number' ? [code] : [];
  });
}

function failure(result: CloudflareResult, action: string): Error {
  const codes = errorCodes(result);
  return new Error(`${action} failed with status ${result.status}${codes.length ? ` (${codes.join(', ')})` : ''}`);
}

function assertSuccess<T>(result: CloudflareResult, action: string, validate: (value: unknown) => T): T {
  if (result.status < 200 || result.status >= 300) throw failure(result, action);
  if (result.body.success !== true) throw failure(result, action);
  if (!('result' in result.body)) throw new Error(`${action} returned no result`);
  return validate(result.body.result);
}

function isKnownNotFound(result: CloudflareResult, code: number): boolean {
  const errors = result.body.errors;
  if (result.status !== 404 || result.body.success !== false || !Array.isArray(errors) || errors.length !== 1) return false;
  const error: unknown = errors[0];
  return error !== null && typeof error === 'object' && !Array.isArray(error) && 'code' in error && error.code === code;
}

function validateBucket(value: unknown, env: CiEnvironment): void {
  const bucket = recordValue(value, `R2 bucket ${env.r2Bucket}`);
  if (bucket.name !== env.r2Bucket) throw new Error(`R2 bucket result did not name ${env.r2Bucket}`);
}

function validateManagedDomain(value: unknown): ManagedDomain {
  const domain = recordValue(value, 'R2 managed domain');
  if (typeof domain.enabled !== 'boolean') throw new Error('R2 managed domain result omitted the enabled boolean');
  return { enabled: domain.enabled };
}

function validateCustomDomains(value: unknown, env: CiEnvironment): void {
  const custom = recordValue(value, `R2 custom domains for ${env.r2Bucket}`);
  if (!Array.isArray(custom.domains)) throw new Error('R2 custom domains result omitted the domains array');
  custom.domains.forEach((item, index) => {
    const domain = recordValue(item, `R2 custom domain ${index}`);
    if (typeof domain.enabled !== 'boolean') throw new Error(`R2 custom domain ${index} omitted the enabled boolean`);
    if (domain.enabled) throw new Error(`R2 bucket ${env.r2Bucket} has enabled public custom domain access`);
  });
}

function validatePagesProject(value: unknown, env: CiEnvironment): PagesProject {
  const project = recordValue(value, `Pages project ${env.pagesProjectName}`);
  if (project.name !== env.pagesProjectName) throw new Error(`Pages project result did not name ${env.pagesProjectName}`);
  if (project.production_branch !== 'main') throw new Error(`Pages project ${env.pagesProjectName} must use main as its production branch`);
  if (typeof project.subdomain !== 'string') throw new Error(`Pages project ${env.pagesProjectName} omitted its subdomain`);
  if (project.subdomain !== project.subdomain.trim() || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.pages\.dev$/.test(project.subdomain)) {
    throw new Error(`Pages project ${env.pagesProjectName} subdomain must be a valid production pages.dev hostname`);
  }
  return { name: project.name, production_branch: 'main', subdomain: project.subdomain };
}

async function ensurePrivateBucket(env: CiEnvironment, fetchImpl: FetchLike): Promise<{ created: boolean; publicDevUrlEnabled: boolean }> {
  const bucketPath = `/accounts/${env.accountId}/r2/buckets/${encodeURIComponent(env.r2Bucket)}`;
  const existing = await request(fetchImpl, bucketPath, env.apiToken);
  let created = false;
  if (isKnownNotFound(existing, R2_BUCKET_NOT_FOUND_CODE)) {
    const createdResult = await request(fetchImpl, `/accounts/${env.accountId}/r2/buckets`, env.apiToken, {
      method: 'POST',
      body: JSON.stringify({ name: env.r2Bucket })
    });
    assertSuccess(createdResult, `Creating R2 bucket ${env.r2Bucket}`, value => validateBucket(value, env));
    created = true;
  } else {
    assertSuccess(existing, `Reading R2 bucket ${env.r2Bucket}`, value => validateBucket(value, env));
  }

  const managed = await request(fetchImpl, `${bucketPath}/domains/managed`, env.apiToken);
  const managedDomain = assertSuccess(managed, `Reading public access for R2 bucket ${env.r2Bucket}`, validateManagedDomain);
  if (managedDomain.enabled) throw new Error(`R2 bucket ${env.r2Bucket} has the public r2.dev URL enabled; disable it before bootstrap`);

  const custom = await request(fetchImpl, `${bucketPath}/domains/custom`, env.apiToken);
  assertSuccess(custom, `Reading custom domains for R2 bucket ${env.r2Bucket}`, value => validateCustomDomains(value, env));
  return { created, publicDevUrlEnabled: false };
}

async function ensurePagesProject(env: CiEnvironment, fetchImpl: FetchLike): Promise<{ created: boolean; url: string }> {
  const projectPath = `/accounts/${env.accountId}/pages/projects/${encodeURIComponent(env.pagesProjectName)}`;
  const existing = await request(fetchImpl, projectPath, env.apiToken);
  if (isKnownNotFound(existing, PAGES_PROJECT_NOT_FOUND_CODE)) {
    const createdResult = await request(fetchImpl, `/accounts/${env.accountId}/pages/projects`, env.apiToken, {
      method: 'POST',
      body: JSON.stringify({ name: env.pagesProjectName, production_branch: 'main' })
    });
    const project = assertSuccess(createdResult, `Creating Pages project ${env.pagesProjectName}`, value => validatePagesProject(value, env));
    return { created: true, url: `https://${project.subdomain}` };
  }
  const project = assertSuccess(existing, `Reading Pages project ${env.pagesProjectName}`, value => validatePagesProject(value, env));
  return { created: false, url: `https://${project.subdomain}` };
}

export async function verifyPagesProduction(env: CiEnvironment, fetchImpl: FetchLike = fetch): Promise<{ url: string }> {
  const projectPath = `/accounts/${env.accountId}/pages/projects/${encodeURIComponent(env.pagesProjectName)}`;
  const result = await request(fetchImpl, projectPath, env.apiToken);
  const project = assertSuccess(result, `Reading Pages project ${env.pagesProjectName}`, value => validatePagesProject(value, env));
  return { url: `https://${project.subdomain}` };
}

export async function provisionCloudflare(env: CiEnvironment, fetchImpl: FetchLike = fetch): Promise<ProvisionSummary> {
  const bucket = await ensurePrivateBucket(env, fetchImpl);
  const pages = await ensurePagesProject(env, fetchImpl);
  return {
    environment: env.targetEnv,
    bucket: env.r2Bucket,
    bucketCreated: bucket.created,
    bucketPublicDevUrlEnabled: bucket.publicDevUrlEnabled,
    pagesProject: env.pagesProjectName,
    pagesProjectCreated: pages.created,
    pagesUrl: pages.url
  };
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'envcheck' && command !== 'provision' && command !== 'publicationcheck' && command !== 'pagescheck') {
    throw new Error('usage: cloudflare-ci.ts envcheck|provision|publicationcheck|pagescheck --env staging|production');
  }
  const targetEnv = arg('env') ?? process.env.TARGET_ENV;
  if (command === 'publicationcheck') {
    const publication = validatePublicationEnvironment({ ...process.env, TARGET_ENV: targetEnv });
    console.log(`cloudflare-ci: ${publication.targetEnv} bucket ${publication.r2Bucket}`);
    return;
  }
  const env = validateCiEnvironment({ ...process.env, TARGET_ENV: targetEnv });
  if (command === 'envcheck') {
    console.log(`cloudflare-ci: ${env.targetEnv} bucket ${env.r2Bucket} pages ${env.pagesProjectName} api ${env.apiBaseUrl}`);
    return;
  }
  if (command === 'pagescheck') {
    const pages = await verifyPagesProduction(env);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `url=${pages.url}\n`);
    console.log(`cloudflare-ci: ${env.targetEnv} pages ${env.pagesProjectName} production-branch main url ${pages.url}`);
    return;
  }
  const summary = await provisionCloudflare(env);
  console.log(`cloudflare-ci: ${summary.environment} bucket ${summary.bucket} created=${summary.bucketCreated} private=${!summary.bucketPublicDevUrlEnabled} pages ${summary.pagesProject} created=${summary.pagesProjectCreated} url ${summary.pagesUrl}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`cloudflare-ci: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
