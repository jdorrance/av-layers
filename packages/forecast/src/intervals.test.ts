import { expect, it } from 'vitest';
import { recoverTrailingWindow } from './intervals.js';

it.each([Float32Array, Float64Array])('recovers upward interval means from %s with masks and Float32 overflow', ArrayType => {
  const recovered = recoverTrailingWindow({
    currentValues: ArrayType.of(-100, -150, NaN, 1e38), currentMissing: Uint8Array.of(0, 1, 0, 0),
    companionValues: ArrayType.of(-80, -100, -20, -1e38), companionMissing: Uint8Array.of(0, 0, 0, 0),
    currentHours: 24, previousHours: 23, statistic: 'mean',
    packingErrorCurrent: 0, packingErrorPrevious: 0, outputSign: -1
  });
  expect(recovered.values[0]).toBe(560);
  expect(recovered.missing).toEqual(Uint8Array.of(0, 1, 1, 1));
  expect(recovered.missingCount).toBe(3);
  expect([...recovered.values.slice(1)].every(Number.isNaN)).toBe(true);
});

it('changes flux direction once and preserves positive zero, including rounded subnormals', () => {
  const recovered = recoverTrailingWindow({
    currentValues: Float64Array.of(0, -0, 1e-60, -80, 20), currentMissing: new Uint8Array(5),
    companionValues: null, companionMissing: null, currentHours: 1, previousHours: 0,
    statistic: 'mean', packingErrorCurrent: 0, packingErrorPrevious: 0, outputSign: -1
  });
  expect([...recovered.values]).toEqual([0, 0, 0, 80, -20]);
  expect([...recovered.missing]).toEqual([0, 0, 0, 0, 0]);
});

it('rejects a companion mask that cannot describe its values', () => {
  expect(() => recoverTrailingWindow({
    currentValues: Float32Array.of(1), currentMissing: Uint8Array.of(0),
    companionValues: Float32Array.of(1), companionMissing: new Uint8Array(0),
    currentHours: 2, previousHours: 1, statistic: 'mean', packingErrorCurrent: 0, packingErrorPrevious: 0
  })).toThrow(/mask/);
});
