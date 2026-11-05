import type { IndexedSource } from './source.js';
import { sourceCycle, sourceUrl } from '../source.js';
import { IndexedGribError } from './errors.ts';
import { indexedGribWindowStart } from './intervals.ts';
import type { IndexedGribFieldSpec } from './types.ts';


export function indexedGribFirstFixedSurface(level: string): readonly [number, number] {
  if (level === 'surface') return [1, 0];
  if (level === '2 m above ground') return [103, 2];
  const pressure = /^(\d+) mb$/.exec(level);
  if (pressure) return [100, Number(pressure[1]) * 100];
  throw new Error(`Unsupported Indexed GRIB fixed surface: ${level}`);
}

export function validateCycle(source: IndexedSource, cycle: string): string {
  try { return sourceCycle(cycle, source.model.forecast.cycleHoursUtc).replace('.000Z', 'Z'); }
  catch { throw new IndexedGribError('invalid-option', 'Cycle must identify a configured source run', { cycle }); }
}

export function cycleStamp(cycle: string): string {
  return cycle.slice(0, 13).replace(/[-T:]/g, '');
}

export function indexedGribFileUrl(source: IndexedSource,
  cycle: string,
  hour: number,
  productName: string,
): string {
  return sourceUrl(source.upstream.urlTemplate, { date: cycle.slice(0, 10).replaceAll('-', ''),
    cycleHour: cycle.slice(11, 13), product: productName, hour: String(hour).padStart(3, '0') });
}

export function indexedGribProductName(source: IndexedSource, product: IndexedGribFieldSpec['product']): string {
  return source.upstream.products[product];
}

function instant(
  key: string,
  kind: IndexedGribFieldSpec['kind'],
  variable: string,
  level: string,
  product: IndexedGribFieldSpec['product'],
  hour: number,
  levelHpa?: number,
): IndexedGribFieldSpec {
  return {
    key,
    kind,
    variable,
    level,
    product,
    forecast: `${hour} hour fcst`,
    statistic: 'instant',
    ...(levelHpa === undefined ? {} : { levelHpa }),
  };
}

function window(
  key: string,
  kind: IndexedGribFieldSpec['kind'],
  variable: string,
  level: string,
  product: IndexedGribFieldSpec['product'],
  startHour: number,
  endHour: number,
  statistic: 'mean' | 'accumulation',
  role: 'current' | 'companion',
): IndexedGribFieldSpec {
  return {
    key,
    kind,
    variable,
    level,
    product,
    forecast: `${startHour}-${endHour} hour ${statistic === 'mean' ? 'ave' : 'acc'} fcst`,
    statistic,
    role,
  };
}

export function indexedGribSurfaceSpecs(source: IndexedSource, hour: number): IndexedGribFieldSpec[] {
  return [
    instant('terrain', 'terrain', ...source.fields.terrain, source.upstream.surfaceProduct, hour),
    instant('surfacePressure', 'surface-pressure', ...source.fields.surfacePressure, source.upstream.surfaceProduct, hour),
    instant('temp2m', 'temp-2m', ...source.fields.temp2m, source.upstream.surfaceProduct, hour),
    instant('spfh2m', 'spfh-2m', ...source.fields.spfh2m, source.upstream.surfaceProduct, hour),
    window('sensibleHeatFlux', 'sensible-flux', ...source.fields.sensibleHeatFlux, source.upstream.surfaceProduct, indexedGribWindowStart(source, hour), hour, 'mean', 'current'),
    window('latentHeatFlux', 'latent-flux', ...source.fields.latentHeatFlux, source.upstream.surfaceProduct, indexedGribWindowStart(source, hour), hour, 'mean', 'current'),
    window('precipitation', 'precipitation', ...source.fields.precipitation, source.upstream.surfaceProduct, indexedGribWindowStart(source, hour), hour, 'accumulation', 'current'),
  ];
}

export function indexedGribPressureSpecs(source: IndexedSource, hour: number): IndexedGribFieldSpec[] {
  return source.pressureLevels.flatMap((levelHpa) => {
    const product = source.levelProducts.get(levelHpa)!;
    const level = `${levelHpa} mb`;
    return [
      instant(`${levelHpa}.hgt`, 'height', source.fields.height[0], level, product, hour, levelHpa),
      instant(`${levelHpa}.tmp`, 'temperature', source.fields.temperature[0], level, product, hour, levelHpa),
    ];
  });
}

export function indexedGribCurrentSpecs(source: IndexedSource, hour: number): IndexedGribFieldSpec[] {
  return [...indexedGribSurfaceSpecs(source, hour), ...indexedGribPressureSpecs(source, hour)];
}

export function indexedGribCompanionSpecs(source: IndexedSource, hour: number): IndexedGribFieldSpec[] {
  const start = indexedGribWindowStart(source, hour);
  const end = hour - source.model.forecast.intervalHours;
  if (start === end) return [];
  return [
    window('sensibleHeatFlux', 'sensible-flux', ...source.fields.sensibleHeatFlux, source.upstream.surfaceProduct, start, end, 'mean', 'companion'),
    window('latentHeatFlux', 'latent-flux', ...source.fields.latentHeatFlux, source.upstream.surfaceProduct, start, end, 'mean', 'companion'),
    window('precipitation', 'precipitation', ...source.fields.precipitation, source.upstream.surfaceProduct, start, end, 'accumulation', 'companion'),
  ];
}

export function indexedGribWindowNeedsCompanion(source: IndexedSource, hour: number): boolean {
  return indexedGribWindowStart(source, hour) !== hour - source.model.forecast.intervalHours;
}
