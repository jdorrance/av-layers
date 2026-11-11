import { isLayerId, surfaceFrameCount, type ForecastSurfaceV5, type LayerId, type ManifestV5 } from '@av/contracts';
import type { ResolvedSparseCoverage } from './coverage';
import { fail } from './http';

function coordinate(value: string | null | undefined, name: string, min: number, max: number): number {
  if (value === null || value === undefined || value.trim() === '' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) fail(400, 'invalid-query', `Invalid ${name}`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) fail(400, 'invalid-query', `Invalid ${name}`);
  return Object.is(number, -0) ? 0 : number;
}

export function readCoordinatePair(lat: string | null | undefined, lon: string | null | undefined) {
  return { lat: coordinate(lat, 'lat', -90, 90), lon: coordinate(lon, 'lon', -180, 180) };
}

export function readPointCoordinates(url: URL) {
  return readCoordinatePair(url.searchParams.get('lat'), url.searchParams.get('lon'));
}

/** Resolve unique published selections in canonical order; the caller admits its output work. */
export function selectSampleFields(m: ManifestV5, url: URL, defaultLayers: readonly LayerId[] = m.layers) {
  const requested = url.searchParams.get('frame');
  const frameIds = requested === 'all' ? m.frames.map(frame => frame.id)
    : requested === null ? [m.frames[0]!.id] : requested.split(',');
  const layers = url.searchParams.get('layers')?.split(',') ?? [...defaultLayers];
  if (!frameIds.length || !layers.length || new Set(frameIds).size !== frameIds.length || new Set(layers).size !== layers.length) fail(400, 'invalid-query', 'Select distinct frames and layers');
  const selectedLayers = layers.map(layer => {
    if (!isLayerId(layer) || !m.layers.includes(layer)) fail(404, 'unknown-layer', 'Unknown layer');
    return layer;
  }).sort();
  const frames = frameIds.map(id => {
    const frame = m.frames.find(frame => frame.id === id);
    if (!frame) fail(404, 'unknown-frame', 'Unknown frame');
    return frame;
  }).sort((a, b) => a.validTime.localeCompare(b.validTime));
  return { frames, layers: selectedLayers };
}

/** Select frame-then-layer channels within the surface's packed scalar groups. */
export function sampleChannelGroups(
  manifest: ManifestV5, surface: ForecastSurfaceV5, coverage: ResolvedSparseCoverage,
  frames: Readonly<ManifestV5['frames']>, layers: readonly LayerId[]
) {
  const groups = coverage.groups ?? [{ firstFrame: 0, frameCount: surfaceFrameCount(manifest, surface),
    channelCount: surface.samples.channelCount, shards: surface.samples.shards }];
  const frameIndices = frames.map(frame => ({ frameId: frame.id, index: manifest.frames.indexOf(frame) }));
  const layerIndices = layers.map(layer => ({ layer, index: surface.layers.indexOf(layer) }));
  return groups.flatMap(({ firstFrame, frameCount, channelCount, shards }) => {
    const jobs = frameIndices.filter(({ index }) => index >= firstFrame && index < firstFrame + frameCount)
      .flatMap(({ frameId, index }) => {
        const firstChannel = (index - firstFrame) * surface.layers.length;
        return layerIndices.map(({ layer, index }) => ({ frameId, layer, channel: firstChannel + index }));
      });
    return jobs.length ? [{ jobs, channels: jobs.map(job => job.channel), layout: coverage.layouts.get(channelCount)!, shards }] : [];
  });
}
