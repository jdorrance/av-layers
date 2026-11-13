/** Decode captured XC Skies responses; runtime snapshots bind each forecast hour to its cycle. */
import type { ComparisonSample, Measurement } from './core.js';

export const XC_MODELS = {
  gfs: { xcModel: 'gfs', product: 'noaa-gfs-0p25' },
  'icon-eu': { xcModel: 'iconeu', product: 'dwd-icon-eu-regular-0p0625' },
  rrfs: { xcModel: 'rrfs', product: 'noaa-rrfs-conus-3km' }
} as const;
type Model = keyof typeof XC_MODELS;

export interface XcRuntime {
  model: Model;
  xcModel: string;
  validTime: string;
  cycle: string;
  forecastHour: number;
  state: string;
}

export interface XcCaptureOptions {
  siteId: string;
  lat: number;
  lon: number;
  model: Model;
  sourceRef: string;
  runtimesBefore?: readonly XcRuntime[];
  runtimesAfter?: readonly XcRuntime[];
}

export interface XcNativeProfile {
  validTime: string;
  levels: { heightM: number; pressureHpa: number | null; temperatureC: number | null; dewPointC: number | null }[];
}

export interface XcProfileResult {
  samples: ComparisonSample[];
  profiles: XcNativeProfile[];
  rawFields: string[];
  unmappedFields: string[];
  diagnostics: string[];
}

const MAX_CAPTURE_BYTES = 8 * 1024 ** 2;
const MAX_FRAMES = 512;

/** JSONP accepts a dotted identifier around one JSON value and never executes code. */
export function parseXcPayload(text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_CAPTURE_BYTES) throw new Error('XC response exceeds byte budget');
  const input = text.trim();
  if (input.startsWith('{') || input.startsWith('[')) return JSON.parse(input);
  const wrapped = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(([\s\S]*)\)\s*;?$/.exec(input);
  if (!wrapped) throw new Error('XC response is neither JSON nor a JSONP call');
  return JSON.parse(wrapped[1]!);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid XC ${label}`);
  return value as Record<string, unknown>;
}

function numeric(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid XC ${label}`);
  return value;
}

function epochTime(value: unknown): string {
  const epoch = numeric(value, 'epoch');
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > 8_640_000_000_000) throw new Error('Invalid XC epoch');
  return new Date(epoch * 1000).toISOString();
}

export function normalizeXcRuntimes(payload: unknown): XcRuntime[] {
  const data = object(object(payload, 'runtimes response').runtimes, 'runtimes'), result: XcRuntime[] = [];
  for (const [model, config] of Object.entries(XC_MODELS)) {
    const rows = data[config.xcModel];
    if (rows === undefined) continue;
    if (!Array.isArray(rows) || rows.length > MAX_FRAMES) throw new Error('Invalid XC runtime rows');
    const epochs = new Set<string>();
    for (const raw of rows) {
      const row = object(raw, 'runtime'), day = String(row.zday), run = numeric(row.zrun, 'run hour');
      const hour = numeric(row.fhour, 'forecast hour'), validTime = epochTime(row.epoch);
      if (!/^\d{8}$/.test(day) || !Number.isInteger(run) || run < 0 || run > 23 || !Number.isInteger(hour) || hour < 0) {
        throw new Error('Invalid XC cycle or forecast hour');
      }
      const cycleMs = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)), run);
      const cycle = new Date(cycleMs).toISOString();
      if (cycle.slice(0, 10).replaceAll('-', '') !== day || cycleMs + hour * 3_600_000 !== Date.parse(validTime)) {
        throw new Error('XC valid time differs from cycle plus forecast hour');
      }
      if (epochs.has(validTime)) throw new Error('Duplicate XC runtime valid time');
      if (typeof row.state !== 'string' || !row.state) throw new Error('Missing XC runtime state');
      epochs.add(validTime);
      result.push({ model: model as Model, xcModel: config.xcModel, validTime, cycle, forecastHour: hour, state: row.state });
    }
  }
  return result;
}

function bindCycles(options: XcCaptureOptions) {
  const index = (rows: readonly XcRuntime[] | undefined) => {
    const result = new Map<string, XcRuntime>();
    for (const row of rows ?? []) if (row.model === options.model) {
      if (result.has(row.validTime)) throw new Error('Duplicate XC binding valid time');
      result.set(row.validTime, row);
    }
    return result;
  };
  const before = index(options.runtimesBefore), after = index(options.runtimesAfter);
  return (validTime: string): string | null => {
    const a = before.get(validTime), b = after.get(validTime);
    return a && b && a.cycle === b.cycle && a.forecastHour === b.forecastHour && a.state === b.state ? a.cycle : null;
  };
}

function physical(value: unknown, factor = 1): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > -9000 ? value * factor : null;
}

function measurement(value: number | null, unit: string, verticalReference: string, definition: string,
  timeSupport = 'valid-time'): Measurement {
  return { value, status: value === null ? 'unavailable' : 'valid', unit, verticalReference, definition,
    timeSupport, methodId: 'xcskies-undisclosed' };
}

function lift(values: Record<string, Measurement>, top: number | null, depth: number | null) {
  const noLift = depth !== null && depth <= 0;
  values['usable-lift-msl'] = { ...measurement(noLift ? null : top, 'm', 'MSL', 'usable-lift-top', 'unknown'),
    status: noLift ? 'no-lift' : top === null ? 'unavailable' : 'valid' };
  values['usable-lift-agl'] = { ...measurement(depth === null ? null : Math.max(0, depth), 'm', 'XC-ground-AGL', 'usable-lift-depth', 'unknown'),
    status: noLift ? 'no-lift' : depth === null ? 'unavailable' : 'valid' };
}

function sample(options: XcCaptureOptions, validTime: string, cycle: string | null,
  values: Record<string, Measurement>, groundM: number | null): ComparisonSample {
  return { provider: 'xcskies', siteId: options.siteId, lat: options.lat, lon: options.lon, model: options.model,
    product: XC_MODELS[options.model].product, validTime, cycle, values, sourceRef: options.sourceRef, groundM };
}

export function normalizeXcProfile(payload: unknown, options: XcCaptureOptions): XcProfileResult {
  const data = object(payload, 'profile');
  if (data.status !== 1) throw new Error('XC profile is unavailable or requires authentication');
  if (!Array.isArray(data.epochs) || !data.epochs.length || data.epochs.length > MAX_FRAMES) throw new Error('Invalid XC profile time axis');
  const validTimes = data.epochs.map(epochTime), used = new Set(['status', 'epochs']);
  for (let index = 1; index < validTimes.length; index++) if (validTimes[index]! <= validTimes[index - 1]!) {
    throw new Error('XC profile times must be distinct and ascending');
  }
  const series = (name: string): unknown[] | undefined => {
    const values = data[name];
    if (values === undefined) return undefined;
    if (!Array.isArray(values) || values.length !== validTimes.length) throw new Error(`XC profile ${name} differs from time axis`);
    used.add(name); return values;
  };
  const elevations = series('elevs'), tops = series('vtops'), blTops = series('bltops'), conservative = series('dalrtops');
  const temperatures = series('ntmp2m'), cloudBases = series('dptops'), cloudTops = series('cutops');
  const meanWind = series('windavg'), precipitation = series('precip'), cloudCover = series('cldmax');
  const nativeT = series('ntmp'), nativeP = series('npress'), nativeD = series('ndp'), nativeH = series('nhgt');
  if ([nativeT, nativeP, nativeH].some(Boolean) && ![nativeT, nativeP, nativeH].every(Boolean)) throw new Error('Incomplete XC native profile');
  const spacing = nativeH ? numeric(data.ninterval, 'native height interval') : undefined;
  if (spacing !== undefined && spacing <= 0) throw new Error('Invalid XC native height interval');
  if (nativeH) used.add('ninterval');
  const cycleFor = bindCycles(options), samples: ComparisonSample[] = [], profiles: XcNativeProfile[] = [];
  for (const [index, validTime] of validTimes.entries()) {
    const ground = physical(elevations?.[index], 10), top = physical(tops?.[index], 10), blTop = physical(blTops?.[index], 10);
    const values: Record<string, Measurement> = {};
    if (tops || elevations) lift(values, top, top === null || ground === null ? null : Math.max(0, top - ground));
    if (blTops) values['thermal-top-msl'] = measurement(blTop, 'm', 'MSL', 'boundary-layer-top', 'unknown');
    if (conservative) {
      const row = conservative[index];
      if (!Array.isArray(row) || row.length !== 3) throw new Error('Invalid XC conservative top');
      values['xc-conservative-top-msl'] = measurement(physical(row[0]), 'm', 'MSL', 'conservative-lift-top', 'unknown');
    }
    if (temperatures) values['sfc-temp-c'] = measurement(physical(temperatures[index]), 'degC', 'surface', 'air-temperature');
    if (cloudBases) {
      const base = physical(cloudBases[index], 10), cloud = base !== null && base > 0 && blTop !== null && base <= blTop;
      values['xc-cloud-base-msl'] = measurement(cloud ? base : null, 'm', 'MSL', 'conditional-cumulus-base');
      if (cloudTops) values['xc-cloud-top-msl'] = measurement(cloud ? physical(cloudTops[index], 10) : null, 'm', 'MSL', 'conditional-cumulus-top');
    }
    if (meanWind) values['xc-bl-mean-wind-speed'] = measurement(physical(meanWind[index], 0.1), 'm/s', 'XC-ground-AGL', 'boundary-layer-mean-wind-speed');
    if (precipitation) values['xc-precipitation'] = measurement(physical(precipitation[index], 0.1), 'mm', 'surface', 'precipitation-amount-unspecified-window', 'unknown');
    if (cloudCover) values['cloud-cover-total'] = measurement(physical(cloudCover[index]), '%', 'surface', 'maximum-profile-cloud-cover');
    samples.push(sample(options, validTime, cycleFor(validTime), values, ground));
    if (nativeT && nativeP && nativeH) {
      const ts = nativeT[index], ps = nativeP[index], ds = nativeD?.[index], heights = nativeH[index];
      if (!Array.isArray(ts) || !Array.isArray(ps) || !Array.isArray(heights) || heights.length !== 2
        || !ts.length || ts.length > 2048 || ts.length !== ps.length || (ds !== undefined && (!Array.isArray(ds) || ds.length !== ts.length))) {
        throw new Error('XC native profile axes differ');
      }
      const start = numeric(heights[0], 'profile start height'), end = numeric(heights[1], 'profile end height');
      if (start > end || start + (ts.length - 1) * spacing! > end) throw new Error('XC native height range differs from levels');
      profiles.push({ validTime, levels: ts.map((temperature, level) => ({ heightM: start + level * spacing!,
        pressureHpa: physical(ps[level]), temperatureC: physical(temperature), dewPointC: physical((ds as unknown[] | undefined)?.[level]) })) });
    }
  }
  const rawFields = Object.keys(data).sort(), unknownCycles = samples.filter(row => row.cycle === null).length;
  return { samples, profiles, rawFields, unmappedFields: rawFields.filter(field => !used.has(field)), diagnostics: [
    'XC model names identify nominal upstream products; source grid and regridding are undisclosed.',
    'XC flux windows, lift methods, and ground datum remain unspecified.',
    ...(unknownCycles ? [`${unknownCycles} profile frames lack stable before/after runtime identity.`] : [])
  ] };
}

/** Pointinfo values use physical units; the selected request supplies valid time. */
export function normalizeXcPointInfo(payload: unknown, options: XcCaptureOptions & { validTime: string }): XcProfileResult {
  const data = object(payload, 'pointinfo'), raw = data[XC_MODELS[options.model].xcModel];
  if (!Array.isArray(raw) || raw.length > 128) throw new Error('Invalid XC pointinfo parameter list');
  const fields: Record<string, number | null> = {};
  for (const entry of raw) {
    const row = object(entry, 'pointinfo measurement'), names = Object.keys(row);
    if (names.length !== 1 || Object.hasOwn(fields, names[0]!)) throw new Error('Duplicate or invalid XC pointinfo measurement');
    fields[names[0]!] = physical(row[names[0]!]);
  }
  const values: Record<string, Measurement> = {}, used = new Set<string>();
  if ('xclift225' in fields || 'xcbldepth' in fields) {
    lift(values, fields.xclift225 ?? null, fields.xcbldepth ?? null); used.add('xclift225'); used.add('xcbldepth');
  }
  const definitions = [
    ['xcm0', 'thermal-top-msl', 'm', 'MSL', 'boundary-layer-top', 'unknown'],
    ['xcstemp', 'sfc-temp-c', 'degC', 'surface', 'terrain-interpolated-air-temperature', 'valid-time'],
    ['xccape', 'cape-jkg', 'J/kg', 'surface', 'convective-available-potential-energy-unspecified-parcel', 'valid-time'],
    ['xcskycond', 'cloud-cover-total', '%', 'surface', 'cloud-cover-total', 'valid-time'],
    ['xccbase', 'xc-cloud-base-msl', 'm', 'MSL', 'conditional-cumulus-base', 'valid-time'],
    ['xccdepth', 'xc-cloud-depth', 'm', 'cloud-depth', 'convective-cloud-depth', 'valid-time']
  ] as const;
  for (const [field, parameter, unit, reference, definition, support] of definitions) if (field in fields) {
    const value = fields[field] ?? null;
    values[parameter] = measurement((field === 'xccbase' || field === 'xccdepth') && value !== null && value <= 0 ? null : value,
      unit, reference, definition, support); used.add(field);
  }
  const rawFields = Object.keys(fields).sort(), cycle = bindCycles(options)(options.validTime);
  return { samples: [sample(options, options.validTime, cycle, values, physical(data.elev))], profiles: [], rawFields,
    unmappedFields: rawFields.filter(field => !used.has(field)), diagnostics: [
      'XC pointinfo surface temperature includes terrain interpolation.',
      ...(cycle === null ? ['Pointinfo lacks stable before/after runtime identity.'] : [])
    ] };
}
