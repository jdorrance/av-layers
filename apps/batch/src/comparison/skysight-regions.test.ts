import { describe, expect, it } from 'vitest';
import { regionForecastTimes, selectSkySightRegions } from './skysight-regions.js';
import type { ComparisonSite } from './sites.js';

const site: ComparisonSite = { id: 'site', name: 'Site', lat: 45, lon: 10, timezone: 'Europe/Rome',
  region: 'europe-caucasus', terrain: 'valley', source: 'fixture' };
const region = (id: string, timezone = 'Europe/Berlin') => ({ id, timezone, modelFamily: 'ss' });
const fixture = (candidates: string[]) => ({ version: 1, regions: [region('EUROPE'), region('ALPS'), region('WEST_US'), region('EAST_US')],
  assignments: [{ siteId: site.id, lat: site.lat, lon: site.lon, candidates }] });

describe('SkySight region selection', () => {
  it('prefers Europe over Alps while retaining overlapping US products and uncovered sites', () => {
    expect(selectSkySightRegions(fixture(['ALPS', 'EUROPE']), [site]).regions.map(value => value.id)).toEqual(['EUROPE']);
    expect(selectSkySightRegions(fixture(['WEST_US', 'EAST_US']), [site]).assignments[0].regions).toEqual(['EAST_US', 'WEST_US']);
    expect(selectSkySightRegions(fixture([]), [site])).toMatchObject({ regions: [], assignments: [{ siteId: site.id, regions: [] }] });
  });

  it('rejects stale coordinates, unknown products and nonnative or invalid region metadata', () => {
    expect(() => selectSkySightRegions(fixture(['EUROPE']), [{ ...site, lat: 44 }])).toThrow('coordinates differ');
    expect(() => selectSkySightRegions(fixture(['MISSING']), [site])).toThrow('candidate region');
    const invalid = fixture(['EUROPE']); invalid.regions[0].modelFamily = 'noaa';
    expect(() => selectSkySightRegions(invalid, [site])).toThrow();
    invalid.regions[0] = region('EUROPE', 'invalid/timezone');
    expect(() => selectSkySightRegions(invalid, [site])).toThrow('timezone');
  });
});

describe('SkySight regional forecast times', () => {
  it('uses the regional calendar date and converts half-hour local times to UTC', () => {
    const schedule = regionForecastTimes('2026-11-13T12:45:00Z', { id: 'NZ', timezone: 'Pacific/Auckland' });
    expect(schedule.times).toHaveLength(75);
    expect(schedule.times[0]).toBe('202611131900');
    expect(schedule.times.at(-1)).toBe('202611160700');
    expect(schedule.probes[0]).toEqual({ localDate: '2026-11-14', time: '202611132300' });
    const india = regionForecastTimes('2026-11-13T09:45:00Z', { id: 'BIR', timezone: 'Asia/Kolkata' });
    expect(india.times[0]).toBe('202611130230');
    expect(india.probes[0].time).toBe('202611130630');
  });

  it('applies Brazil hours and accounts for a daylight-saving change between local days', () => {
    const brazil = regionForecastTimes('2026-11-13T09:45:00Z', { id: 'BRAZIL', timezone: 'America/Sao_Paulo' });
    expect(brazil.times).toHaveLength(87);
    expect(brazil.times[0]).toBe('202611130900');
    const europe = regionForecastTimes('2026-03-28T09:45:00Z', { id: 'EUROPE', timezone: 'Europe/Berlin' });
    expect(europe.probes.map(probe => probe.time)).toEqual(['202603281100', '202603291000', '202603301000']);
    expect(() => regionForecastTimes('2026-11-13T09:45:00', { id: 'EUROPE', timezone: 'Europe/Berlin' })).toThrow('reference time');
  });
});
