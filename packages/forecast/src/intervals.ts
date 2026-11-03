/** Pure temporal recovery. Source adapters verify run/grid identity, overlapping
 * windows and statistic semantics before calling. Keep source precision until
 * subtraction; only the normalized result is rounded to Float32.
 */
export type TrailingStatistic = 'mean' | 'accumulation';

export interface CompactTrailingWindowInput {
  currentValues: Float32Array | Float64Array;
  currentMissing: Uint8Array;
  companionValues: Float32Array | Float64Array | null;
  companionMissing: Uint8Array | null;
  currentHours: number;
  previousHours: number;
  statistic: TrailingStatistic;
  packingErrorCurrent: number;
  packingErrorPrevious: number;
  /** Reverse downward-positive flux to upward-positive; zero remains positive. */
  outputSign?: 1 | -1;
}

export interface CompactTrailingWindowResult {
  values: Float32Array;
  missing: Uint8Array;
  missingCount: number;
  derivedHours: number;
  quantizationTolerance: number;
}

export function recoverTrailingWindow(input: CompactTrailingWindowInput): CompactTrailingWindowResult {
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
    throw new RangeError('Invalid current statistical window length');
  }
  if (companionValues && (!Number.isFinite(previousHours) || previousHours <= 0 || currentHours <= previousHours)) {
    throw new RangeError('Invalid companion statistical window length');
  }
  if (companionValues && companionValues.length !== currentValues.length) {
    throw new RangeError('Companion window has a different active-cell count');
  }
  const isFloatArray = (value: unknown) => value instanceof Float32Array || value instanceof Float64Array;
  if (!isFloatArray(currentValues) || (companionValues !== null && !isFloatArray(companionValues))) throw new RangeError('Window recovery requires floating-point source arrays');
  if (input.outputSign !== undefined && input.outputSign !== 1 && input.outputSign !== -1) throw new RangeError('Invalid output sign');
  if (statistic !== 'mean' && statistic !== 'accumulation') throw new RangeError('Unsupported interval statistic');
  if (!(input.currentMissing instanceof Uint8Array) || input.currentMissing.length !== currentValues.length ||
      (companionValues ? !(input.companionMissing instanceof Uint8Array) || input.companionMissing.length !== currentValues.length : input.companionMissing !== null)) {
    throw new RangeError('Window missing mask has a different active-cell count');
  }
  if (
    !Number.isFinite(packingErrorCurrent) ||
    packingErrorCurrent < 0 ||
    !Number.isFinite(packingErrorPrevious) ||
    packingErrorPrevious < 0
  ) {
    throw new RangeError('Invalid GRIB packing error');
  }
  const derivedHours = companionValues ? currentHours - previousHours : currentHours;
  const quantizationTolerance = packingErrorCurrent + packingErrorPrevious + 1e-9;
  const values = new Float32Array(currentValues.length);
  const missing = new Uint8Array(currentValues.length);
  let missingCount = 0;
  for (let i = 0; i < currentValues.length; i++) {
    const value = currentValues[i];
    const previous = companionValues?.[i];
    let result = Number.NaN;
    if (value !== null && value !== undefined && Number.isFinite(value) && !input.currentMissing[i] &&
        (!companionValues || (previous !== null && previous !== undefined && Number.isFinite(previous) && !input.companionMissing![i]))) {
      if (statistic === 'mean') {
        result = companionValues ? (currentHours * value - previousHours * previous!) / derivedHours : value;
      } else {
        const amount = companionValues ? value - previous! : value;
        if (Number.isFinite(amount) && amount >= -quantizationTolerance) result = (amount < 0 ? 0 : amount) / derivedHours;
      }
    }
    if (input.outputSign === -1) result = -result;
    if (Number.isFinite(result)) result = Math.fround(result);
    if (input.outputSign === -1 && result === 0) result = 0;
    if (!Number.isFinite(result)) {
      missing[i] = 1;
      missingCount++;
      values[i] = Number.NaN;
    } else {
      values[i] = result;
    }
  }
  return { values, missing, missingCount, derivedHours, quantizationTolerance };
}
