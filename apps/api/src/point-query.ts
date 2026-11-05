import { isLayerId, type LayerId } from '@av/contracts';
import type { PublishedManifest } from './publication';
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
export function selectSampleFields(m: PublishedManifest, url: URL, defaults: { frames: 'first' | 'all'; layers?: readonly LayerId[] } = { frames: 'first' }) {
  const requested = url.searchParams.get('frame');
  const frameIds = requested === 'all' || (requested === null && defaults.frames === 'all') ? m.frames.map(frame => frame.id)
    : requested === null ? [m.frames[0]!.id] : requested.split(',');
  const layers = url.searchParams.get('layers')?.split(',') ?? [...(defaults.layers ?? m.layers)];
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
