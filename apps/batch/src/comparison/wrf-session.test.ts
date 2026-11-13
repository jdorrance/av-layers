import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PinnedBuild } from '@av/client';
import { fixturePointBuild, fixturePointSample } from '../../../../tests/client-point-fixture.js';
import { planWrfComparison, captureWrfComparison, reportWrfComparison } from './wrf-session.js';

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'wrf-comparison-')); dirs.push(dir);
  const models = ['baseline', 'control', 'fine'];
  const builds = models.map(model => JSON.parse(JSON.stringify(fixturePointBuild({ frameHours: [7, 8] })).replaceAll('gfs', model)) as PinnedBuild);
  builds.forEach(build => { build.manifest.tool.components = { science: 'c'.repeat(64) }; });
  const cycle = builds[0].manifest.cycle, origin = new Date(Date.parse(cycle) + 6 * 3600000).toISOString();
  builds.slice(1).forEach(build => { build.manifest.cycle = origin; });
  const runs = await Promise.all(builds.map(async (build, index) => {
    const runLock = { model_id: build.manifest.model, publish_origin_utc: build.manifest.cycle, forcing_cycle_utc: cycle,
      wrf_init_utc: cycle, spinup_hours: 6, config_sha256: 'a'.repeat(64), forcing_profile_id: 'forcing', attempt_id: 'attempt' };
    const readyReceipt = join(dir, `ready-${index}.json`);
    await writeFile(readyReceipt, JSON.stringify(runLock));
    return { model: build.manifest.model, buildId: build.manifest.buildId, ...(index ? { runLock, readyReceipt } : {}) };
  }));
  const campaign = { forcing_profile: 'forcing', baseline_model: models[0], products: models.slice(1), layers: ['sfc-temp-c', 'wind-10m-u'],
    sites: [{ id: 'valley', name: 'Valley', lat: 40.2, lon: 44.3, region: 'europe-caucasus', terrain: 'valley', timezone: 'UTC', source: 'fixture' }] };
  const campaignPath = join(dir, 'campaign.json'), runsPath = join(dir, 'runs.json');
  await writeFile(campaignPath, JSON.stringify(campaign)); await writeFile(runsPath, JSON.stringify(runs));
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input)), index = models.indexOf(url.pathname.split('/')[3]);
    const build = builds[index];
    if (url.pathname.endsWith('/provenance')) {
      const bytes = await readFile(runs[index].readyReceipt!);
      return Response.json({ model: build.manifest.model, buildId: build.manifest.buildId,
        receipt: { sourcePin: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length } } });
    }
    if (!url.pathname.endsWith('/samples')) return Response.json(build.manifest);
    const points = url.searchParams.get('points')!.split(';').map((pair, index) => {
      const [lat, lon] = pair.split(','); url.searchParams.set('lat', lat); url.searchParams.set('lon', lon);
      return { index, sample: fixturePointSample(build, url.href) };
    });
    return Response.json({ version: 1, model: build.manifest.model, buildId: build.manifest.buildId, expiresAt: build.manifest.expiresAt, points });
  });
  vi.stubGlobal('fetch', fetcher);
  return { dir, builds, runs, runsPath, fetcher, options: { campaign: campaignPath, runs: runsPath, api: 'https://api.test', reference: '2099-01-01T00:00:00Z' } };
}

describe('WRF comparison archive', () => {
  it('pins three products, captures with existing AV budgets, and replays offline at matching valid times', async () => {
    const { dir, options, fetcher } = await setup();
    const plan = await planWrfComparison(dir, options);
    expect(plan.builds).toHaveLength(3); expect(new Set(plan.builds.map(build => build.sourceCycle)).size).toBe(1);
    await captureWrfComparison(dir);
    const calls = fetcher.mock.calls.length;
    await captureWrfComparison(dir); expect(fetcher).toHaveBeenCalledTimes(calls);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const report = await reportWrfComparison(dir);
    expect(report.differences.control.counts.numericPairs).toBe(4);
    expect(report.differences.fine.counts.numericPairs).toBe(4);
    expect(report.observations).toBeNull();
    const normalized = JSON.parse(await readFile(join(dir, 'wrf-normalized.json'), 'utf8'));
    expect(normalized).toHaveLength(6);
  });
  it('rejects mixed forcing cycles and late builds', async () => {
    const { dir, options, runs, runsPath } = await setup();
    runs[2].runLock!.forcing_cycle_utc = '2098-01-01T00:00:00Z';
    await writeFile(runsPath, JSON.stringify(runs));
    await expect(planWrfComparison(dir, options)).rejects.toThrow('Matched source cycles');
    const other = await setup();
    await expect(planWrfComparison(other.dir, { ...other.options, reference: '2000-01-01T00:00:00Z' })).rejects.toThrow('briefing cutoff');
  });
  it('rejects a supplied receipt that differs from its run lock', async () => {
    const { dir, options, runs } = await setup();
    const path = runs[1].readyReceipt!;
    const receipt = JSON.parse(await readFile(path, 'utf8')); receipt.config_sha256 = 'b'.repeat(64);
    await writeFile(path, JSON.stringify(receipt));
    await expect(planWrfComparison(dir, options)).rejects.toThrow('differs from run lock');
  });
  it('rejects changed archived ready bytes during offline replay', async () => {
    const { dir, options } = await setup();
    await planWrfComparison(dir, options); await captureWrfComparison(dir);
    await writeFile(join(dir, 'captures', 'ready-1.json'), '{}');
    await expect(reportWrfComparison(dir)).rejects.toThrow('Archived ready receipt changed');
  });
  it('rejects a mismatched producer source and altered consumer source pin', async () => {
    const first = await setup(); first.runs[1].runLock!.forcing_profile_id = 'other-source';
    await writeFile(first.runsPath, JSON.stringify(first.runs));
    await expect(planWrfComparison(first.dir, first.options)).rejects.toThrow('forcing profile');
    const second = await setup(), delegate = second.fetcher.getMockImplementation()!;
    second.fetcher.mockImplementation(async (...args) => {
      const response = await delegate(...args);
      if (!String(args[0]).includes('/provenance')) return response;
      const body = await response.json(); body.receipt.sourcePin.sha256 = '0'.repeat(64);
      return Response.json(body);
    });
    await expect(planWrfComparison(second.dir, second.options)).rejects.toThrow('source pin');
  });

  it('resumes partial planning and failed HTTP captures while preserving failure evidence', async () => {
    const { dir, options, fetcher } = await setup(), delegate = fetcher.getMockImplementation()!;
    let fail = true;
    fetcher.mockImplementation(async (...args) => fail && String(args[0]).includes('/fine/')
      ? new Response('transient', { status: 500 }) : delegate(...args));
    await expect(planWrfComparison(dir, options)).rejects.toThrow('HTTP 500');
    fail = false;
    const plan = await planWrfComparison(dir, options);
    expect(plan.builds[2].manifestId).toBe('manifest-2-retry-1');
    fetcher.mockResolvedValueOnce(new Response('transient', { status: 500 }));
    await expect(captureWrfComparison(dir)).rejects.toThrow('HTTP 500');
    await captureWrfComparison(dir);
    expect(JSON.parse(await readFile(join(dir, 'captures', 'samples-0.json'), 'utf8')).status).toBe(500);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await reportWrfComparison(dir);
    const normalized = JSON.parse(await readFile(join(dir, 'wrf-normalized.json'), 'utf8'));
    expect(normalized[0].sourceRef).toContain('samples-0-retry-1');
  });
  it('rejects an edited request list before collection or scoring', async () => {
    const { dir, options } = await setup(), plan = await planWrfComparison(dir, options);
    plan.requests.pop();
    await writeFile(join(dir, 'wrf-plan.json'), JSON.stringify(plan));
    await expect(captureWrfComparison(dir)).rejects.toThrow('complete comparison plan');
    await expect(reportWrfComparison(dir)).rejects.toThrow('complete comparison plan');
  });
  it('rejects mismatched consumer science and inconsistent spin-up clocks', async () => {
    const first = await setup(); first.builds[2].manifest.tool.components = { science: 'd'.repeat(64) };
    await expect(planWrfComparison(first.dir, first.options)).rejects.toThrow('science versions');
    const second = await setup(); second.runs[2].runLock!.spinup_hours = 7;
    await writeFile(second.runsPath, JSON.stringify(second.runs));
    await expect(planWrfComparison(second.dir, second.options)).rejects.toThrow('initialization clocks');
  });
  it('requires the selected samples to have been captured before the briefing', async () => {
    const { dir, options, builds } = await setup();
    await planWrfComparison(dir, { ...options, reference: builds[0].manifest.createdAt });
    await captureWrfComparison(dir);
    const report = await reportWrfComparison(dir);
    expect(report.availability.every(item => !item.observedByBriefing)).toBe(true);
  });

  it('rejects a partial baseline instead of silently shrinking the forecast comparison', async () => {
    const { dir, options, builds } = await setup();
    Object.assign(builds[0].manifest, JSON.parse(JSON.stringify(fixturePointBuild({ frameHours: [7] }).manifest).replaceAll('gfs', 'baseline')));
    builds[0].manifest.tool.components = { science: 'c'.repeat(64) };
    await expect(planWrfComparison(dir, options)).rejects.toThrow('matching control and baseline');
  });

});
