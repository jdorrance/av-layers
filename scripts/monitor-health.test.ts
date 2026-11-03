import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeFreshness, ICON_EU_PRODUCT, manifestSchema } from '@av/contracts';
import { resolveProductFrameHours } from '@av/forecast';
import { loadCoverage } from '../apps/batch/src/coverage.js';
import { assertUsefulHorizon } from '../apps/batch/src/publication.js';
import { forecastFindings, forecastScheduleFindings, forecastWorkflowFindings, maintenanceFindings, monitor, type ObservedWorkflowRun } from './monitor-health.js';
import * as serving from './smoke-api.js';

const fake = vi.hoisted(() => ({ gh: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: fake.gh }) };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fake.gh.mockReset(); });

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
  const regionalFixture = (cycle = '2026-12-21T00:00:00Z', hours: readonly number[] = [18, 19]) => {
    const manifest = fixture(), cycleMs = Date.parse(cycle);
    manifest.model = 'icon-eu';
    manifest.cycle = cycle;
    manifest.createdAt = new Date(cycleMs + 6 * 3600000).toISOString();
    manifest.expiresAt = new Date(cycleMs + 7 * 86400000).toISOString();
    manifest.frames = hours.map(hour => ({
      id: `f${String(hour).padStart(3, '0')}`,
      validTime: new Date(cycleMs + hour * 3600000).toISOString(),
      intervalStart: new Date(cycleMs + (hour - 1) * 3600000).toISOString(),
      intervalEnd: new Date(cycleMs + hour * 3600000).toISOString()
    }));
    return manifest;
  };
  it.each(['2026-11-03', '2026-12-21', '2027-02-15'])('retains useful ICON hours across winter cycles on %s', async day => {
    const product = ICON_EU_PRODUCT, mask = await loadCoverage(product);
    for (const cycleHour of [0, 6, 12, 18]) {
      const cycle = `${day}T${String(cycleHour).padStart(2, '0')}:00:00Z`;
      const hours = resolveProductFrameHours(product, mask, cycle), manifest = regionalFixture(cycle, hours);
      expect(hours.length).toBeLessThan(product.frameHours.length);
      expect(hours.at(-1)).toBe(cycleHour === 0 ? 19 : product.frameHours.at(-1));
      const published = computeFreshness(manifest, Date.parse(manifest.createdAt));
      expect(published.horizonRemainingSeconds).toBeGreaterThanOrEqual(product.freshness.minHorizonHours * 3600);
      expect(() => assertUsefulHorizon(manifest, Date.parse(manifest.createdAt))).not.toThrow();
      const admissionDeadline = Date.parse(published.latestValidTime) - product.freshness.minHorizonHours * 3600000;
      expect(() => assertUsefulHorizon(manifest, admissionDeadline)).not.toThrow();
      expect(() => assertUsefulHorizon(manifest, admissionDeadline + 1)).toThrow('useful forecast horizon');
      for (const age of [13.5, 17.5]) expect(forecastFindings(manifest, Date.parse(cycle) + age * 3600000)).toEqual([]);
      expect(forecastFindings(manifest, Date.parse(published.latestValidTime))).toContain('exhausted-horizon: no published forecast times remain');
    }
  });
  it.each(['missing', 'exhausted'])('reports %s useful daylight slots even with six hours of source coverage remaining', state => {
    const manifest = regionalFixture();
    manifest.frames = state === 'missing' ? [] : manifest.frames.map(frame => ({ ...frame, validTime: manifest.createdAt }));
    expect(forecastFindings(manifest, Date.parse(manifest.cycle) + 13 * 3600000)).toEqual(['exhausted-horizon: no published forecast times remain']);
  });
  it('still detects the end of configured source coverage before the last daylight frame expires', () => {
    const manifest = regionalFixture(), findings = forecastFindings(manifest, Date.parse(manifest.cycle) + 18.5 * 3600000);
    expect(findings.join(';')).toContain('shrinking-horizon');
    expect(findings.join(';')).toContain('upstream-lag');
    expect(findings.join(';')).not.toContain('exhausted-horizon');
  });
  it('keeps the six-hour check tied to published frames for an all-hours model', () => {
    const manifest = regionalFixture();
    manifest.model = 'gfs';
    expect(forecastFindings(manifest, Date.parse(manifest.cycle) + 17.5 * 3600000)).toEqual(['shrinking-horizon: less than 6 hours of forecast remain']);
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
    expect(forecastScheduleFindings([run({ display_title: 'Forecast production gfs', event: 'schedule', status: 'in_progress', conclusion: null })], now)).toEqual([]);
  });
  const modelJobs = (model: string, conclusion: string, skipped = false) => [
    { name: `Forecast ${model} / Plan ${model}`, status: 'completed', conclusion: 'success' },
    { name: `Forecast ${model} / Build ${model} batch 0`, status: 'completed', conclusion: skipped ? 'skipped' : conclusion },
    { name: `Forecast ${model} / Publish ${model}`, status: 'completed', conclusion: skipped || conclusion !== 'success' ? 'skipped' : 'success' }
  ];
  it('attributes all-model failures to the model whose jobs failed', () => {
    const all = run({ display_title: 'Forecast production all', event: 'schedule', jobs: [...modelJobs('gfs', 'success'), ...modelJobs('icon-eu', 'failure')] });
    expect(forecastWorkflowFindings([all], 'production', now, 'gfs')).toEqual([]);
    expect(forecastWorkflowFindings([all], 'production', now, 'icon-eu')).toEqual([`publisher-or-cleanup-failure: ${all.html_url}`]);
    expect(forecastScheduleFindings([all], now, 'gfs')).toEqual([]);
    expect(forecastScheduleFindings([all], now, 'icon-eu')).toEqual([`publisher-or-cleanup-failure: ${all.html_url}`]);
    expect(forecastWorkflowFindings([all], 'staging', now, 'icon-eu')).toEqual([]);
  });
  it('accepts an already-published model while another model fails', () => {
    const all = run({ display_title: 'Forecast production all', event: 'schedule', jobs: [...modelJobs('gfs', 'success', true), ...modelJobs('icon-eu', 'failure')] });
    expect(forecastScheduleFindings([all], now, 'gfs')).toEqual([]);
  });
  it('keeps missing model work visible instead of trusting an all-run conclusion', () => {
    const all = run({ display_title: 'Forecast production all', conclusion: 'success', jobs: modelJobs('gfs', 'success') });
    expect(forecastWorkflowFindings([all], 'production', now, 'icon-eu').join(';')).toContain('workflow-observation');
    expect(forecastWorkflowFindings([{ ...all, jobs: undefined }], 'production', now).join(';')).toContain('workflow-observation');
    const skipped = { ...all, jobs: [{ name: 'Forecast icon-eu / Publish icon-eu', status: 'completed', conclusion: 'skipped' }] };
    expect(forecastWorkflowFindings([skipped], 'production', now, 'icon-eu').join(';')).toContain('no completed icon-eu work');
  });
  it('requires a scheduled run for each model and isolates manual recovery', () => {
    const gfs = run({ display_title: 'Forecast production gfs', event: 'schedule', conclusion: 'success' });
    expect(forecastScheduleFindings([gfs], now, 'icon-eu')).toEqual(['missed-schedule: no scheduled forecast run within 14 hours']);
    const all = run({ display_title: 'Forecast production all', event: 'schedule', jobs: [...modelJobs('gfs', 'success'), ...modelJobs('icon-eu', 'failure')] });
    const recovery = run({ display_title: 'Forecast production icon-eu', conclusion: 'success', created_at: '2026-11-01T11:30:00Z' });
    expect(forecastScheduleFindings([all, recovery], now, 'icon-eu')).toEqual([]);
    expect(forecastScheduleFindings([all, { ...recovery, display_title: 'Forecast production gfs' }], now, 'icon-eu')).toEqual([`publisher-or-cleanup-failure: ${all.html_url}`]);
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

it.each(['gfs', 'icon-eu'])('observes only the latest all-run jobs for %s and checks its schedule', async model => {
  vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo');
  vi.stubEnv('TARGET_ENV', 'production');
  vi.spyOn(serving, 'probeApi').mockResolvedValue(manifestSchema.parse(JSON.parse(readFileSync(new URL('./fixtures/manifest.contract.json', import.meta.url), 'utf8'))));
  const latest: ObservedWorkflowRun = {
    id: 2, status: 'completed', conclusion: 'failure', created_at: new Date(Date.now() - 60_000).toISOString(),
    html_url: 'https://github.com/owner/repo/actions/runs/2', display_title: 'Forecast production all', event: 'schedule'
  };
  fake.gh.mockImplementation(async (_command: string, args: string[]) => {
    const path = args[1];
    if (path.includes('/maintenance.yml/')) return { stdout: JSON.stringify({ workflow_runs: [] }) };
    if (path.includes('/forecast.yml/')) return { stdout: JSON.stringify({ workflow_runs: [latest, { ...latest, id: 1, created_at: new Date(Date.now() - 3600_000).toISOString() }] }) };
    expect(path).toBe('repos/owner/repo/actions/runs/2/jobs?filter=latest&per_page=100');
    return { stdout: JSON.stringify({ total_count: 2, jobs: [
      { name: 'Forecast gfs / Publish gfs', status: 'completed', conclusion: 'success' },
      { name: 'Forecast icon-eu / Build icon-eu batch 0', status: 'completed', conclusion: 'failure' }
    ] }) };
  });
  const result = await monitor('https://api.example', model);
  expect(result.healthy).toBe(model === 'gfs');
  expect(result.findings).toEqual(model === 'gfs' ? [] : [`publisher-or-cleanup-failure: ${latest.html_url}`]);
  expect(fake.gh).toHaveBeenCalledTimes(4);
  expect(fake.gh.mock.calls.some(([, args]) => args[1].includes('event=schedule'))).toBe(true);
});
