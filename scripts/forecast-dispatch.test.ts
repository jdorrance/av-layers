import { expect, it } from 'vitest';
import { getProduct } from '@av/contracts/models';
import { forecastDispatch } from './forecast-dispatch.js';

it('admits only a configured event-driven model with an explicit environment and canonical cycle', () => {
  const gfs = getProduct('gfs')!;
  const model = { ...gfs, modelId: 'external-test', execution: { ...gfs.execution, schedule: [] } };
  const products = [gfs, model], input = { model: model.modelId, environment: 'staging', cycle: '2026-11-11T06:00:00Z' };
  expect(forecastDispatch(input, products)).toEqual(input);
  for (const change of [
    { model: 'gfs' }, { model: 'all' }, { model: 'external-other' }, { environment: undefined }, { environment: 'test' },
    { cycle: '2026-11-11T07:00:00Z' }, { cycle: '2026-02-31T06:00:00Z' }, { cycle: '2026-11-11T06:00:00Z\nmodel=gfs' }
  ]) expect(() => forecastDispatch({ ...input, ...change }, products)).toThrow();
});
