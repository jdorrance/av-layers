import { expect, it } from 'vitest';
import { getProduct } from '@av/contracts/models';
import { forecastDispatch } from './forecast-dispatch.js';

it('admits only a configured event-driven model and normalizes its explicit cycle', () => {
  const gfs = getProduct('gfs')!;
  const model = { ...gfs, modelId: 'external-test', execution: { ...gfs.execution, schedule: [] } };
  const products = [gfs, model], input = { model: model.modelId, environment: 'staging', cycle: '2026-11-11T06:00:00Z' };
  const normalized = { ...input, cycle: new Date(input.cycle).toISOString() };
  expect(forecastDispatch(input, products)).toEqual(normalized);
  expect(forecastDispatch(normalized, products)).toEqual(normalized);
  for (const change of [
    { model: 'gfs' }, { model: 'all' }, { model: 'external-other' }, { environment: undefined }, { environment: 'test' },
    { cycle: undefined }, { cycle: '2026-11-11T06:00:00.001Z' }, { cycle: '2026-11-11T07:00:00Z' }, { cycle: '2026-02-31T06:00:00Z' }, { cycle: '2026-11-11T06:00:00Z\nmodel=gfs' }
  ]) expect(() => forecastDispatch({ ...input, ...change }, products)).toThrow();
});
