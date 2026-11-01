import { expect, it, vi } from 'vitest';
import { failureReason } from './failure.js';

it('retains provider-neutral failure identity and structured reasons', () => {
  expect(failureReason(Object.assign(new Error('Invalid field'), { code: 'source-conflict', details: { field: 't2m', expected: { units: 'K' }, actual: { units: 'C' } } }))).toEqual({ name: 'Error', message: 'Invalid field', code: 'source-conflict', details: { field: 't2m', expected: { units: 'K' }, actual: { units: 'C' } } });
});

it('bounds circular, broad, deep and long details without invoking getters', () => {
  const getter = vi.fn(), details: Record<string, unknown> = { long: '🪁'.repeat(100_000), deep: { one: { two: { three: { four: true } } } } };
  details.self = details;
  Object.defineProperty(details, 'getter', { get: getter, enumerable: true });
  for (let i = 0; i < 1000; i++) details[`property-${i}`] = 'x'.repeat(1000);
  const result = failureReason(Object.assign(new Error('x'.repeat(100_000)), { code: 'x'.repeat(100_000), details }));
  expect(result.detailsTruncated).toBe(true);
  expect(JSON.stringify(result).length).toBeLessThan(16 * 1024);
  expect(getter).not.toHaveBeenCalled();
  expect(result.details).toHaveProperty('self', '[circular]');
  expect(failureReason('aborted')).toEqual({ name: 'Error', message: 'aborted' });
});
