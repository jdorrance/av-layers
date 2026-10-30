import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifestSchema, type Manifest } from '@av/contracts';
import { buildLocalPointer, shouldSeedAssets, validateArtifactRecords as validatePreviewArtifacts } from './sample-preview';
import { validateArtifactRecords as validateSmokeArtifacts, validateSampleFlags } from './smoke-build';
import { SAMPLE_STATUSES, isSampleStatus, validateSampleContract, type SampleContract } from './smoke-api';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const manifestFixture = () => manifestSchema.parse(JSON.parse(readFileSync(fixture('manifest.contract.json'), 'utf8'))) as Manifest;
const sampleFixture = () => JSON.parse(readFileSync(fixture('sample.contract.json'), 'utf8')) as SampleContract;

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
  it('parses a manifest with 8 frames, 3 layers, 24 records and 48 object paths', () => {
    const manifest = manifestFixture();
    expect(manifest.frames).toHaveLength(8);
    expect(manifest.layers).toHaveLength(3);
    expect(manifest.artifacts).toHaveLength(24);
    expect(new Set(manifest.artifacts.flatMap(item => [item.tilesKey, item.samplesKey])).size).toBe(48);
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
    expect(bash(script, { ACTION: 'rollback', MODEL: 'gfs', BUILD_ID: validBuild, CONFIRM: 'publishers-paused' }).status).toBe(0);
    expect(bash(script, { ACTION: 'cleanup', MODEL: 'icon-armenia', BUILD_ID: '', CONFIRM: 'publishers-paused' }).status).toBe(0);
    expect(bash(script, { ACTION: 'rollback', MODEL: 'gfs; touch /tmp/pwned', BUILD_ID: validBuild, CONFIRM: 'publishers-paused' }).status).not.toBe(0);
    expect(bash(script, { ACTION: 'rollback; touch /tmp/pwned', MODEL: 'gfs', BUILD_ID: validBuild, CONFIRM: 'publishers-paused' }).status).not.toBe(0);
    expect(bash(script, { ACTION: 'rollback', MODEL: 'gfs', BUILD_ID: 'x; touch /tmp/pwned', CONFIRM: 'publishers-paused' }).status).not.toBe(0);
    expect(bash(script, { ACTION: 'rollback', MODEL: 'gfs', BUILD_ID: validBuild, CONFIRM: 'publishers-paused; touch /tmp/pwned' }).status).not.toBe(0);
    expect(bash(script, { ACTION: 'cleanup', MODEL: 'gfs', BUILD_ID: validBuild, CONFIRM: 'publishers-paused' }).status).not.toBe(0);
  });

  it('accepts allowlisted deploy environments and rejects injection attempts', () => {
    const script = runBlock('deploy.yml', 'Validate deploy inputs and credentials');
    const creds = { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' };
    expect(bash(script, { ...creds, TARGET_ENV: 'staging', CONFIRM: 'deploy-read-only-worker' }).status).toBe(0);
    expect(bash(script, { ...creds, TARGET_ENV: 'production', CONFIRM: 'deploy-read-only-worker' }).status).toBe(0);
    expect(bash(script, { ...creds, TARGET_ENV: 'staging; touch /tmp/pwned', CONFIRM: 'deploy-read-only-worker' }).status).not.toBe(0);
    expect(bash(script, { ...creds, TARGET_ENV: 'staging', CONFIRM: 'deploy-read-only-worker; touch /tmp/pwned' }).status).not.toBe(0);
    expect(bash(script, { TARGET_ENV: 'staging', CONFIRM: 'deploy-read-only-worker' }).status).not.toBe(0);
  });
});
