import { describe, expect, it } from 'vitest';
import { buildReport } from './report.js';
import type { ComparisonSample, Measurement, ParameterMapping } from './core.js';
import type { ComparisonSite } from './sites.js';

const sites: ComparisonSite[] = [
  { id: 'plain', name: 'Plain', lat: 0, lon: 0, region: 'europe-caucasus', terrain: 'flat', timezone: 'UTC', source: 'fixture' },
  { id: 'ridge', name: 'Ridge', lat: 1, lon: 0, region: 'europe-caucasus', terrain: 'ridge', timezone: 'UTC', source: 'fixture' }
];
const mapping: ParameterMapping = { id: 'top', leftParameter: 'top', rightParameter: 'top', comparability: 'related', note: 'Different methods' };

function sample(site: ComparisonSite, validTime: string, value: number | null, status: Measurement['status'] = 'valid'): ComparisonSample {
  return { provider: 'fixture', siteId: site.id, lat: site.lat, lon: site.lon,
    model: 'gfs', product: 'gfs-0p25', cycle: '2026-03-20T00:00:00Z', validTime, sourceRef: `raw/${site.id}/${validTime}.json`,
    values: { top: { value, status, unit: 'm', verticalReference: 'MSL', definition: 'thermal-top', timeSupport: 'valid-time' } } };
}

describe('comparison reports', () => {
  it('weights local site-days equally and excludes night from the headline', () => {
    const left = [sample(sites[0], '2026-03-20T11:00:00Z', 1000), sample(sites[0], '2026-03-20T12:00:00Z', 1000),
      sample(sites[0], '2026-03-20T00:00:00Z', 5000), sample(sites[1], '2026-03-20T12:00:00Z', 1900)];
    const right = left.map(row => ({ ...row, values: { top: { ...row.values.top, value: 1000 } } }));
    const report = buildReport(left, right, [mapping], sites);
    expect(report.counts).toMatchObject({ pairedMeasurements: 4, daylightPairedMeasurements: 3 });
    expect(report.daylight[0].meanDifference).toBe(300);
    expect(report.headline[0]).toMatchObject({ siteDayCount: 2, numericSiteDayCount: 2, meanDifference: 450, meanAbsoluteDifference: 450 });
    expect(report.topDiscrepancies[0].pairs[0]).toMatchObject({ siteId: 'ridge', difference: 900, leftValue: 1900, rightValue: 1000 });
    expect(report).toEqual(buildReport([...left].reverse(), [...right].reverse(), [mapping], sites));
  });

  it('keeps missing and outside pairs out of lift-flip denominators', () => {
    const times = ['10', '11', '12', '13'].map(hour => `2026-03-20T${hour}:00:00Z`);
    const left = [sample(sites[0], times[0], 1200), sample(sites[0], times[1], null, 'no-lift'),
      sample(sites[0], times[2], null, 'unavailable'), sample(sites[0], times[3], null, 'outside-domain')];
    const right = [sample(sites[0], times[0], null, 'no-lift'), sample(sites[0], times[1], null, 'no-lift'),
      sample(sites[0], times[2], 1000), sample(sites[0], times[3], 1000)];
    const report = buildReport(left, right, [mapping], sites);
    expect(report.daylight[0]).toMatchObject({ pairedCount: 4, numericCount: 0, availablePairCount: 2,
      outsidePairCount: 1, unavailablePairCount: 1, leftLiftOnlyCount: 1, rightLiftOnlyCount: 0, bothNoLiftCount: 1 });
    expect(report.headline[0].meanDifference).toBeNull();
    expect(report.topDiscrepancies).toEqual([]);
  });

  it('uses the site calendar day and records unmatched metadata reasons', () => {
    const auckland: ComparisonSite = { ...sites[0], id: 'auckland', lat: -36.85, lon: 174.76, timezone: 'Pacific/Auckland' };
    const first = sample(auckland, '2026-03-20T23:00:00Z', 1500);
    const unmatched = { ...first, validTime: '2026-03-21T00:00:00Z' };
    const report = buildReport([first, unmatched], [first], [mapping], [auckland]);
    expect(report.siteDay[0].localDate).toBe('2026-03-21');
    expect(report.unmatchedReasons).toEqual([{ scope: 'sample', reason: 'valid-time-mismatch', count: 1 }]);
    expect(() => buildReport([first], [first], [mapping], sites)).toThrow('Unknown report site');
  });

  it('caps outliers separately within each metric and preserves source references', () => {
    const rows = Array.from({ length: 25 }, (_, index) => sample(sites[0], `2026-03-${String(20 + Math.floor(index / 5)).padStart(2, '0')}T${10 + index % 5}:00:00Z`, 1000 + index));
    const right = rows.map(row => ({ ...row, values: { top: { ...row.values.top, value: 1000 } } }));
    const report = buildReport(rows, right, [mapping], sites);
    expect(report.topDiscrepancies[0].pairs).toHaveLength(20);
    expect(report.topDiscrepancies[0].pairs[0]).toMatchObject({ difference: 24, leftSourceRef: rows[24].sourceRef, rightSourceRef: right[24].sourceRef });
  });

  it('retains different ground references in the headline and outlier qualifiers', () => {
    const left = sample(sites[0], '2026-03-20T12:00:00Z', 1000), right = sample(sites[0], '2026-03-20T12:00:00Z', 1200);
    left.values.top.verticalReference = 'terrain-AGL';
    right.values.top.verticalReference = 'XC-ground-AGL';
    const report = buildReport([left], [right], [{ ...mapping, referencePolicy: 'provider-ground' }], sites);
    const qualifier = { referencePolicy: 'provider-ground', verticalReference: 'terrain-AGL vs XC-ground-AGL' };
    expect(report.headline[0]).toMatchObject(qualifier);
    expect(report.topDiscrepancies[0]).toMatchObject(qualifier);
  });

  it('reports both forecast identities and unknown initialization in explicit cross-product comparisons', () => {
    const left = [sample(sites[0], '2026-03-20T11:00:00Z', 1100), sample(sites[0], '2026-03-20T12:00:00Z', 1300)]
      .map(row => ({ ...row, provider: 'av-layers', buildId: 'av-build', capturedAt: '2026-03-20T09:00:00Z' }));
    const right = left.map(row => ({ ...row, provider: 'skysight', model: 'regional', product: 'EUROPE',
      cycle: null, buildId: undefined, capturedAt: '2026-03-20T10:00:00Z', sourceRef: `sky/${row.validTime}`,
      values: { top: { ...row.values.top, value: 1000 } } }));
    const pairing = { mode: 'products-at-valid-time' as const, note: 'Provider product disagreement; initialization remains unknown for SkySight.' };
    expect(buildReport(left, right, [mapping], sites).counts.pairedMeasurements).toBe(0);
    const report = buildReport(left, right, [mapping], sites, { pairing });
    expect(report.basis.pairing).toEqual(pairing);
    expect(report.headline[0]).toMatchObject({ pairingMode: pairing.mode,
      leftProvider: 'av-layers', rightProvider: 'skysight', leftModel: 'gfs', rightModel: 'regional',
      leftProduct: 'gfs-0p25', rightProduct: 'EUROPE', meanDifference: 200 });
    expect(report.daylight[0]).toMatchObject({ cycleCount: 1, rightCycleCount: 0 });
    expect(report.topDiscrepancies[0].pairs[0]).toMatchObject({
      leftIdentity: { provider: 'av-layers', cycle: left[0].cycle, leadHours: 12, buildId: 'av-build', capturedAt: left[0].capturedAt },
      rightIdentity: { provider: 'skysight', model: 'regional', product: 'EUROPE', cycle: null, leadHours: null, capturedAt: right[0].capturedAt }
    });
    expect(report.forecastInventory.right).toEqual([{ provider: 'skysight', model: 'regional', product: 'EUROPE',
      cycle: null, buildId: null, capturedAt: right[0].capturedAt, sampleCount: 2,
      validFrom: right[0].validTime, validTo: right[1].validTime }]);
    expect(report).toEqual(buildReport([...left].reverse(), [...right].reverse(), [mapping], sites, { pairing }));
  });
});
