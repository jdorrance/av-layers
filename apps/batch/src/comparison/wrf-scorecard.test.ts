import { describe, expect, it } from 'vitest';
import type { ComparisonSample } from './core.js';
import { observationScorecard } from './wrf-scorecard.js';

const models = ['baseline', 'control', 'fine'], validTime = '2026-07-15T10:00:00Z';
const observations = [{ siteId: 'ridge', lat: 40, lon: 44, status: 'valid', timeSupport: 'valid-time', validTime, parameter: 'sfc-temp-c', value: 20, unit: '°C', verticalReference: '2m-AGL', source: 'station' }];
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
    const report = observationScorecard(rows, models, 'baseline', [...observations, { ...observations[0], validTime: '2026-07-15T11:00:00Z' }]);
    expect(report.groups[0].maeSkill.fine).toBeNull(); expect(report.groups[0].statusCounts['fine:missing']).toBe(1);
  });
  it('rejects displaced stations and inconsistent forecast coordinates', () => {
    expect(() => observationScorecard(samples(), models, 'baseline', [{ ...observations[0], lat: 40.01 }])).toThrow('coordinates');
    const rows = samples(); rows[2].lon = 44.01;
    expect(() => observationScorecard(rows, models, 'baseline', observations)).toThrow('coordinates');
    expect(() => observationScorecard(samples(), models, 'baseline', [{ ...observations[0], parameter: 'typo' }])).toThrow('parameter');
  });
  it('requires explicit matching statistical support and excludes shifted intervals', () => {
    const intervalStart = '2026-07-15T09:00:00Z', rows = samples();
    rows.forEach(row => Object.assign(row.values['sfc-temp-c'], { timeSupport: 'interval-mean', intervalStart, intervalEnd: validTime }));
    const observation = { ...observations[0], timeSupport: 'interval-mean', intervalStart, intervalEnd: validTime };
    expect(observationScorecard(rows, models, 'baseline', [observation]).groups[0].scores.fine.n).toBe(1);
    rows[2].values['sfc-temp-c'].intervalStart = '2026-07-15T08:00:00Z';
    const group = observationScorecard(rows, models, 'baseline', [observation]).groups[0];
    expect(group.supportExcluded).toBe(1); expect(group.scores.baseline.n).toBe(0);
    expect(() => observationScorecard(rows, models, 'baseline', [{ ...observation, intervalStart: validTime }])).toThrow('positive');
    expect(() => observationScorecard(rows, models, 'baseline', [{ ...observation, timeSupport: 'valid-time' }])).toThrow('windows');
  });
  it('counts lift misses and false alarms even when no numeric ceiling pair exists', () => {
    const rows = samples(), parameter = 'usable-lift-msl';
    rows.forEach((row, i) => { row.values = { [parameter]: { value: i === 2 ? null : 2500, status: i === 2 ? 'no-lift' : 'valid',
      unit: 'm', verticalReference: 'MSL', definition: 'usable lift ceiling', timeSupport: 'valid-time' } }; });
    const observation = { ...observations[0], parameter, value: 2600, unit: 'm', verticalReference: 'MSL' };
    const hit = observationScorecard(rows, models, 'baseline', [observation]).groups[0];
    expect(hit.events.baseline.hits).toBe(1); expect(hit.events.fine.misses).toBe(1);
    expect(hit.scores.baseline.n).toBe(0);
    const absent = observationScorecard(rows, models, 'baseline', [{ ...observation, status: 'no-lift', value: null }]).groups[0];
    expect(absent.events.baseline.falseAlarms).toBe(1); expect(absent.events.fine.correctNegatives).toBe(1);
    expect(() => observationScorecard(rows, models, 'baseline', [{ ...observation, status: 'no-lift' }])).toThrow('status');
  });
  it('rejects overflowing error statistics and skill instead of serializing null', () => {
    const rows = samples(); rows[2].values['sfc-temp-c'].value = 1e308;
    expect(() => observationScorecard(rows, models, 'baseline', observations)).toThrow('Non-finite');
    rows[0].values['sfc-temp-c'].value = 1e-310; rows[2].values['sfc-temp-c'].value = 1;
    expect(() => observationScorecard(rows, models, 'baseline', [{ ...observations[0], value: 0 }])).toThrow('skill');
  });

});
