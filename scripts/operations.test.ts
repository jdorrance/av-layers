import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  deploymentMarker, verifyPagesRevision, validateOperationInputs,
  PAGES_PROJECT_NOT_FOUND_CODE,
  R2_BUCKET_NOT_FOUND_CODE,
  loadWranglerConfig,
  provisionCloudflare,
  validateCiEnvironment,
  validatePublicationEnvironment,
  verifyPagesProduction,
  type FetchLike,
  type WranglerConfig
} from './operations';

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const API = 'https://api.cloudflare.com/client/v4';
const BUCKET = 'windy-av-layer-staging';
const PAGES = 'windy-av-preview-staging';
const BUCKET_URL = `${API}/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}`;
const PAGES_URL = `${API}/accounts/${ACCOUNT_ID}/pages/projects/${PAGES}`;

const config: WranglerConfig = {
  staging: { name: 'windy-av-api-staging', bucket: BUCKET },
  production: { name: 'windy-av-api-production', bucket: 'windy-av-layer' }
};

const base = {
  TARGET_ENV: 'staging',
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: 'token-value',
  R2_BUCKET: BUCKET,
  PAGES_PROJECT_NAME: PAGES,
  API_BASE_URL: 'https://api-staging.example.com'
};

describe('operation input admission', () => {
  const maintenance = { TARGET_ENV: 'production', ACTION: 'rollback', MODEL: 'gfs', BUILD_ID: '20261030T000000Z-00000000-0000-4000-8000-000000000000', CONFIRM: 'serialized-maintenance' };
  it('accepts the supported maintenance actions and rejects ambiguous or unsupported input', () => {
    expect(() => validateOperationInputs('maintenance', maintenance)).not.toThrow();
    expect(() => validateOperationInputs('maintenance', { ...maintenance, ACTION: 'cleanup', BUILD_ID: '' })).not.toThrow();
    for (const patch of [{ ACTION: 'qualify' }, { ACTION: 'cleanup' }, { MODEL: 'hrrr' }, { TARGET_ENV: 'preview' }, { ACTION: 'rollback; touch /tmp/pwned' }, { BUILD_ID: '../other' }, { CONFIRM: '' }]) {
      expect(() => validateOperationInputs('maintenance', { ...maintenance, ...patch })).toThrow();
    }
  });
  it('requires explicit manual deployment/bootstrap intent and a numeric source run', () => {
    expect(() => validateOperationInputs('deploy', { TARGET_ENV: 'staging', GITHUB_EVENT_NAME: 'push' })).not.toThrow();
    expect(() => validateOperationInputs('deploy', { TARGET_ENV: 'production', GITHUB_EVENT_NAME: 'workflow_dispatch', CONFIRM: 'deploy-read-only-worker' })).not.toThrow();
    expect(() => validateOperationInputs('deploy', { TARGET_ENV: 'production', GITHUB_EVENT_NAME: 'workflow_dispatch' })).toThrow();
    expect(() => validateOperationInputs('bootstrap', { TARGET_ENV: 'staging', CONFIRM: 'bootstrap-private-cloudflare' })).not.toThrow();
    expect(() => validateOperationInputs('bootstrap', { TARGET_ENV: 'staging' })).toThrow();
    expect(() => validateOperationInputs('forecast', { TARGET_ENV: 'staging', MODEL: 'gfs', RESUME_RUN_ID: '123' })).not.toThrow();
    expect(() => validateOperationInputs('forecast', { TARGET_ENV: 'staging', MODEL: 'gfs', RESUME_RUN_ID: '123; touch /tmp/pwned' })).toThrow();
  });
});

const publicationBase = {
  TARGET_ENV: 'staging',
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  R2_ACCOUNT_ID: ACCOUNT_ID,
  R2_ACCESS_KEY_ID: 'access-key-value',
  R2_SECRET_ACCESS_KEY: 'secret-key-value',
  R2_BUCKET: BUCKET
};

interface Route {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  status: number;
  body: unknown;
}

interface Call {
  method: string;
  url: string;
  body: string | null;
  signal: AbortSignal | null | undefined;
  authorization: string | null;
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' }
});

function mockCloudflare(routes: Route[]): {
  fetchImpl: FetchLike;
  calls: Call[];
  remaining: Route[];
} {
  const pending = [...routes];
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : null, signal: init?.signal, authorization: new Headers(init?.headers).get('authorization') });
    const index = pending.findIndex(route => route.method === method && route.url === url);
    if (index < 0) throw new Error(`unexpected ${method} ${url}`);
    const [route] = pending.splice(index, 1);
    return json(route!.status, route!.body);
  };
  return { fetchImpl, calls, remaining: pending };
}

const existingBucketRoute = (): Route => ({
  method: 'GET',
  url: BUCKET_URL,
  status: 200,
  body: { success: true, result: { name: BUCKET } }
});

const missingBucketRoute = (): Route => ({
  method: 'GET',
  url: BUCKET_URL,
  status: 404,
  body: { success: false, errors: [{ code: R2_BUCKET_NOT_FOUND_CODE, message: 'not found' }] }
});

const createBucketRoute = (): Route => ({
  method: 'POST',
  url: `${API}/accounts/${ACCOUNT_ID}/r2/buckets`,
  status: 201,
  body: { success: true, result: { name: BUCKET } }
});

const managedRoute = (enabled: boolean, malformed = false): Route => ({
  method: 'GET',
  url: `${BUCKET_URL}/domains/managed`,
  status: 200,
  body: { success: true, result: malformed ? {} : { enabled, domain: 'pub.example.r2.dev' } }
});

const customRoute = (domains: unknown, malformed = false): Route => ({
  method: 'GET',
  url: `${BUCKET_URL}/domains/custom`,
  status: 200,
  body: { success: true, result: malformed ? {} : { domains } }
});

const existingPagesRoute = (overrides: Record<string, unknown> = {}): Route => ({
  method: 'GET',
  url: PAGES_URL,
  status: 200,
  body: {
    success: true,
    result: { name: PAGES, production_branch: 'main', subdomain: `${PAGES}.pages.dev`, ...overrides }
  }
});

const missingPagesRoute = (): Route => ({
  method: 'GET',
  url: PAGES_URL,
  status: 404,
  body: { success: false, errors: [{ code: PAGES_PROJECT_NOT_FOUND_CODE, message: 'not found' }] }
});

const createPagesRoute = (overrides: Record<string, unknown> = {}): Route => ({
  method: 'POST',
  url: `${API}/accounts/${ACCOUNT_ID}/pages/projects`,
  status: 201,
  body: { success: true, result: { name: PAGES, production_branch: 'main', subdomain: `${PAGES}.pages.dev`, ...overrides } }
});

const env = () => validateCiEnvironment(base, config);

describe('Cloudflare environment validation', () => {
  it('accepts environment-scoped values that match wrangler', () => {
    expect(env()).toMatchObject({
      targetEnv: 'staging',
      r2Bucket: BUCKET,
      pagesProjectName: PAGES,
      apiBaseUrl: 'https://api-staging.example.com'
    });
  });

  it('rejects unknown environments and mismatched wrangler buckets', () => {
    expect(() => validateCiEnvironment({ ...base, TARGET_ENV: 'preview' }, config)).toThrow(/TARGET_ENV/);
    expect(() => validateCiEnvironment({ ...base, R2_BUCKET: 'windy-av-layer' }, config)).toThrow(/R2_BUCKET/);
  });

  it('rejects invalid account, token and pages slugs', () => {
    expect(() => validateCiEnvironment({ ...base, CLOUDFLARE_ACCOUNT_ID: 'short' }, config)).toThrow(/ACCOUNT_ID/);
    expect(() => validateCiEnvironment({ ...base, CLOUDFLARE_API_TOKEN: 'bad token' }, config)).toThrow(/whitespace/);
    expect(() => validateCiEnvironment({ ...base, PAGES_PROJECT_NAME: 'Preview_Staging' }, config)).toThrow(/PAGES_PROJECT_NAME/);
  });

  it('accepts only public root HTTPS API URLs without credentials', () => {
    expect(() => validateCiEnvironment({ ...base, API_BASE_URL: 'https://[2606:4700:4700::1111]' }, config)).not.toThrow();
    const invalid = [
      ['http://api.example.com', /HTTPS/],
      ['https://user:pass@api.example.com', /credentials/],
      ['https://api.example.com?token=1', /query or fragment/],
      ['https://api.example.com#fragment', /query or fragment/],
      ['https://api.example.com/v1', /without a path/],
      ['https://localhost:8787', /public host/],
      ['https://localhost', /public host/],
      ['https://127.0.0.1', /private, or loopback/],
      ['https://0.0.0.0', /private, or loopback/],
      ['https://10.0.0.1', /private, or loopback/],
      ['https://172.16.0.1', /private, or loopback/],
      ['https://192.168.1.1', /private, or loopback/],
      ['https://169.254.169.254', /private, or loopback/],
      ['https://[::1]', /private, or loopback/],
      ['https://[fe80::1]', /private, or loopback/],
      ['https://[fc00::1]', /private, or loopback/],
      ['https://[::ffff:127.0.0.1]', /private, or loopback/]
    ] as const;
    for (const [url, message] of invalid) {
      expect(() => validateCiEnvironment({ ...base, API_BASE_URL: url }, config)).toThrow(message);
    }
  });

  it('requires environment-specific Pages project suffixes', () => {
    expect(() => validateCiEnvironment({ ...base, PAGES_PROJECT_NAME: 'windy-av-preview' }, config)).toThrow(/must end with -staging/);
    expect(validateCiEnvironment({
      ...base,
      TARGET_ENV: 'production',
      R2_BUCKET: 'windy-av-layer',
      PAGES_PROJECT_NAME: 'windy-av-preview',
      API_BASE_URL: 'https://api-production.example.test'
    }, config).pagesProjectName).toBe('windy-av-preview');
    expect(() => validateCiEnvironment({
      ...base,
      TARGET_ENV: 'production',
      R2_BUCKET: 'windy-av-layer',
      PAGES_PROJECT_NAME: 'windy-av-preview-staging',
      API_BASE_URL: 'https://api-production.example.test'
    }, config)).toThrow(/must not end with -staging/);
  });

  it('pins default workers.dev URLs to the selected wrangler name and account subdomain', () => {
    expect(validateCiEnvironment({
      ...base,
      API_BASE_URL: 'https://windy-av-api-staging.account-subdomain.workers.dev'
    }, config).apiBaseUrl).toBe('https://windy-av-api-staging.account-subdomain.workers.dev');
    expect(validateCiEnvironment({
      ...base,
      TARGET_ENV: 'production',
      R2_BUCKET: 'windy-av-layer',
      PAGES_PROJECT_NAME: 'windy-av-preview',
      API_BASE_URL: 'https://windy-av-api-production.account-subdomain.workers.dev'
    }, config).apiBaseUrl).toBe('https://windy-av-api-production.account-subdomain.workers.dev');
    expect(() => validateCiEnvironment({
      ...base,
      API_BASE_URL: 'https://windy-av-api-production.account-subdomain.workers.dev'
    }, config)).toThrow(/must start with windy-av-api-staging/);
    expect(() => validateCiEnvironment({
      ...base,
      API_BASE_URL: 'https://windy-av-api-staging.workers.dev'
    }, config)).toThrow(/non-empty account subdomain/);
    expect(validateCiEnvironment({
      ...base,
      API_BASE_URL: 'https://api-staging.example.test'
    }, config).apiBaseUrl).toBe('https://api-staging.example.test');
  });

  it('selects the BUCKET binding instead of the first wrangler bucket', () => {
    const directory = mkdtempSync(join(tmpdir(), 'Cloudflare-'));
    const path = join(directory, 'wrangler.jsonc');
    try {
      writeFileSync(path, JSON.stringify({
        env: {
          staging: {
            name: 'windy-av-api-staging',
            r2_buckets: [
              { binding: 'OTHER', bucket_name: 'wrong-staging' },
              { binding: 'BUCKET', bucket_name: BUCKET }
            ]
          },
          production: {
            name: 'windy-av-api-production',
            r2_buckets: [
              { binding: 'BUCKET', bucket_name: 'windy-av-layer' },
              { binding: 'OTHER', bucket_name: 'wrong-production' }
            ]
          }
        }
      }));
      expect(loadWranglerConfig(path)).toEqual({
        staging: { name: 'windy-av-api-staging', bucket: BUCKET },
        production: { name: 'windy-av-api-production', bucket: 'windy-av-layer' }
      });
      writeFileSync(path, JSON.stringify({
        env: {
          staging: { name: 'windy-av-api-staging', r2_buckets: [{ binding: 'OTHER', bucket_name: BUCKET }] },
          production: { name: 'windy-av-api-production', r2_buckets: [{ binding: 'BUCKET', bucket_name: 'windy-av-layer' }] }
        }
      }));
      expect(() => loadWranglerConfig(path)).toThrow(/BUCKET binding/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('Cloudflare publication environment', () => {
  it('validates only R2 publication credentials and the selected bucket', () => {
    expect(validatePublicationEnvironment(publicationBase, config)).toEqual({
      targetEnv: 'staging',
      accountId: ACCOUNT_ID,
      r2Bucket: BUCKET,
      r2AccessKeyId: 'access-key-value',
      r2SecretAccessKey: 'secret-key-value'
    });
    expect(() => validatePublicationEnvironment({
      ...publicationBase,
      TARGET_ENV: 'production',
      R2_BUCKET: 'windy-av-layer'
    }, config)).not.toThrow();
    expect(() => validatePublicationEnvironment({
      ...publicationBase,
      TARGET_ENV: 'production',
      R2_BUCKET: BUCKET
    }, config)).toThrow(/R2_BUCKET for production/);
  });

  it('rejects missing publication values before any network operation', () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error('network must not be called');
    }) as typeof fetch;
    try {
      for (const key of ['TARGET_ENV', 'CLOUDFLARE_ACCOUNT_ID', 'R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
        const values: Record<string, string | undefined> = { ...publicationBase };
        delete values[key];
        expect(() => validatePublicationEnvironment(values, config)).toThrow(new RegExp(key));
      }
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects malformed accounts, whitespace credentials and mismatched buckets', () => {
    expect(() => validatePublicationEnvironment({ ...publicationBase, R2_ACCOUNT_ID: 'short' }, config)).toThrow(/R2_ACCOUNT_ID/);
    expect(() => validatePublicationEnvironment({ ...publicationBase, R2_ACCOUNT_ID: 'f'.repeat(32) }, config)).toThrow(/must match/);
    expect(() => validatePublicationEnvironment({ ...publicationBase, CLOUDFLARE_ACCOUNT_ID: 'bad' }, config)).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    expect(() => validatePublicationEnvironment({ ...publicationBase, R2_ACCESS_KEY_ID: 'access key' }, config)).toThrow(/R2_ACCESS_KEY_ID.*whitespace/);
    expect(() => validatePublicationEnvironment({ ...publicationBase, R2_SECRET_ACCESS_KEY: 'secret key' }, config)).toThrow(/R2_SECRET_ACCESS_KEY.*whitespace/);
    expect(() => validatePublicationEnvironment({ ...publicationBase, R2_BUCKET: 'windy-av-layer' }, config)).toThrow(/R2_BUCKET/);
  });
});

describe('Cloudflare deploy-time Pages verification', () => {
  it('requires the configured project on the main production branch', async () => {
    const mock = mockCloudflare([existingPagesRoute()]);
    await expect(verifyPagesProduction(env(), mock.fetchImpl)).resolves.toEqual({ url: `https://${PAGES}.pages.dev` });
    const wrong = mockCloudflare([existingPagesRoute({ production_branch: 'preview' })]);
    await expect(verifyPagesProduction(env(), wrong.fetchImpl)).rejects.toThrow(/production branch/);
  });
});

describe('Pages canonical URL', () => {
  it('accepts the authenticated project subdomain with a collision suffix', async () => {
    const mock = mockCloudflare([existingPagesRoute({ subdomain: `${PAGES}-f19.pages.dev` })]);
    await expect(verifyPagesProduction(env(), mock.fetchImpl)).resolves.toEqual({ url: `https://${PAGES}-f19.pages.dev` });
  });

  it.each([
    'attacker.example.com', `${PAGES}.pages.dev.evil.com`, `branch.${PAGES}.pages.dev`,
    `https://${PAGES}.pages.dev`, `${PAGES}.pages.dev/path`, `${PAGES}.pages.dev:443`,
    `${PAGES}.pages.dev\n`, `${PAGES}.pages.dev\nurl=https://evil.com`, `${'a'.repeat(64)}.pages.dev`, '-bad.pages.dev'
  ])('rejects an unsafe production hostname: %j', async subdomain => {
    const mock = mockCloudflare([existingPagesRoute({ subdomain })]);
    await expect(verifyPagesProduction(env(), mock.fetchImpl)).rejects.toThrow(/valid production pages.dev hostname/);
  });


});

describe('Cloudflare provisioning', () => {
  it('creates a missing private bucket and Pages project on main', async () => {
    const mock = mockCloudflare([
      missingBucketRoute(),
      createBucketRoute(),
      managedRoute(false),
      customRoute([]),
      missingPagesRoute(),
      createPagesRoute({ subdomain: `${PAGES}-f19.pages.dev` })
    ]);

    const summary = await provisionCloudflare(env(), mock.fetchImpl);

    expect(summary).toEqual({
      environment: 'staging',
      bucket: BUCKET,
      bucketCreated: true,
      bucketPublicDevUrlEnabled: false,
      pagesProject: PAGES,
      pagesProjectCreated: true,
      pagesUrl: `https://${PAGES}-f19.pages.dev`
    });
    expect(mock.calls.map(call => `${call.method} ${call.url}`)).toEqual([
      `GET ${BUCKET_URL}`,
      `POST ${API}/accounts/${ACCOUNT_ID}/r2/buckets`,
      `GET ${BUCKET_URL}/domains/managed`,
      `GET ${BUCKET_URL}/domains/custom`,
      `GET ${PAGES_URL}`,
      `POST ${API}/accounts/${ACCOUNT_ID}/pages/projects`
    ]);
    expect(mock.calls[1]?.body).toBe(JSON.stringify({ name: BUCKET }));
    expect(mock.calls[5]?.body).toBe(JSON.stringify({ name: PAGES, production_branch: 'main' }));
    expect(mock.calls.every(call => call.signal !== undefined)).toBe(true);
    expect(mock.remaining).toHaveLength(0);
  });

  it('is idempotent for an existing private bucket and main Pages project', async () => {
    const mock = mockCloudflare([
      existingBucketRoute(),
      managedRoute(false),
      customRoute([{ domain: 'cdn.example.com', enabled: false }]),
      existingPagesRoute()
    ]);

    const summary = await provisionCloudflare(env(), mock.fetchImpl);

    expect(summary.bucketCreated).toBe(false);
    expect(summary.pagesProjectCreated).toBe(false);
    expect(summary.pagesUrl).toBe(`https://${PAGES}.pages.dev`);
    expect(mock.calls.map(call => call.method)).toEqual(['GET', 'GET', 'GET', 'GET']);
    expect(mock.calls).toHaveLength(4);
    expect(mock.remaining).toHaveLength(0);
  });

  it('fails an existing bucket with public r2.dev access without modifying it', async () => {
    const mock = mockCloudflare([
      existingBucketRoute(),
      managedRoute(true)
    ]);

    await expect(provisionCloudflare(env(), mock.fetchImpl)).rejects.toThrow(/public r2.dev URL enabled/);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls.some(call => call.method === 'PUT')).toBe(false);
    expect(mock.calls.some(call => call.url.endsWith('/domains/custom'))).toBe(false);
  });

  it('fails an enabled public custom domain without modifying it', async () => {
    const mock = mockCloudflare([
      existingBucketRoute(),
      managedRoute(false),
      customRoute([{ domain: 'cdn.example.com', enabled: false }, { domain: 'public.example.com', enabled: true }])
    ]);

    await expect(provisionCloudflare(env(), mock.fetchImpl)).rejects.toThrow(/enabled public custom domain access/);
    expect(mock.calls).toHaveLength(3);
    expect(mock.calls.some(call => call.method === 'PUT')).toBe(false);
  });

  it('fails closed on malformed managed and custom domain results', async () => {
    const managed = mockCloudflare([existingBucketRoute(), managedRoute(false, true)]);
    await expect(provisionCloudflare(env(), managed.fetchImpl)).rejects.toThrow(/enabled boolean/);

    for (const [domains, malformed] of [
      [undefined, true],
      [{ enabled: 'false' }, false],
      [[{}], false],
      [['not-an-object'], false]
    ] as const) {
      const mock = mockCloudflare([existingBucketRoute(), managedRoute(false), customRoute(domains, malformed)]);
      await expect(provisionCloudflare(env(), mock.fetchImpl)).rejects.toThrow(/domains array|enabled boolean|malformed result/);
    }
  });

  it('rejects a Pages project with mismatched identity, branch, or unsafe subdomain', async () => {
    const cases = [
      [{ production_branch: 'develop' }, /production branch/],
      [{ name: 'other-project' }, /did not name/],
      [{ production_branch: undefined }, /production branch/],
      [{ subdomain: undefined }, /omitted its subdomain/],
      [{ subdomain: 'attacker.example.com' }, /valid production pages.dev hostname/]
    ] as const;
    for (const [overrides, message] of cases) {
      const mock = mockCloudflare([existingBucketRoute(), managedRoute(false), customRoute([]), existingPagesRoute(overrides)]);
      await expect(provisionCloudflare(env(), mock.fetchImpl)).rejects.toThrow(message);
    }
  });

  it('requires a safe Pages production subdomain after creation', async () => {
    const mock = mockCloudflare([
      missingBucketRoute(),
      createBucketRoute(),
      managedRoute(false),
      customRoute([]),
      missingPagesRoute(),
      {
        method: 'POST',
        url: `${API}/accounts/${ACCOUNT_ID}/pages/projects`,
        status: 201,
        body: { success: true, result: { name: PAGES, production_branch: 'main', subdomain: 'attacker.example.com' } }
      }
    ]);
    await expect(provisionCloudflare(env(), mock.fetchImpl)).rejects.toThrow(/valid production pages.dev hostname/);
  });

  it('treats only a lone documented not-found code as absent', async () => {
    for (const errors of [
      [{ code: 9999, message: 'other' }],
      [{ code: R2_BUCKET_NOT_FOUND_CODE, message: 'not found' }, { code: 1000, message: 'auth' }],
      [{ code: R2_BUCKET_NOT_FOUND_CODE }, { code: '1000', message: 'auth' }],
      [{ code: R2_BUCKET_NOT_FOUND_CODE }, null],
      [{ code: R2_BUCKET_NOT_FOUND_CODE }, {}],
      [{ code: R2_BUCKET_NOT_FOUND_CODE }, 'auth'],
      [{ code: R2_BUCKET_NOT_FOUND_CODE }, []],
      [{ code: String(R2_BUCKET_NOT_FOUND_CODE) }]
    ]) {
      const mock = mockCloudflare([
        { method: 'GET', url: BUCKET_URL, status: 404, body: { success: false, errors } }
      ]);
      await expect(provisionCloudflare(env(), mock.fetchImpl)).rejects.toThrow(/Reading R2 bucket/);
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls.some(call => call.method === 'POST')).toBe(false);
    }
  });

  it('rejects non-2xx responses even when success is true', async () => {
    const mock = mockCloudflare([
      { method: 'GET', url: BUCKET_URL, status: 500, body: { success: true, result: { name: BUCKET } } }
    ]);
    await expect(provisionCloudflare(env(), mock.fetchImpl)).rejects.toThrow(/status 500/);
    expect(mock.calls).toHaveLength(1);
  });

  it.each(['cfat_account-token', 'cfut_user-token', 'legacy-token'])('authenticates %s through account-scoped resource requests', async apiToken => {
    const mock = mockCloudflare([existingBucketRoute(), managedRoute(false), customRoute([]), existingPagesRoute()]);
    await expect(provisionCloudflare({ ...env(), apiToken }, mock.fetchImpl)).resolves.toMatchObject({ bucketCreated: false, pagesProjectCreated: false });
    expect(mock.calls.every(call => call.url.startsWith(`${API}/accounts/${ACCOUNT_ID}/`))).toBe(true);
    expect(mock.calls.every(call => call.authorization === `Bearer ${apiToken}`)).toBe(true);
    expect(mock.remaining).toHaveLength(0);
  });

  it('fails authentication without retrying', async () => {
    const mock = mockCloudflare([
      { method: 'GET', url: BUCKET_URL, status: 403, body: { success: false, errors: [{ code: 1000, message: 'Authentication error' }] } }
    ]);
    await expect(provisionCloudflare(env(), mock.fetchImpl)).rejects.toThrow(/Reading R2 bucket/);
    expect(mock.calls).toHaveLength(1);
  });
});

const deploymentId = `${'a'.repeat(40)}-12345-1`;
const marker = deploymentMarker(deploymentId);

describe('Pages deployment revision verification', () => {
  it('accepts HTML with the exact marker for the deployed commit', async () => {
    const fetchImpl = vi.fn(async () => new Response(`<meta ${marker} />`));
    await expect(verifyPagesRevision({ url: 'https://preview.example/', expectedDeploymentId: deploymentId, fetchImpl })).resolves.toBeUndefined();
  });

  it('rejects stale, missing, quoted-mismatched and failed responses', async () => {
    const stale = vi.fn(async () => new Response(`<meta ${deploymentMarker(`${'b'.repeat(40)}-12345-1`)} />`));
    await expect(verifyPagesRevision({ url: 'https://preview.example/', expectedDeploymentId: deploymentId, fetchImpl: stale, retries: 0 })).rejects.toThrow(/does not contain/);
    const sameCommitOlderRun = vi.fn(async () => new Response(`<meta ${deploymentMarker(`${'a'.repeat(40)}-12344-1`)} />`));
    await expect(verifyPagesRevision({ url: 'https://preview.example/', expectedDeploymentId: deploymentId, fetchImpl: sameCommitOlderRun, retries: 0 })).rejects.toThrow(/does not contain/);
    const missing = vi.fn(async () => new Response('<meta name="build-deployment" content="" />'));
    await expect(verifyPagesRevision({ url: 'https://preview.example/', expectedDeploymentId: deploymentId, fetchImpl: missing, retries: 0 })).rejects.toThrow(/does not contain/);
    const failed = vi.fn(async () => new Response('unavailable', { status: 503 }));
    await expect(verifyPagesRevision({ url: 'https://preview.example/', expectedDeploymentId: deploymentId, fetchImpl: failed, retries: 0 })).rejects.toThrow(/status 503/);
  });

  it('retries a transient stale response and then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('<meta name="build-deployment" content="stale" />'))
      .mockResolvedValueOnce(new Response(`<meta ${marker} />`));
    await expect(verifyPagesRevision({ url: 'https://preview.example/', expectedDeploymentId: deploymentId, fetchImpl, retries: 1, delayMs: 0 })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects identifiers that are not commit-run-attempt values', () => {
    expect(() => deploymentMarker('main')).toThrow(/commit SHA, run ID and run attempt/);
    expect(() => deploymentMarker('a'.repeat(40))).toThrow(/commit SHA, run ID and run attempt/);
  });

  it('retries a transient connection failure and reports exhausted retries', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(new Response(`<meta ${marker} />`));
    await expect(verifyPagesRevision({ url: 'https://preview.example/', expectedDeploymentId: deploymentId, fetchImpl, retries: 1, delayMs: 0 })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const failing = vi.fn().mockRejectedValue(new TypeError('connection reset'));
    await expect(verifyPagesRevision({ url: 'https://preview.example/', expectedDeploymentId: deploymentId, fetchImpl: failing, retries: 1, delayMs: 0 })).rejects.toThrow(/Pages revision verification failed: connection reset/);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it.each(['headers', 'body'])('aborts stalled %s and retries with a fresh deadline', async stage => {
    let stalledSignal: AbortSignal;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(async (_url, init) => {
      stalledSignal = init!.signal!;
      if (stage === 'headers') {
        return new Promise<Response>((_resolve, reject) => {
          stalledSignal.addEventListener('abort', () => reject(stalledSignal.reason), { once: true });
        });
      }
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('<html>'));
          stalledSignal.addEventListener('abort', () => controller.error(stalledSignal.reason), { once: true });
        }
      }));
    }).mockImplementationOnce(async (_url, init) => {
      expect(stalledSignal.aborted).toBe(true);
      expect(init!.signal).not.toBe(stalledSignal);
      expect(init!.signal!.aborted).toBe(false);
      return new Response(`<meta ${marker} />`);
    });
    await expect(verifyPagesRevision({ url: 'https://preview.example/', expectedDeploymentId: deploymentId, fetchImpl, retries: 1, delayMs: 0, timeoutMs: 20 })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
