import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { manifestSchema } from '@av/contracts';
import { forecastFindings, forecastScheduleFindings, forecastWorkflowFindings, maintenanceFindings, monitor, type ObservedWorkflowRun } from './monitor-health.js';
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


describe('maintenance and forecast workflow observations', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const run = (overrides: Partial<ObservedWorkflowRun> = {}): ObservedWorkflowRun => ({ status: 'completed', conclusion: 'failure', created_at: '2026-11-01T11:00:00Z', html_url: 'https://github.com/owner/repo/actions/runs/1', display_title: 'Maintenance production gfs cleanup', event: 'workflow_dispatch', ...overrides });
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
  it('isolates staging and production forecast runs and clears scheduled failures after manual recovery', () => {
    const failedProd = run({ display_title: 'Forecast production gfs', event: 'schedule' });
    const failedStaging = run({ display_title: 'Forecast staging gfs', html_url: 'https://github.com/owner/repo/actions/runs/2' });
    expect(forecastWorkflowFindings([failedStaging, run({ ...failedProd, conclusion: 'success' })], 'production', now)).toEqual([]);
    expect(forecastWorkflowFindings([failedStaging], 'staging', now)).toEqual(['publisher-or-cleanup-failure: https://github.com/owner/repo/actions/runs/2']);
    expect(forecastWorkflowFindings([], 'staging', now)).toEqual([]);
    expect(forecastWorkflowFindings([], 'production', now)).toEqual([]);
    const manualRecovery = run({ display_title: 'Forecast production gfs', conclusion: 'success', created_at: '2026-11-01T11:30:00Z' });
    expect(forecastWorkflowFindings([manualRecovery, failedProd], 'production', now)).toEqual([]);
  });
  it('reports missing scheduled runs even after a successful manual publication', () => {
    const manual = run({ display_title: 'Forecast production gfs', conclusion: 'success' });
    const oldScheduled = run({ display_title: 'Forecast production gfs', event: 'schedule', created_at: '2026-10-31T21:00:00Z' });
    expect(forecastWorkflowFindings([manual, oldScheduled], 'production', now)).toEqual([]);
    expect(forecastScheduleFindings([manual, oldScheduled], now)).toEqual(['missed-schedule: no scheduled forecast run within 14 hours']);
    expect(forecastScheduleFindings([manual], now)).toEqual(['missed-schedule: no scheduled forecast run within 14 hours']);
    expect(forecastScheduleFindings([run({ event: 'schedule', status: 'in_progress', conclusion: null })], now)).toEqual([]);
  });
  it('does not attribute an old unlabelled manual staging run to production', () => {
    const legacyManual = run({ display_title: 'Forecast' });
    expect(forecastWorkflowFindings([legacyManual], 'production', now)).toEqual([]);
    const scheduled = run({ display_title: 'Forecast', event: 'schedule', created_at: '2026-11-01T10:00:00Z' });
    expect(forecastWorkflowFindings([run({ ...legacyManual, conclusion: 'success' }), scheduled], 'production', now)).toEqual([`publisher-or-cleanup-failure: ${scheduled.html_url}`]);
    expect(forecastScheduleFindings([scheduled], now)).toEqual([`publisher-or-cleanup-failure: ${scheduled.html_url}`]);
    expect(forecastScheduleFindings([run({ ...scheduled, conclusion: 'success' })], now)).toEqual([]);
  });
});
