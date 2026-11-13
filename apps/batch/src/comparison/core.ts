/** Pair normalized point forecasts and summarize differences; adapters own units and parameter definitions. */
export type ComparisonStatus = 'valid' | 'no-lift' | 'unavailable' | 'outside-domain';
export type Comparability = 'equivalent' | 'related' | 'unmapped';
export type PairingMode = 'same-product-cycle' | 'products-at-valid-time';
export interface ComparisonOptions {
  pairing?: { mode: 'products-at-valid-time'; note: string };
}

export interface Measurement {
  value: number | null;
  status: ComparisonStatus;
  unit: string;
  verticalReference: string;
  definition: string;
  intervalStart?: string | null;
  intervalEnd?: string | null;
  methodId?: string;
  timeSupport?: string;
  support?: number;
  interpolated?: boolean;
  surfaceId?: string;
}

export interface ComparisonSample {
  provider: string;
  siteId: string;
  model: string;
  product: string;
  cycle: string | null;
  validTime: string;
  values: Record<string, Measurement>;
  sourceRef: string;
  buildId?: string;
  capturedAt?: string;
  groundM?: number | null;
  lat?: number;
  lon?: number;
}

export interface ParameterMapping {
  id: string;
  leftParameter: string;
  rightParameter: string;
  comparability: Comparability;
  note: string;
  timePolicy?: 'exact' | 'valid-time';
  referencePolicy?: 'exact' | 'provider-ground';
}

export type UnmatchedReason = 'missing-model' | 'valid-time-mismatch' | 'product-mismatch' | 'unknown-product'
  | 'cycle-mismatch' | 'unknown-cycle' | 'coordinate-mismatch' | 'unknown-coordinate' | 'missing-parameter' | 'unmapped-parameter'
  | 'unit-mismatch' | 'unknown-unit' | 'reference-mismatch' | 'unknown-reference' | 'unknown-definition'
  | 'interval-mismatch' | 'time-support-mismatch';

interface PairIdentity {
  siteId: string;
  model: string;
  product: string;
  cycle: string | null;
  validTime: string;
}

export interface ForecastIdentity {
  provider: string;
  model: string;
  product: string;
  cycle: string | null;
  buildId?: string;
  capturedAt: string | null;
  leadHours: number | null;
}

export interface ComparisonPair extends PairIdentity {
  pairingMode: PairingMode;
  leftIdentity: ForecastIdentity;
  rightIdentity: ForecastIdentity;
  parameter: string;
  comparability: Exclude<Comparability, 'unmapped'>;
  timePolicy: 'exact' | 'valid-time';
  referencePolicy: 'exact' | 'provider-ground';
  left: Measurement;
  right: Measurement;
  leftSourceRef: string;
  rightSourceRef: string;
  /** Left minus right, for two valid numeric values. */
  difference: number | null;
}

export interface UnmatchedSample extends PairIdentity {
  side: 'left' | 'right' | 'both';
  reason: UnmatchedReason;
  parameter?: string;
  leftSourceRef?: string;
  rightSourceRef?: string;
}

export interface ComparisonSummary {
  parameter: string;
  model: string;
  product: string;
  pairingMode: PairingMode;
  leftProvider: string;
  rightProvider: string;
  leftModel: string;
  rightModel: string;
  leftProduct: string;
  rightProduct: string;
  comparability: Exclude<Comparability, 'unmapped'>;
  timePolicy: 'exact' | 'valid-time';
  referencePolicy: 'exact' | 'provider-ground';
  unit: string;
  verticalReference: string;
  pairedCount: number;
  numericCount: number;
  siteCount: number;
  cycleCount: number;
  rightCycleCount: number;
  meanDifference: number | null;
  medianDifference: number | null;
  meanAbsoluteDifference: number | null;
  p90AbsoluteDifference: number | null;
  p95AbsoluteDifference: number | null;
  maximumAbsoluteDifference: number | null;
  statusTransitions: { left: ComparisonStatus; right: ComparisonStatus; count: number }[];
}

export interface ComparisonResult {
  pairs: ComparisonPair[];
  unmatched: UnmatchedSample[];
  summaries: ComparisonSummary[];
  parameterInventory: { left: string[]; right: string[]; unmappedLeft: string[]; unmappedRight: string[] };
}

const statuses = new Set<ComparisonStatus>(['valid', 'no-lift', 'unavailable', 'outside-domain']);
const groundReferences = new Set(['model-AGL', 'terrain-AGL', 'XC-ground-AGL', 'SkySight-ground-AGL']);
const unknown = (value: string) => /^(?:unknown|unverified|unspecified)?$/i.test(value.trim());
const key = (...values: unknown[]) => JSON.stringify(values);

function timestamp(value: string): number {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid comparison timestamp: ${value}`);
  }
  return Date.parse(value);
}

function identity(sample: ComparisonSample): PairIdentity {
  return { siteId: sample.siteId, model: sample.model, product: sample.product,
    cycle: sample.cycle, validTime: sample.validTime };
}

function forecastIdentity(sample: ComparisonSample): ForecastIdentity {
  return { provider: sample.provider, model: sample.model, product: sample.product, cycle: sample.cycle,
    ...(sample.buildId === undefined ? {} : { buildId: sample.buildId }), capturedAt: sample.capturedAt ?? null,
    leadHours: sample.cycle === null ? null : (timestamp(sample.validTime) - timestamp(sample.cycle)) / 3_600_000 };
}

function indexSamples(samples: readonly ComparisonSample[]) {
  const exact = new Map<string, ComparisonSample>();
  const models = new Set<string>(), times = new Set<string>(), products = new Map<string, ComparisonSample[]>();
  const parameters = new Set<string>();
  for (const sample of samples) {
    if (![sample.provider, sample.siteId, sample.model, sample.sourceRef].every(value => value.trim())) {
      throw new Error('Comparison sample identity is incomplete');
    }
    const validTime = timestamp(sample.validTime), cycle = sample.cycle === null ? null : timestamp(sample.cycle);
    if (sample.capturedAt !== undefined) timestamp(sample.capturedAt);
    if (cycle !== null && cycle > validTime) throw new Error('Comparison cycle follows valid time');
    if (sample.lat !== undefined && (!Number.isFinite(sample.lat) || Math.abs(sample.lat) > 90)
      || sample.lon !== undefined && (!Number.isFinite(sample.lon) || Math.abs(sample.lon) > 180)) {
      throw new Error('Invalid comparison coordinates');
    }
    const exactKey = key(sample.siteId, sample.model, sample.product, cycle, validTime);
    if (exact.has(exactKey)) throw new Error(`Duplicate comparison sample: ${exactKey}`);
    exact.set(exactKey, sample);
    models.add(key(sample.siteId, sample.model));
    times.add(key(sample.siteId, sample.model, validTime));
    const productKey = key(sample.siteId, sample.model, sample.product, validTime);
    const candidates = products.get(productKey) ?? [];
    candidates.push(sample); products.set(productKey, candidates);
    for (const [parameter, measurement] of Object.entries(sample.values)) {
      parameters.add(parameter);
      if (!statuses.has(measurement.status) || (measurement.value !== null && !Number.isFinite(measurement.value))
        || (measurement.status === 'valid' && measurement.value === null)
        || ((measurement.status === 'unavailable' || measurement.status === 'outside-domain') && measurement.value !== null)) {
        throw new Error(`Invalid comparison measurement: ${parameter}`);
      }
      const start = measurement.intervalStart, end = measurement.intervalEnd;
      if ((start == null) !== (end == null)) throw new Error('Comparison interval requires both endpoints');
      if (start != null && end != null && timestamp(start) > timestamp(end)) throw new Error('Comparison interval is reversed');
      if (start != null) timestamp(start);
      if (end != null) timestamp(end);
      if (end != null && timestamp(end) > validTime) throw new Error('Comparison interval ends after valid time');
    }
  }
  return { exact, models, times, products, parameters };
}

function indexProductTimes(samples: readonly ComparisonSample[]) {
  const index = new Map<string, ComparisonSample>(), products = new Set<string>();
  for (const sample of samples) {
    if (unknown(sample.product)) throw new Error('Cross-product comparison requires an identified product');
    products.add(key(sample.provider, sample.model, sample.product, sample.cycle === null ? null : timestamp(sample.cycle), sample.buildId));
    if (products.size > 1) throw new Error('Cross-product comparison requires one pinned product per side');
    const id = key(sample.siteId, timestamp(sample.validTime));
    if (index.has(id)) throw new Error('Cross-product comparison has an ambiguous site and valid time');
    index.set(id, sample);
  }
  return index;
}

function missingReason(sample: ComparisonSample, other: ReturnType<typeof indexSamples>): UnmatchedReason {
  if (unknown(sample.product)) return 'unknown-product';
  if (sample.cycle === null) return 'unknown-cycle';
  const validTime = timestamp(sample.validTime);
  if (!other.models.has(key(sample.siteId, sample.model))) return 'missing-model';
  if (!other.times.has(key(sample.siteId, sample.model, validTime))) return 'valid-time-mismatch';
  const candidates = other.products.get(key(sample.siteId, sample.model, sample.product, validTime));
  if (!candidates) return 'product-mismatch';
  return candidates.some(candidate => candidate.cycle === null) ? 'unknown-cycle' : 'cycle-mismatch';
}

function measurementMismatch(left: Measurement, right: Measurement, timePolicy: 'exact' | 'valid-time',
  referencePolicy: 'exact' | 'provider-ground'): UnmatchedReason | undefined {
  if (unknown(left.unit) || unknown(right.unit)) return 'unknown-unit';
  if (left.unit !== right.unit) return 'unit-mismatch';
  if (unknown(left.verticalReference) || unknown(right.verticalReference)) return 'unknown-reference';
  if (left.verticalReference !== right.verticalReference && !(referencePolicy === 'provider-ground'
    && groundReferences.has(left.verticalReference) && groundReferences.has(right.verticalReference))) return 'reference-mismatch';
  if (unknown(left.definition) || unknown(right.definition)) return 'unknown-definition';
  if (timePolicy === 'valid-time') return undefined;
  for (const field of ['intervalStart', 'intervalEnd'] as const) {
    const a = left[field], b = right[field];
    if ((a == null) !== (b == null) || (a != null && b != null && timestamp(a) !== timestamp(b))) return 'interval-mismatch';
  }
  if (left.timeSupport === undefined || right.timeSupport === undefined
    || left.timeSupport !== right.timeSupport || unknown(left.timeSupport)) {
    return 'time-support-mismatch';
  }
  if (left.timeSupport?.startsWith('interval-') && left.intervalStart == null) return 'interval-mismatch';
  return undefined;
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction, lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

export function summarizePairs(pairs: readonly ComparisonPair[]): ComparisonSummary[] {
  const groups = new Map<string, ComparisonPair[]>();
  for (const pair of pairs) {
    const id = key(pair.parameter, pair.model, pair.product, pair.pairingMode,
      pair.leftIdentity.provider, pair.rightIdentity.provider, pair.rightIdentity.model, pair.rightIdentity.product,
      pair.comparability, pair.timePolicy, pair.referencePolicy,
      pair.left.unit, pair.left.verticalReference, pair.right.verticalReference);
    const group = groups.get(id) ?? []; group.push(pair); groups.set(id, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => {
    const first = group[0]!, differences: number[] = [], transitions = new Map<string, ComparisonSummary['statusTransitions'][number]>();
    let sum = 0, absoluteSum = 0;
    const sites = new Set<string>(), cycles = new Set<number>(), rightCycles = new Set<number>();
    for (const pair of group) {
      sites.add(pair.siteId);
      if (pair.cycle !== null) cycles.add(timestamp(pair.cycle));
      if (pair.rightIdentity.cycle !== null) rightCycles.add(timestamp(pair.rightIdentity.cycle));
      const id = key(pair.left.status, pair.right.status), transition = transitions.get(id)
        ?? { left: pair.left.status, right: pair.right.status, count: 0 };
      transition.count++; transitions.set(id, transition);
      if (pair.difference !== null) { differences.push(pair.difference); sum += pair.difference; absoluteSum += Math.abs(pair.difference); }
    }
    differences.sort((a, b) => a - b);
    const absolute = differences.map(Math.abs).sort((a, b) => a - b);
    return { parameter: first.parameter, model: first.model, product: first.product, comparability: first.comparability,
      pairingMode: first.pairingMode, leftProvider: first.leftIdentity.provider, rightProvider: first.rightIdentity.provider,
      leftModel: first.leftIdentity.model, rightModel: first.rightIdentity.model,
      leftProduct: first.leftIdentity.product, rightProduct: first.rightIdentity.product,
      timePolicy: first.timePolicy, referencePolicy: first.referencePolicy, unit: first.left.unit,
      verticalReference: first.left.verticalReference === first.right.verticalReference ? first.left.verticalReference
        : `${first.left.verticalReference} vs ${first.right.verticalReference}`, pairedCount: group.length, numericCount: differences.length,
      siteCount: sites.size, cycleCount: cycles.size, rightCycleCount: rightCycles.size,
      meanDifference: differences.length ? sum / differences.length : null, medianDifference: percentile(differences, 0.5),
      meanAbsoluteDifference: differences.length ? absoluteSum / differences.length : null,
      p90AbsoluteDifference: percentile(absolute, 0.9), p95AbsoluteDifference: percentile(absolute, 0.95),
      maximumAbsoluteDifference: absolute.at(-1) ?? null,
      statusTransitions: [...transitions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value) };
  });
}

/** Pair selected products under explicit temporal and height-reference policies. */
export function compareSamples(left: readonly ComparisonSample[], right: readonly ComparisonSample[],
  mappings: readonly ParameterMapping[], options: ComparisonOptions = {}): ComparisonResult {
  if (options.pairing !== undefined && (options.pairing.mode !== 'products-at-valid-time' || !options.pairing.note.trim())) {
    throw new Error('Cross-product comparison requires an explicit mode and explanation');
  }
  const pairingMode: PairingMode = options.pairing?.mode ?? 'same-product-cycle';
  const mappingIds = new Set<string>();
  for (const mapping of mappings) {
    if (!mapping.id.trim() || mappingIds.has(mapping.id)) throw new Error(`Duplicate or empty comparison mapping: ${mapping.id}`);
    if (!['equivalent', 'related', 'unmapped'].includes(mapping.comparability)) throw new Error('Invalid parameter comparability');
    if (mapping.timePolicy !== undefined && mapping.timePolicy !== 'exact' && mapping.timePolicy !== 'valid-time') {
      throw new Error('Invalid comparison time policy');
    }
    if (mapping.timePolicy === 'valid-time' && (mapping.comparability !== 'related' || !mapping.note.trim())) {
      throw new Error('Valid-time comparison requires a related mapping and explanation');
    }
    if (mapping.referencePolicy !== undefined && mapping.referencePolicy !== 'exact' && mapping.referencePolicy !== 'provider-ground') {
      throw new Error('Invalid comparison reference policy');
    }
    if (mapping.referencePolicy === 'provider-ground' && (mapping.comparability !== 'related' || !mapping.note.trim())) {
      throw new Error('Provider-ground comparison requires a related mapping and explanation');
    }
    mappingIds.add(mapping.id);
  }
  const a = indexSamples(left), b = indexSamples(right), consumed = new Set<ComparisonSample>();
  const productTimes = pairingMode === 'products-at-valid-time'
    ? { left: indexProductTimes(left), right: indexProductTimes(right) } : undefined;
  const pairs: ComparisonPair[] = [], unmatched: UnmatchedSample[] = [];
  for (const sample of left) {
    const other = productTimes ? productTimes.right.get(key(sample.siteId, timestamp(sample.validTime)))
      : sample.cycle === null || unknown(sample.product) ? undefined
        : b.exact.get(key(sample.siteId, sample.model, sample.product, timestamp(sample.cycle), timestamp(sample.validTime)));
    if (!other) {
      unmatched.push({ ...identity(sample), side: 'left', reason: productTimes ? 'valid-time-mismatch' : missingReason(sample, b), leftSourceRef: sample.sourceRef });
      continue;
    }
    consumed.add(other);
    const base = { ...identity(sample), leftSourceRef: sample.sourceRef, rightSourceRef: other.sourceRef };
    if (sample.lat === undefined || sample.lon === undefined || other.lat === undefined || other.lon === undefined) {
      unmatched.push({ ...base, side: 'both', reason: 'unknown-coordinate' });
      continue;
    }
    if ((sample.lat !== undefined && other.lat !== undefined && Math.abs(sample.lat - other.lat) > 1e-8)
      || (sample.lon !== undefined && other.lon !== undefined && Math.abs(sample.lon - other.lon) > 1e-8)) {
      unmatched.push({ ...base, side: 'both', reason: 'coordinate-mismatch' });
      continue;
    }
    const forecasts = { pairingMode, leftIdentity: forecastIdentity(sample), rightIdentity: forecastIdentity(other) };
    for (const mapping of mappings) {
      const lv = sample.values[mapping.leftParameter], rv = other.values[mapping.rightParameter];
      const timePolicy = mapping.timePolicy ?? 'exact';
      const referencePolicy = mapping.referencePolicy ?? 'exact';
      const reason = mapping.comparability === 'unmapped' ? 'unmapped-parameter'
        : !lv || !rv ? 'missing-parameter' : measurementMismatch(lv, rv, timePolicy, referencePolicy);
      if (reason) { unmatched.push({ ...base, parameter: mapping.id, side: 'both', reason }); continue; }
      const difference = lv!.status === 'valid' && rv!.status === 'valid' ? lv!.value! - rv!.value! : null;
      pairs.push({ ...base, ...forecasts,
        parameter: mapping.id, comparability: mapping.comparability as ComparisonPair['comparability'],
        timePolicy, referencePolicy, left: lv!, right: rv!, difference });
    }
  }
  for (const sample of right) if (!consumed.has(sample)) {
    unmatched.push({ ...identity(sample), side: 'right', reason: productTimes ? 'valid-time-mismatch' : missingReason(sample, a), rightSourceRef: sample.sourceRef });
  }
  const leftParameters = [...a.parameters].sort(), rightParameters = [...b.parameters].sort();
  const mappedLeft = new Set(mappings.filter(mapping => mapping.comparability !== 'unmapped').map(mapping => mapping.leftParameter));
  const mappedRight = new Set(mappings.filter(mapping => mapping.comparability !== 'unmapped').map(mapping => mapping.rightParameter));
  return { pairs, unmatched, summaries: summarizePairs(pairs), parameterInventory: {
    left: leftParameters, right: rightParameters,
    unmappedLeft: leftParameters.filter(parameter => !mappedLeft.has(parameter)),
    unmappedRight: rightParameters.filter(parameter => !mappedRight.has(parameter))
  } };
}
