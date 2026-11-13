import { describe, expect, it } from 'vitest';
import { compareSamples, type ComparisonOptions, type ComparisonSample, type Measurement, type ParameterMapping } from './core.js';

const mapping: ParameterMapping = { id: 'thermal-top', leftParameter: 'top', rightParameter: 'top',
  comparability: 'related', note: 'The providers use different parcel methods.' };

function measurement(value = 1500, changes: Partial<Measurement> = {}): Measurement {
  return { value, status: 'valid', unit: 'm', verticalReference: 'MSL', definition: 'dry-thermal-top',
    timeSupport: 'valid-time', ...changes };
}

function sample(changes: Partial<ComparisonSample> = {}): ComparisonSample {
  return { provider: 'ours', siteId: 'valley', model: 'gfs', product: 'noaa-gfs-0p25',
    cycle: '2026-11-13T00:00:00Z', validTime: '2026-11-13T12:00:00Z',
    values: { top: measurement() }, sourceRef: 'capture/ours.json', lat: 39.5, lon: 44.9, ...changes };
}

describe('point forecast comparisons', () => {
  it('compares explicitly selected products at valid time while retaining unknown cycles and known leads', () => {
    const left = sample({ buildId: 'pinned-build', capturedAt: '2026-11-13T09:00:00Z' });
    const right = sample({ provider: 'skysight', model: 'unknown', product: 'skysight-europe', cycle: null,
      capturedAt: '2026-11-13T10:00:00Z', values: { top: measurement(1800) }, sourceRef: 'capture/sky.json' });
    const options: ComparisonOptions = { pairing: { mode: 'products-at-valid-time', note: 'Different upstream products; SkySight initialization undisclosed.' } };
    expect(compareSamples([left], [right], [mapping]).pairs).toEqual([]);
    const result = compareSamples([left], [right], [mapping], options);
    expect(result.unmatched).toEqual([]);
    expect(result.pairs[0]).toMatchObject({ difference: -300, pairingMode: 'products-at-valid-time',
      leftIdentity: { provider: 'ours', model: 'gfs', product: 'noaa-gfs-0p25', cycle: left.cycle,
        buildId: 'pinned-build', capturedAt: left.capturedAt, leadHours: 12 },
      rightIdentity: { provider: 'skysight', model: 'unknown', product: 'skysight-europe', cycle: null,
        capturedAt: right.capturedAt, leadHours: null } });
    expect(result.summaries[0]).toMatchObject({ leftModel: 'gfs', rightModel: 'unknown', leftProduct: 'noaa-gfs-0p25',
      rightProduct: 'skysight-europe', leftProvider: 'ours', rightProvider: 'skysight', cycleCount: 1, rightCycleCount: 0 });
    const mismatch = (changes: Partial<ComparisonSample>) => compareSamples([left], [{ ...right, ...changes }], [mapping], options);
    expect(mismatch({ lat: 39.6 }).unmatched[0]?.reason).toBe('coordinate-mismatch');
    expect(mismatch({ validTime: '2026-11-13T13:00:00Z' }).unmatched.every(row => row.reason === 'valid-time-mismatch')).toBe(true);
    expect(mismatch({ values: { top: measurement(1800, { unit: 'ft' }) } }).unmatched[0]?.reason).toBe('unit-mismatch');
    expect(mismatch({ values: { top: measurement(1800, { timeSupport: 'unknown' }) } }).unmatched[0]?.reason).toBe('time-support-mismatch');
    expect(mismatch({ cycle: '2026-11-13T06:00:00Z' }).pairs[0]?.rightIdentity.leadHours).toBe(6);
  });

  it('requires an explained, unambiguous single pinned product for cross-product pairing', () => {
    const options: ComparisonOptions = { pairing: { mode: 'products-at-valid-time', note: 'Different forecast products.' } };
    expect(() => compareSamples([sample()], [sample()], [mapping], { pairing: { ...options.pairing!, note: '' } })).toThrow('explanation');
    expect(() => compareSamples([sample(), sample({ cycle: '2026-11-13T06:00:00Z' })], [sample()], [mapping], options))
      .toThrow('one pinned product');
    expect(() => compareSamples([sample()], [sample(), sample({ siteId: 'ridge', product: 'other' })], [mapping], options))
      .toThrow('one pinned product');
    expect(() => compareSamples([sample()], [sample({ product: 'unknown' })], [mapping], options)).toThrow('identified product');
    expect(() => compareSamples([sample({ capturedAt: 'undated' })], [sample()], [mapping], options)).toThrow('timestamp');
  });

  it('pairs UTC instants and keeps definition differences explicitly related', () => {
    const result = compareSamples([sample()], [sample({ provider: 'xcskies', sourceRef: 'capture/xc.json',
      cycle: '2026-11-13T01:00:00+01:00', validTime: '2026-11-13T13:00:00+01:00',
      values: { top: measurement(1700, { definition: 'xc-thermal-top' }) } })], [mapping]);
    expect(result.unmatched).toEqual([]);
    expect(result.pairs[0]).toMatchObject({ difference: -200, comparability: 'related',
      leftSourceRef: 'capture/ours.json', rightSourceRef: 'capture/xc.json' });
    expect(result.summaries[0]).toMatchObject({ numericCount: 1, meanDifference: -200, medianDifference: -200,
      meanAbsoluteDifference: 200, p95AbsoluteDifference: 200, siteCount: 1, cycleCount: 1 });
  });

  it.each([
    [{ model: 'hrrr' }, 'missing-model'],
    [{ product: 'other-gfs-grid' }, 'product-mismatch'],
    [{ cycle: '2026-11-13T06:00:00Z' }, 'cycle-mismatch'],
    [{ cycle: null }, 'unknown-cycle'],
    [{ validTime: '2026-11-13T13:00:00Z' }, 'valid-time-mismatch']
  ] as const)('excludes mismatched sample metadata %j', (change, reason) => {
    const result = compareSamples([sample()], [sample(change)], [mapping]);
    expect(result.pairs).toEqual([]);
    expect(result.unmatched[0]?.reason).toBe(reason);
  });

  it('does not score unknown cycles, unknown products, or different requested coordinates', () => {
    for (const [change, reason] of [
      [{ cycle: null }, 'unknown-cycle'], [{ product: 'unknown' }, 'unknown-product']
    ] as const) {
      const result = compareSamples([sample(change)], [sample(change)], [mapping]);
      expect(result.pairs).toEqual([]);
      expect(result.unmatched).toHaveLength(2);
      expect(result.unmatched.every(row => row.reason === reason)).toBe(true);
    }
    expect(compareSamples([sample()], [sample({ lat: 39.6 })], [mapping]).unmatched)
      .toEqual([expect.objectContaining({ reason: 'coordinate-mismatch', side: 'both' })]);
    expect(compareSamples([sample()], [sample({ lat: undefined })], [mapping]).unmatched)
      .toEqual([expect.objectContaining({ reason: 'unknown-coordinate', side: 'both' })]);
  });

  it.each([
    [{ unit: 'ft' }, 'unit-mismatch'],
    [{ unit: 'unknown' }, 'unknown-unit'],
    [{ verticalReference: 'model-AGL' }, 'reference-mismatch'],
    [{ verticalReference: 'unknown' }, 'unknown-reference'],
    [{ definition: 'unknown' }, 'unknown-definition'],
    [{ timeSupport: 'interval-mean' }, 'time-support-mismatch'],
    [{ intervalStart: '2026-11-13T11:00:00Z', intervalEnd: '2026-11-13T12:00:00Z' }, 'interval-mismatch']
  ] as const)('excludes mismatched measurement metadata %j', (change, reason) => {
    const result = compareSamples([sample()], [sample({ values: { top: measurement(1500, change) } })], [mapping]);
    expect(result.pairs).toEqual([]);
    expect(result.unmatched).toEqual([expect.objectContaining({ parameter: 'thermal-top', reason })]);
  });

  it('requires matching statistical window endpoints and known interval support', () => {
    const hourly = measurement(1500, { timeSupport: 'interval-mean', intervalStart: '2026-11-13T11:00:00Z',
      intervalEnd: '2026-11-13T12:00:00Z' });
    const threeHourly = { ...hourly, intervalStart: '2026-11-13T09:00:00Z' };
    const run = (left: Measurement, right: Measurement) => compareSamples([sample({ values: { top: left } })],
      [sample({ values: { top: right } })], [mapping]);
    expect(run(hourly, hourly).pairs).toHaveLength(1);
    expect(run(hourly, threeHourly).unmatched[0]?.reason).toBe('interval-mismatch');
    const missingWindow = measurement(1500, { timeSupport: 'interval-mean' });
    expect(run(missingWindow, missingWindow).unmatched[0]?.reason).toBe('interval-mismatch');
    const missingSupport = measurement(1500, { timeSupport: undefined });
    expect(run(missingSupport, missingSupport).unmatched[0]?.reason).toBe('time-support-mismatch');
  });

  it('explicitly compares related outputs at the same valid time while preserving unknown forcing intervals', () => {
    const left = sample({ values: { top: measurement(1500, { timeSupport: 'interval-flux-endpoint-profile',
      intervalStart: '2026-11-13T11:00:00Z', intervalEnd: '2026-11-13T12:00:00Z' }) } });
    const right = sample({ values: { top: measurement(1700, { timeSupport: 'unknown' }) } });
    const related = { ...mapping, timePolicy: 'valid-time' as const, note: 'XC forcing interval is undisclosed.' };
    const result = compareSamples([left], [right], [related]);
    expect(result.pairs[0]).toMatchObject({ timePolicy: 'valid-time', difference: -200,
      left: { intervalStart: '2026-11-13T11:00:00Z' }, right: { timeSupport: 'unknown' } });
    expect(result.summaries[0]?.timePolicy).toBe('valid-time');
    expect(compareSamples([left], [sample({ ...right, cycle: '2026-11-13T06:00:00Z' })], [related]).pairs).toEqual([]);
    expect(compareSamples([left], [sample({ ...right, values: { top: measurement(1700, { unit: 'ft' }) } })], [related]).pairs).toEqual([]);
    expect(() => compareSamples([left], [right], [{ ...related, comparability: 'equivalent' }])).toThrow('related');
    expect(() => compareSamples([left], [right], [{ ...related, note: '' }])).toThrow('explanation');
  });

  it('explicitly compares provider AGL outputs while retaining both ground references', () => {
    const left = sample({ values: { top: measurement(500, { verticalReference: 'terrain-AGL' }) } });
    const right = sample({ values: { top: measurement(700, { verticalReference: 'XC-ground-AGL' }) } });
    const related = { ...mapping, referencePolicy: 'provider-ground' as const,
      note: 'Each provider uses its own ground surface; this compares displayed AGL products.' };
    expect(compareSamples([left], [right], [mapping]).pairs).toEqual([]);
    const result = compareSamples([left], [right], [related]);
    expect(result.pairs[0]).toMatchObject({ referencePolicy: 'provider-ground', difference: -200,
      left: { verticalReference: 'terrain-AGL' }, right: { verticalReference: 'XC-ground-AGL' } });
    expect(result.summaries[0]).toMatchObject({ verticalReference: 'terrain-AGL vs XC-ground-AGL', referencePolicy: 'provider-ground' });
    expect(compareSamples([left], [sample({ values: { top: measurement(700, { verticalReference: 'SkySight-ground-AGL' }) } })], [related])
      .pairs[0]?.right.verticalReference).toBe('SkySight-ground-AGL');
    expect(compareSamples([left], [sample()], [related]).pairs).toEqual([]);
    expect(() => compareSamples([left], [right], [{ ...related, comparability: 'equivalent' }])).toThrow('related');
    expect(() => compareSamples([left], [right], [{ ...related, note: '' }])).toThrow('explanation');
  });

  it('preserves missingness and no-lift in status counts without scoring them as numeric zero', () => {
    const left = [sample(), sample({ siteId: 'ridge', values: { top: measurement(0, { status: 'no-lift' }) } }),
      sample({ siteId: 'plain', values: { top: measurement(0, { status: 'unavailable', value: null }) } })];
    const right = [sample({ values: { top: measurement(1000) } }), sample({ siteId: 'ridge' }),
      sample({ siteId: 'plain', values: { top: measurement(0, { status: 'no-lift', value: null }) } })];
    const result = compareSamples(left, right, [mapping]);
    expect(result.pairs.map(row => row.difference)).toEqual([500, null, null]);
    expect(result.summaries[0]).toMatchObject({ pairedCount: 3, numericCount: 1, siteCount: 3, meanDifference: 500,
      statusTransitions: [
        { left: 'no-lift', right: 'valid', count: 1 },
        { left: 'unavailable', right: 'no-lift', count: 1 },
        { left: 'valid', right: 'valid', count: 1 }
      ] });
  });

  it('keeps equivalent and related metrics separate and reports unmapped fields', () => {
    const input = sample({ values: { top: measurement(), temperature: measurement(20, { unit: 'degC', verticalReference: '2 m model AGL' }),
      extra: measurement(10) } });
    const result = compareSamples([input], [input], [mapping, { id: 'temperature', leftParameter: 'temperature',
      rightParameter: 'temperature', comparability: 'equivalent', note: 'Same native field.' },
    { id: 'other', leftParameter: 'extra', rightParameter: 'extra', comparability: 'unmapped', note: 'Definition unknown.' }]);
    expect(result.summaries.map(row => row.comparability).sort()).toEqual(['equivalent', 'related']);
    expect(result.parameterInventory.unmappedLeft).toEqual(['extra']);
    expect(result.unmatched).toEqual([expect.objectContaining({ parameter: 'other', reason: 'unmapped-parameter' })]);
    expect(compareSamples([input], [sample({ values: {} })], [mapping]).unmatched[0]?.reason).toBe('missing-parameter');
  });

  it('computes signed and absolute quantiles from paired values only', () => {
    const differences = [-200, 0, 100, 500];
    const left = differences.map((difference, index) => sample({ siteId: `site-${index}`, values: { top: measurement(1000 + difference) } }));
    const right = differences.map((_, index) => sample({ siteId: `site-${index}`, values: { top: measurement(1000) } }));
    const result = compareSamples(left, right, [mapping]);
    expect(result.summaries[0]).toMatchObject({ meanDifference: 100, medianDifference: 50, meanAbsoluteDifference: 200,
      maximumAbsoluteDifference: 500 });
    expect(result.summaries[0]?.p90AbsoluteDifference).toBeCloseTo(410);
    expect(result.summaries[0]?.p95AbsoluteDifference).toBeCloseTo(455);
  });

  it('rejects duplicates, invalid values, and ambiguous timestamps before scoring', () => {
    expect(() => compareSamples([sample(), sample({ validTime: '2026-11-13T13:00:00+01:00' })], [], [mapping])).toThrow('Duplicate');
    expect(() => compareSamples([sample()], [], [mapping, mapping])).toThrow('Duplicate');
    expect(() => compareSamples([sample({ values: { top: measurement(NaN) } })], [], [mapping])).toThrow('measurement');
    expect(() => compareSamples([sample({ values: { top: measurement(1500, { value: null }) } })], [], [mapping])).toThrow('measurement');
    expect(() => compareSamples([sample({ validTime: '2026-11-13T12:00:00' })], [], [mapping])).toThrow('timestamp');
    expect(() => compareSamples([sample({ values: { top: measurement(1500, { intervalStart: '2026-11-13T11:00:00Z' }) } })], [], [mapping])).toThrow('endpoints');
    expect(() => compareSamples([sample({ values: { top: measurement(1500, { intervalStart: '2026-11-13T11:00:00Z',
      intervalEnd: '2026-11-13T13:00:00Z' }) } })], [], [mapping])).toThrow('after valid time');
  });
});
