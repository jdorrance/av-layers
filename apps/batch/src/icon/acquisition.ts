import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ICON_ARMENIA_BBOX,
  ICON_ARMENIA_EXPORT_GRID,
  ICON_ARMENIA_FORECAST_HOURS,
  ICON_ARMENIA_INTERVAL_HOURS,
  ICON_ATTRIBUTION,
  ICON_BASE,
  ICON_HALF_LEVELS,
  ICON_LEVELS,
  ICON_LEVEL_NUMBERS_ASCENDING,
  ICON_REQUIRED_FIELDS,
  ICON_SHORT_NAMES,
  ICON_SURFACE_FIELDS,
  ICON_STAT_FIELDS,
  ICON_NATIVE_LEVEL_FIELDS,
  ICON_UNITS,
} from './constants.ts';
import { IconAdapterError, iconWindowMeanUpwardFlux, iconWindowPrecipitationRate } from './fields.ts';
import { buildIconExportMapping, buildIconNativeGeometry, recordKey, validateIconBounds } from './geometry.ts';
import type {
  AcquireIconArmeniaOptions,
  DiscoveredIconArmeniaRun,
  DiscoverIconArmeniaRunOptions,
  IconArmeniaAcquisition,
  IconArmeniaFrame,
  IconBounds,
  IconExtract,
  IconFieldMetadata,
  IconGrid,
  IconIntervalWindow,
  IconNativeCell,
  IconProvenance,
  IconRecord,
  IconSourceAsset,
} from './types.ts';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new IconAdapterError('extract', `ICON extract ${name} must be a non-empty string`);
  return value;
}

function numberValue(value: unknown, name: string): number {
  if (!finite(value)) throw new IconAdapterError('extract', `ICON extract ${name} must be finite`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new IconAdapterError('extract', `ICON extract ${name} must be a non-negative integer`);
  return value as number;
}

function parseAsset(value: unknown): IconSourceAsset | undefined {
  if (value === undefined || value === null) return undefined;
  if (!object(value)) throw new IconAdapterError('extract', 'ICON source asset is malformed');
  const url = text(value.url, 'source.url');
  if (value.sourceKind === 'fixture') {
    if (!url.startsWith('fixture://') || value.sha256 !== null || value.bytes !== null || value.range !== null || value.lastModified !== null) throw new IconAdapterError('extract', 'Invalid synthetic ICON fixture asset');
    return { sourceKind: 'fixture', url, sha256: null, bytes: null, range: null, lastModified: null };
  }
  if ((value.sourceKind !== undefined && value.sourceKind !== 'source') || !url.startsWith('https://opendata.dwd.de/')) throw new IconAdapterError('extract', 'Invalid ICON source asset');
  const sha256 = text(value.sha256, 'source.sha256');
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new IconAdapterError('extract', 'ICON source asset sha256 is invalid');
  const bytes = numberValue(value.bytes, 'source.bytes');
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new IconAdapterError('extract', 'ICON source asset bytes is invalid');
  return {
    sourceKind: 'source',
    url,
    sha256,
    bytes,
    range: Array.isArray(value.range) && value.range.length === 2 ? [numberValue(value.range[0], 'source.range'), numberValue(value.range[1], 'source.range')] : null,
    lastModified: typeof value.lastModified === 'string' ? value.lastModified : null,
  };
}

function parseMetadata(value: unknown): IconFieldMetadata {
  if (!object(value)) throw new IconAdapterError('extract', 'ICON record metadata is malformed');
  if (typeof value.shortName !== 'string' || typeof value.units !== 'string' || typeof value.stepType !== 'string') {
    throw new IconAdapterError('extract', 'ICON record metadata requires shortName, units and stepType');
  }
  const startHour = numberValue(value.startHour, 'metadata.startHour');
  const endHour = numberValue(value.endHour, 'metadata.endHour');
  const packingError = value.packingError === undefined ? undefined : numberValue(value.packingError, 'metadata.packingError');
  return { ...value, shortName: value.shortName, units: value.units, stepType: value.stepType, startHour, endHour, ...(packingError === undefined ? {} : { packingError }) } as IconFieldMetadata;
}

function parseRecord(value: unknown): IconRecord {
  if (!object(value)) throw new IconAdapterError('extract', 'ICON record is malformed');
  const field = text(value.field, 'record.field');
  if (!ICON_REQUIRED_FIELDS.includes(field)) throw new IconAdapterError('field-not-admitted', `ICON field ${field} is not in the stripped required-field list`);
  const hour = positiveInteger(value.hour, 'record.hour');
  const level = value.level === null ? null : positiveInteger(value.level, 'record.level');
  if (!Array.isArray(value.values)) throw new IconAdapterError('extract', 'ICON record values must be an array');
  const values = value.values.map((entry) => {
    if (entry === null) return null;
    if (!finite(entry)) throw new IconAdapterError('extract', 'ICON record values must be finite numbers or null');
    return entry;
  });
  return { field, hour, level, metadata: parseMetadata(value.metadata), values, source: parseAsset(value.source) };
}

function parseCells(value: unknown): IconNativeCell[] {
  if (!Array.isArray(value) || !value.length) throw new IconAdapterError('extract', 'ICON extract cells must be a non-empty array');
  return value.map((entry) => {
    if (!object(entry)) throw new IconAdapterError('extract', 'ICON native cell is malformed');
    return {
      index: positiveInteger(entry.index, 'cell.index'),
      id: text(entry.id, 'cell.id'),
      latitude: numberValue(entry.latitude, 'cell.latitude'),
      longitude: numberValue(entry.longitude, 'cell.longitude'),
      terrainM: numberValue(entry.terrainM, 'cell.terrainM'),
    };
  });
}

function parseGrid(value: unknown): IconGrid {
  if (!object(value) || value.type !== 'icon-native-triangular') throw new IconAdapterError('extract', 'ICON extract grid must be the native triangular grid');
  return {
    type: 'icon-native-triangular',
    uuid: text(value.uuid, 'grid.uuid'),
    number: positiveInteger(value.number, 'grid.number'),
    pointCount: positiveInteger(value.pointCount, 'grid.pointCount'),
    geometrySource: value.geometrySource,
    coordinateSources: object(value.coordinateSources) ? value.coordinateSources as Record<string, IconSourceAsset> : undefined,
  };
}

function parseProvenance(value: unknown): IconProvenance {
  if (!object(value)) throw new IconAdapterError('extract', 'ICON provenance is required');
  const capturedAt = text(value.capturedAt, 'provenance.capturedAt');
  if (!Number.isFinite(Date.parse(capturedAt))) throw new IconAdapterError('extract', 'ICON provenance capturedAt is invalid');
  return {
    sourceSynthetic: value.sourceSynthetic === true,
    publicationReady: false,
    provider: text(value.provider, 'provenance.provider'),
    accessProduct: text(value.accessProduct, 'provenance.accessProduct'),
    attribution: text(value.attribution, 'provenance.attribution'),
    capturedAt: new Date(capturedAt).toISOString(),
    ...(finite(value.downloadedBytes) ? { downloadedBytes: value.downloadedBytes } : {}),
    ...(finite(value.downloads) ? { downloads: value.downloads } : {}),
    ...(finite(value.retries) ? { retries: value.retries } : {}),
    ...(finite(value.elapsedSeconds) ? { elapsedSeconds: value.elapsedSeconds } : {}),
    ...(object(value.decoder) ? { decoder: value.decoder } : {}),
  };
}

function parseExtract(raw: unknown): IconExtract {
  if (!object(raw)) throw new IconAdapterError('extract', 'ICON extract must be an object');
  const levels = Array.isArray(raw.levels) ? raw.levels.map((level) => positiveInteger(level, 'levels')) : [];
  if (levels.length !== ICON_LEVELS.length || levels.some((level, index) => level !== ICON_LEVELS[index])) {
    throw new IconAdapterError('levels', 'ICON extract must contain exactly levels 45 through 74');
  }
  const forecastHours = Array.isArray(raw.forecastHours) ? raw.forecastHours.map((hour) => positiveInteger(hour, 'forecastHours')) : [];
  if (!forecastHours.length || forecastHours.some((hour, index) => hour < 1 || hour > 78 || (index > 0 && hour <= forecastHours[index - 1]))) {
    throw new IconAdapterError('hours', 'ICON forecast hours must be unique ascending integers from 1 to 78');
  }
  const intervalHours = positiveInteger(raw.intervalHours, 'intervalHours');
  if (!intervalHours || intervalHours > 24) throw new IconAdapterError('hours', 'ICON intervalHours must be between 1 and 24');
  if (forecastHours.some((hour) => hour - intervalHours < 0)) throw new IconAdapterError('hours', 'ICON forecast frame precedes its interval basis');
  if (!object(raw.records)) throw new IconAdapterError('extract', 'ICON extract records are required');
  const records: Record<string, IconRecord> = {};
  for (const [key, value] of Object.entries(raw.records)) {
    const record = parseRecord(value);
    if (key !== recordKey(record.field, record.hour, record.level)) throw new IconAdapterError('extract', `ICON record key ${key} does not match its identity`);
    records[key] = record;
  }
  const referenceTime = text(raw.referenceTime, 'referenceTime');
  const grid = parseGrid(raw.grid);
  const provenance = parseProvenance(raw.provenance);
  const cycle = iconReferenceTime(referenceTime);
  const expected = new Date(cycle);
  for (const record of Object.values(records)) {
    const m = record.metadata;
    const valid = new Date(+expected + record.hour * 3_600_000);
    const date = (time: Date) => Number(time.toISOString().slice(0, 10).replaceAll('-', ''));
    if (!record.source || (record.source.sourceKind === 'fixture') !== provenance.sourceSynthetic) throw new IconAdapterError('extract', 'ICON source asset and synthetic provenance disagree');
    if (record.source.sourceKind === 'source' && record.source.url !== iconFieldUrl(record.field, cycle, record.hour, record.level)) throw new IconAdapterError('identity', `ICON ${record.field} source URL mismatch`);
    if (m.shortName !== ICON_SHORT_NAMES[record.field as keyof typeof ICON_SHORT_NAMES] || m.gridType !== 'unstructured_grid' || m.uuidOfHGrid !== grid.uuid || m.numberOfDataPoints !== grid.pointCount || m.numberOfGridUsed !== grid.number || m.dataDate !== date(expected) || m.dataTime !== expected.getUTCHours() * 100 || m.validityDate !== date(valid) || m.validityTime !== valid.getUTCHours() * 100 || m.endHour !== record.hour) {
      throw new IconAdapterError('identity', `ICON ${record.field} field, grid or time identity mismatch`);
    }
    if (record.level !== null && (m.typeOfFirstFixedSurface !== 150 || m.scaleFactorOfFirstFixedSurface !== 0 || m.scaledValueOfFirstFixedSurface !== record.level)) throw new IconAdapterError('identity', `ICON ${record.field} native level mismatch`);
    if (!ICON_STAT_FIELDS.includes(record.field) && (m.stepType !== 'instant' || m.startHour !== record.hour)) throw new IconAdapterError('identity', `ICON ${record.field} requires an instantaneous endpoint`);
  }
  if (provenance.sourceSynthetic && (raw.provenance as Record<string, unknown>).publicationReady !== false) throw new IconAdapterError('extract', 'Synthetic ICON fixture must be marked not publication ready');
  return {
    model: 'icon-eu',
    referenceTime: cycle,
    levels,
    forecastHours,
    intervalHours,
    bbox: validateIconBounds(raw.bbox as IconBounds),
    grid,
    cells: parseCells(raw.cells),
    records,
    provenance,
  };
}

export function iconReferenceTime(referenceTime: string): string {
  const time = new Date(referenceTime);
  if (!Number.isFinite(time.getTime()) || time.getUTCMinutes() || time.getUTCSeconds() || time.getUTCMilliseconds() || time.getUTCHours() % 6) {
    throw new IconAdapterError('cycle', 'ICON-EU requires an explicit 00, 06, 12 or 18 UTC main run');
  }
  return time.toISOString().replace('.000Z', 'Z');
}

export function iconFieldUrl(field: string, referenceTime: string, forecastHour: number, level: number | null = null): string {
  const run = iconReferenceTime(referenceTime);
  if (!/^[A-Z][A-Z0-9_]*$/.test(field) || !Number.isInteger(forecastHour) || forecastHour < 0 || forecastHour > 120 || (level !== null && (!Number.isInteger(level) || level < 1 || level > 75))) {
    throw new IconAdapterError('field-url', 'Invalid ICON field request');
  }
  return `${ICON_BASE}${field}${level === null ? '' : `/lvt1/150/lv1/${level}`}/r/${run.slice(0, 16).replace(':', '%3A')}/s/PT${String(forecastHour).padStart(3, '0')}H00M.grib2`;
}

export async function discoverIconArmeniaRun(options: DiscoverIconArmeniaRunOptions = {}): Promise<DiscoveredIconArmeniaRun> {
  options.signal?.throwIfAborted();
  const now = options.now ?? new Date();
  const fetchFn = options.fetchFn ?? fetch;
  const lastForecastHour = options.lastForecastHour ?? Math.max(...ICON_ARMENIA_FORECAST_HOURS);
  if (!Number.isInteger(lastForecastHour) || lastForecastHour < 1 || lastForecastHour > 78) throw new IconAdapterError('hours', 'ICON discovery horizon must be an integer from 1 to 78');
  const hours = options.forecastHours ? [...options.forecastHours] : ICON_ARMENIA_FORECAST_HOURS.filter((hour) => hour <= lastForecastHour);
  const intervalHours = options.intervalHours ?? ICON_ARMENIA_INTERVAL_HOURS;
  if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 24 || !hours.length || hours.some((hour, i) => !Number.isInteger(hour) || hour < intervalHours || hour > 78 || (i > 0 && hour <= hours[i - 1]))) throw new IconAdapterError('hours', 'Invalid ICON discovery hours or interval');
  const requestSignal = () => options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  const response = await fetchFn(`${ICON_BASE}HSURF/r/`, { signal: requestSignal() });
  if (!response.ok) throw new IconAdapterError('discovery', `ICON run inventory HTTP ${response.status}`);
  const body = await response.text();
  const candidates = [...body.matchAll(/href="(\d{4}-\d\d-\d\dT\d\d(?:%3A|:)00)\/"/gi)]
    .map((match) => `${decodeURIComponent(match[1])}:00Z`)
    .filter((run) => Number.isFinite(Date.parse(run)) && new Date(run).getUTCHours() % 6 === 0 && Date.parse(run) <= +now)
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  for (const referenceTime of candidates) {
    options.signal?.throwIfAborted();
    const urls = [
      ...['CLAT', 'CLON', 'HSURF'].map((field) => iconFieldUrl(field, referenceTime, 0)),
      ...ICON_HALF_LEVELS.map((level) => iconFieldUrl('HHL', referenceTime, 0, level)),
      ...hours.flatMap((hour) => ICON_SURFACE_FIELDS.map((field) => iconFieldUrl(field, referenceTime, hour))),
      ...[...new Set(hours.flatMap((hour) => hour > intervalHours ? [hour, hour - intervalHours] : [hour]))].flatMap((hour) => ICON_STAT_FIELDS.map((field) => iconFieldUrl(field, referenceTime, hour))),
      ...hours.flatMap((hour) => ICON_LEVELS.flatMap((level) => ICON_NATIVE_LEVEL_FIELDS.map((field) => iconFieldUrl(field, referenceTime, hour, level)))),
    ];
    let next = 0;
    let available = true;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (available && next < urls.length) {
        const url = urls[next++];
        try { if (!(await fetchFn(url, { method: 'HEAD', signal: requestSignal() })).ok) available = false; }
        catch { available = false; }
      }
    }));
    options.signal?.throwIfAborted();
    if (available) {
      return {
        referenceTime: iconReferenceTime(referenceTime),
        forecastHours: hours,
        completionUrls: urls,
        status: 'asset-heads-only',
        checkedAt: now.toISOString(),
      };
    }
  }
  throw new IconAdapterError('discovery', 'ICON-EU has no main run with all requested asset URLs available; keep the last published forecast');
}

function fieldRecord(extract: IconExtract, field: string, hour: number, level: number | null = null): IconRecord {
  const record = extract.records[recordKey(field, hour, level)];
  if (!record) throw new IconAdapterError('required-field', `ICON required field ${field} at hour ${hour}${level === null ? '' : ` level ${level}`} is unavailable`);
  return record;
}

function checkUnits(record: IconRecord, units: string, name: string): void {
  if (record.metadata.units !== units) throw new IconAdapterError('units', `ICON ${name} units ${record.metadata.units} are not ${units}`);
}

function scalar(record: IconRecord, index: number, missing: Uint8Array, name: string, min: number, max: number): number {
  const value = record.values[index];
  if (value === null) {
    missing[index] = 1;
    return Number.NaN;
  }
  if (!finite(value) || value < min || value > max) throw new IconAdapterError('range', `ICON ${name} value outside admitted range at cell position ${index}`);
  return value;
}

function isoHour(cycle: string, hour: number): string {
  return new Date(Date.parse(cycle) + hour * 3_600_000).toISOString().replace('.000Z', 'Z');
}

function interval(cycle: string, startHour: number, endHour: number): IconIntervalWindow {
  return {
    start: isoHour(cycle, startHour),
    end: isoHour(cycle, endHour),
    sourceStart: isoHour(cycle, 0),
    sourceEnd: isoHour(cycle, endHour),
  };
}

function normalizedFrame(extract: IconExtract, hour: number, levelHeightsM: Float32Array, expectedCellIndices: Uint32Array): IconArmeniaFrame {
  const startHour = hour - extract.intervalHours;
  const count = extract.cells.length;
  const levelCount = ICON_LEVELS.length;
  const temp2m = fieldRecord(extract, 'T_2M', hour);
  const dewPoint2m = fieldRecord(extract, 'TD_2M', hour);
  const pressure = fieldRecord(extract, 'PS', hour);
  const pbl = fieldRecord(extract, 'MH', hour);
  const sensibleCurrent = fieldRecord(extract, 'ASHFL_S', hour);
  const latentCurrent = fieldRecord(extract, 'ALHFL_S', hour);
  const precipitationCurrent = fieldRecord(extract, 'TOT_PREC', hour);
  const sensiblePrevious = startHour > 0 ? fieldRecord(extract, 'ASHFL_S', startHour) : undefined;
  const latentPrevious = startHour > 0 ? fieldRecord(extract, 'ALHFL_S', startHour) : undefined;
  const precipitationPrevious = startHour > 0 ? fieldRecord(extract, 'TOT_PREC', startHour) : undefined;
  for (const [record, units, name] of [
    [temp2m, ICON_UNITS.T_2M, 'T_2M'],
    [dewPoint2m, ICON_UNITS.TD_2M, 'TD_2M'],
    [pressure, ICON_UNITS.PS, 'PS'],
    [pbl, ICON_UNITS.MH, 'MH'],
  ] as const) checkUnits(record, units, name);
  const missing = {
    surface: new Uint8Array(count),
    temp2m: new Uint8Array(count),
    dewPoint2m: new Uint8Array(count),
    pbl: new Uint8Array(count),
    sensible: new Uint8Array(count),
    latent: new Uint8Array(count),
    precipitation: new Uint8Array(count),
    level: new Uint8Array(count * levelCount),
  };
  const terrainM = new Float32Array(count);
  const surfacePressurePa = new Float32Array(count);
  const temp2mK = new Float32Array(count);
  const dewPoint2mK = new Float32Array(count);
  const pblHeightM = new Float32Array(count);
  const sensibleHeatFluxWm2 = new Float32Array(count);
  const latentHeatFluxWm2 = new Float32Array(count);
  const precipitationMmPerHour = new Float32Array(count);
  const levelPressurePa = new Float32Array(count * levelCount);
  const levelTemperatureK = new Float32Array(count * levelCount);
  for (let position = 0; position < count; position++) {
    const cell = extract.cells[position];
    terrainM[position] = cell.terrainM;
    const temperature = scalar(temp2m, position, missing.temp2m, 'T_2M', 150, 350);
    const dewPoint = scalar(dewPoint2m, position, missing.dewPoint2m, 'TD_2M', 100, 350);
    temp2mK[position] = temperature;
    dewPoint2mK[position] = dewPoint;
    if (Number.isFinite(temperature) && Number.isFinite(dewPoint) && dewPoint > temperature + 0.05) {
      throw new IconAdapterError('dewpoint', `ICON TD_2M exceeds T_2M at native cell ${cell.index}`);
    }
    const surface = pressure.values[position];
    if (surface === null) missing.surface[position] = 1;
    else if (!finite(surface) || surface <= 1000 || surface > 120_000) throw new IconAdapterError('range', `ICON PS value outside admitted range at native cell ${cell.index}`);
    else surfacePressurePa[position] = surface;
    const pblValue = pbl.values[position];
    if (pblValue === null) missing.pbl[position] = 1;
    else if (!finite(pblValue) || pblValue < 0 || pblValue > 25_000) throw new IconAdapterError('range', `ICON MH value outside admitted range at native cell ${cell.index}`);
    else if (pblValue === 0) missing.pbl[position] = 1;
    else pblHeightM[position] = pblValue;
    const sensible = iconWindowMeanUpwardFlux(sensibleCurrent, sensiblePrevious, startHour, hour, position);
    if (sensible === null) missing.sensible[position] = 1; else sensibleHeatFluxWm2[position] = sensible;
    const latent = iconWindowMeanUpwardFlux(latentCurrent, latentPrevious, startHour, hour, position);
    if (latent === null) missing.latent[position] = 1; else latentHeatFluxWm2[position] = latent;
    const rain = iconWindowPrecipitationRate(precipitationCurrent, precipitationPrevious, startHour, hour, position);
    if (rain === null) missing.precipitation[position] = 1; else precipitationMmPerHour[position] = rain.mmPerHour;
    for (let k = 0; k < levelCount; k++) {
      const level = ICON_LEVEL_NUMBERS_ASCENDING[k];
      const temperatureRecord = fieldRecord(extract, 'T', hour, level);
      const pressureRecord = fieldRecord(extract, 'P', hour, level);
      checkUnits(temperatureRecord, ICON_UNITS.T, 'T');
      checkUnits(pressureRecord, ICON_UNITS.P, 'P');
      const flat = position * levelCount + k;
      const levelTemperature = temperatureRecord.values[position];
      const levelPressure = pressureRecord.values[position];
      if (levelTemperature === null || levelPressure === null) {
        missing.level[flat] = 1;
        levelTemperatureK[flat] = Number.NaN;
        levelPressurePa[flat] = Number.NaN;
        continue;
      }
      if (!finite(levelTemperature) || levelTemperature < 150 || levelTemperature > 350) throw new IconAdapterError('range', `ICON T outside admitted range at native cell ${cell.index} level ${level}`);
      if (!finite(levelPressure) || levelPressure <= 0 || levelPressure > 120_000) throw new IconAdapterError('range', `ICON P outside admitted range at native cell ${cell.index} level ${level}`);
      levelTemperatureK[flat] = levelTemperature;
      levelPressurePa[flat] = levelPressure;
    }
  }
  const used = [
    temp2m, dewPoint2m, pressure, pbl, sensibleCurrent, latentCurrent, precipitationCurrent,
    ...(sensiblePrevious ? [sensiblePrevious] : []),
    ...(latentPrevious ? [latentPrevious] : []),
    ...(precipitationPrevious ? [precipitationPrevious] : []),
    ...ICON_LEVEL_NUMBERS_ASCENDING.flatMap((level) => [fieldRecord(extract, 'T', hour, level), fieldRecord(extract, 'P', hour, level)]),
  ];
  const receiptFields = used.map((record) => ({
    field: record.field,
    hour: record.hour,
    level: record.level,
    units: record.metadata.units,
    stepType: record.metadata.stepType,
    startHour: record.metadata.startHour,
    endHour: record.metadata.endHour,
    asset: record.source ?? null,
  }));
  return {
    schemaVersion: 1,
    hour,
    validAt: isoHour(extract.referenceTime, hour),
    capturedAt: extract.provenance.capturedAt,
    cellIndices: expectedCellIndices,
    terrainM,
    surfacePressurePa,
    temp2mK,
    dewPoint2mK,
    pblHeightM,
    sensibleHeatFluxWm2,
    latentHeatFluxWm2,
    precipitationMmPerHour,
    levelPressurePa,
    levelTemperatureK,
    missing,
    intervals: {
      flux: interval(extract.referenceTime, startHour, hour),
      precipitation: interval(extract.referenceTime, startHour, hour),
    },
    receipt: { sourceSynthetic: extract.provenance.sourceSynthetic, publicationReady: false, fields: receiptFields },
  };
}

export function normalizeIconExtract(raw: unknown): IconArmeniaAcquisition {
  const extract = parseExtract(raw);
  if (extract.grid.pointCount < extract.cells.length) throw new IconAdapterError('geometry', 'ICON native cell count exceeds the source point count');
  const cells = extract.cells;
  if (cells.some((cell, index) => index > 0 && cell.index <= cells[index - 1].index)) {
    throw new IconAdapterError('geometry-index', 'ICON native cells must be ordered by ascending source index');
  }
  const sorted: IconExtract = extract;
  const native = buildIconNativeGeometry(sorted);
  const mapping = buildIconExportMapping(native.cells, ICON_ARMENIA_EXPORT_GRID);
  const cellIndices = Uint32Array.from(native.cells.map((cell) => cell.index));
  const frames = sorted.forecastHours.map((hour) => normalizedFrame(sorted, hour, native.levelHeightsM, cellIndices));
  const allFields: IconArmeniaAcquisition['receipt']['fields'][number][] = [];
  const seen = new Set<string>();
  for (const [key, record] of Object.entries(sorted.records)) {
    if (seen.has(key)) continue;
    seen.add(key);
    allFields.push({
      field: record.field,
      hour: record.hour,
      level: record.level,
      units: record.metadata.units,
      stepType: record.metadata.stepType,
      startHour: record.metadata.startHour,
      endHour: record.metadata.endHour,
      asset: record.source ?? null,
    });
  }
  const receipt: IconArmeniaAcquisition['receipt'] = {
    schemaVersion: 1,
    model: 'icon-armenia',
    cycle: sorted.referenceTime,
    capturedAt: sorted.provenance.capturedAt,
    bbox: sorted.bbox,
    native: {
      type: 'icon-native-triangular',
      uuid: sorted.grid.uuid,
      number: sorted.grid.number,
      pointCount: sorted.grid.pointCount,
      selectedCount: native.cells.length,
      spacingDegEstimate: native.spacingDegEstimate,
      levelCount: ICON_LEVELS.length,
      levelNumbers: ICON_LEVEL_NUMBERS_ASCENDING,
    },
    export: {
      width: ICON_ARMENIA_EXPORT_GRID.width,
      height: ICON_ARMENIA_EXPORT_GRID.height,
      dx: ICON_ARMENIA_EXPORT_GRID.dx,
      dy: ICON_ARMENIA_EXPORT_GRID.dy,
      cellCount: ICON_ARMENIA_EXPORT_GRID.width * ICON_ARMENIA_EXPORT_GRID.height,
      activeCount: mapping.activeIndices.length,
      spacingDeg: Math.min(Math.abs(ICON_ARMENIA_EXPORT_GRID.dx), Math.abs(ICON_ARMENIA_EXPORT_GRID.dy)),
    },
    mapping: {
      policy: mapping.policy,
      maxDistanceDeg: mapping.maxDistanceDeg,
      distanceP95Deg: mapping.distanceP95Deg,
      spacingRatio: mapping.exportSpacingDeg / mapping.nativeSpacingDeg,
    },
    fields: allFields,
    provenance: sorted.provenance,
    attribution: sorted.provenance.sourceSynthetic
      ? { ...ICON_ATTRIBUTION, data: { provider: 'synthetic fixture', product: 'ICON-EU fixture', access: 'fixture://icon/', attribution: 'Synthetic test data' } }
      : ICON_ATTRIBUTION,
    gating: {
      regionalPublication: 'gated',
      publicationReady: false,
      reason: 'No static icon-armenia export coverage mask is present; live regional publication is gated and GFS mask indices are never applied to this export grid.',
    },
  };
  const nativeGeometry: IconArmeniaAcquisition['native'] = {
    type: 'icon-native-triangular',
    uuid: sorted.grid.uuid,
    number: sorted.grid.number,
    pointCount: sorted.grid.pointCount,
    selectedCount: native.cells.length,
    spacingDegEstimate: native.spacingDegEstimate,
    levelCount: ICON_LEVELS.length,
    levelNumbers: ICON_LEVEL_NUMBERS_ASCENDING,
    levelHeightsM: native.levelHeightsM,
    cells: native.cells,
  };
  return {
    schemaVersion: 1,
    model: 'icon-armenia',
    cycle: sorted.referenceTime,
    capturedAt: sorted.provenance.capturedAt,
    bbox: sorted.bbox,
    forecastHours: sorted.forecastHours,
    intervalHours: sorted.intervalHours,
    native: nativeGeometry,
    frames,
    mapping,
    receipt,
  };
}

async function runDecoder(options: AcquireIconArmeniaOptions, referenceTime: string, forecastHours: readonly number[], intervalHours: number, bbox: IconBounds, output: string): Promise<void> {
  const temporary = mkdtempSync(join(tmpdir(), 'av-icon-'));
  const request = join(temporary, 'request.json');
  mkdirSync(resolve(options.cacheDir), { recursive: true });
  writeFileSync(request, JSON.stringify({
    referenceTime,
    forecastHours,
    intervalHours,
    bbox,
    cacheDir: resolve(options.cacheDir),
    output,
    concurrency: options.concurrency ?? 8,
    maxDownloadBytes: options.maxDownloadBytes ?? 16_000_000_000,
    levels: ICON_LEVELS,
    halfLevels: ICON_HALF_LEVELS,
  }));
  const log = options.log ?? (() => undefined);
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const python = options.python ?? process.env.ICON_PYTHON ?? 'python3';
      const child = spawn(python, [fileURLToPath(new URL('./icon-decode.py', import.meta.url)), request], { stdio: ['ignore', 'pipe', 'pipe'] });
      const abort = () => child.kill('SIGTERM');
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      let errors = '';
      child.stdout.on('data', (chunk: Buffer) => log(chunk.toString().trim()));
      child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); log(chunk.toString().trim()); });
      child.on('error', (error) => { options.signal?.removeEventListener('abort', abort); reject(error); });
      child.on('close', (code) => {
        options.signal?.removeEventListener('abort', abort);
        if (options.signal?.aborted) reject(options.signal.reason);
        else if (code === 0) resolvePromise();
        else reject(new IconAdapterError('decoder', errors.trim() || `ICON decoder exit ${code}`));
      });
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function acquireIconArmenia(options: AcquireIconArmeniaOptions): Promise<IconArmeniaAcquisition> {
  options.signal?.throwIfAborted();
  if (!options.cacheDir) throw new IconAdapterError('cache', 'ICON cacheDir is required');
  const forecastHours = options.forecastHours ? [...options.forecastHours] : [...ICON_ARMENIA_FORECAST_HOURS];
  if (!forecastHours.length || forecastHours.some((hour, index) => !Number.isInteger(hour) || hour < 1 || hour > 78 || (index > 0 && hour <= forecastHours[index - 1]))) {
    throw new IconAdapterError('hours', 'ICON forecast hours must be unique ascending integers from 1 to 78');
  }
  const intervalHours = options.intervalHours ?? ICON_ARMENIA_INTERVAL_HOURS;
  if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 24) throw new IconAdapterError('hours', 'ICON intervalHours must be between 1 and 24');
  if (forecastHours.some((hour) => hour - intervalHours < 0)) throw new IconAdapterError('hours', 'ICON forecast frame precedes its interval basis');
  const referenceTime = options.referenceTime
    ? iconReferenceTime(options.referenceTime)
    : (await discoverIconArmeniaRun({ forecastHours, intervalHours, signal: options.signal })).referenceTime;
  const bbox = validateIconBounds(options.bbox ?? ICON_ARMENIA_BBOX);
  const temporary = mkdtempSync(join(tmpdir(), 'av-icon-extract-'));
  const output = options.extractPath ? resolve(options.extractPath) : join(temporary, 'icon-extract.json');
  mkdirSync(dirname(output), { recursive: true });
  try {
    await runDecoder(options, referenceTime, forecastHours, intervalHours, bbox, output);
    const raw: unknown = JSON.parse(readFileSync(output, 'utf8'));
    if (!object(raw)) throw new IconAdapterError('extract', `ICON decoder output ${basename(output)} is not an object`);
    return normalizeIconExtract(raw);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
