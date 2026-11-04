import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MODEL_IDS } from '@av/contracts';
import { workflowAuthority } from '../apps/batch/src/authority.js';
import { forecastPlanReport, deploymentMarker, verifyPagesRevision, verifyWindyPluginBundle, validateOperationInputs, loadWranglerConfig, validateCiEnvironment, validatePublicationEnvironment, verifyPagesProduction, type WranglerConfig } from './operations';

const account = '0123456789abcdef0123456789abcdef', pages = 'windy-av-preview-staging';
const config: WranglerConfig = {
  staging: { name: 'windy-av-api-staging', bucket: 'windy-av-layer-staging' },
  production: { name: 'windy-av-api-production', bucket: 'windy-av-layer' }
};
const base = { TARGET_ENV: 'staging', MODEL: 'gfs', CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: 'token', PAGES_PROJECT_NAME: pages, API_BASE_URL: 'https://api-staging.example.com' };

it('requires an explicit registered model for forecast writes and maintenance', () => {
  const context = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: 'a'.repeat(40), GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/forecast.yml@refs/heads/main', GITHUB_RUN_ID: '123', TARGET_ENV: 'staging' };
  for (const MODEL of MODEL_IDS) {
    for (const command of ['forecast-plan', 'forecast-shard', 'forecast', 'maintenance']) {
      expect(() => validateOperationInputs(command, { ...base, MODEL, SHARD_ID: '0', ACTION: 'cleanup' })).not.toThrow();
    }
    expect(workflowAuthority({ ...context, MODEL })).toMatchObject({ model: MODEL, group: `forecast-staging-${MODEL}` });
  }
  for (const MODEL of [undefined, '', 'all', 'unknown', 'constructor']) {
    for (const command of ['forecast-plan', 'forecast-shard', 'forecast', 'maintenance']) {
      expect(() => validateOperationInputs(command, { ...base, MODEL, SHARD_ID: '0', ACTION: 'cleanup' })).toThrow(/MODEL|model/);
    }
    expect(() => workflowAuthority({ ...context, MODEL })).toThrow('serialized');
  }
  expect(() => validateOperationInputs('deploy', { ...base, MODEL: undefined })).not.toThrow();
  expect(() => validateOperationInputs('deploy', { ...base, MODEL: 'unknown' })).toThrow('Unknown forecast model');
});

it('accepts explicit operations without ceremonial confirmation and rejects ambiguous write targets', () => {
  expect(() => validateOperationInputs('deploy', base)).not.toThrow();
  const maintenance = { ...base, ACTION: 'rollback', MODEL: 'gfs', BUILD_ID: '20261030T000000Z-00000000-0000-4000-8000-000000000000' };
  expect(() => validateOperationInputs('maintenance', maintenance)).not.toThrow();
  expect(() => validateOperationInputs('maintenance', { ...maintenance, ACTION: 'cleanup', BUILD_ID: '' })).not.toThrow();
  for (const patch of [{ ACTION: 'unknown' }, { ACTION: 'cleanup' }, { MODEL: 'unknown' }, { MODEL: 'constructor' }, { TARGET_ENV: 'preview' }, { BUILD_ID: '../other' }]) expect(() => validateOperationInputs('maintenance', { ...maintenance, ...patch })).toThrow();
  expect(() => validateOperationInputs('forecast', { ...base, RESUME_RUN_ID: '123' })).not.toThrow();
  expect(() => validateOperationInputs('forecast', { ...base, RESUME_RUN_ID: '123; command' })).toThrow();
  expect(() => validateOperationInputs('bootstrap', base)).toThrow('Usage');
});

it('admits explicit forecast commands and bounded worker identities', () => {
  for (const command of ['forecast-plan', 'forecast']) expect(() => validateOperationInputs(command, base)).not.toThrow();
  for (const SHARD_ID of ['0', '1', '2', '3']) expect(() => validateOperationInputs('forecast-shard', { ...base, SHARD_ID })).not.toThrow();
  for (const SHARD_ID of ['', '-1', '4', '0.5', '01', '1; command']) expect(() => validateOperationInputs('forecast-shard', { ...base, SHARD_ID })).toThrow('SHARD_ID');
  for (const command of ['forecast-plan', 'forecast-shard']) expect(() => validateOperationInputs(command, { ...base, SHARD_ID: '0', RESUME_RUN_ID: '123' })).toThrow('Only forecast accepts');
});

it('derives publication bucket from the selected Wrangler environment and needs one account ID', () => {
  const env = { ...base, R2_ACCESS_KEY_ID: 'access', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET: 'ignored-stale-variable' };
  expect(validatePublicationEnvironment(env, config)).toMatchObject({ accountId: account, r2Bucket: config.staging.bucket });
  expect(validatePublicationEnvironment({ ...env, TARGET_ENV: 'production' }, config).r2Bucket).toBe(config.production.bucket);
  for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) expect(() => validatePublicationEnvironment({ ...env, [name]: '' }, config)).toThrow(name);
  expect(() => validatePublicationEnvironment({ ...env, TARGET_ENV: 'preview' }, config)).toThrow('TARGET_ENV');
});

it('checks API destinations and account identity before invoking Cloudflare', () => {
  expect(validateCiEnvironment(base, config).apiBaseUrl).toBe(base.API_BASE_URL);
  expect(() => validateCiEnvironment({ ...base, CLOUDFLARE_ACCOUNT_ID: 'short' }, config)).toThrow('ACCOUNT_ID');
  for (const API_BASE_URL of ['http://api.example', 'https://user:pass@api.example', 'https://api.example/path', 'https://api.example?token=x', 'https://wrong-worker.account.workers.dev']) expect(() => validateCiEnvironment({ ...base, API_BASE_URL }, config)).toThrow('API_BASE_URL');
  expect(() => validateCiEnvironment({ ...base, API_BASE_URL: 'https://windy-av-api-staging.account.workers.dev' }, config)).not.toThrow();
});

it('allows 10,000 sample requests per second in every Wrangler environment', () => {
  const wrangler = JSON.parse(readFileSync(new URL('../apps/api/wrangler.json', import.meta.url), 'utf8'));
  for (const environment of [wrangler, wrangler.env.staging, wrangler.env.production]) {
    expect(environment.ratelimits).toEqual([{
      name: 'SAMPLE_RATE_LIMITER',
      namespace_id: expect.stringMatching(/^\d+$/),
      simple: { limit: 100000, period: 10 }
    }]);
  }
  expect(new Set([wrangler, wrangler.env.staging, wrangler.env.production].map(environment => environment.ratelimits[0].namespace_id)).size).toBe(3);
});

it('reads the named BUCKET binding rather than the first binding', () => {
  const root = mkdtempSync(join(tmpdir(), 'av-config-'));
  try {
    const path = join(root, 'wrangler.json');
    writeFileSync(path, JSON.stringify({ env: Object.fromEntries(Object.entries(config).map(([name, value]) => [name, { name: value.name, r2_buckets: [{ binding: 'OTHER', bucket_name: 'other' }, { binding: 'BUCKET', bucket_name: value.bucket }] }])) }));
    expect(loadWranglerConfig(path)).toEqual(config);
    writeFileSync(path, '{}'); expect(() => loadWranglerConfig(path)).toThrow('BUCKET');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('uses the authenticated canonical Pages hostname and rejects wrong destinations or branches', async () => {
  const project = { name: pages, production_branch: 'main', subdomain: `${pages}-abc.pages.dev` };
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ success: true, result: project }));
  expect(await verifyPagesProduction(validateCiEnvironment(base, config), fetchImpl)).toEqual({ url: `https://${project.subdomain}` });
  expect(fetchImpl).toHaveBeenCalledWith(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${pages}`, expect.objectContaining({ headers: { authorization: 'Bearer token' }, signal: expect.any(AbortSignal) }));
  for (const patch of [{ name: 'other' }, { production_branch: 'preview' }, { subdomain: 'evil.example' }, { subdomain: '../host.pages.dev' }]) {
    fetchImpl.mockResolvedValueOnce(Response.json({ success: true, result: { ...project, ...patch } }));
    await expect(verifyPagesProduction(validateCiEnvironment(base, config), fetchImpl)).rejects.toThrow('Pages project');
  }
  fetchImpl.mockResolvedValueOnce(Response.json({ success: false, result: project }));
  await expect(verifyPagesProduction(validateCiEnvironment(base, config), fetchImpl)).rejects.toThrow('Pages project');
  fetchImpl.mockResolvedValueOnce(new Response('', { status: 403 }));
  await expect(verifyPagesProduction(validateCiEnvironment(base, config), fetchImpl)).rejects.toThrow('403');
});

describe('Pages deployment revision verification', () => {
  const deploymentId = `${'a'.repeat(40)}-12345-2`, marker = deploymentMarker(deploymentId);
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

  it('verifies deployed Windy plugin bundle, CORS header and embedded API base URL on Pages', async () => {
    const ok = vi.fn(async () => new Response('export const name="windy-plugin-av-layer",base="https://api.example";', {
      headers: { 'access-control-allow-origin': 'https://www.windy.com' }
    }));
    await expect(verifyWindyPluginBundle({ url: 'https://preview.example/', expectedApiBaseUrl: 'https://api.example', fetchImpl: ok, retries: 0 })).resolves.toBeUndefined();
    await expect(verifyWindyPluginBundle({ url: 'https://preview.example/', expectedApiBaseUrl: 'https://other.example', fetchImpl: ok, retries: 0 })).rejects.toThrow(/expected API base URL/);
    const missingCors = vi.fn(async () => new Response('export const name="windy-plugin-av-layer";'));
    await expect(verifyWindyPluginBundle({ url: 'https://preview.example/', fetchImpl: missingCors, retries: 0 })).rejects.toThrow(/CORS header/);
  });

  it('cancels an unread plugin body when the CORS check fails', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ cancel })));
    await expect(verifyWindyPluginBundle({ url: 'https://preview.example/', fetchImpl, retries: 0 })).rejects.toThrow(/CORS header/);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

it('lists exact model-specific hour batches and UTC times, including gaps and omitted nights', () => {
  const report = forecastPlanReport({ model: 'icon-eu', cycle: '2026-11-03T00:00:00.000Z', groups: [[7, 8], [12, 16]] }, 'icon-eu');
  expect(report.shards).toEqual([{ id: 0, hours: 'f007, f008' }, { id: 1, hours: 'f012, f016' }]);
  expect(report.summary).toContain('2026-11-03T16:00:00.000Z');
  expect(report.summary).not.toContain('f001');
  expect(forecastPlanReport(null, 'gfs')).toEqual({ shards: [], summary: expect.stringContaining('already published') });
});
