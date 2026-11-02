import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { getProduct, type Manifest } from '@av/contracts';
import { probeApi } from './smoke-api.js';

export function forecastFindings(manifest: Manifest, now: number): string[] {
  const findings: string[] = [], product = getProduct(manifest.model);
  if (!product) return ['unknown-product: latest forecast model is not registered'];
  const ageHours = (now - Date.parse(manifest.createdAt)) / 3600000;
  const cycleAgeHours = (now - Date.parse(manifest.cycle)) / 3600000;
  const horizonHours = (Math.max(...manifest.frames.map(f => Date.parse(f.validTime))) - now) / 3600000;
  if (ageHours > 14) findings.push('missed-publication: latest build is more than 14 hours old');
  if (cycleAgeHours > product.freshness.maxCycleAgeHours) findings.push('upstream-lag: source cycle exceeds the admitted age');
  if (horizonHours < product.freshness.minHorizonHours) findings.push(`shrinking-horizon: less than ${product.freshness.minHorizonHours} hours of forecast remain`);
  if (Date.parse(manifest.expiresAt) <= now) findings.push('expired-publication: retained build expired');
  return findings;
}

export interface ObservedWorkflowRun { status: string; conclusion: string | null; created_at: string; html_url: string; display_title: string; event: string }
export function maintenanceFindings(runs: readonly ObservedWorkflowRun[], environment: string, now: number, model = 'gfs'): string[] {
  const findings: string[] = [];
  for (const action of ['cleanup', 'rollback']) {
    const latest = runs.filter(run => run.display_title === `Maintenance ${environment} ${model} ${action}` && run.status === 'completed' && now - Date.parse(run.created_at) <= 24 * 3600000)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (latest && latest.conclusion !== 'success') findings.push(`maintenance-workflow-failure (${action}): ${latest.html_url}`);
  }
  return findings;
}
export function forecastWorkflowFindings(runs: readonly ObservedWorkflowRun[], environment: string, now: number, model = 'gfs'): string[] {
  const matching = runs.filter(run => run.display_title === `Forecast ${environment} ${model}` || (environment === 'production' && model === 'gfs' && run.event === 'schedule' && run.display_title === 'Forecast'))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const latestCompleted = matching.find(run => run.status === 'completed' && now - Date.parse(run.created_at) <= 24 * 3600000);
  return latestCompleted && latestCompleted.conclusion !== 'success' ? [`publisher-or-cleanup-failure: ${latestCompleted.html_url}`] : [];
}
export function forecastScheduleFindings(runs: readonly ObservedWorkflowRun[], now: number): string[] {
  const scheduled = runs.filter(run => run.event === 'schedule').sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const latest = scheduled[0];
  const findings = !latest || now - Date.parse(latest.created_at) > 14 * 3600000 ? ['missed-schedule: no scheduled forecast run within 14 hours'] : [];
  const latestCompleted = scheduled.find(run => run.status === 'completed' && now - Date.parse(run.created_at) <= 24 * 3600000);
  if (latestCompleted && latestCompleted.conclusion !== 'success') {
    const recovered = runs.some(run =>
      (run.display_title === 'Forecast production gfs' || (run.event === 'schedule' && run.display_title === 'Forecast')) &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      Date.parse(run.created_at) > Date.parse(latestCompleted.created_at) &&
      now - Date.parse(run.created_at) <= 24 * 3600000
    );
    if (!recovered) findings.push(`publisher-or-cleanup-failure: ${latestCompleted.html_url}`);
  }
  return findings;
}
function workflowRuns(raw: unknown): ObservedWorkflowRun[] {
  const runs = (raw as { workflow_runs?: unknown })?.workflow_runs;
  if (!Array.isArray(runs) || runs.length > 100 || runs.some(run => !run || typeof run.status !== 'string' || (run.conclusion !== null && typeof run.conclusion !== 'string') || !Number.isFinite(Date.parse(run.created_at)) || typeof run.html_url !== 'string' || typeof run.display_title !== 'string' || typeof run.event !== 'string')) throw new Error('Invalid workflow observation');
  return runs;
}

/** Read-only checks. A failed workflow is the alert; successful unchanged checks send no messages. */
export async function monitor(baseUrl: string, model = 'gfs') {
  const findings: string[] = [], checkedAt = new Date().toISOString();
  let buildId: string | undefined, sourceRevision: string | undefined;
  try {
    if (!getProduct(model)) throw new Error('Unknown forecast model');
    await probeApi({ baseUrl, model, requireLive: false, observeManifest(manifest) {
      buildId = manifest.buildId; sourceRevision = manifest.recipe.sourceRevision;
      findings.push(...forecastFindings(manifest, Date.now()));
    } });
  } catch (error) { findings.push(`serving-integrity: ${String(error)}`); }
  const repository = process.env.GITHUB_REPOSITORY;
  const environment = process.env.TARGET_ENV;
  if (repository && /^[\w.-]+\/[\w.-]+$/.test(repository) && (environment === 'production' || environment === 'staging')) {
    const workflows: Array<'forecast' | 'maintenance' | 'schedule'> = ['forecast', 'maintenance'];
    if (environment === 'production' && model === 'gfs') workflows.push('schedule');
    const observations = await Promise.allSettled(workflows.map(async workflow => {
      // A separate schedule query cannot be crowded out by staging/manual runs.
      const query = workflow === 'schedule' ? 'event=schedule&branch=main&per_page=10' : workflow === 'forecast' ? 'branch=main&per_page=50' : 'event=workflow_dispatch&branch=main&per_page=50';
      const name = workflow === 'schedule' ? 'forecast' : workflow;
      const { stdout } = await promisify(execFile)('gh', ['api', `repos/${repository}/actions/workflows/${name}.yml/runs?${query}`], { timeout: 15_000, maxBuffer: 1024 * 1024 });
      return workflowRuns(JSON.parse(stdout));
    }));
    const forecastRuns: ObservedWorkflowRun[] = [];
    const scheduleRuns: ObservedWorkflowRun[] = [];
    observations.forEach((observation, index) => {
      const workflow = workflows[index];
      if (observation.status === 'rejected') { findings.push(`workflow-observation (${workflow}): ${String(observation.reason)}`); return; }
      if (workflow === 'maintenance') findings.push(...maintenanceFindings(observation.value, environment, Date.now(), model));
      else if (workflow === 'schedule') scheduleRuns.push(...observation.value);
      else forecastRuns.push(...observation.value);
    });
    const combinedForecastRuns = [...forecastRuns, ...scheduleRuns.filter(s => !forecastRuns.some(f => f.html_url === s.html_url))];
    if (combinedForecastRuns.length) findings.push(...forecastWorkflowFindings(combinedForecastRuns, environment, Date.now(), model));
    if (workflows.includes('schedule') && observations[workflows.indexOf('schedule')]?.status === 'fulfilled') {
      for (const item of forecastScheduleFindings([...scheduleRuns, ...forecastRuns], Date.now())) {
        if (!findings.includes(item)) findings.push(item);
      }
    }
  }
  return { version: 1, checkedAt, baseUrl, buildId, sourceRevision, healthy: findings.length === 0, findings, runbook: 'docs/operations.md#check-a-failure' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseUrl = process.env.API_BASE_URL;
  if (!baseUrl) throw new Error('API_BASE_URL is required');
  const result = await monitor(baseUrl.replace(/\/+$/, ''), process.env.MODEL ?? 'gfs');
  await mkdir('output/health', { recursive: true });
  await writeFile('output/health/latest.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (!result.healthy) process.exitCode = 1;
}
