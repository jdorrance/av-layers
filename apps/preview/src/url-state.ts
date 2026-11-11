import { MODEL_OPTIONS } from '@av/contracts/model-options';

export type AltitudeReference = 'agl' | 'msl';

function finiteParam(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function previewQuery(search: string, offline: boolean) {
  const params = new URLSearchParams(search);
  const model = params.get('model');
  const lat = finiteParam(params.get('lat'));
  const lon = finiteParam(params.get('lon'));
  const zoom = finiteParam(params.get('z'));
  const opacity = finiteParam(params.get('opacity'));
  const reference: AltitudeReference = params.get('ref') === 'msl' ? 'msl' : 'agl';
  return {
    model: model && (offline || MODEL_OPTIONS.some(option => option.modelId === model)) ? model : null,
    reference,
    opacity: opacity === null ? null : Math.min(1, Math.max(0, opacity)),
    validTime: params.get('t'),
    camera: lat !== null && Math.abs(lat) <= 90 && lon !== null && zoom !== null
      ? { center: [lon, lat] as [number, number], zoom } : null
  };
}

export function previewUrl(pathname: string, state: {
  model: string;
  reference: AltitudeReference;
  opacity: number;
  lat: number;
  lon: number;
  zoom: number;
  validTime?: string;
}): string {
  const params = new URLSearchParams({
    model: state.model, ref: state.reference, opacity: String(Math.round(state.opacity * 100) / 100),
    lat: state.lat.toFixed(4), lon: state.lon.toFixed(4), z: String(Math.round(state.zoom * 100) / 100)
  });
  if (state.validTime) params.set('t', state.validTime);
  return `${pathname}?${params}`;
}
