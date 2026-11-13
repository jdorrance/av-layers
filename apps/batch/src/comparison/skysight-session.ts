/** Capture regional SkySight products and compare them with pinned archived baseline forecasts. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { manifestV5Schema } from '@av/contracts/publication';
import { readLocalFile } from '../local-file.js';
import { captureUrl, readCapture, type Capture } from './archive.js';
import type { ComparisonSample } from './core.js';
import { buildReport } from './report.js';
import { readComparisonAnalysis, readPlan } from './session.js';
import { parseSites, type ComparisonSite } from './sites.js';
import { normalizeSkySightPoint, normalizeSkySightWindgram, parseSkySightPayload, SKY_SIGHT_MAPPINGS, SKY_SIGHT_XC_MAPPINGS, SKY_SIGHT_WINDGRAM_MAPPINGS,
  type SkySightResult } from './skysight.js';
import { selectSkySightRegions, regionForecastTimes } from './skysight-regions.js';

const MAX_REQUESTS = 4096, MAX_PLAN_BYTES = 16 * 1024 ** 2, MAX_BASELINE_BYTES = 128 * 1024 ** 2;
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

export interface SkySightRequest {
  id: string; url: string; method: 'GET' | 'POST'; kind: 'point' | 'windgram' | 'update-marker';
  phase: 'before' | 'forecast' | 'after'; region: string; siteId?: string; requestBody?: string;
  times?: string[]; localDate?: string; probeTime?: string;
}

export interface SkySightPlan {
  version: 1; provider: 'skysight'; referenceTime: string; sites: ComparisonSite[];
  baseline: { directory: string; planSha256: string; normalizedSha256: string; reportSha256: string; analysis: unknown };
  pins: { model: string; buildId: string; cycle: string; latestCaptureSha256: string }[];
  regions: ReturnType<typeof selectSkySightRegions>;
  regionsSha256: string;
  requests: SkySightRequest[];
}

function responseJson(capture: Capture): unknown {
  if (capture.status !== 200) throw new Error(`HTTP ${capture.status}`);
  return parseSkySightPayload(capture.body);
}

export async function planSkySight(out: string, options: { baseline: string; regions: string; referenceTime?: string }): Promise<SkySightPlan> {
  if (resolve(out) === resolve(options.baseline)) throw new Error('SkySight output must differ from the baseline directory');
  const baseline = await readPlan(options.baseline), reference = new Date(options.referenceTime ?? baseline.referenceTime);
  if (!Number.isFinite(reference.getTime())) throw new Error('Invalid SkySight reference time');
  const regionBytes = await readLocalFile(options.regions, MAX_PLAN_BYTES);
  const regions = selectSkySightRegions(JSON.parse(regionBytes.toString('utf8')), baseline.sites);
  const reportBytes = await readLocalFile(join(options.baseline, 'report.json'), MAX_PLAN_BYTES);
  const report = JSON.parse(reportBytes.toString('utf8')) as { analysis: unknown };
  const plan: SkySightPlan = { version: 1, provider: 'skysight', referenceTime: reference.toISOString(), sites: baseline.sites,
    baseline: { directory: resolve(options.baseline), analysis: report.analysis,
      planSha256: digest(await readLocalFile(join(options.baseline, 'plan.json'), MAX_PLAN_BYTES)),
      normalizedSha256: digest(await readLocalFile(join(options.baseline, 'normalized.json'), MAX_BASELINE_BYTES)),
      reportSha256: digest(reportBytes) }, pins: [], regions, regionsSha256: digest(regionBytes), requests: [] };
  for (const model of [...new Set(baseline.builds.map(build => build.model))].sort()) {
    const capture = await readCapture(join(options.baseline, 'captures'), `av-latest-${model}`, {
      url: `${baseline.apiBase}/v1/models/${model}/latest?expand=manifest` });
    const data = responseJson(capture) as { manifest: unknown }, manifest = manifestV5Schema.parse(data.manifest);
    if (manifest.model !== model || !baseline.builds.some(build => build.model === model && build.buildId === manifest.buildId
      && Date.parse(build.cycle) === Date.parse(manifest.cycle))) throw new Error('Archived latest build is absent from baseline plan');
    plan.pins.push({ model, buildId: manifest.buildId, cycle: manifest.cycle, latestCaptureSha256: capture.sha256 });
  }
  for (const region of regions.regions) {
    const schedule = regionForecastTimes(plan.referenceTime, region);
    for (const probe of schedule.probes) for (const phase of ['before', 'after'] as const) {
      plan.requests.push({ id: `sky-update-${phase}-${region.id}-${probe.localDate}`, kind: 'update-marker', phase,
        method: 'GET', region: region.id, localDate: probe.localDate, probeTime: probe.time,
        url: `https://cf.skysight.io/tile/updated/${region.id}/${probe.time.slice(0, 8)}/${probe.time.slice(8)}` });
    }
    for (const assignment of regions.assignments.filter(value => value.regions.includes(region.id))) {
      const site = plan.sites.find(value => value.id === assignment.siteId)!;
      for (const kind of ['point', 'windgram'] as const) {
        const url = new URL(`https://cf.skysight.io/v2/${kind}/${site.lat}/${site.lon}`);
        url.searchParams.set('region', region.id);
        plan.requests.push({ id: `sky-${kind}-${region.id}-${site.id}`, kind, phase: 'forecast', region: region.id,
          siteId: site.id, method: 'POST', url: url.href, times: schedule.times,
          requestBody: JSON.stringify(kind === 'point' ? { times: schedule.times, include_windgram: false }
            : { hours: schedule.times, native_levels: true }) });
      }
    }
  }
  const order = { before: 0, forecast: 1, after: 2 };
  plan.requests.sort((a, b) => order[a.phase] - order[b.phase] || a.id.localeCompare(b.id));
  if (plan.requests.length > MAX_REQUESTS) throw new Error('SkySight request plan exceeds budget');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'regions.json'), regionBytes, { flag: 'wx' });
  await writeFile(join(out, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  return plan;
}

export async function readSkySightPlan(out: string): Promise<SkySightPlan> {
  const plan = JSON.parse((await readLocalFile(join(out, 'plan.json'), MAX_PLAN_BYTES)).toString('utf8')) as SkySightPlan;
  if (plan.version !== 1 || plan.provider !== 'skysight' || !Array.isArray(plan.requests) || plan.requests.length > MAX_REQUESTS
    || new Set(plan.requests.map(request => request.id)).size !== plan.requests.length) throw new Error('Invalid SkySight plan');
  plan.sites = parseSites(plan.sites);
  if (resolve(out) === resolve(plan.baseline.directory)) throw new Error('SkySight output must differ from the baseline directory');
  if (digest(await readLocalFile(join(out, 'regions.json'), MAX_PLAN_BYTES)) !== plan.regionsSha256) throw new Error('SkySight region input changed');
  for (const request of plan.requests) {
    const url = new URL(request.url);
    if (url.origin !== 'https://cf.skysight.io' || !plan.regions.regions.some(region => region.id === request.region)) throw new Error('Invalid SkySight request region or origin');
    if (request.kind === 'update-marker') {
      if (!['before', 'after'].includes(request.phase) || request.method !== 'GET' || request.requestBody !== undefined
        || !/^\d{12}$/.test(request.probeTime ?? '')
        || request.url !== `https://cf.skysight.io/tile/updated/${request.region}/${request.probeTime!.slice(0, 8)}/${request.probeTime!.slice(8)}`) {
        throw new Error('Invalid SkySight marker request');
      }
    } else {
      const site = plan.sites.find(site => site.id === request.siteId);
      const body = JSON.stringify(request.kind === 'point' ? { times: request.times, include_windgram: false }
        : { hours: request.times, native_levels: true });
      if (!site || !['point', 'windgram'].includes(request.kind) || request.phase !== 'forecast' || request.method !== 'POST'
        || !Array.isArray(request.times) || !request.times.length || request.times.length > 512
        || request.times.some((time, index) => !/^\d{12}$/.test(time) || index > 0 && time <= request.times![index - 1])
        || request.requestBody !== body
        || request.url !== `https://cf.skysight.io/v2/${request.kind}/${site.lat}/${site.lon}?region=${request.region}`) {
        throw new Error('Invalid SkySight forecast request');
      }
    }
  }
  return plan;
}

export async function captureSkySight(out: string, progress: (done: number, total: number) => void = () => {}) {
  const plan = await readSkySightPlan(out);
  const transport: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://cf.skysight.io') throw new Error('SkySight transport origin differs');
    const headers = new Headers(init?.headers);
    if (init?.method === 'POST' && !process.env.SKYSIGHT_TOKEN) throw new Error('SkySight forecast capture requires SKYSIGHT_TOKEN');
    if (process.env.SKYSIGHT_TOKEN) headers.set('x-auth', process.env.SKYSIGHT_TOKEN);
    if (init?.method === 'POST') headers.set('content-type', 'application/json');
    return fetch(input, { ...init, headers, redirect: 'error' });
  };
  let done = 0;
  for (const phase of ['before', 'forecast', 'after'] as const) {
    const requests = plan.requests.filter(request => request.phase === phase); let next = 0;
    const worker = async () => {
      while (next < requests.length) {
        const request = requests[next++];
        await captureUrl(join(out, 'captures'), request.id, request.url, request.method === 'POST'
          ? { method: 'POST', requestBody: request.requestBody!, fetch: transport } : { fetch: transport });
        progress(++done, plan.requests.length);
      }
    };
    await Promise.all([worker(), worker()]);
  }
}

async function baselineSamples(plan: SkySightPlan) {
  for (const [name, sha256] of [['plan.json', plan.baseline.planSha256], ['report.json', plan.baseline.reportSha256]]) {
    if (digest(await readLocalFile(join(plan.baseline.directory, name), MAX_PLAN_BYTES)) !== sha256) throw new Error(`Baseline changed: ${name}`);
  }
  const bytes = await readLocalFile(join(plan.baseline.directory, 'normalized.json'), MAX_BASELINE_BYTES);
  if (digest(bytes) !== plan.baseline.normalizedSha256) throw new Error('Baseline changed: normalized.json');
  const normalized = JSON.parse(bytes.toString('utf8')) as { left: ComparisonSample[]; right: ComparisonSample[] };
  if (!Array.isArray(normalized.left) || !Array.isArray(normalized.right)) throw new Error('Invalid baseline normalized samples');
  const left = normalized.left.filter(row => plan.pins.some(pin => pin.model === row.model && pin.buildId === row.buildId));
  const latest = new Map<string, number>();
  for (const row of normalized.right) if (row.cycle !== null) {
    const key = JSON.stringify([row.model, row.product]); latest.set(key, Math.max(latest.get(key) ?? -Infinity, Date.parse(row.cycle)));
  }
  const right = normalized.right.filter(row => row.cycle !== null && Date.parse(row.cycle) === latest.get(JSON.stringify([row.model, row.product])));
  const times = new Map<string, string>();
  for (const row of [...left, ...right]) {
    if (!times.has(row.sourceRef)) times.set(row.sourceRef, (await readCapture(join(plan.baseline.directory, 'captures'), row.sourceRef)).capturedAt);
    row.capturedAt = times.get(row.sourceRef);
  }
  return { left, right };
}

export async function replaySkySight(out: string) {
  const plan = await readSkySightPlan(out), analysis = await readComparisonAnalysis(), baseline = await baselineSamples(plan);
  const point: ComparisonSample[] = [], windgram: ComparisonSample[] = [];
  const profiles: { siteId: string; region: string; sourceRef: string; profiles: SkySightResult['profiles'] }[] = [];
  const inventory: { id: string; region: string; siteId: string; kind: string; rawFields: string[]; unmappedFields: string[]; diagnostics: string[] }[] = [];
  const failures: { id: string; error: string }[] = [], markers: { id: string; region: string; phase: string; localDate: string;
    probeTime: string; capturedAt: string; sha256: string; updateTime: string | null; init: unknown; value: unknown }[] = [];
  let capturedBytes = 0;
  for (const request of plan.requests) {
    try {
      const capture = await readCapture(join(out, 'captures'), request.id, { url: request.url, method: request.method, requestBody: request.requestBody });
      capturedBytes += capture.bytes;
      const payload = responseJson(capture);
      if (request.kind === 'update-marker') {
        if (payload === null || typeof payload !== 'object' || !('unix' in payload)) throw new Error('Invalid SkySight update marker');
        const marker = payload as { unix: unknown; init?: unknown };
        const epoch = typeof marker.unix === 'number' || typeof marker.unix === 'string' && /^\d+$/.test(marker.unix)
          ? Number(marker.unix) : NaN;
        const update = new Date(epoch * 1000);
        markers.push({ id: request.id, region: request.region, phase: request.phase, localDate: request.localDate!,
          probeTime: request.probeTime!, capturedAt: capture.capturedAt, sha256: capture.sha256,
          updateTime: Number.isFinite(update.getTime()) ? update.toISOString() : null, init: marker.init ?? null, value: payload });
        continue;
      }
      const site = plan.sites.find(value => value.id === request.siteId);
      if (!site) throw new Error('SkySight request site is absent from cohort');
      const options = { siteId: site.id, lat: site.lat, lon: site.lon, region: request.region,
        sourceRef: request.id, capturedAt: capture.capturedAt, requestedTimes: request.times };
      const result = request.kind === 'point' ? normalizeSkySightPoint(payload, options) : normalizeSkySightWindgram(payload, options);
      (request.kind === 'point' ? point : windgram).push(...result.samples);
      if (result.profiles.length) profiles.push({ siteId: site.id, region: request.region, sourceRef: request.id, profiles: result.profiles });
      inventory.push({ id: request.id, region: request.region, siteId: site.id, kind: request.kind,
        rawFields: result.rawFields, unmappedFields: result.unmappedFields, diagnostics: result.diagnostics });
    } catch (error) { failures.push({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
  }
  const comparisons = [], skipped: { provider: string; model: string; region: string; endpoint: 'point' | 'windgram'; reason: string }[] = [];
  for (const [provider, source, endpoint, target, mappings] of [
    ['av-layers', baseline.left, 'point', point, SKY_SIGHT_MAPPINGS],
    ['av-layers', baseline.left, 'windgram', windgram, SKY_SIGHT_WINDGRAM_MAPPINGS],
    ['xcskies', baseline.right, 'point', point, SKY_SIGHT_XC_MAPPINGS]
  ] as const) {
    for (const model of [...new Set(source.map(row => row.model))].sort()) for (const region of plan.regions.regions) {
      const siteIds = new Set(plan.regions.assignments.filter(value => value.regions.includes(region.id)).map(value => value.siteId));
      const left = source.filter(row => row.model === model && siteIds.has(row.siteId));
      const right = target.filter(row => row.product === `skysight-${region.id.toLowerCase()}-${endpoint}`);
      if (!left.length || !right.length) { skipped.push({ provider, model, region: region.id, endpoint,
        reason: !left.length ? 'No baseline samples in region' : `No normalized SkySight ${endpoint} samples` }); continue; }
      const pinned = new Set(left.map(row => JSON.stringify([row.provider, row.model, row.product, row.cycle, row.buildId])));
      if (pinned.size !== 1) { skipped.push({ provider, model, region: region.id, endpoint, reason: 'Baseline requires one pinned product and cycle' }); continue; }
      comparisons.push({ provider, model, region: region.id, endpoint, report: buildReport(left, right, mappings, plan.sites, {
        pairing: { mode: 'products-at-valid-time', note: 'Different upstream regional forecast products; SkySight initialization and lead are unknown. Exact UTC valid times and requested coordinates are paired.' }
      }) });
    }
  }
  const updateChecks = plan.requests.filter(request => request.kind === 'update-marker' && request.phase === 'before').map(probe => {
    const before = markers.find(marker => marker.id === probe.id);
    const after = markers.find(marker => marker.phase === 'after' && marker.region === probe.region && marker.probeTime === probe.probeTime);
    return { region: probe.region, localDate: probe.localDate!, probeTime: probe.probeTime!,
      before: before ?? null, after: after ?? null, unchanged: before && after ? before.sha256 === after.sha256 : null };
  });
  const changedUpdateProbeCount = updateChecks.filter(probe => probe.unchanged === false).length;
  const missingUpdateProbeCount = updateChecks.filter(probe => probe.unchanged === null).length;
  const report = { version: 1, provider: 'skysight', referenceTime: plan.referenceTime, analysis,
    requestPlanSha256: digest(JSON.stringify(plan)), regionsSha256: plan.regionsSha256, baseline: plan.baseline, pins: plan.pins,
    basis: { primaryProduct: 'regional point forecast', windgram: 'separate boundary-layer-top and low-cloud comparisons, with native profiles archived',
      coverage: 'client-domain assignments; decoded frame statuses retain forecast availability',
      updateMarkers: 'Sampled local-noon update markers; values are update evidence for these probes, with model cycle and other-hour stability unspecified.',
      updateMarkerWarning: changedUpdateProbeCount || missingUpdateProbeCount
        ? `${changedUpdateProbeCount} sampled update probes changed; ${missingUpdateProbeCount} lack a successful before/after pair. Forecast comparisons retain their capture timestamps; initialization and unprobed-hour update state remain unspecified.`
        : null,
      skySightCycle: markers.length && markers.every(marker => marker.init === '')
        ? 'unknown: forecast responses omit initialization and every sampled update-marker init is empty'
        : 'unknown: forecast responses omit initialization and sampled update markers do not establish a model cycle',
      xcSelection: 'latest known cycle per baseline model and product' },
    counts: { sites: plan.sites.length, coveredSites: plan.regions.assignments.filter(value => value.regions.length > 0).length,
      outsideSites: plan.regions.assignments.filter(value => value.regions.length === 0).length,
      siteRegionCombinations: plan.regions.assignments.reduce((sum, value) => sum + value.regions.length, 0),
      pointSites: new Set(point.map(row => row.siteId)).size,
      availablePointSites: new Set(point.filter(row => Object.values(row.values).some(value => value.status === 'valid' || value.status === 'no-lift')).map(row => row.siteId)).size,
      pointSamples: point.length, windgramSamples: windgram.length, nativeProfiles: profiles.reduce((sum, value) => sum + value.profiles.length, 0),
      comparisons: comparisons.length }, coverage: plan.regions.assignments, sites: plan.sites,
    collection: { plannedRequests: plan.requests.length, capturedBytes, failures, inventory, updateChecks,
      changedUpdateProbeCount, missingUpdateProbeCount }, comparisons, skipped };
  if ((await readComparisonAnalysis()).hash !== analysis.hash) throw new Error('Comparison sources changed during replay');
  await writeFile(join(out, 'normalized.json'), JSON.stringify({ point, windgram, profiles, analysis, baseline: plan.baseline }) + '\n');
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
