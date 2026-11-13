import { describe, expect, it } from 'vitest';
import { MAX_SAMPLE_POINTS, gridToGeographic, multiPointSampleResponseSchema } from '@av/contracts';
import { planSample } from '@av/forecast/sampler';
import { fixturePointBuild, fixturePointSample, fixtureProfileBuild, fixtureProfileResponse } from '../../../../tests/client-point-fixture.js';
import { normalizeAvProfile, normalizeAvSamples, planAvSampleRequests, type AvSampleRequest } from './av-layers.js';
import { compareSamples } from './core.js';
import { COMPARISON_MAPPINGS } from './mappings.js';

const sites = [{ id: 'valley', lat: 40.2, lon: 44.3 }, { id: 'ridge', lat: 40.3, lon: 44.4 }, { id: 'plain', lat: 40.4, lon: 44.5 }];
const options = { baseUrl: 'https://api.test' };

function fixture() {
  const build = fixturePointBuild({ frameHours: [1, 3] });
  const [request] = planAvSampleRequests(build.manifest, sites.slice(0, 1), options);
  return { build, request, raw: response(build, request) };
}

function response(build: ReturnType<typeof fixturePointBuild>, request: AvSampleRequest) {
  const m = build.manifest;
  return multiPointSampleResponseSchema.parse({ version: 1, model: m.model, buildId: m.buildId, expiresAt: m.expiresAt,
    points: request.sites.map((site, index) => {
      const url = new URL(request.url);
      url.searchParams.set('lat', String(site.lat)); url.searchParams.set('lon', String(site.lon));
      return { index, sample: fixturePointSample(build, url.href) };
    }) });
}

function profileFixture() {
  const build = fixtureProfileBuild({ frameHours: [1, 3] }), site = sites[0];
  const raw = fixtureProfileResponse(build, `https://api.test/profile?lat=${site.lat}&lon=${site.lon}&frame=f001,f003&layers=thermal-top-msl`);
  const native = build.manifest.surfaces.find(surface => surface.kind === 'native')!;
  const donor = planSample(native.grid, site.lat, site.lon)!.contributors.sort((a, b) => b.weight - a.weight)[0];
  raw.cell = { index: donor.index, ...gridToGeographic(native.grid, donor.column, donor.row)!, surfaceId: native.id };
  return { build, raw, site };
}

describe('AV baseline adapter', () => {
  it('collects every advertised channel and selected time once within point/value budgets', () => {
    const build = fixturePointBuild({ frameHours: Array.from({ length: 15 }, (_, i) => i + 1) });
    const requests = planAvSampleRequests(build.manifest, sites, options);
    const received = new Set<string>();
    expect(build.manifest.layers).toHaveLength(20);
    for (const request of requests) {
      expect(request.sites.length).toBeLessThanOrEqual(MAX_SAMPLE_POINTS);
      expect(request.sites.length * request.frameIds.length * request.layers.length).toBeLessThanOrEqual(build.manifest.descriptors.maxSampleValues);
      expect(new URL(request.url).pathname).toContain(`/runs/${build.manifest.buildId}/samples`);
      for (const site of request.sites) for (const frame of request.frameIds) for (const layer of request.layers) {
        const key = `${site.id}/${frame}/${layer}`;
        expect(received.has(key)).toBe(false); received.add(key);
      }
    }
    expect(received.size).toBe(sites.length * build.manifest.frames.length * build.manifest.layers.length);
    expect(() => planAvSampleRequests(build.manifest, sites, { ...options, frames: ['missing'] })).toThrow('frames');
  });

  it('retains per-layer meanings, no-lift status and one-hour support at a three-hour output', () => {
    const { build, request, raw } = fixture();
    const first = raw.points[0].sample.frames[0].layers;
    first['usable-lift-msl'] = { ...first['usable-lift-msl'], value: null, status: 'no-usable-lift' };
    first['usable-lift-agl'] = { ...first['usable-lift-agl'], value: 0, status: 'no-usable-lift' };
    first['cloud-cover-low'] = { ...first['cloud-cover-low'], value: null, status: 'unavailable' };
    const rows = normalizeAvSamples(build.manifest, request, raw, 'raw/av.json');
    expect(rows[0]).toMatchObject({ provider: 'av-layers', siteId: 'valley', lat: 40.2, lon: 44.3,
      product: build.manifest.recipe.source.configurationId, cycle: build.manifest.cycle, buildId: build.manifest.buildId, sourceRef: 'raw/av.json' });
    expect(rows[0].values['usable-lift-msl']).toMatchObject({ value: null, status: 'no-lift', unit: 'm', verticalReference: 'MSL' });
    expect(rows[0].values['usable-lift-agl']).toMatchObject({ value: 0, status: 'no-lift', verticalReference: 'terrain-AGL',
      surfaceId: build.manifest.surfaces.find(surface => surface.kind === 'fine')!.id });
    expect(rows[0].values['cloud-cover-low']).toMatchObject({ value: null, status: 'unavailable', unit: '%' });
    expect(rows[0].values['sfc-temp-c']).not.toHaveProperty('intervalStart');
    expect(rows[0].values['thermal-top-msl'].methodId).toBe(build.manifest.descriptors.layers['thermal-top-msl'].methodId);
    const precipitation = rows[1].values['precip-rate'];
    expect(precipitation.unit).toBe('mm/h');
    expect(Date.parse(precipitation.intervalEnd!) - Date.parse(precipitation.intervalStart!)).toBe(3_600_000);
  });

  it('derives BL vector magnitude with missingness and compares the qualified XC wind product', () => {
    const { build, request, raw } = fixture(), layers = raw.points[0].sample.frames[0].layers;
    layers['bl-mean-wind-u'].value = 3; layers['bl-mean-wind-v'].value = 4;
    layers['bl-mean-wind-u'].interpolated = true;
    const sourceKeys = Object.keys(layers), row = normalizeAvSamples(build.manifest, request, raw, 'av-capture')[0];
    expect(row.values['derived-bl-mean-wind-speed']).toMatchObject({ value: 5, status: 'valid', unit: 'm/s',
      definition: 'magnitude-of-sampled-boundary-layer-mean-wind-components', timeSupport: 'valid-time', interpolated: true });
    expect(Object.keys(layers)).toEqual(sourceKeys);
    expect(sourceKeys).toHaveLength(20);
    const xc = { ...row, provider: 'xcskies', sourceRef: 'xc-capture', values: { 'xc-bl-mean-wind-speed': {
      ...row.values['derived-bl-mean-wind-speed'], value: 4.2, verticalReference: 'XC-ground-AGL', definition: 'boundary-layer-mean-wind-speed'
    } } };
    const result = compareSamples([row], [xc], COMPARISON_MAPPINGS.filter(mapping => mapping.id === 'bl-mean-wind-speed'));
    expect(result.pairs[0]).toMatchObject({ referencePolicy: 'provider-ground', timePolicy: 'exact', comparability: 'related' });
    expect(result.pairs[0].difference).toBeCloseTo(0.8);
    layers['bl-mean-wind-v'].status = 'unavailable'; layers['bl-mean-wind-v'].value = null;
    expect(normalizeAvSamples(build.manifest, request, raw, 'av-capture')[0].values['derived-bl-mean-wind-speed'])
      .toMatchObject({ value: null, status: 'unavailable' });
  });

  it.each(['point', 'provenance', 'frame', 'surface', 'selection', 'status'] as const)('rejects a mismatched %s before scoring', mismatch => {
    const { build, request, raw } = fixture(), sample = raw.points[0].sample;
    if (mismatch === 'point') sample.lon += 0.1;
    if (mismatch === 'provenance') sample.source.provenanceSha256 = 'f'.repeat(64);
    if (mismatch === 'frame') sample.frames[0].intervalStart = sample.frames[0].intervalEnd;
    if (mismatch === 'surface') sample.surfaces[0].coverage.gridHash = 'e'.repeat(64);
    if (mismatch === 'selection') delete sample.frames[0].layers['sensible-heat-flux'];
    if (mismatch === 'status') sample.frames[0].layers['usable-lift-agl'].status = 'no-usable-lift';
    expect(() => normalizeAvSamples(build.manifest, request, raw, 'raw/av.json')).toThrow();
  });

  it('retains native levels and all additional diagnostics with separate sampling coordinates', () => {
    const { build, raw, site } = profileFixture();
    raw.frames[0].derived.mixedLayerLclM = null;
    raw.frames[0].derived.cumulus = false;
    raw.frames[0].derived.cloudCapped = true;
    raw.frames[0].profile.levels[1].dewPointC = null;
    const result = normalizeAvProfile(build.manifest, site, raw, 'raw/profile.json');
    expect(result.cell).toEqual(raw.cell);
    expect(result.cell!.lat).not.toBe(site.lat);
    expect(result.profiles[0].profile).toEqual(raw.frames[0].profile);
    const sample = result.samples[0];
    expect(sample).toMatchObject({ lat: site.lat, lon: site.lon, groundM: 1500, sourceRef: 'raw/profile.json', buildId: build.manifest.buildId });
    expect(Object.keys(sample.values)).toHaveLength(18);
    expect(Object.keys(sample.values).every(key => key.startsWith('native-'))).toBe(true);
    expect(sample.values).not.toHaveProperty('thermal-top-msl');
    expect(sample.values['native-usable-lift-v2-msl']).toMatchObject({ value: raw.frames[0].derived.usableLiftTopV2M, unit: 'm', verticalReference: 'MSL' });
    expect(sample.values['native-mixed-layer-lcl-msl']).toMatchObject({ value: null, status: 'unavailable' });
    expect(sample.values['native-cumulus']).toMatchObject({ value: 0, status: 'valid', unit: 'boolean' });
    expect(sample.values['native-cloud-capped']).toMatchObject({ value: 1, status: 'valid', unit: 'boolean' });
  });

  it.each(['cycle', 'cell', 'time', 'surface'] as const)('rejects a profile with mismatched %s', mismatch => {
    const { build, raw, site } = profileFixture();
    if (mismatch === 'cycle') raw.cycle = '2026-11-12T00:00:00.000Z';
    if (mismatch === 'cell') raw.cell!.lat += 0.01;
    if (mismatch === 'time') raw.frames[0].intervalStart = raw.frames[0].intervalEnd;
    if (mismatch === 'surface') raw.frames[0].layers['thermal-top-msl'].interpolated = true;
    expect(() => normalizeAvProfile(build.manifest, site, raw, 'raw/profile.json')).toThrow();
  });

  it('keeps an outside-domain native profile distinct from unavailable diagnostics', () => {
    const { build, raw, site } = profileFixture();
    raw.cell = null;
    for (const frame of raw.frames) {
      frame.profile = { status: 'outside-domain', modelTerrainM: null, surfacePressureHpa: null, levels: [] };
      for (const value of Object.values(frame.layers)) { value.status = 'outside-domain'; value.value = null; }
      for (const key of Object.keys(frame.derived) as (keyof typeof frame.derived)[]) frame.derived[key] = null;
    }
    const result = normalizeAvProfile(build.manifest, site, raw, 'raw/profile.json');
    expect(result.cell).toBeNull();
    expect(result.samples.every(sample => Object.values(sample.values).every(value => value.status === 'outside-domain' && value.value === null))).toBe(true);
  });
});
