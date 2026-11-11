import type { ManifestV5, parseProvenance } from '@av/contracts';

interface ForecastObject {
  key: string;
  sha256: string;
  contentType: string;
  bytes?: number;
}

/** List numeric packs before raster archives in publication order. */
export function forecastObjects(manifest: ManifestV5): ForecastObject[] {
  const packs = manifest.surfaces.flatMap(surface => [...surface.samples.shards, ...(surface.profiles?.groups.flatMap(group => group.shards) ?? [])]);
  return [
    ...packs.map(({ key, sha256, bytes }) => ({ key, sha256, bytes, contentType: 'application/octet-stream' })),
    ...manifest.artifacts.map(({ tilesKey: key, tilesSha256: sha256 }) => ({ key, sha256, contentType: 'application/vnd.pmtiles' }))
  ];
}

/** List separately stored frame receipts in provenance index order. */
export function provenanceObjects(value: ReturnType<typeof parseProvenance>) {
  return value.version === 2 ? value.frames.map(frame => ({ ...frame, contentType: 'application/json' as const })) : [];
}
