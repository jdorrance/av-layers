import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { forecastObjects, manifestSchema, type Manifest } from '@av/contracts';
import { GFS_DISCOVERY_LAG_HOURS, GFS_FORECAST_HOURS } from '../apps/batch/src/noaa/constants';
import { buildLocalPointer, shouldSeedAssets, validateArtifactRecords as validatePreviewArtifacts } from './sample-preview';
import { validateArtifactRecords as validateSmokeArtifacts, validateSampleFlags } from './smoke-build';
import { SAMPLE_STATUSES, isSampleStatus, validateSampleContract, type SampleContract } from './smoke-api';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const manifestFixture = () => manifestSchema.parse(JSON.parse(readFileSync(fixture('manifest.contract.json'), 'utf8'))) as Manifest;
const sampleFixture = () => JSON.parse(readFileSync(fixture('sample.contract.json'), 'utf8')) as SampleContract;
const requireFromWrangler = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'));
const yaml = requireFromWrangler('yaml') as { parse(source: string): unknown };
const workflowText = (name: string): string => readFileSync(fileURLToPath(new URL(`../.github/workflows/${name}`, import.meta.url)), 'utf8');
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
  return value as Record<string, unknown>;
};
const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('expected array');
  return value;
};
const workflow = (name: string): Record<string, unknown> => record(yaml.parse(workflowText(name)));
const stepNames = (workflowFile: Record<string, unknown>, job: string): string[] => list(record(record(workflowFile.jobs)[job]).steps).map(step => {
  const name = record(step).name;
  return typeof name === 'string' ? name : '';
});

function runBlock(workflow: string, step: string): string {
  const lines = readFileSync(fileURLToPath(new URL(`../.github/workflows/${workflow}`, import.meta.url)), 'utf8').split('\n');
  const start = lines.findIndex(line => line.trim() === `- name: ${step}`);
  if (start < 0) throw new Error(`step not found: ${step}`);
  const runIndex = lines.findIndex((line, index) => index > start && /^\s*run:\s*\|\s*$/.test(line));
  if (runIndex < 0) throw new Error(`run block not found: ${step}`);
  const baseIndent = (lines[runIndex]!.match(/^\s*/) ?? [''])[0]!.length;
  const body: string[] = [];
  for (let index = runIndex + 1; index < lines.length; index++) {
    const line = lines[index]!;
    const indent = (line.match(/^\s*/) ?? [''])[0]!.length;
    if (line.trim() && indent <= baseIndent) break;
    body.push(line);
  }
  return body.join('\n');
}

function bash(script: string, env: Record<string, string>) {
  return spawnSync('bash', ['-c', script], { env: { ...process.env, ...env }, encoding: 'utf8' });
}

describe('project runtime', () => {
  const project = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    engines: { node: string };
    devEngines: { runtime: { name: string; version: string; onFail: string } };
  };

  it('pins a downloaded project runtime to the declared Node version', () => {
    expect(project.devEngines.runtime).toEqual({ name: 'node', version: project.engines.node, onFail: 'download' });
  });

  it('executes tests using the project Node runtime with real SQLite support', async () => {
    expect(process.versions.node).toBe(project.devEngines.runtime.version);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try { expect(db.prepare('SELECT 1 AS value').get()?.value).toBe(1); }
    finally { db.close(); }
  });
});

describe('real contract-shaped fixtures', () => {
  it('parses a manifest with 8 frames, 3 layers, 24 tile records and one numeric pack', () => {
    const manifest = manifestFixture();
    expect(manifest.frames).toHaveLength(8);
    expect(manifest.layers).toHaveLength(3);
    expect(manifest.artifacts).toHaveLength(24);
    expect(new Set(forecastObjects(manifest).map(item => item.key)).size).toBe(25);
    expect(() => validatePreviewArtifacts(manifest)).not.toThrow();
    expect(() => validateSmokeArtifacts(manifest)).not.toThrow();
  });

  it('rejects 48 artifact records where 24 records are required', () => {
    const broken = structuredClone(manifestFixture());
    broken.artifacts.push(...structuredClone(broken.artifacts));
    expect(() => validatePreviewArtifacts(broken)).toThrow(/24 artifact records/);
    expect(() => validateSmokeArtifacts(broken)).toThrow(/24 artifact records/);
  });

  it('rejects missing, duplicate and noncanonical artifact records', () => {
    const missing = structuredClone(manifestFixture());
    missing.artifacts.pop();
    expect(() => validatePreviewArtifacts(missing)).toThrow(/24 artifact records/);

    const duplicate = structuredClone(manifestFixture());
    duplicate.artifacts[1] = structuredClone(duplicate.artifacts[0]!);
    expect(() => validatePreviewArtifacts(duplicate)).toThrow(/duplicate artifact record/);

    const wrongPath = structuredClone(manifestFixture());
    wrongPath.artifacts[0]!.tilesKey = 'builds/gfs/other/usable-lift-msl/f003.pmtiles';
    expect(() => validateSmokeArtifacts(wrongPath)).toThrow(/unexpected tilesKey/);
  });

  it('accepts only contract status strings and valid sample flags', () => {
    const sample = sampleFixture();
    expect(() => validateSampleContract(sample, 'gfs', sample.buildId as string, 'f003', ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'])).not.toThrow();
    for (const status of SAMPLE_STATUSES) {
      expect(isSampleStatus(status)).toBe(true);
      const copy = structuredClone(sample);
      copy.frames![0]!.layers!['usable-lift-msl']!.status = status;
      expect(() => validateSampleContract(copy, 'gfs', copy.buildId as string, 'f003', ['usable-lift-msl'])).not.toThrow();
    }
    for (const status of [0, 'ok', null]) {
      expect(isSampleStatus(status)).toBe(false);
      const copy = structuredClone(sample);
      copy.frames![0]!.layers!['usable-lift-msl']!.status = status;
      expect(() => validateSampleContract(copy, 'gfs', copy.buildId as string, 'f003', ['usable-lift-msl'])).toThrow(/invalid usable-lift-msl status/);
    }
    const flags = Uint8Array.from([0, 0, 0, 0, 4, 0, 0, 0, 0, 16]);
    expect(() => validateSampleFlags(flags, 10)).not.toThrow();
    expect(() => validateSampleFlags(flags, 10, 'precip-rate')).toThrow(/precip-rate lift flags/);
    expect(() => validateSampleFlags(Uint8Array.from([0, 0, 192, 127, 0]), 5)).toThrow(/non-finite sample value/);
    expect(() => validateSampleFlags(Uint8Array.from([0, 0, 0, 0, 32]), 5)).toThrow(/support bits/);
    expect(() => validateSampleFlags(new Uint8Array(5), 10)).toThrow(/length/);
  });

  it('selects the requested build pointer every run even when assets were seeded earlier', () => {
    const manifest = manifestFixture();
    const keyA = `builds/gfs/${manifest.buildId}/manifest.json`;
    const pointerA = buildLocalPointer(manifest, keyA);
    expect(pointerA.latestBuildId).toBe(manifest.buildId);
    expect(pointerA.retained).toEqual([{ buildId: manifest.buildId, manifestKey: keyA, cycle: manifest.cycle, expiresAt: manifest.expiresAt }]);

    const buildB = structuredClone(manifest);
    buildB.buildId = '20261030T000000Z-11111111-1111-4111-8111-111111111111';
    const pointerB = buildLocalPointer(buildB, `builds/gfs/${buildB.buildId}/manifest.json`);
    expect(pointerB.latestBuildId).toBe(buildB.buildId);

    const pointerAAgain = buildLocalPointer(manifest, keyA);
    expect(pointerAAgain.latestBuildId).toBe(pointerA.latestBuildId);
    expect(pointerAAgain.retained).toHaveLength(1);
    expect(shouldSeedAssets(true, false)).toBe(false);
    expect(shouldSeedAssets(false, false)).toBe(true);
    expect(shouldSeedAssets(true, true)).toBe(true);
  });
});

describe('workflow input guards', () => {
  const validBuild = '20261030T000000Z-00000000-0000-4000-8000-000000000000';

  it('never interpolates workflow inputs directly into run blocks', () => {
    for (const [workflow, step] of [['maintenance.yml', 'Validate maintenance inputs'], ['deploy.yml', 'Validate deploy inputs and credentials']] as const) {
      expect(runBlock(workflow, step)).not.toContain('${{');
      const validation = runBlock(workflow, step);
      expect(validation).toContain('case "${');
      expect(validation).toContain('set -euo pipefail');
    }
  });

  it('accepts allowlisted maintenance inputs and rejects injection attempts', () => {
    const script = runBlock('maintenance.yml', 'Validate maintenance inputs');
    const maintenance = { TARGET_ENV: 'production', ACTION: 'rollback', MODEL: 'gfs', BUILD_ID: validBuild, CONFIRM: 'publishers-paused' };
    expect(bash(script, maintenance).status).toBe(0);
    expect(bash(script, { ...maintenance, ACTION: 'cleanup', BUILD_ID: '' }).status).toBe(0);
    expect(bash(script, { ...maintenance, MODEL: 'hrrr' }).status).not.toBe(0);
    expect(bash(script, { ...maintenance, TARGET_ENV: 'preview' }).status).not.toBe(0);
    expect(bash(script, { ...maintenance, MODEL: 'gfs; touch /tmp/pwned' }).status).not.toBe(0);
    expect(bash(script, { ...maintenance, ACTION: 'rollback; touch /tmp/pwned' }).status).not.toBe(0);
    expect(bash(script, { ...maintenance, BUILD_ID: 'x; touch /tmp/pwned' }).status).not.toBe(0);
    expect(bash(script, { ...maintenance, CONFIRM: 'publishers-paused; touch /tmp/pwned' }).status).not.toBe(0);
    expect(bash(script, { ...maintenance, ACTION: 'cleanup' }).status).not.toBe(0);
  });

  it('accepts allowlisted deploy environments and rejects injection attempts', () => {
    const script = runBlock('deploy.yml', 'Validate deploy inputs and credentials');
    const creds = { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account', GITHUB_EVENT_NAME: 'workflow_dispatch' };
    expect(bash(script, { ...creds, TARGET_ENV: 'staging', CONFIRM: 'deploy-read-only-worker' }).status).toBe(0);
    expect(bash(script, { ...creds, TARGET_ENV: 'production', CONFIRM: 'deploy-read-only-worker' }).status).toBe(0);
    expect(bash(script, { ...creds, TARGET_ENV: 'staging; touch /tmp/pwned', CONFIRM: 'deploy-read-only-worker' }).status).not.toBe(0);
    expect(bash(script, { ...creds, TARGET_ENV: 'staging', CONFIRM: 'deploy-read-only-worker; touch /tmp/pwned' }).status).not.toBe(0);
    expect(bash(script, { TARGET_ENV: 'staging', CONFIRM: 'deploy-read-only-worker' }).status).not.toBe(0);
  });
});

describe('workflow structure guards', () => {
  const workflowFiles = ['ci.yml', 'deploy.yml', 'forecast.yml', 'maintenance.yml', 'bootstrap.yml'];

  it('parses every workflow as YAML', () => {
    for (const name of workflowFiles) {
      const parsed = workflow(name);
      expect(Object.keys(parsed).length).toBeGreaterThan(0);
    }
  });

  it('never uses workflow_run or exposes secrets to pull requests', () => {
    for (const name of workflowFiles) {
      expect(workflowText(name)).not.toContain('workflow_run');
    }
    expect(workflowText('ci.yml')).not.toContain('secrets.');
  });

  it('runs CI on feature branches and reusable deploy verification', () => {
    const ci = record(workflow('ci.yml').on);
    expect(ci.workflow_call).not.toBeUndefined();
    expect(list(record(ci.push)['branches-ignore'])).toEqual(['main']);
    expect(ci.pull_request).not.toBeUndefined();
    expect(record(workflow('ci.yml').concurrency)['cancel-in-progress']).toBe(false);
    const deploy = workflow('deploy.yml');
    expect(record(record(deploy.jobs).verify).uses).toBe('./.github/workflows/ci.yml');
    const deployJob = record(record(deploy.jobs).deploy);
    expect(deployJob.needs).toBe('verify');
    expect(deployJob.if).toContain("github.ref == 'refs/heads/main'");
    expect(record(workflow('deploy.yml').concurrency)['cancel-in-progress']).toBe(false);
  });

  it('pins every deployment checkout to the triggering revision without persisted credentials', () => {
    for (const [name, job] of [['deploy.yml', 'deploy'], ['forecast.yml', 'build-publish'], ['maintenance.yml', 'maintain'], ['bootstrap.yml', 'bootstrap'], ['ci.yml', 'verify']] as const) {
      const steps = list(record(record(workflow(name).jobs)[job]).steps).map(record);
      const checkout = steps.find(step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));
      expect(record(checkout?.with).ref).toBe('${{ github.sha }}');
      expect(record(checkout?.with)['persist-credentials']).toBe(false);
    }
    for (const [name, job] of [['deploy.yml', 'deploy'], ['forecast.yml', 'build-publish'], ['maintenance.yml', 'maintain'], ['bootstrap.yml', 'bootstrap']] as const) {
      const names = stepNames(workflow(name), job);
      expect(names).toContain('Refuse superseded main revision');
      expect(names.indexOf('Refuse superseded main revision')).toBeLessThan(names.length - 1);
    }
  });

  it('deploys only main refs with protected environment values and smoke checks', () => {
    const deploy = workflow('deploy.yml');
    expect(list(record(record(deploy.on).push).branches)).toEqual(['main']);
    const deployJob = record(record(deploy.jobs).deploy);
    expect(deployJob.environment).toBe("${{ inputs.environment || 'production' }}");
    const env = record(deployJob.env);
    for (const name of ['API_BASE_URL', 'R2_BUCKET', 'PAGES_PROJECT_NAME', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
      expect(name in env).toBe(true);
    }
    const names = stepNames(deploy, 'deploy');
    expect(names).toContain('Validate deploy environment mapping');
    expect(names).toContain('Deploy Worker');
    expect(names).toContain('Deploy Pages');
    expect(names).toContain('Smoke API');
    expect(names).toContain('Verify Pages production branch');
    expect(names).toContain('Verify live Pages revision');
    expect(runBlock('deploy.yml', 'Deploy Pages')).toContain('--project-name "${PAGES_PROJECT_NAME}"');
    expect(runBlock('deploy.yml', 'Deploy Pages')).toContain('--branch main');
    expect(runBlock('deploy.yml', 'Build preview')).not.toContain('${{');
    expect(runBlock('deploy.yml', 'Smoke API')).toContain('Bootstrap Cloudflare resources, Forecast sample, then Deploy Worker and Pages');
    expect(runBlock('deploy.yml', 'Build preview')).toContain('pnpm --filter @av/preview build');
    expect(runBlock('deploy.yml', 'Verify live Pages revision')).toContain('scripts/verify-pages-revision.ts');
    const steps = list(deployJob.steps).map(record);
    expect(steps.find(step => step.name === 'Verify Pages production branch')?.id).toBe('pages');
    for (const name of ['Verify live Pages revision', 'Deployment summary']) {
      expect(record(steps.find(step => step.name === name)?.env).PAGES_BASE_URL).toBe('${{ steps.pages.outputs.url }}');
    }
    expect(runBlock('deploy.yml', 'Deployment summary')).toContain('"${PAGES_BASE_URL}"');
    expect(runBlock('deploy.yml', 'Deployment summary')).not.toContain('pages.dev');
    expect(env.DEPLOYMENT_ID).toBe('${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(runBlock('deploy.yml', 'Deploy Worker')).toContain('--var "AV_DEPLOYMENT_ID:${DEPLOYMENT_ID}"');
    expect(runBlock('deploy.yml', 'Smoke API')).toContain('--expected-deployment-id "${DEPLOYMENT_ID}"');
    expect(names.indexOf('Smoke API')).toBeLessThan(names.indexOf('Build preview'));
    expect(names.indexOf('Smoke API')).toBeLessThan(names.indexOf('Deploy Pages'));
    expect(record(steps.find(step => step.name === 'Build preview')?.env).VITE_BUILD_REVISION).toBe('${{ env.DEPLOYMENT_ID }}');
    expect(record(steps.find(step => step.name === 'Verify live Pages revision')?.env).EXPECTED_DEPLOYMENT_ID).toBe('${{ env.DEPLOYMENT_ID }}');
    expect(readFileSync(fileURLToPath(new URL('../apps/preview/index.html', import.meta.url)), 'utf8')).toContain('name="build-deployment" content="%VITE_BUILD_REVISION%"');
  });

  it('runs the scheduled forecast on main with environment-scoped secrets', () => {
    const forecast = workflow('forecast.yml');
    expect(record(list(record(forecast.on).schedule)[0]).cron).toBe('17 5,17 * * *');
    const dispatch = record(record(forecast.on).workflow_dispatch);
    expect(list(record(record(dispatch.inputs).environment).options)).toEqual(['staging', 'production']);
    expect(list(record(record(dispatch.inputs).model).options)).toEqual(['gfs']);
    const job = record(record(forecast.jobs)['build-publish']);
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe("${{ inputs.environment || 'production' }}");
    expect(record(forecast.concurrency).group).toBe("forecast-${{ inputs.environment || 'production' }}-gfs");
    expect(record(forecast.concurrency)['cancel-in-progress']).toBe(false);
    const names = stepNames(forecast, 'build-publish'), combined = 'Build, validate and publish';
    expect(names.indexOf('Validate forecast environment and secrets')).toBeLessThan(names.indexOf(combined));
    expect(names.indexOf('Validate publication environment mapping')).toBeGreaterThan(names.indexOf('Validate forecast environment and secrets'));
    expect(names.indexOf('Validate publication environment mapping')).toBeLessThan(names.indexOf(combined));
    expect(names).not.toContain('Record skipped publication');
    expect(names).not.toContain('Validate sample');
    const runner = list(job.steps).map(record).find(step => step.name === combined);
    expect(runner?.run).toBe('pnpm exec tsx scripts/build-and-publish.ts');
    expect(record(runner?.env).GH_TOKEN).toBe('${{ github.token }}');
    const source = readFileSync(new URL('./build-and-publish.ts', import.meta.url), 'utf8');
    expect(source).toContain("GITHUB_REF !== 'refs/heads/main'");
    expect(source.indexOf('git/ref/heads/main')).toBeGreaterThan(source.indexOf('onValidated:'));
    expect(source.indexOf('if (stdout.trim() !== revision)')).toBeLessThan(source.indexOf('await publish('));
    expect(names).toContain('Upload build receipts');
    expect(names).toContain('Upload full build artifacts on failure or explicit request');
    expect(runBlock('forecast.yml', 'Validate forecast environment and secrets')).not.toContain('${{');
  });

  it('finishes the next scheduled job before the previous normal forecast horizon ends', () => {
    const forecast = workflow('forecast.yml');
    const cron = String(record(list(record(forecast.on).schedule)[0]).cron);
    const [minute, hours, day, month, weekday] = cron.split(' ');
    expect([day, month, weekday]).toEqual(['*', '*', '*']);
    const starts = hours!.split(',').map(hour => Number(hour) * 60 + Number(minute)).sort((a, b) => a - b);
    expect(starts.every(Number.isFinite)).toBe(true);
    const budget = Number(record(record(forecast.jobs)['build-publish'])['timeout-minutes']);
    for (let i = 0; i < starts.length; i++) {
      // Discovery admits six-hour cycles only after the configured source lag.
      const cycle = Math.floor((starts[i]! - GFS_DISCOVERY_LAG_HOURS * 60) / 360) * 360;
      const horizonEnd = cycle + Math.max(...GFS_FORECAST_HOURS) * 60;
      const nextStart = starts[(i + 1) % starts.length]! + (i + 1 === starts.length ? 1440 : 0);
      expect(nextStart + budget).toBeLessThan(horizonEnd);
    }
  });

  it('serializes maintenance with forecast and requires GFS on main', () => {
    const maintenance = workflow('maintenance.yml');
    const job = record(record(maintenance.jobs).maintain);
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe("${{ inputs.environment || 'production' }}");
    expect(record(maintenance.concurrency).group).toBe("forecast-${{ inputs.environment || 'production' }}-gfs");
    expect(record(maintenance.concurrency)['cancel-in-progress']).toBe(false);
    const inputs = record(record(maintenance.on).workflow_dispatch).inputs;
    expect(list(record(record(inputs).model).options)).toEqual(['gfs']);
    expect(list(record(record(inputs).environment).options)).toEqual(['staging', 'production']);
    const names = stepNames(maintenance, 'maintain');
    expect(names.indexOf('Validate maintenance secrets')).toBeLessThan(names.indexOf('Rollback pointer'));
    expect(names.indexOf('Validate publication environment mapping')).toBeLessThan(names.indexOf('Rollback pointer'));
    expect(names).toContain('Validate maintenance inputs');
  });

  it('bootstraps only from main with confirmation and environment resources', () => {
    const bootstrap = workflow('bootstrap.yml');
    expect(Object.keys(record(bootstrap.on))).toEqual(['workflow_dispatch']);
    const job = record(record(bootstrap.jobs).bootstrap);
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe('${{ inputs.environment }}');
    const names = stepNames(bootstrap, 'bootstrap');
    expect(names).toContain('Validate bootstrap inputs and credentials');
    expect(names).toContain('Provision private R2 bucket and Pages project');
    expect(runBlock('bootstrap.yml', 'Validate bootstrap inputs and credentials')).toContain('bootstrap-private-cloudflare');
    expect(record(job.env).CLOUDFLARE_API_TOKEN).toBe('${{ secrets.CLOUDFLARE_BOOTSTRAP_TOKEN }}');
    expect(workflowText('bootstrap.yml')).not.toContain('CLOUDFLARE_API_TOKEN:-');
  });
});
