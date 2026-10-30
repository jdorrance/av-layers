import { HRRR_BASE_URL, HRRR_MAX_DISCOVERY_HOUR, HRRR_MIN_FORECAST_HOUR, HRRR_PRESSURE_LEVELS_HPA, HRRR_PRODUCT_NAMES } from './constants.ts';
import { validAt } from '../noaa/intervals.ts';
import type { HrrrFieldKind, HrrrFieldSpec, HrrrProduct, HrrrFrameIntervals } from './types.ts';

export const HRRR_PARAMETERS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  HGT: [3, 5],
  PRES: [3, 0],
  TMP: [0, 0],
  DPT: [0, 6],
  HPBL: [3, 18],
  SHTFL: [0, 11],
  LHTFL: [0, 10],
  APCP: [1, 8],
});

export function hrrrCycleStamp(cycle: string): string {
  return cycle.slice(0, 13).replace(/[-T:]/g, '');
}

export function hrrrFileUrl(cycle: string, hour: number, product: HrrrProduct): string {
  const date = cycle.slice(0, 10).replaceAll('-', '');
  const cycleHour = cycle.slice(11, 13);
  return `${HRRR_BASE_URL}/hrrr.${date}/conus/hrrr.t${cycleHour}z.${HRRR_PRODUCT_NAMES[product]}f${String(hour).padStart(2, '0')}.grib2`;
}

export function hrrrIndexUrl(cycle: string, hour: number, product: HrrrProduct): string {
  return `${hrrrFileUrl(cycle, hour, product)}.idx`;
}

export function hrrrInstantForecastLabel(hour: number): string {
  return hour === 0 ? 'anl' : `${hour} hour fcst`;
}

export function hrrrPrecipitationForecastLabel(hour: number): string {
  if (!Number.isInteger(hour) || hour < HRRR_MIN_FORECAST_HOUR || hour > HRRR_MAX_DISCOVERY_HOUR) {
    throw new Error(`HRRR precipitation requires an integer forecast hour ${HRRR_MIN_FORECAST_HOUR}..${HRRR_MAX_DISCOVERY_HOUR}`);
  }
  return hour === 1 ? '0-1 hour acc fcst' : `${hour - 1}-${hour} hour acc fcst`;
}

export function hrrrFirstFixedSurface(level: string): readonly [number, number] {
  if (level === 'surface') return [1, 0];
  if (level === '2 m above ground') return [103, 2];
  const pressure = /^(\d+) mb$/.exec(level);
  if (pressure) return [100, Number(pressure[1]) * 100];
  throw new Error(`Unsupported HRRR fixed surface: ${level}`);
}

function spec(
  key: string,
  kind: HrrrFieldKind,
  product: HrrrProduct,
  variable: string,
  level: string,
  hour: number,
  statistic: HrrrFieldSpec['statistic'],
  unit: string,
  conversion: string,
  levelHpa?: number,
): HrrrFieldSpec {
  return {
    key,
    kind,
    product,
    variable,
    level,
    ...(levelHpa === undefined ? {} : { levelHpa }),
    forecast: statistic === 'instant' ? hrrrInstantForecastLabel(hour) : hrrrPrecipitationForecastLabel(hour),
    statistic,
    unit,
    conversion,
  };
}

export function hrrrSurfaceSpecs(hour: number): HrrrFieldSpec[] {
  if (!Number.isInteger(hour) || hour < HRRR_MIN_FORECAST_HOUR) {
    throw new Error('HRRR minimal acquisition starts at f001; f000 has no positive precipitation interval');
  }
  return [
    spec('terrain', 'terrain', 'surface', 'HGT', 'surface', hour, 'instant', 'm', 'identity'),
    spec('surfacePressure', 'surface-pressure', 'surface', 'PRES', 'surface', hour, 'instant', 'Pa', 'identity'),
    spec('temp2m', 'temp-2m', 'surface', 'TMP', '2 m above ground', hour, 'instant', 'K', 'identity'),
    spec('dewPoint2m', 'dewpoint-2m', 'surface', 'DPT', '2 m above ground', hour, 'instant', 'K', 'identity'),
    spec('pbl', 'pbl', 'surface', 'HPBL', 'surface', hour, 'instant', 'm', 'identity'),
    spec('sensibleHeatFlux', 'sensible-flux', 'surface', 'SHTFL', 'surface', hour, 'instant', 'W/m2', 'instantaneous surface flux at valid time'),
    spec('latentHeatFlux', 'latent-flux', 'surface', 'LHTFL', 'surface', hour, 'instant', 'W/m2', 'instantaneous surface flux at valid time'),
    spec('precipitation', 'precipitation', 'surface', 'APCP', 'surface', hour, 'accumulation', 'kg/m2', 'one-hour accumulation kg/m2 equals mm/h'),
  ];
}

export function hrrrPressureSpecs(hour: number): HrrrFieldSpec[] {
  if (!Number.isInteger(hour) || hour < HRRR_MIN_FORECAST_HOUR) {
    throw new Error('HRRR minimal acquisition starts at f001; f000 has no positive precipitation interval');
  }
  return HRRR_PRESSURE_LEVELS_HPA.flatMap((levelHpa) => {
    const level = `${levelHpa} mb`;
    return [
      spec(`${levelHpa}.hgt`, 'height', 'pressure', 'HGT', level, hour, 'instant', 'm', 'identity', levelHpa),
      spec(`${levelHpa}.tmp`, 'temperature', 'pressure', 'TMP', level, hour, 'instant', 'K', 'identity', levelHpa),
    ];
  });
}

export function hrrrFieldSpecs(hour: number, product?: HrrrProduct): HrrrFieldSpec[] {
  const surface = hrrrSurfaceSpecs(hour), pressure = hrrrPressureSpecs(hour);
  if (product === 'surface') return surface;
  if (product === 'pressure') return pressure;
  return [...surface, ...pressure];
}

export function hrrrFrameIntervals(cycle: string, hour: number): HrrrFrameIntervals {
  const end = validAt(cycle, hour);
  return {
    profileTime: end,
    flux: { kind: 'instant', validAt: end },
    precipitation: {
      kind: 'window',
      start: validAt(cycle, hour - 1),
      end,
      durationHours: 1,
      sourceLabel: hrrrPrecipitationForecastLabel(hour),
    },
  };
}
