/** Select native SkySight domains from an extracted client manifest and schedule local forecast hours. */
import z from 'zod';
import type { ComparisonSite } from './sites.js';

const regionId = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const timezone = z.string().refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
}, 'Invalid region timezone');
const regionSchema = z.object({ id: regionId, name: z.string().min(1).optional(), modelFamily: z.literal('ss'), timezone });
const manifestSchema = z.object({ version: z.literal(1), regions: z.array(regionSchema).min(1).max(64),
  assignments: z.array(z.object({ siteId: z.string().min(1), lat: z.number().finite().min(-90).max(90),
    lon: z.number().finite().min(-180).max(180), candidates: z.array(regionId).max(64) })).max(256) });

export function selectSkySightRegions(raw: unknown, sites: readonly ComparisonSite[]) {
  const manifest = manifestSchema.parse(raw), byId = new Map(manifest.regions.map(region => [region.id, region]));
  if (byId.size !== manifest.regions.length) throw new Error('Duplicate SkySight region');
  const assignments = new Map(manifest.assignments.map(assignment => [assignment.siteId, assignment]));
  if (assignments.size !== manifest.assignments.length || assignments.size !== sites.length
    || new Set(sites.map(site => site.id)).size !== sites.length) throw new Error('SkySight assignments differ from cohort');
  const selected = sites.map(site => {
    const assignment = assignments.get(site.id);
    if (!assignment || assignment.lat !== site.lat || assignment.lon !== site.lon) throw new Error(`SkySight assignment coordinates differ: ${site.id}`);
    if (new Set(assignment.candidates).size !== assignment.candidates.length
      || assignment.candidates.some(id => !byId.has(id))) throw new Error(`Invalid SkySight candidate region: ${site.id}`);
    const regions = assignment.candidates.filter(id => id !== 'ALPS' || !assignment.candidates.includes('EUROPE')).sort();
    return { siteId: site.id, lat: site.lat, lon: site.lon, regions };
  }).sort((a, b) => a.siteId.localeCompare(b.siteId));
  const used = new Set(selected.flatMap(assignment => assignment.regions));
  return { regions: manifest.regions.filter(region => used.has(region.id)).sort((a, b) => a.id.localeCompare(b.id)), assignments: selected };
}

function localParts(formatter: Intl.DateTimeFormat, timestamp: number) {
  const parts = formatter.formatToParts(timestamp), value = (type: string) => Number(parts.find(part => part.type === type)!.value);
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute') };
}

function localToUtc(formatter: Intl.DateTimeFormat, localTimestamp: number): number {
  let candidate = localTimestamp;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = localParts(formatter, candidate);
    const rendered = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const correction = localTimestamp - rendered;
    if (correction === 0) return candidate;
    candidate += correction;
  }
  throw new Error('SkySight local forecast time does not exist');
}

/** Three regional calendar days, half-hourly through 20:00; Brazil starts at 06:00, other regions at 08:00. */
export function regionForecastTimes(referenceTime: string, region: { id: string; timezone: string }) {
  const reference = Date.parse(referenceTime);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(referenceTime) || !Number.isFinite(reference)) throw new Error('Invalid SkySight reference time');
  regionId.parse(region.id); timezone.parse(region.timezone);
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: region.timezone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const date = localParts(formatter, reference), midnight = Date.UTC(date.year, date.month - 1, date.day);
  const times: string[] = [], probes: { localDate: string; time: string }[] = [];
  const encode = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  for (let day = 0; day < 3; day++) {
    const localMidnight = midnight + day * 86_400_000;
    for (let minute = (region.id === 'BRAZIL' ? 6 : 8) * 60; minute <= 20 * 60; minute += 30) {
      times.push(encode(localToUtc(formatter, localMidnight + minute * 60_000)));
    }
    probes.push({ localDate: new Date(localMidnight).toISOString().slice(0, 10),
      time: encode(localToUtc(formatter, localMidnight + 12 * 3_600_000)) });
  }
  return { times: [...new Set(times)].sort(), probes };
}
