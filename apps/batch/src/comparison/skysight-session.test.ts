import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixturePointBuild } from '../../../../tests/client-point-fixture.js';
import { writeCapture } from './archive.js';
import type { ComparisonSample } from './core.js';
import type { ComparisonPlan } from './session.js';
import { captureSkySight, planSkySight, readSkySightPlan, replaySkySight } from './skysight-session.js';

vi.mock('./skysight-regions.js', () => ({
  selectSkySightRegions: (_input: unknown, sites: { id: string }[]) => ({
    regions: [{ id: 'EUROPE', timezone: 'Europe/Paris' }],
    assignments: sites.map((site, index) => ({ siteId: site.id, regions: index === 0 ? ['EUROPE'] : [] }))
  }),
  regionForecastTimes: () => ({ times: ['202610301200', '202610311200', '202611011200'],
    probes: ['202610301100', '202610311100', '202611011100'].map(time => ({ localDate: time.slice(0, 8), time })) })
}));

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'av-skysight-session-')); directories.push(dir);
  const baseline = join(dir, 'baseline'), out = join(dir, 'sky'), regions = join(dir, 'regions.json');
  await mkdir(baseline); await writeFile(regions, '{}');
  const manifest = fixturePointBuild({ frameHours: [12] }).manifest;
  const site = { id: 'valley', name: 'Valley', lat: 46.1, lon: 10.2, region: 'europe-caucasus' as const,
    terrain: 'valley' as const, timezone: 'Europe/Paris', source: 'fixture' };
  const sites = [site, { ...site, id: 'outside', lat: 40, lon: 44, timezone: 'Asia/Yerevan' }];
  const plan: ComparisonPlan = { version: 1, referenceTime: '2026-10-30T09:45:00.000Z', apiBase: 'https://api.test', sites,
    runtimeUrl: 'https://n1.xcskies.com/runtime/test', builds: [{ captureId: 'manifest', model: 'gfs',
      buildId: manifest.buildId, cycle: manifest.cycle, frames: ['f012'] }], requests: [] };
  const current: ComparisonSample = { provider: 'av-layers', siteId: site.id, model: 'gfs', product: 'noaa-gfs-0p25',
    cycle: manifest.cycle, validTime: manifest.frames[0].validTime, buildId: manifest.buildId, sourceRef: 'ours-current',
    lat: site.lat, lon: site.lon, values: { 'usable-lift-msl': { value: 2000, status: 'valid', unit: 'm',
      verticalReference: 'MSL', definition: 'usable-lift-top', timeSupport: 'valid-time' },
    'thermal-top-msl': { value: 2500, status: 'valid', unit: 'm', verticalReference: 'MSL', definition: 'convective-top', timeSupport: 'valid-time' },
    'cloud-cover-low': { value: 60, status: 'valid', unit: '%', verticalReference: 'surface', definition: 'low-cloud-cover', timeSupport: 'valid-time' } } };
  const old = { ...current, buildId: 'older-build', cycle: '2026-10-29T00:00:00.000Z', sourceRef: 'ours-old',
    values: { 'usable-lift-msl': { ...current.values['usable-lift-msl'], value: 4000 } } };
  const xc = { ...current, provider: 'xcskies', buildId: undefined, sourceRef: 'xc-current',
    values: { 'usable-lift-msl': { ...current.values['usable-lift-msl'], value: 1700 } } };
  await writeFile(join(baseline, 'plan.json'), JSON.stringify(plan));
  await writeFile(join(baseline, 'report.json'), JSON.stringify({ analysis: { hash: 'original-analysis' } }));
  await writeFile(join(baseline, 'normalized.json'), JSON.stringify({ left: [old, current],
    right: [{ ...xc, cycle: old.cycle, sourceRef: 'xc-old' }, xc] }));
  const save = (id: string, url: string, body: unknown) => writeCapture(join(baseline, 'captures'), id, {
    url, status: 200, capturedAt: '2026-10-30T09:00:00.000Z', body: JSON.stringify(body) });
  await save('av-latest-gfs', 'https://api.test/v1/models/gfs/latest?expand=manifest', { manifest });
  await save('ours-current', 'https://api.test/samples', {});
  await save('xc-current', 'https://n1.xcskies.com/profile/test', {});
  return { dir, baseline, out, regions, manifest };
}

function transport() {
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith('/tile/updated/')) return new Response(JSON.stringify({ unix: '1794559575', init: '' }));
    expect(new Headers(init?.headers).get('x-auth')).toBe('test-token');
    const body = JSON.parse(String(init?.body)) as { times?: string[]; hours?: string[] };
    if (url.pathname.startsWith('/v2/point/')) {
      const times = body.times!;
      return new Response(JSON.stringify({ times, HGT: times.map(() => 1000), hwcrit: times.map(() => 1800),
        dwcrit: times.map(() => 800), mslpress: times.map(() => 1000), sfctemp: times.map(() => 20), CFRACL: times.map(() => 0) }));
    }
    return new Response(JSON.stringify({ base: 1000, vertical_grid: 'native', data: body.hours!.map(dt => ({ dt, pblh: 2200, cfracl: 45,
      data: [{ altitude: 1000, temp: 20, press: 900 }] })) }));
  });
}

describe('SkySight extension session', () => {
  it('pins archived latest builds and replays separately with explicit product identities and sampled update markers', async () => {
    const { baseline, out, regions, manifest } = await fixture();
    const original = await readFile(join(baseline, 'normalized.json'), 'utf8');
    const plan = await planSkySight(out, { baseline, regions });
    expect(plan.pins.map(pin => pin.buildId)).toEqual([manifest.buildId]);
    expect(plan.requests.map(request => request.phase)).toEqual(['before', 'before', 'before', 'forecast', 'forecast', 'after', 'after', 'after']);
    expect(plan.requests.filter(request => request.kind === 'point')[0]?.requestBody).toContain('include_windgram');
    vi.stubEnv('SKYSIGHT_TOKEN', 'test-token'); const fetcher = transport(); vi.stubGlobal('fetch', fetcher);
    await captureSkySight(out);
    expect(fetcher).toHaveBeenCalledTimes(8);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Replay attempted network')));
    const report = await replaySkySight(out);
    expect(report.collection.failures).toEqual([]);
    expect(report.counts).toMatchObject({ sites: 2, coveredSites: 1, outsideSites: 1, siteRegionCombinations: 1,
      pointSamples: 3, windgramSamples: 3, nativeProfiles: 3, comparisons: 3 });
    const ours = report.comparisons.find(value => value.provider === 'av-layers' && value.endpoint === 'point')!.report;
    expect(ours.overall.find(value => value.parameter === 'usable-lift-msl')?.meanDifference).toBe(200);
    expect(ours.forecastInventory.left[0]).toMatchObject({ buildId: manifest.buildId, capturedAt: '2026-10-30T09:00:00.000Z' });
    expect(ours.forecastInventory.right[0]?.cycle).toBeNull();
    expect(ours.overall.some(value => value.parameter === 'cloud-cover-low')).toBe(false);
    const windgram = report.comparisons.find(value => value.provider === 'av-layers' && value.endpoint === 'windgram')!.report;
    expect(windgram.forecastInventory.right[0]?.product).toBe('skysight-europe-windgram');
    expect(windgram.forecastInventory.left[0]?.buildId).toBe(manifest.buildId);
    expect(windgram.overall.find(value => value.parameter === 'thermal-top-msl')?.meanDifference).toBe(300);
    expect(windgram.overall.find(value => value.parameter === 'cloud-cover-low')?.meanDifference).toBe(15);
    expect(windgram.overall.some(value => value.parameter === 'usable-lift-msl')).toBe(false);
    expect(report.comparisons.some(value => value.provider === 'xcskies' && value.endpoint === 'windgram')).toBe(false);
    const xc = report.comparisons.find(value => value.provider === 'xcskies')!.report;
    expect(xc.forecastInventory.left).toHaveLength(1);
    expect(xc.forecastInventory.left[0]?.cycle).toBe(manifest.cycle);
    expect(report.collection.updateChecks.every(check => check.unchanged === true)).toBe(true);
    expect(report.collection).toMatchObject({ changedUpdateProbeCount: 0, missingUpdateProbeCount: 0 });
    expect(report.basis.updateMarkerWarning).toBeNull();
    expect(report.collection.updateChecks[0]?.before).toMatchObject({ init: '', updateTime: new Date(1794559575 * 1000).toISOString() });
    expect(report.basis.skySightCycle).toContain('init is empty');
    expect(await readFile(join(out, 'regions.json'), 'utf8')).toBe(await readFile(regions, 'utf8'));
    expect(report.baseline.analysis).toEqual({ hash: 'original-analysis' });
    expect(await readFile(join(baseline, 'normalized.json'), 'utf8')).toBe(original);
    const captured = await readFile(join(out, 'captures', plan.requests.find(request => request.kind === 'point')!.id + '.json'), 'utf8');
    expect(captured).toContain('requestBodySha256'); expect(captured).not.toContain('test-token');
  });

  it('counts changed and missing sampled probes without treating unchanged probes as full-hour stability', async () => {
    const { baseline, out, regions } = await fixture();
    const plan = await planSkySight(out, { baseline, regions });
    const base = transport(), calls = new Map<string, number>();
    vi.stubEnv('SKYSIGHT_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.includes('/tile/updated/')) return base(input, init);
      const count = (calls.get(url) ?? 0) + 1; calls.set(url, count);
      return new Response(JSON.stringify({ unix: url.endsWith('/20261030/1100') && count === 2 ? '1794563730' : '1794552014', init: '' }));
    }));
    await captureSkySight(out);
    const before = plan.requests.filter(request => request.phase === 'before');
    const after = plan.requests.filter(request => request.phase === 'after');
    await rm(join(out, 'captures', `${before[1].id}.json`));
    await rm(join(out, 'captures', `${after[2].id}.json`));
    const report = await replaySkySight(out);
    expect(report.collection).toMatchObject({ changedUpdateProbeCount: 1, missingUpdateProbeCount: 2 });
    expect(report.collection.updateChecks).toHaveLength(3);
    expect(report.collection.updateChecks.map(probe => probe.unchanged)).toEqual([false, null, null]);
    expect(report.collection.updateChecks[1]?.before).toBeNull();
    expect(report.collection.updateChecks[2]?.after).toBeNull();
    expect(report.basis.updateMarkerWarning).toContain('1 sampled update probes changed; 2 lack');
    expect(report.basis.updateMarkers).toContain('other-hour stability unspecified');
    expect(report.comparisons).toHaveLength(3);
  });

  it('rejects changed baseline inputs and unsafe or re-bound plans before collection', async () => {
    const { baseline, out, regions } = await fixture();
    await expect(planSkySight(baseline, { baseline, regions })).rejects.toThrow('differ');
    const plan = await planSkySight(out, { baseline, regions });
    await writeFile(join(baseline, 'normalized.json'), '{}');
    await expect(replaySkySight(out)).rejects.toThrow('Baseline changed');
    plan.requests.find(request => request.kind === 'point')!.url = 'https://cf.skysight.io/login';
    await writeFile(join(out, 'plan.json'), JSON.stringify(plan));
    await expect(readSkySightPlan(out)).rejects.toThrow('forecast request');
  });
});
