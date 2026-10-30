import { parseProduct, type Identification } from '@azohra/meteo.grib';
import { NoaaError } from './errors.ts';
import type { DecodedFieldReceipt, NoaaIntervalReceipt } from './types.ts';

export const HOUR_MS = 3_600_000;

export function validAt(referenceTime: string, hour: number): string {
  return new Date(Date.parse(referenceTime) + hour * HOUR_MS).toISOString().replace('.000Z', 'Z');
}

export function gfsWindowStart(hour: number): number {
  return Math.floor((hour - 3) / 6) * 6;
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
  if (a.start !== b.start || Date.parse(a.end) - Date.parse(b.end) !== 3 * HOUR_MS) {
    refuse('NOAA window pair does not bound one trailing three-hour interval', {
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
  if (previousHours <= 0 || currentHours <= previousHours || currentHours - previousHours !== 3) {
    refuse('NOAA window pair does not yield exactly three hours', {
      currentHours,
      previousHours,
    });
  }
  return { currentHours, previousHours, start: a.start, end: a.end };
}

export type TrailingStatistic = 'mean' | 'accumulation';

export interface TrailingWindowInput {
  currentValues: readonly (number | null)[];
  companionValues: readonly (number | null)[] | null;
  currentHours: number;
  previousHours: number;
  statistic: TrailingStatistic;
  packingErrorCurrent: number;
  packingErrorPrevious: number;
}

export interface TrailingWindowResult {
  values: (number | null)[];
  derivedHours: number;
  quantizationTolerance: number;
}

export interface CompactTrailingWindowInput extends Omit<TrailingWindowInput, 'currentValues' | 'companionValues'> {
  currentValues: Float64Array;
  currentMissing: Uint8Array;
  companionValues: Float64Array | null;
  companionMissing: Uint8Array | null;
}

export interface CompactTrailingWindowResult {
  values: Float32Array;
  missing: Uint8Array;
  missingCount: number;
  derivedHours: number;
  quantizationTolerance: number;
}

export function recoverTrailingWindow(input: CompactTrailingWindowInput): CompactTrailingWindowResult;
export function recoverTrailingWindow(input: TrailingWindowInput): TrailingWindowResult;
export function recoverTrailingWindow(input: CompactTrailingWindowInput | TrailingWindowInput): CompactTrailingWindowResult | TrailingWindowResult {
  const {
    currentValues,
    companionValues,
    currentHours,
    previousHours,
    statistic,
    packingErrorCurrent,
    packingErrorPrevious,
  } = input;
  if (!Number.isFinite(currentHours) || currentHours <= 0) {
    throw new NoaaError('source-conflict', 'Invalid current statistical window length');
  }
  if (companionValues && (!Number.isFinite(previousHours) || previousHours <= 0 || currentHours <= previousHours)) {
    throw new NoaaError('source-conflict', 'Invalid companion statistical window length');
  }
  if (companionValues && companionValues.length !== currentValues.length) {
    throw new NoaaError('source-conflict', 'Companion window has a different active-cell count');
  }
  const compact = 'currentMissing' in input;
  if (compact && (input.currentMissing.length !== currentValues.length ||
      (companionValues ? !input.companionMissing || input.companionMissing.length !== currentValues.length : input.companionMissing !== null))) {
    throw new NoaaError('source-conflict', 'Window missing mask has a different active-cell count');
  }
  if (
    !Number.isFinite(packingErrorCurrent) ||
    packingErrorCurrent < 0 ||
    !Number.isFinite(packingErrorPrevious) ||
    packingErrorPrevious < 0
  ) {
    throw new NoaaError('source-conflict', 'Invalid GRIB packing error');
  }
  const derivedHours = companionValues ? currentHours - previousHours : currentHours;
  const quantizationTolerance = packingErrorCurrent + packingErrorPrevious + 1e-9;
  const values = compact ? new Float32Array(currentValues.length) : new Array<number | null>(currentValues.length);
  const missing = compact ? new Uint8Array(currentValues.length) : null;
  let missingCount = 0;
  for (let i = 0; i < currentValues.length; i++) {
    const value = currentValues[i];
    const previous = companionValues?.[i];
    let result = Number.NaN;
    if (value !== null && value !== undefined && Number.isFinite(value) && (!compact || !input.currentMissing[i]) &&
        (!companionValues || (previous !== null && previous !== undefined && Number.isFinite(previous) && (!compact || !input.companionMissing![i])))) {
      if (statistic === 'mean') {
        result = companionValues ? (currentHours * value - previousHours * previous!) / derivedHours : value;
      } else {
        const amount = companionValues ? value - previous! : value;
        if (Number.isFinite(amount) && amount >= -quantizationTolerance) result = (amount < 0 ? 0 : amount) / derivedHours;
      }
    }
    if (missing && Number.isFinite(result)) result = Math.fround(result);
    if (!Number.isFinite(result)) {
      if (missing) {
        missing[i] = 1;
        missingCount++;
        (values as Float32Array)[i] = Number.NaN;
      } else {
        (values as (number | null)[])[i] = null;
      }
    } else {
      values[i] = result;
    }
  }
  return missing
    ? { values: values as Float32Array, missing, missingCount, derivedHours, quantizationTolerance }
    : { values: values as (number | null)[], derivedHours, quantizationTolerance };
}
