/** Decode captured SkySight point and native windgram responses with their regional product identity. */
import type { ComparisonSample, Measurement, ParameterMapping } from './core.js';

export interface SkySightCaptureOptions {
  siteId: string;
  lat: number;
  lon: number;
  region: string;
  sourceRef: string;
  capturedAt?: string;
  requestedTimes?: readonly string[];
}

export interface SkySightNativeProfile {
  validTime: string;
  base: number | null;
  scalars: Record<string, number | null>;
  levels: { altitude: number; values: Record<string, number | null>; available: boolean }[];
}

export interface SkySightResult {
  samples: ComparisonSample[];
  profiles: SkySightNativeProfile[];
  rawFields: string[];
  unmappedFields: string[];
  diagnostics: string[];
}

const MAX_CAPTURE_BYTES = 8 * 1024 ** 2;
const MAX_FRAMES = 512;
const MAX_LEVELS = 256;
const MAX_FIELDS = 64;

export function parseSkySightPayload(text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_CAPTURE_BYTES) throw new Error('SkySight response exceeds byte budget');
  return JSON.parse(text);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > MAX_FIELDS) {
    throw new Error(`Invalid SkySight ${label}`);
  }
  return value as Record<string, unknown>;
}

function numeric(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if ((typeof value !== 'number' && typeof value !== 'string') || typeof value === 'string' && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
    || !Number.isFinite(Number(value))) throw new Error(`Invalid SkySight ${label}`);
  return Number(value);
}

function validTime(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{12}$/.test(value)) throw new Error('Invalid SkySight UTC time');
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:00.000Z`;
  if (!Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString() !== iso) throw new Error('Invalid SkySight UTC time');
  return iso;
}

function validateTimes(values: readonly unknown[], options: SkySightCaptureOptions): string[] {
  if (!values.length || values.length > MAX_FRAMES) throw new Error('Invalid SkySight time axis');
  const times = values.map(validTime);
  if (times.some((time, index) => index > 0 && time <= times[index - 1]!)) throw new Error('SkySight times must be distinct and ascending');
  if (options.requestedTimes && (options.requestedTimes.length !== times.length
    || options.requestedTimes.some((time, index) => validTime(time) !== times[index]))) throw new Error('SkySight response differs from requested times');
  return times;
}

function validateOptions(options: SkySightCaptureOptions): void {
  if (!options.siteId.trim() || !options.sourceRef.trim() || !/^[A-Z][A-Z0-9_-]{0,31}$/.test(options.region)
    || !Number.isFinite(options.lat) || Math.abs(options.lat) > 90 || !Number.isFinite(options.lon) || Math.abs(options.lon) > 180) {
    throw new Error('Invalid SkySight capture identity');
  }
  if (options.capturedAt && (!/(?:Z|[+-]\d{2}:\d{2})$/.test(options.capturedAt) || !Number.isFinite(Date.parse(options.capturedAt)))) {
    throw new Error('Invalid SkySight capture time');
  }
}

function measurement(value: number | null, unit: string, verticalReference: string, definition: string,
  timeSupport = 'valid-time'): Measurement {
  return { value, status: value === null ? 'unavailable' : 'valid', unit, verticalReference, definition,
    timeSupport, methodId: 'skysight-undisclosed' };
}

function sample(options: SkySightCaptureOptions, endpoint: string, time: string, values: Record<string, Measurement>, groundM: number | null): ComparisonSample {
  return { provider: 'skysight', siteId: options.siteId, lat: options.lat, lon: options.lon, model: 'skysight',
    product: `skysight-${options.region.toLowerCase()}-${endpoint}`, cycle: null, validTime: time,
    sourceRef: options.sourceRef, capturedAt: options.capturedAt, values, groundM };
}

const diagnostics = [
  'SkySight regional model initialization and forecast lead are unknown in these responses.',
  'Point and windgram endpoints retain separate product identities and parameter inventories.',
  'SkySight displays surface wind and gusts at 2m AGL; the gust duration is unspecified.',
  'The provider labels CAPE units as J; conversion to J/kg remains unverified.'
];

const commonMappings: readonly ParameterMapping[] = [
  { id: 'usable-lift-msl', leftParameter: 'usable-lift-msl', rightParameter: 'usable-lift-msl', comparability: 'related', timePolicy: 'valid-time',
    note: 'SkySight reports the 175fpm (0.889m/s) thermal threshold; the other provider uses a different usable-lift threshold and method. Forcing windows are unspecified.' },
  { id: 'usable-lift-agl', leftParameter: 'usable-lift-agl', rightParameter: 'usable-lift-agl', comparability: 'related', timePolicy: 'valid-time', referencePolicy: 'provider-ground',
    note: 'Each product uses its own ground and usable-lift threshold; SkySight uses 175fpm (0.889m/s). Forcing windows are unspecified.' },
  { id: 'sfc-temp-c', leftParameter: 'sfc-temp-c', rightParameter: 'sfc-temp-c', comparability: 'related',
    note: 'Surface air-temperature forecasts use different regional models, terrain and spatial sampling.' }
];
const lowCloudMapping: ParameterMapping = { id: 'cloud-cover-low', leftParameter: 'cloud-cover-low', rightParameter: 'cloud-cover-low', comparability: 'related',
  note: 'Low cloud cover uses each model\'s vertical aggregation; SkySight documents its low layer as 0–4000m.' };

export const SKY_SIGHT_MAPPINGS: readonly ParameterMapping[] = [
  ...commonMappings,
  { id: 'sfc-dewpoint-c', leftParameter: 'sfc-dewpoint-c', rightParameter: 'sfc-dewpoint-c', comparability: 'related',
    note: 'Surface dewpoint forecasts use different regional models, terrain and spatial sampling.' },
  { id: 'mslp-hpa', leftParameter: 'mslp-hpa', rightParameter: 'mslp-hpa', comparability: 'related',
    note: 'Mean sea-level pressure uses each regional model and its pressure reduction.' },
  { id: 'cloud-base-msl', leftParameter: 'surface-lcl-msl', rightParameter: 'skysight-condensation-level-msl', comparability: 'related',
    note: 'Surface LCL versus SkySight displayed condensation level; parcel and spatial sampling methods differ.' },
  { ...lowCloudMapping, comparability: 'unmapped',
    note: 'Point cloud fields were zero across all 3,030 valid baseline frames and are unused by the point client. Their discrepancy with windgram cloud values is unresolved.' },
  { id: 'sensible-heat-flux', leftParameter: 'sensible-heat-flux', rightParameter: 'sfcshf', comparability: 'unmapped',
    note: 'SkySight point surface heating remains a raw field because its wire units and statistical window are unverified.' },
  { id: 'precip-rate', leftParameter: 'precip-rate', rightParameter: 'skysight-rain-30m-mm', comparability: 'unmapped',
    note: 'SkySight supplies a 30-minute accumulation in mm; AV supplies a rate over its own statistical window.' },
  { id: 'thermal-strength', leftParameter: 'thermal-velocity', rightParameter: 'skysight-thermal-strength', comparability: 'unmapped',
    note: 'SkySight displays thermal strength in m/s; its relationship to our characteristic velocity and averaging rule is unspecified.' },
  { id: 'wind-gust', leftParameter: 'wind-gust-10m', rightParameter: 'skysight-surface-gust', comparability: 'unmapped',
    note: 'SkySight point gusts accompany its 2m wind; our gusts are at 10m. SkySight gust duration is unspecified.' }
];

export const SKY_SIGHT_XC_MAPPINGS: readonly ParameterMapping[] = [
  ...commonMappings,
  { id: 'cloud-base-msl', leftParameter: 'xc-cloud-base-msl', rightParameter: 'skysight-condensation-level-msl', comparability: 'related',
    note: 'XC conditional cumulus base versus SkySight condensation level; cloud occurrence and parcel methods differ.' }
];

export const SKY_SIGHT_WINDGRAM_MAPPINGS: readonly ParameterMapping[] = [
  { id: 'thermal-top-msl', leftParameter: 'thermal-top-msl', rightParameter: 'skysight-boundary-top-msl', comparability: 'related', timePolicy: 'valid-time',
    note: 'AV convective top versus SkySight windgram boundary-layer top, separate from its 175fpm point height. Model ground and spatial sampling differ; captured SkySight tops below its native profile base retain their original MSL values.' },
  lowCloudMapping,
  { id: 'cape-jkg', leftParameter: 'cape-jkg', rightParameter: 'skysight-cape', comparability: 'unmapped',
    note: 'SkySight legend labels CAPE as J; wire scaling to J/kg is unverified.' }
];

function rain(value: number | null, time: string): Measurement {
  return { ...measurement(value, 'mm', 'surface', 'precipitation-amount', 'interval-accumulation'),
    intervalStart: new Date(Date.parse(time) - 30 * 60_000).toISOString(), intervalEnd: time };
}

export function normalizeSkySightWindgram(payload: unknown, options: SkySightCaptureOptions): SkySightResult {
  validateOptions(options);
  const data = object(payload, 'windgram');
  if (data.vertical_grid !== 'native' || !Array.isArray(data.data) || data.data.length > MAX_FRAMES) throw new Error('SkySight native windgram is required');
  const rows = data.data.map(row => object(row, 'windgram frame'));
  const times = validateTimes(rows.map(row => row.dt), options), base = numeric(data.base, 'base');
  const rawFields = new Set(Object.keys(data)), used = new Set(['data', 'base', 'vertical_grid', 'data[].dt', 'data[].data']);
  const profiles: SkySightNativeProfile[] = [], samples: ComparisonSample[] = [];
  for (const [index, row] of rows.entries()) {
    for (const field of Object.keys(row)) rawFields.add(`data[].${field}`);
    if (!Array.isArray(row.data) || row.data.length > MAX_LEVELS) throw new Error('Invalid SkySight native level axis');
    const levels = row.data.map(raw => {
      const level = object(raw, 'native level'), altitude = numeric(level.altitude, 'native altitude');
      if (altitude === null) throw new Error('Missing SkySight native altitude');
      const values: Record<string, number | null> = {};
      for (const [field, value] of Object.entries(level)) {
        rawFields.add(`data[].data[].${field}`);
        if (field !== 'altitude') values[field] = numeric(value, `native ${field}`);
      }
      return { altitude, values, available: values.press !== null && values.press !== undefined && values.press > 0 };
    });
    if (levels.some((level, i) => i > 0 && level.altitude <= levels[i - 1]!.altitude)) throw new Error('SkySight native heights must be distinct and ascending');
    const scalars: Record<string, number | null> = {};
    for (const [field, value] of Object.entries(row)) if (field !== 'dt' && field !== 'data') scalars[field] = numeric(value, field);
    const time = times[index]!, values: Record<string, Measurement> = {}, available = levels.some(level => level.available);
    // Units and absolute height are displayed by the secure client; retain endpoint-specific diagnostics.
    for (const [field, name, unit, reference, definition] of [
      ['pblh', 'skysight-boundary-top-msl', 'm', 'MSL', 'boundary-layer-top'],
      ['zsfclcl', 'skysight-condensation-level-msl', 'm', 'MSL', 'condensation-level'],
      ['cfracl', 'cloud-cover-low', '%', 'surface', 'cloud-cover-0-4000m'],
      ['cfracm', 'skysight-cloud-cover-mid', '%', 'surface', 'cloud-cover-4000-8000m'],
      ['cfrach', 'skysight-cloud-cover-high', '%', 'surface', 'cloud-cover-above-8000m'],
      ['cape', 'skysight-cape', 'J', 'surface', 'convective-available-potential-energy-provider-units']
    ] as const) if (field in scalars) {
      values[name] = measurement(available ? scalars[field]! : null, unit, reference, definition, field === 'pblh' ? 'unknown' : 'valid-time');
      used.add(`data[].${field}`);
    }
    if ('accrain' in scalars) { values['skysight-rain-30m-mm'] = rain(available ? scalars.accrain! : null, time); used.add('data[].accrain'); }
    profiles.push({ validTime: time, base, scalars, levels });
    samples.push(sample(options, 'windgram', time, values, base));
  }
  return { samples, profiles, rawFields: [...rawFields].sort(), unmappedFields: [...rawFields].filter(field => !used.has(field)).sort(),
    diagnostics: [...diagnostics, 'Native windgram fields retain wire names; first-level temperature is separate from 2m surface temperature.'] };
}

export function normalizeSkySightPoint(payload: unknown, options: SkySightCaptureOptions): SkySightResult {
  validateOptions(options);
  const data = object(payload, 'point');
  if (!Array.isArray(data.times)) throw new Error('Missing SkySight point time axis');
  const times = validateTimes(data.times, options), used = new Set(['times']);
  const series = (name: string): (number | null)[] | undefined => {
    const values = data[name];
    if (values === undefined) return undefined;
    if (!Array.isArray(values) || values.length !== 0 && values.length !== times.length) throw new Error(`SkySight point ${name} differs from time axis`);
    used.add(name); return values.length ? values.map(value => numeric(value, name)) : times.map(() => null);
  };
  const grounds = series('HGT'), tops = series('hwcrit'), depths = series('dwcrit');
  const pressures = series('mslpress'), precipitation = series('accrain');
  const definitions = [
    ['sfctemp', 'sfc-temp-c', 'degC', 'surface', 'air-temperature-2m', 'valid-time'],
    ['sfcdewpt', 'sfc-dewpoint-c', 'degC', 'surface', 'dewpoint-temperature-2m', 'valid-time'],
    ['CFRACL', 'cloud-cover-low', '%', 'surface', 'cloud-cover-0-4000m', 'valid-time'],
    ['CFRACM', 'skysight-cloud-cover-mid', '%', 'surface', 'cloud-cover-4000-8000m', 'valid-time'],
    ['CFRACH', 'skysight-cloud-cover-high', '%', 'surface', 'cloud-cover-above-8000m', 'valid-time'],
    ['zsfclcl', 'skysight-condensation-level-msl', 'm', 'MSL', 'condensation-level', 'valid-time'],
    ['wstar', 'skysight-thermal-strength', 'm/s', 'SkySight-ground-AGL', 'thermal-strength-unspecified-averaging', 'unknown'],
    ['sfcwindspd', 'skysight-surface-wind-speed', 'm/s', '2m-SkySight-AGL', 'wind-speed', 'valid-time'],
    ['sfcwinddir', 'skysight-surface-wind-direction', 'deg', '2m-SkySight-AGL', 'wind-direction', 'valid-time'],
    ['sfcgust', 'skysight-surface-gust', 'm/s', '2m-SkySight-AGL', 'wind-gust', 'unknown'],
    ['bltopwindspd', 'skysight-thermal-top-wind-speed', 'm/s', 'SkySight-boundary-layer-top', 'wind-speed', 'valid-time'],
    ['bltopwinddir', 'skysight-thermal-top-wind-direction', 'deg', 'SkySight-boundary-layer-top', 'wind-direction', 'valid-time']
  ] as const;
  const fields = definitions.map(([source, ...definition]) => ({ values: series(source), definition }));
  const samples = times.map((time, index) => {
    const missing = pressures !== undefined && (pressures[index] === null || pressures[index]! <= 0);
    const values: Record<string, Measurement> = {}, top = missing ? null : tops?.[index] ?? null, depth = missing ? null : depths?.[index] ?? null;
    if (tops) values['usable-lift-msl'] = { ...measurement(depth !== null && depth <= 0 ? null : top, 'm', 'MSL', 'thermal-top-at-175fpm', 'unknown'),
      status: depth !== null && depth <= 0 ? 'no-lift' : top === null ? 'unavailable' : 'valid' };
    if (depths) values['usable-lift-agl'] = { ...measurement(depth === null ? null : Math.max(0, depth), 'm', 'SkySight-ground-AGL', 'thermal-depth-at-175fpm', 'unknown'),
      status: depth !== null && depth <= 0 ? 'no-lift' : depth === null ? 'unavailable' : 'valid' };
    if (pressures) values['mslp-hpa'] = measurement(missing ? null : pressures[index]!, 'hPa', 'MSL', 'mean-sea-level-pressure');
    if (precipitation) values['skysight-rain-30m-mm'] = rain(missing ? null : precipitation[index]!, time);
    for (const field of fields) if (field.values) {
      const [name, unit, reference, definition, timeSupport] = field.definition;
      values[name] = measurement(missing ? null : field.values[index]!, unit, reference, definition, timeSupport);
    }
    return sample(options, 'point', time, values, missing ? null : grounds?.[index] ?? null);
  });
  const rawFields = Object.keys(data).sort();
  return { samples, profiles: [], rawFields, unmappedFields: rawFields.filter(field => !used.has(field)), diagnostics: [...diagnostics,
    'Thermal height and depth use the documented 175fpm threshold; forcing windows remain unspecified.',
    'No-lift uses reported depth <= 0; positive sub-metre depths retain their numeric values and valid status.',
    'Point cloud fields remain unscored after all-zero baseline captures disagreed with windgram cloud values.'
  ] };
}
