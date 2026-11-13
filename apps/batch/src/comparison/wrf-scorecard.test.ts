import { describe, expect, it } from 'vitest';
import type { ComparisonSample } from './core.js';
import { observationScorecard } from './wrf-scorecard.js';

const models = ['baseline', 'control', 'fine'], validTime = '2026-07-15T10:00:00Z';
const observations = [{ siteId: 'ridge', validTime, parameter: 'sfc-temp-c', value: 20, unit: '°C', verticalReference: '2m-AGL', source: 'station' }];
function samples(): ComparisonSample[] {
  return models.map((model, i) => ({ provider: 'av', model, product: model, siteId: 'ridge', lat: 40, lon: 44,
    cycle: '2026-07-15T00:00:00Z', validTime, sourceRef: model,
    values: { 'sfc-temp-c': { value: 24 - 2 * i, unit: '°C', verticalReference: '2m-AGL', definition: 'temperature', status: 'valid', timeSupport: 'valid-time' } } }));
}

describe('paired observation scorecard', () => {
  it('scores common samples with signed bias, MAE, RMSE and baseline-relative skill', () => {
    const report = observationScorecard(samples(), models, 'baseline', observations), group = report.groups[0];
    expect(group.scores.baseline).toEqual({ n: 1, bias: 4, mae: 4, rmse: 4 });
    expect(group.scores.control).toEqual({ n: 1, bias: 2, mae: 2, rmse: 2 });
    expect(group.maeSkill).toEqual({ baseline: 0, control: 0.5, fine: 1 });
  });
  it('retains no-lift and missingness while excluding the same row for every model', () => {
    const rows = samples(); rows[2].values['sfc-temp-c'] = { ...rows[2].values['sfc-temp-c'], value: null, status: 'unavailable' };
    const group = observationScorecard(rows, models, 'baseline', observations).groups[0];
    expect(group.scores.baseline.n).toBe(0); expect(group.statusCounts['fine:unavailable']).toBe(1);
    expect(group.maeSkill.fine).toBeNull();
    rows[2].values['sfc-temp-c'].status = 'no-lift';
    expect(observationScorecard(rows, models, 'baseline', observations).groups[0].statusCounts['fine:no-lift']).toBe(1);
  });
  it('requires identical flux windows and physical references', () => {
    const rows = samples(); rows.forEach(row => { row.values['sfc-temp-c'].timeSupport = 'interval-mean'; });
    expect(observationScorecard(rows, models, 'baseline', observations).groups[0].scores.fine.n).toBe(0);
    expect(() => observationScorecard(samples(), models, 'baseline', [{ ...observations[0], unit: 'K' }])).toThrow('units');
    expect(() => observationScorecard(samples(), models, 'baseline', [...observations, ...observations])).toThrow('Duplicate observation');
    expect(() => observationScorecard([...samples(), samples()[0]], models, 'baseline', observations)).toThrow('Duplicate forecast');
    expect(() => observationScorecard(samples(), models, 'baseline', [{ ...observations[0], value: NaN }])).toThrow();
  });
  it('leaves skill undefined for a perfect baseline and keeps sites separate', () => {
    const rows = samples(); rows[0].values['sfc-temp-c'].value = 20;
    const report = observationScorecard(rows, models, 'baseline', [...observations, { ...observations[0], siteId: 'missing' }]);
    expect(report.groups[0].maeSkill.fine).toBeNull(); expect(report.groups[1].scores.fine.n).toBe(0);
  });
});
