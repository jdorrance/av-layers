import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { getProduct, type PublishedManifest } from '@av/contracts';
import { probeApi } from './smoke-api.js';

export function forecastFindings(manifest: PublishedManifest, now: number): string[] {
  const findings: string[] = [], product = getProduct(manifest.model);
  if (!product) return ['unknown-product: latest forecast model is not registered'];
  const ageHours = (now - Date.parse(manifest.createdAt)) / 3600000;
  const cycleAgeHours = (now - Date.parse(manifest.cycle)) / 3600000;
  const horizonHours = (Math.max(...manifest.frames.map(f => Date.parse(f.validTime))) - now) / 3600000;
  if (ageHours > 14) findings.push('missed-publication: latest build is more than 14 hours old');
  if (cycleAgeHours > product.freshness.maxCycleAgeHours) findings.push('upstream-lag: source cycle exceeds the admitted age');
  const daylightFiltered = product.capabilities.daylightFrames === 'regional-daylight';
  // Publication validates the exact selected frame list; omitted night hours do not shorten source coverage.
  const coverageHours = daylightFiltered ? product.frameHours.at(-1)! - cycleAgeHours : horizonHours;
  if (coverageHours < product.freshness.minHorizonHours) findings.push(`shrinking-horizon: less than ${product.freshness.minHorizonHours} hours of forecast remain`);
  if (daylightFiltered && horizonHours <= 0) findings.push('exhausted-horizon: no published forecast times remain');
  if (Date.parse(manifest.expiresAt) <= now) findings.push('expired-publication: retained build expired');
  return findings;
}

interface ObservedWorkflowJob { name: string; status: string; conclusion: string | null }
export interface ObservedWorkflowRun {
  id?: number;
  status: string; conclusion: string | null; created_at: string; html_url: string; display_title: string; event: string;
  jobs?: readonly ObservedWorkflowJob[];
}
export function maintenanceFindings(runs: readonly ObservedWorkflowRun[], environment: string, now: number, model = 'gfs'): string[] {
  const findings: string[] = [];
  for (const action of ['cleanup', 'rollback']) {
    const latest = runs.filter(run => run.display_title === `Maintenance ${environment} ${model} ${action}` && run.status === 'completed' && now - Date.parse(run.created_at) <= 24 * 3600000)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (latest && latest.conclusion !== 'success') findings.push(`maintenance-workflow-failure (${action}): ${latest.html_url}`);
  }
  return findings;
}
function matchesForecast(run: ObservedWorkflowRun, environment: string, model: string): boolean {
  return run.display_title === `Forecast ${environment} ${model}` || run.display_title === `Forecast ${environment} all`
    || (environment === 'production' && model === 'gfs' && run.event === 'schedule' && run.display_title === 'Forecast');
}
function latestCompletedForecast(runs: readonly ObservedWorkflowRun[], environment: string, now: number, model: string): ObservedWorkflowRun | undefined {
  return runs.filter(run => matchesForecast(run, environment, model) && run.status === 'completed' && now - Date.parse(run.created_at) <= 24 * 3600000)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
}
export function forecastWorkflowFindings(runs: readonly ObservedWorkflowRun[], environment: string, now: number, model = 'gfs'): string[] {
  const latest = latestCompletedForecast(runs, environment, now, model);
  if (!latest) return [];
  if (latest.display_title === `Forecast ${environment} all`) {
    if (!latest.jobs) return [`workflow-observation (forecast): missing completed ${model} jobs: ${latest.html_url}`];
    const jobs = latest.jobs.filter(job => job.name.startsWith(`Forecast ${model} / `));
    if (!jobs.length) {
      return [latest.conclusion && latest.conclusion !== 'success'
        ? `publisher-or-cleanup-failure: ${latest.html_url}`
        : `workflow-observation (forecast): missing completed ${model} jobs: ${latest.html_url}`];
    }
    if (jobs.some(job => job.status !== 'completed')) return [`workflow-observation (forecast): missing completed ${model} jobs: ${latest.html_url}`];
    if (jobs.some(job => job.conclusion !== 'success' && job.conclusion !== 'skipped')) return [`publisher-or-cleanup-failure: ${latest.html_url}`];
    // A successful plan may skip an already-published cycle; a resume may skip planning.
    if (!jobs.some(job => job.conclusion === 'success')) return [`workflow-observation (forecast): no completed ${model} work: ${latest.html_url}`];
    return [];
  }
  return latest.conclusion !== 'success' ? [`publisher-or-cleanup-failure: ${latest.html_url}`] : [];
}
export function forecastScheduleFindings(runs: readonly ObservedWorkflowRun[], now: number, model = 'gfs'): string[] {
  const scheduled = runs.filter(run => run.event === 'schedule' && matchesForecast(run, 'production', model))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const latest = scheduled[0];
  const findings = !latest || now - Date.parse(latest.created_at) > 14 * 3600000 ? ['missed-schedule: no scheduled forecast run within 14 hours'] : [];
  return [...findings, ...forecastWorkflowFindings(runs, 'production', now, model)];
}
function workflowRuns(raw: unknown): ObservedWorkflowRun[] {
  const runs = (raw as { workflow_runs?: unknown })?.workflow_runs;
  if (!Array.isArray(runs) || runs.length > 100 || runs.some(run => !run || typeof run.status !== 'string' || (run.conclusion !== null && typeof run.conclusion !== 'string') || !Number.isFinite(Date.parse(run.created_at)) || typeof run.html_url !== 'string' || typeof run.display_title !== 'string' || typeof run.event !== 'string')) throw new Error('Invalid workflow observation');
  return runs;
}

async function observeModelJobs(run: ObservedWorkflowRun, repository: string): Promise<void> {
  if (!Number.isSafeInteger(run.id) || run.id! < 1) throw new Error('Invalid forecast run ID');
  const collected: ObservedWorkflowJob[] = [];
  for (let page = 1; page <= 5; page++) {
    const suffix = page === 1 ? '' : `&page=${page}`;
    const { stdout } = await promisify(execFile)('gh', ['api', `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100${suffix}`], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout) as { jobs?: ObservedWorkflowJob[]; total_count?: number };
    const jobs = result.jobs;
    if (!Array.isArray(jobs) || jobs.length > 100 || !Number.isSafeInteger(result.total_count) || result.total_count! < jobs.length || result.total_count! > 500
        || jobs.some(job => !job || typeof job.name !== 'string' || typeof job.status !== 'string' || (job.conclusion !== null && typeof job.conclusion !== 'string'))) {
      throw new Error('Incomplete or invalid forecast job observation');
    }
    collected.push(...jobs);
    if (collected.length >= result.total_count! || jobs.length === 0) {
      if (collected.length !== result.total_count) throw new Error('Incomplete or invalid forecast job observation');
      run.jobs = collected;
      return;
    }
  }
  throw new Error('Incomplete or invalid forecast job observation');
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
    if (environment === 'production') workflows.push('schedule');
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
    const latest = latestCompletedForecast(combinedForecastRuns, environment, Date.now(), model);
    if (latest?.display_title === `Forecast ${environment} all`) {
      try { await observeModelJobs(latest, repository); }
      catch (error) { findings.push(`workflow-observation (forecast jobs): ${String(error)}`); }
    }
    if (combinedForecastRuns.length) findings.push(...forecastWorkflowFindings(combinedForecastRuns, environment, Date.now(), model));
    if (workflows.includes('schedule') && observations[workflows.indexOf('schedule')]?.status === 'fulfilled') {
      for (const item of forecastScheduleFindings(combinedForecastRuns, Date.now(), model)) {
        if (!findings.includes(item)) findings.push(item);
      }
    }
  }
  return { version: 1, checkedAt, baseUrl, model, buildId, sourceRevision, healthy: findings.length === 0, findings, runbook: 'docs/operations.md#check-a-failure' };
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
