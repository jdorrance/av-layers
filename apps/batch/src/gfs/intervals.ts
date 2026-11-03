import { recoverTrailingWindow as recoverInterval, type CompactTrailingWindowInput, type CompactTrailingWindowResult } from '@av/forecast/intervals';
import { parseProduct, type Identification } from '@azohra/meteo.grib';
import { GFS_INTERVAL_HOURS, GFS_STATISTICS_RESET_HOURS } from './constants.ts';
import { NoaaError } from './errors.ts';
import type { DecodedFieldReceipt, NoaaIntervalReceipt } from './types.ts';

export const HOUR_MS = 3_600_000;

export function validAt(referenceTime: string, hour: number): string {
  return new Date(Date.parse(referenceTime) + hour * HOUR_MS).toISOString().replace('.000Z', 'Z');
}

export function gfsWindowStart(hour: number): number {
  return Math.floor((hour - GFS_INTERVAL_HOURS) / GFS_STATISTICS_RESET_HOURS) * GFS_STATISTICS_RESET_HOURS;
}

export interface NoaaStatRange {
  process: number;
  incrementType: number;
  rangeUnit: number;
  rangeLength: number;
  incrementUnit: number;
  increment: number;
}

export type NoaaInterval =
  | { kind: 'instant'; start: string; end: string }
  | {
      kind: 'window';
      start: string;
      end: string;
      process: 0 | 1;
      missingCount: number;
      ranges: readonly [NoaaStatRange];
    };

function refuse(message: string, details?: Record<string, unknown>): never {
  throw new NoaaError('source-conflict', message, details);
}

export function readNoaaStatisticalInterval(section4: Uint8Array, id: Identification): NoaaInterval {
  if (id.significanceOfReferenceTime !== 1) refuse('NOAA reference-time meaning refused');
  const product = parseProduct(section4);
  const view = new DataView(section4.buffer, section4.byteOffset, section4.byteLength);
  if (product.numberOfCoordinateValues !== 0 || product.typeOfSecondFixedSurface !== undefined) {
    refuse('NOAA coordinate/layer metadata refused');
  }
  if (
    product.typeOfGeneratingProcess !== 2 ||
    product.indicatorOfUnitOfTimeRange !== 1 ||
    !Number.isSafeInteger(product.forecastTime) ||
    product.forecastTime === undefined ||
    product.forecastTime < 0
  ) {
    refuse('NOAA generating process or forecast-time encoding refused');
  }
  const reference = Date.UTC(id.year, id.month - 1, id.day, id.hour, id.minute, id.second);
  const start = new Date(reference + product.forecastTime * HOUR_MS).toISOString();
  if (product.productDefinitionTemplateNumber === 0) {
    if (section4.length !== 34) refuse('NOAA instantaneous PDT 4.0 layout refused');
    return { kind: 'instant', start, end: start };
  }
  if (product.productDefinitionTemplateNumber !== 8 || section4.length !== 58 || section4[41] !== 1) {
    refuse('NOAA statistical PDT 4.8 layout/ranges refused');
  }
  const parts = [
    view.getUint16(34),
    section4[36]!,
    section4[37]!,
    section4[38]!,
    section4[39]!,
    section4[40]!,
  ];
  const end = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
  if (
    parts[0] !== end.getUTCFullYear() ||
    parts[1] !== end.getUTCMonth() + 1 ||
    parts[2] !== end.getUTCDate() ||
    parts[3] !== end.getUTCHours() ||
    parts[4] !== end.getUTCMinutes() ||
    parts[5] !== end.getUTCSeconds()
  ) {
    refuse('NOAA statistical interval date refused');
  }
  const range: NoaaStatRange = {
    process: section4[46]!,
    incrementType: section4[47]!,
    rangeUnit: section4[48]!,
    rangeLength: view.getUint32(49),
    incrementUnit: section4[53]!,
    increment: view.getUint32(54),
  };
  if (
    ![0, 1].includes(range.process) ||
    range.incrementType !== 2 ||
    range.rangeUnit !== 1 ||
    !Number.isInteger(range.rangeLength) ||
    range.rangeLength <= 0
  ) {
    refuse('NOAA statistical interval semantics refused', { range });
  }
  if (range.increment !== 0 || ![1, 255].includes(range.incrementUnit)) {
    refuse('NOAA discrete statistical increment refused; continuous increment 0 required', { range });
  }
  if (Date.parse(end.toISOString()) - Date.parse(start) !== range.rangeLength * HOUR_MS) {
    refuse('NOAA statistical endpoints and range length differ', { start, end: end.toISOString(), range });
  }
  return {
    kind: 'window',
    start,
    end: end.toISOString(),
    process: range.process as 0 | 1,
    missingCount: view.getUint32(42),
    ranges: [range],
  };
}

export function receiptInterval(interval: NoaaInterval): NoaaIntervalReceipt {
  return interval.kind === 'instant'
    ? { kind: 'instant', start: interval.start, end: interval.end }
    : {
        kind: 'window',
        start: interval.start,
        end: interval.end,
        process: interval.process,
        missingCount: interval.missingCount,
        ranges: interval.ranges,
      };
}

function sameExceptRangeLength(a: NoaaStatRange, b: NoaaStatRange): boolean {
  return (
    a.process === b.process &&
    a.incrementType === b.incrementType &&
    a.rangeUnit === b.rangeUnit &&
    a.incrementUnit === b.incrementUnit &&
    a.increment === b.increment
  );
}

export interface AdmittedWindowPair {
  currentHours: number;
  previousHours: number;
  start: string;
  end: string;
}

export function admitNoaaWindowPair(
  current: DecodedFieldReceipt,
  companion: DecodedFieldReceipt,
): AdmittedWindowPair {
  const a = current.interval;
  const b = companion.interval;
  if (
    a.kind !== 'window' ||
    b.kind !== 'window' ||
    a.process !== b.process ||
    a.missingCount !== 0 ||
    b.missingCount !== 0
  ) {
    refuse('NOAA window pair has incomplete or different statistics', {
      current: a,
      companion: b,
    });
  }
  if (
    current.key !== companion.key ||
    current.variable !== companion.variable ||
    current.level !== companion.level ||
    current.unit !== companion.unit ||
    current.grid.gridKey !== companion.grid.gridKey ||
    current.productMetadata.typeOfGeneratingProcess !== companion.productMetadata.typeOfGeneratingProcess
  ) {
    refuse('NOAA window pair source conflict');
  }
  const idKeys = [
    'centre',
    'subCentre',
    'significanceOfReferenceTime',
    'year',
    'month',
    'day',
    'hour',
    'minute',
    'second',
  ] as const;
  if (idKeys.some((key) => current.identification[key] !== companion.identification[key])) {
    refuse('NOAA window pair initialization conflict');
  }
  if (a.start !== b.start || Date.parse(a.end) - Date.parse(b.end) !== GFS_INTERVAL_HOURS * HOUR_MS) {
    refuse(`NOAA window pair does not bound one trailing ${GFS_INTERVAL_HOURS}-hour interval`, {
      current: a,
      companion: b,
    });
  }
  const currentRange = a.ranges?.[0];
  const previousRange = b.ranges?.[0];
  if (!currentRange || !previousRange) {
    refuse('NOAA window pair lacks statistical range descriptors');
  }
  if (!sameExceptRangeLength(currentRange, previousRange)) {
    refuse('NOAA window pair increment descriptors differ', {
      currentRange,
      previousRange,
    });
  }
  const currentHours = (Date.parse(a.end) - Date.parse(a.start)) / HOUR_MS;
  const previousHours = (Date.parse(b.end) - Date.parse(b.start)) / HOUR_MS;
  if (previousHours <= 0 || currentHours <= previousHours || currentHours - previousHours !== GFS_INTERVAL_HOURS) {
    refuse(`NOAA window pair does not yield ${GFS_INTERVAL_HOURS} hour(s)`, {
      currentHours,
      previousHours,
    });
  }
  return { currentHours, previousHours, start: a.start, end: a.end };
}

/** GFS cumulative companions must retain their decoded Float64 precision. */
export function recoverTrailingWindow(input: CompactTrailingWindowInput): CompactTrailingWindowResult {
  if (!(input.currentValues instanceof Float64Array) ||
      (input.companionValues !== null && !(input.companionValues instanceof Float64Array))) {
    throw new NoaaError('source-conflict', 'Window recovery requires Float64 source values');
  }
  try { return recoverInterval(input); }
  catch (error) {
    if (error instanceof RangeError) throw new NoaaError('source-conflict', error.message);
    throw error;
  }
}
