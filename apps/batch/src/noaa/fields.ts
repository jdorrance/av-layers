import {
  GFS_PRESSURE_LEVELS_HPA,
  GFS_PRIMARY_LEVELS_HPA,
  GFS_SECONDARY_LEVELS_HPA,
  GFS_PRODUCTS,
  NOAA_GFS_BASE_URL,
} from './constants.ts';
import { gfsWindowStart } from './intervals.ts';
import type { GfsFieldSpec } from './types.ts';

export const GFS_PARAMETERS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  HGT: [3, 5],
  PRES: [3, 0],
  TMP: [0, 0],
  SPFH: [1, 0],
  HPBL: [3, 196],
  SHTFL: [0, 11],
  LHTFL: [0, 10],
  APCP: [1, 8],
});

export function gfsFirstFixedSurface(level: string): readonly [number, number] {
  if (level === 'surface') return [1, 0];
  if (level === '2 m above ground') return [103, 2];
  const pressure = /^(\d+) mb$/.exec(level);
  if (pressure) return [100, Number(pressure[1]) * 100];
  throw new Error(`Unsupported GFS fixed surface: ${level}`);
}

export function cycleStamp(cycle: string): string {
  return cycle.slice(0, 13).replace(/[-T:]/g, '');
}

export function gfsFileUrl(
  cycle: string,
  hour: number,
  productName: 'pgrb2.0p25' | 'pgrb2b.0p25',
): string {
  const date = cycle.slice(0, 10).replaceAll('-', '');
  const cycleHour = cycle.slice(11, 13);
  return `${NOAA_GFS_BASE_URL}/gfs.${date}/${cycleHour}/atmos/gfs.t${cycleHour}z.${productName}.f${String(hour).padStart(3, '0')}`;
}

export function gfsProductName(product: GfsFieldSpec['product']): 'pgrb2.0p25' | 'pgrb2b.0p25' {
  return GFS_PRODUCTS[product];
}

function instant(
  key: string,
  kind: GfsFieldSpec['kind'],
  variable: string,
  level: string,
  product: GfsFieldSpec['product'],
  hour: number,
  levelHpa?: number,
): GfsFieldSpec {
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
  kind: GfsFieldSpec['kind'],
  variable: string,
  level: string,
  product: GfsFieldSpec['product'],
  startHour: number,
  endHour: number,
  statistic: 'mean' | 'accumulation',
  role: 'current' | 'companion',
): GfsFieldSpec {
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

export function gfsSurfaceSpecs(hour: number): GfsFieldSpec[] {
  return [
    instant('terrain', 'terrain', 'HGT', 'surface', 'primary', hour),
    instant('surfacePressure', 'surface-pressure', 'PRES', 'surface', 'primary', hour),
    instant('temp2m', 'temp-2m', 'TMP', '2 m above ground', 'primary', hour),
    instant('spfh2m', 'spfh-2m', 'SPFH', '2 m above ground', 'primary', hour),
    instant('pbl', 'pbl', 'HPBL', 'surface', 'primary', hour),
    window('sensibleHeatFlux', 'sensible-flux', 'SHTFL', 'surface', 'primary', gfsWindowStart(hour), hour, 'mean', 'current'),
    window('latentHeatFlux', 'latent-flux', 'LHTFL', 'surface', 'primary', gfsWindowStart(hour), hour, 'mean', 'current'),
    window('precipitation', 'precipitation', 'APCP', 'surface', 'primary', gfsWindowStart(hour), hour, 'accumulation', 'current'),
  ];
}

export function gfsPressureSpecs(hour: number): GfsFieldSpec[] {
  const primary = new Set<number>(GFS_PRIMARY_LEVELS_HPA);
  const secondary = new Set<number>(GFS_SECONDARY_LEVELS_HPA);
  return GFS_PRESSURE_LEVELS_HPA.flatMap((levelHpa) => {
    const product: GfsFieldSpec['product'] = primary.has(levelHpa)
      ? 'primary'
      : secondary.has(levelHpa)
        ? 'secondary'
        : (() => {
            throw new Error(`Unrouted GFS pressure level ${levelHpa}`);
          })();
    const level = `${levelHpa} mb`;
    return [
      instant(`${levelHpa}.hgt`, 'height', 'HGT', level, product, hour, levelHpa),
      instant(`${levelHpa}.tmp`, 'temperature', 'TMP', level, product, hour, levelHpa),
    ];
  });
}

export function gfsCurrentSpecs(hour: number): GfsFieldSpec[] {
  return [...gfsSurfaceSpecs(hour), ...gfsPressureSpecs(hour)];
}

export function gfsCompanionSpecs(hour: number): GfsFieldSpec[] {
  const start = gfsWindowStart(hour);
  const end = hour - 3;
  if (start === end) return [];
  return [
    window('sensibleHeatFlux', 'sensible-flux', 'SHTFL', 'surface', 'primary', start, end, 'mean', 'companion'),
    window('latentHeatFlux', 'latent-flux', 'LHTFL', 'surface', 'primary', start, end, 'mean', 'companion'),
    window('precipitation', 'precipitation', 'APCP', 'surface', 'primary', start, end, 'accumulation', 'companion'),
  ];
}

export function gfsWindowNeedsCompanion(hour: number): boolean {
  return gfsWindowStart(hour) !== hour - 3;
}
