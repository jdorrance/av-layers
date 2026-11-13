import { computeFreshness, type CatalogModelEntry, type ManifestV5 } from '@av/contracts/publication';
import { fixtureBuild } from './forecast-fixture.js';

export const AUTO_CYCLE = '2026-10-31T00:00:00.000Z';
export const REGION_A_POINT = { lat: 40.18, lon: 44.5 };
export const REGION_B_POINT = { lat: -36.85, lon: 174.76 };
export const REGION_A_BOUNDS = [42, 38, 46, 43] as const;
export const REGION_B_BOUNDS = [166, -48, 180, -34] as const;
export const autoTime = (hour: number): string => new Date(Date.parse(AUTO_CYCLE) + hour * 3_600_000).toISOString();

export function autoBuild(model: string, bounds: Readonly<ManifestV5['descriptors']['bounds']>, hours: number[], mapFrameCount = hours.length) {
  const frames = hours.map(hour => ({ id: `f${String(hour).padStart(3, '0')}`, validTime: autoTime(hour),
    intervalStart: autoTime(hour - 1), intervalEnd: autoTime(hour) }));
  const build = fixtureBuild({ model, frames, mapFrameCount, createdAt: AUTO_CYCLE, cycle: AUTO_CYCLE, expiresAt: autoTime(96),
    layers: ['usable-lift-msl', 'usable-lift-agl'] });
  build.manifest.descriptors.bounds = [...bounds];
  return build;
}

export function autoCatalogRow(manifest: ManifestV5, nominalDxMeters: number): CatalogModelEntry {
  return { model: manifest.model, available: true, bounds: manifest.descriptors.bounds,
    cycle: manifest.cycle, expiresAt: manifest.expiresAt, nominalDxMeters,
    freshness: computeFreshness(manifest, Date.parse(AUTO_CYCLE)) };
}
