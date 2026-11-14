import { LAYER_IDS, type LayerId } from '@av/contracts/layers';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import { WIND_HEIGHTS } from '@av/contracts/wind-data';
import { AUTO_MODEL_ID, type UnitSystem } from '@av/client';

export type AltitudeReference = 'agl' | 'msl';
export type WindStyleParam = 'trails' | 'barbs' | 'hybrid';
export type TimeZoneMode = 'utc' | 'local';

function finiteParam(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseWindHeight(value: string | null): 'surface' | number | 'lift' | null {
  if (value === 'surface' || value === 'lift') return value;
  const n = finiteParam(value);
  return n !== null && n > 0 ? WIND_HEIGHTS.reduce((best, stop) => Math.abs(stop - n) < Math.abs(best - n) ? stop : best) : null;
}

export function previewQuery(search: string, offline: boolean) {
  const params = new URLSearchParams(search);
  const model = params.get('model');
  const lat = finiteParam(params.get('lat')), lon = finiteParam(params.get('lon')), zoom = finiteParam(params.get('z'));
  const opacity = finiteParam(params.get('opacity'));
  const rawLayer = params.get('layer');
  const layer = rawLayer && (LAYER_IDS as readonly string[]).includes(rawLayer) ? rawLayer as LayerId : null;
  const reference: AltitudeReference = params.get('ref') === 'msl' || layer === 'usable-lift-msl' ? 'msl' : 'agl';
  const wstyle = params.get('wstyle');
  const units = params.get('units');
  const wind = params.get('wind');
  return {
    model: model && (model === AUTO_MODEL_ID ? !offline : offline || MODEL_OPTIONS.some(option => option.modelId === model)) ? model : null,
    reference,
    layer: layer && layer !== 'usable-lift-agl' && layer !== 'usable-lift-msl' ? layer : null,
    opacity: opacity === null ? null : Math.min(1, Math.max(0, opacity)),
    validTime: params.get('t'),
    windVisible: wind === '0' ? false : wind === '1' ? true : null,
    windStyle: wstyle === 'trails' || wstyle === 'barbs' || wstyle === 'hybrid' ? wstyle as WindStyleParam : null,
    windHeight: parseWindHeight(params.get('wheight')),
    units: units === 'metric' || units === 'imperial' ? units as UnitSystem : null,
    timeZoneMode: params.get('tz') === 'local' ? 'local' as TimeZoneMode : params.get('tz') === 'utc' ? 'utc' as TimeZoneMode : null,
    camera: lat !== null && Math.abs(lat) <= 90 && lon !== null && zoom !== null
      ? { center: [lon, lat] as [number, number], zoom } : null
  };
}

export function previewUrl(pathname: string, state: {
  model: string;
  reference: AltitudeReference;
  layer?: LayerId | null;
  opacity: number;
  lat: number;
  lon: number;
  zoom: number;
  validTime?: string;
  windVisible?: boolean;
  windStyle?: WindStyleParam;
  windHeight?: 'surface' | number | 'lift';
  units?: UnitSystem;
  timeZoneMode?: TimeZoneMode;
}): string {
  const params = new URLSearchParams({
    model: state.model, ref: state.reference, opacity: String(Math.round(state.opacity * 100) / 100),
    lat: state.lat.toFixed(4), lon: state.lon.toFixed(4), z: String(Math.round(state.zoom * 100) / 100)
  });
  if (state.layer && state.layer !== 'usable-lift-agl' && state.layer !== 'usable-lift-msl') params.set('layer', state.layer);
  if (state.validTime) params.set('t', state.validTime);
  if (state.windVisible !== undefined) params.set('wind', state.windVisible ? '1' : '0');
  if (state.windStyle && state.windStyle !== 'trails') params.set('wstyle', state.windStyle);
  if (state.windHeight && state.windHeight !== 'surface') params.set('wheight', String(state.windHeight));
  if (state.units && state.units !== 'metric') params.set('units', state.units);
  if (state.timeZoneMode === 'local') params.set('tz', 'local');
  return `${pathname}?${params}`;
}
