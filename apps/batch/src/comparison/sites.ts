/** Loads fixed comparison locations; terrain tags describe the selected cohort. */
import { readFile } from 'node:fs/promises';
import z from 'zod';

const siteSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1),
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
  region: z.enum(['europe-caucasus', 'north-america', 'south-america', 'asia-oceania']),
  terrain: z.enum(['valley', 'ridge', 'slope', 'flat', 'plateau', 'water']),
  timezone: z.string().refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
    catch { return false; }
  }, 'Invalid IANA timezone'),
  source: z.string().min(1)
});

const sitesSchema = z.array(siteSchema).min(1).max(256).superRefine((sites, context) => {
  const ids = new Set<string>(), coordinates = new Set<string>();
  for (const [index, site] of sites.entries()) {
    if (ids.has(site.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message: 'Duplicate site ID' });
    ids.add(site.id);
    const coordinate = JSON.stringify([site.lat, site.lon]);
    if (coordinates.has(coordinate)) context.addIssue({ code: 'custom', path: [index], message: 'Duplicate site coordinates' });
    coordinates.add(coordinate);
  }
});

export type ComparisonSite = z.infer<typeof siteSchema>;

export function parseSites(value: unknown): ComparisonSite[] {
  return sitesSchema.parse(value);
}

export async function loadSites(path?: string): Promise<ComparisonSite[]> {
  return parseSites(JSON.parse(await readFile(path ?? new URL('./sites.json', import.meta.url), 'utf8')));
}
