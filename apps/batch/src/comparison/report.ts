/** Summarizes archived comparisons by daylight and local site-day; all differences are left minus right. */
import { DEFAULT_HORIZON_DEG, solarPosition } from '@av/solar';
import { compareSamples, summarizePairs, type ComparisonOptions, type ComparisonPair, type ComparisonSample, type ComparisonSummary, type ParameterMapping } from './core.js';
import type { ComparisonSite } from './sites.js';

function availability(summary: ComparisonSummary) {
  let availablePairCount = 0, outsidePairCount = 0, unavailablePairCount = 0;
  let leftLiftOnlyCount = 0, rightLiftOnlyCount = 0, bothNoLiftCount = 0;
  for (const { left, right, count } of summary.statusTransitions) {
    if (left === 'outside-domain' || right === 'outside-domain') outsidePairCount += count;
    else if (left === 'unavailable' || right === 'unavailable') unavailablePairCount += count;
    else {
      availablePairCount += count;
      if (left === 'valid' && right === 'no-lift') leftLiftOnlyCount += count;
      if (left === 'no-lift' && right === 'valid') rightLiftOnlyCount += count;
      if (left === 'no-lift' && right === 'no-lift') bothNoLiftCount += count;
    }
  }
  return { ...summary, availablePairCount, outsidePairCount, unavailablePairCount,
    leftLiftOnlyCount, rightLiftOnlyCount, bothNoLiftCount };
}

type RowSummary = ReturnType<typeof availability>;
interface SiteDaySummary extends RowSummary { siteId: string; localDate: string }
type MetricIdentity = Pick<ComparisonSummary, 'model' | 'product' | 'parameter' | 'comparability' | 'timePolicy' | 'referencePolicy' | 'unit' | 'verticalReference'
  | 'pairingMode' | 'leftProvider' | 'rightProvider' | 'leftModel' | 'rightModel' | 'leftProduct' | 'rightProduct'>;

function metric(summary: MetricIdentity): MetricIdentity {
  const { model, product, parameter, comparability, timePolicy, referencePolicy, unit, verticalReference,
    pairingMode, leftProvider, rightProvider, leftModel, rightModel, leftProduct, rightProduct } = summary;
  return { model, product, parameter, comparability, timePolicy, referencePolicy, unit, verticalReference,
    pairingMode, leftProvider, rightProvider, leftModel, rightModel, leftProduct, rightProduct };
}

function forecastInventory(samples: readonly ComparisonSample[]) {
  const groups = new Map<string, { provider: string; model: string; product: string; cycle: string | null;
    buildId: string | null; capturedAt: string | null; sampleCount: number; validFrom: string; validTo: string }>();
  for (const sample of samples) {
    const identity = { provider: sample.provider, model: sample.model, product: sample.product, cycle: sample.cycle,
      buildId: sample.buildId ?? null, capturedAt: sample.capturedAt ?? null };
    const key = JSON.stringify(identity), group = groups.get(key)
      ?? { ...identity, sampleCount: 0, validFrom: sample.validTime, validTo: sample.validTime };
    group.sampleCount++;
    if (Date.parse(sample.validTime) < Date.parse(group.validFrom)) group.validFrom = sample.validTime;
    if (Date.parse(sample.validTime) > Date.parse(group.validTo)) group.validTo = sample.validTime;
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group);
}

function localDate(formatter: Intl.DateTimeFormat, time: number): string {
  const parts = formatter.formatToParts(time);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}

function equalSiteDayMeans(rows: readonly SiteDaySummary[]) {
  const groups = new Map<string, SiteDaySummary[]>();
  for (const row of rows) {
    const key = JSON.stringify(metric(row)), group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => {
    const numeric = group.filter(row => row.numericCount > 0);
    return { ...metric(group[0]), siteCount: new Set(group.map(row => row.siteId)).size,
      siteDayCount: group.length, numericSiteDayCount: numeric.length,
      pairedCount: group.reduce((sum, row) => sum + row.pairedCount, 0),
      numericCount: group.reduce((sum, row) => sum + row.numericCount, 0),
      meanDifference: numeric.length ? numeric.reduce((sum, row) => sum + row.meanDifference!, 0) / numeric.length : null,
      meanAbsoluteDifference: numeric.length ? numeric.reduce((sum, row) => sum + row.meanAbsoluteDifference!, 0) / numeric.length : null
    };
  });
}

function largestDifferences(pairs: readonly ComparisonPair[]) {
  const groups = new Map<string, ComparisonPair[]>();
  const identity = (pair: ComparisonPair) => metric({ ...pair, unit: pair.left.unit,
    leftProvider: pair.leftIdentity.provider, rightProvider: pair.rightIdentity.provider,
    leftModel: pair.leftIdentity.model, rightModel: pair.rightIdentity.model,
    leftProduct: pair.leftIdentity.product, rightProduct: pair.rightIdentity.product,
    verticalReference: pair.left.verticalReference === pair.right.verticalReference ? pair.left.verticalReference
      : `${pair.left.verticalReference} vs ${pair.right.verticalReference}` });
  for (const pair of pairs) {
    if (pair.difference === null) continue;
    const key = JSON.stringify(identity(pair)), group = groups.get(key) ?? [];
    group.push(pair); groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => {
    group.sort((a, b) => Math.abs(b.difference!) - Math.abs(a.difference!)
      || a.siteId.localeCompare(b.siteId) || a.validTime.localeCompare(b.validTime)
      || (a.cycle ?? '').localeCompare(b.cycle ?? '') || a.leftSourceRef.localeCompare(b.leftSourceRef));
    const first = group[0];
    return { ...identity(first),
      pairs: group.slice(0, 20).map(pair => ({ siteId: pair.siteId, cycle: pair.cycle, validTime: pair.validTime,
        leftIdentity: pair.leftIdentity, rightIdentity: pair.rightIdentity,
        leftValue: pair.left.value!, rightValue: pair.right.value!, difference: pair.difference!,
        leftSourceRef: pair.leftSourceRef, rightSourceRef: pair.rightSourceRef })) };
  });
}

/** Site dates use their IANA timezone; daylight uses solar elevation at valid time. */
export function buildReport(left: readonly ComparisonSample[], right: readonly ComparisonSample[],
  mappings: readonly ParameterMapping[], sites: readonly ComparisonSite[], options: ComparisonOptions = {}) {
  const byId = new Map(sites.map(site => [site.id, site]));
  if (byId.size !== sites.length) throw new Error('Report sites contain duplicate IDs');
  for (const sample of [...left, ...right]) {
    const site = byId.get(sample.siteId);
    if (!site) throw new Error(`Unknown report site: ${sample.siteId}`);
    if (sample.lat !== site.lat || sample.lon !== site.lon) throw new Error(`Report coordinates differ from site: ${sample.siteId}`);
  }
  const result = compareSamples(left, right, mappings, options);
  const formatters = new Map(sites.map(site => [site.id, new Intl.DateTimeFormat('en', {
    timeZone: site.timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  })]));
  const times = new Map<string, { daylight: boolean; localDate: string }>();
  const daylightPairs: ComparisonPair[] = [], days = new Map<string, ComparisonPair[]>();
  for (const pair of result.pairs) {
    const key = JSON.stringify([pair.siteId, pair.validTime]);
    let time = times.get(key);
    if (!time) {
      const site = byId.get(pair.siteId)!, timestamp = Date.parse(pair.validTime);
      time = { daylight: solarPosition(site.lat, site.lon, timestamp).elevationDeg > DEFAULT_HORIZON_DEG,
        localDate: localDate(formatters.get(site.id)!, timestamp) };
      times.set(key, time);
    }
    if (!time.daylight) continue;
    daylightPairs.push(pair);
    const dayKey = JSON.stringify([pair.siteId, time.localDate]), group = days.get(dayKey) ?? [];
    group.push(pair); days.set(dayKey, group);
  }
  const siteDay: SiteDaySummary[] = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, pairs]) => {
    const [siteId, date] = JSON.parse(key) as [string, string];
    return summarizePairs(pairs).map(summary => ({ ...availability(summary), siteId, localDate: date }));
  });
  const reasons = new Map<string, { reason: string; scope: 'sample' | 'measurement'; count: number }>();
  for (const row of result.unmatched) {
    const scope = row.parameter === undefined ? 'sample' : 'measurement', key = JSON.stringify([scope, row.reason]);
    const count = reasons.get(key) ?? { reason: row.reason, scope, count: 0 };
    count.count++; reasons.set(key, count);
  }
  return {
    version: 1 as const,
    basis: { difference: 'left-minus-right', rowWeighting: 'each paired measurement',
      pairing: options.pairing ?? { mode: 'same-product-cycle', note: 'Same nominal model, product, initialization and valid time' },
      headlineWeighting: 'equal daylight site-day means within each provider/model/product pairing and parameter',
      daylight: `solar elevation at valid time > ${DEFAULT_HORIZON_DEG} degrees`,
      localDate: 'site IANA timezone', largestDifferences: 'up to 20 numeric daylight pairs per provider/model/product pairing and parameter' },
    counts: { leftSamples: left.length, rightSamples: right.length,
      leftSites: new Set(left.map(sample => sample.siteId)).size, rightSites: new Set(right.map(sample => sample.siteId)).size,
      pairedMeasurements: result.pairs.length, numericPairs: result.pairs.filter(pair => pair.difference !== null).length,
      daylightPairedMeasurements: daylightPairs.length, daylightNumericPairs: daylightPairs.filter(pair => pair.difference !== null).length,
      matchedSites: new Set(result.pairs.map(pair => pair.siteId)).size, unmatchedRecords: result.unmatched.length },
    parameterInventory: result.parameterInventory,
    forecastInventory: { left: forecastInventory(left), right: forecastInventory(right) },
    mappings: [...mappings].sort((a, b) => a.id.localeCompare(b.id)),
    overall: result.summaries.map(availability),
    daylight: summarizePairs(daylightPairs).map(availability),
    siteDay,
    headline: equalSiteDayMeans(siteDay),
    unmatchedReasons: [...reasons.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, reason]) => reason),
    topDiscrepancies: largestDifferences(daylightPairs)
  };
}
