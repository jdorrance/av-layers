import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { manifestSchema } from '@av/contracts';
import { forecastFindings, maintenanceFindings, monitor, type ObservedWorkflowRun } from './monitor-health.js';
import * as serving from './smoke-api.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('keeps forecast identity and expiry findings when a later serving probe fails', async () => {
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(new URL('./fixtures/manifest.contract.json', import.meta.url), 'utf8')));
  manifest.expiresAt = new Date(0).toISOString();
  vi.stubEnv('GITHUB_REPOSITORY', '');
  vi.spyOn(serving, 'probeApi').mockImplementation(async options => {
    options.observeManifest?.(manifest);
    throw new Error('sample unavailable');
  });
  const result = await monitor('https://api.example');
  expect(result).toMatchObject({ healthy: false, buildId: manifest.buildId });
  expect(result.findings.join(';')).toContain('expired-publication');
  expect(result.findings.join(';')).toContain('sample unavailable');
});

describe('forecast health decisions', () => {
  const fixture = () => manifestSchema.parse(JSON.parse(readFileSync(new URL('./fixtures/manifest.contract.json', import.meta.url), 'utf8')));
  it('keeps a fresh complete horizon quiet', () => {
    const manifest = fixture();
    expect(forecastFindings(manifest, Date.parse(manifest.cycle) + 6 * 3600000)).toEqual([]);
  });
  it('distinguishes lag, missed publication and exhausted horizon from retention expiry', () => {
    const manifest = fixture(), findings = forecastFindings(manifest, Date.parse(manifest.cycle) + 25 * 3600000);
    expect(findings.join(';')).toContain('missed-publication');
    expect(findings.join(';')).toContain('upstream-lag');
    expect(findings.join(';')).toContain('shrinking-horizon');
    expect(findings.join(';')).not.toContain('expired-publication');
  });
});


describe('maintenance workflow observations', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const run = (overrides: Partial<ObservedWorkflowRun> = {}): ObservedWorkflowRun => ({ status: 'completed', conclusion: 'failure', created_at: '2026-11-01T11:00:00Z', html_url: 'https://github.com/owner/repo/actions/runs/1', display_title: 'Maintenance production gfs cleanup', ...overrides });
  it('reports recent cleanup failures for the correct environment without reading artifacts', () => {
    expect(maintenanceFindings([run()], 'production', now).join(';')).toContain('maintenance-workflow-failure (cleanup');
    expect(maintenanceFindings([run()], 'staging', now)).toEqual([]);
    expect(maintenanceFindings([run({ created_at: '2026-10-30T11:00:00Z' })], 'production', now)).toEqual([]);
  });
  it('keeps a failed cleanup visible during retry and clears it after a successful cleanup', () => {
    const retry = run({ status: 'in_progress', conclusion: null, created_at: '2026-11-01T11:30:00Z' });
    expect(maintenanceFindings([retry, run()], 'production', now)).toHaveLength(1);
    expect(maintenanceFindings([run({ ...retry, status: 'completed', conclusion: 'success' }), run()], 'production', now)).toEqual([]);
    expect(maintenanceFindings([run({ ...retry, status: 'completed', conclusion: 'success', display_title: 'Maintenance production gfs rollback' }), run()], 'production', now)).toHaveLength(1);
  });
});
