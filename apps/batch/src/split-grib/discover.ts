import type { SplitSource } from './source.js';
import { recentSourceCycles } from '../source.js';
import { DEFAULT_PROBE_TIMEOUT_MS } from '@av/contracts';
import { splitGribRegularFieldUrl, validateSplitGribCycle } from './fields.js';
import { pause } from '../pause.js';

const PROBE_CONCURRENCY = 4;
const PROBE_ATTEMPTS = 3;


export interface SplitGribDiscoveryResult {
  readonly schemaVersion: 1;
  readonly model: string;
  readonly cycle: string;
  readonly forecastHours: readonly number[];
  readonly sentinelUrls: readonly string[];
}

export function candidateSplitGribCycles(source: SplitSource, now = new Date(), lag = source.upstream.discoveryLagHours, count = source.upstream.discoveryCandidates): string[] {
  return recentSourceCycles(now, source.model.forecast.cycleHoursUtc, lag, count);
}

/**
 * Sentinel URLs that must be present on DWD Open Data before a 00/06/12/18 UTC
 * Split GRIB main run is admitted. Probes cover field families and profile endpoints;
 * acquisition still checks every required object.
 */
export function splitGribRunSentinelUrls(source: SplitSource,
  cycleIso: string,
  options: {
    readonly lastForecastHour?: number;
    readonly baseUrl?: string;
  } = {}
): string[] {
  const cycle = validateSplitGribCycle(source, cycleIso);
  const lastHour = options.lastForecastHour ?? source.model.forecast.hours.at(-1)!;
  const topHalfLevel = source.halfLevels[0]!;
  const bottomHalfLevel = source.halfLevels.at(-1)!;
  const lowestLevel = source.modelLevels[0]!;
  const highestLevel = source.modelLevels.at(-1)!;
  return [
    splitGribRegularFieldUrl(source, source.fields.staticTerrain, cycle, { baseUrl: options.baseUrl }),
    ...[topHalfLevel, bottomHalfLevel].map(level => splitGribRegularFieldUrl(source, source.fields.halfLevelHeight, cycle, { level, baseUrl: options.baseUrl })),
    ...[source.fields.surfacePressure, source.fields.temperature2m, source.fields.specificHumidity2m, source.fields.sensibleHeatFlux, source.fields.latentHeatFlux].map(field => splitGribRegularFieldUrl(source, field, cycle, { hour: lastHour, baseUrl: options.baseUrl })),
    ...(source.model.layers.includes('precip-rate') ? [splitGribRegularFieldUrl(source, source.fields.precipitation!, cycle, { hour: lastHour, baseUrl: options.baseUrl })] : []),
    ...Object.values(source.upstream.auxSurface ?? {}).map(spec => splitGribRegularFieldUrl(source, spec.field, cycle, { hour: lastHour, baseUrl: options.baseUrl })),
    ...Object.values(source.upstream.auxLevels ?? {}).flatMap(spec => [lowestLevel, highestLevel].map(level => splitGribRegularFieldUrl(source, spec.field, cycle, { hour: lastHour, level, baseUrl: options.baseUrl }))),
    ...[source.fields.temperature, source.fields.pressure].flatMap(field => [lowestLevel, highestLevel].map(level => splitGribRegularFieldUrl(source, field, cycle, { hour: lastHour, level, baseUrl: options.baseUrl })))
  ];
}

function probeFailure(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = cause && typeof cause === 'object' && 'code' in cause ? ` (${String(cause.code)})` : '';
  return `${error instanceof Error ? error.message : String(error)}${code}`.slice(0, 256);
}

async function probeSentinel(url: string, fetchFn: typeof fetch, signal: AbortSignal): Promise<string | undefined> {
  let failure = '';
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetchFn(url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS)]) });
      try {
        if (response.ok) return;
        failure = `HTTP ${response.status}`;
        if (response.status !== 408 && response.status !== 429 && response.status < 500) return failure;
      } finally { await response.body?.cancel(); }
    } catch (error) {
      signal.throwIfAborted();
      failure = probeFailure(error);
    }
    if (attempt + 1 < PROBE_ATTEMPTS) await pause(250 * (attempt + 1), signal);
  }
  return `${failure} after ${PROBE_ATTEMPTS} attempts`;
}

export async function discoverSplitGribRun(source: SplitSource,
  options: {
    readonly now?: Date;
    readonly baseUrl?: string;
    readonly fetchImpl?: typeof fetch;
    readonly signal?: AbortSignal;
    readonly cacheDir?: string;
  } = {}
): Promise<SplitGribDiscoveryResult> {
  options.signal?.throwIfAborted();
  const fetchFn = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? source.upstream.urlTemplate.split('/{cycleHour}')[0]!;
  const candidates = candidateSplitGribCycles(source, options.now);
  const DISCOVERY_TIMEOUT_MS = source.upstream.discoveryCandidates * DEFAULT_PROBE_TIMEOUT_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('Split GRIB discovery deadline exceeded')), DISCOVERY_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const failures: string[] = [];

  try {
    for (const cycle of candidates) {
      options.signal?.throwIfAborted();
      if (deadline.signal.aborted) break;
      const sentinelUrls = splitGribRunSentinelUrls(source, cycle, { baseUrl });
      let complete = true;
      for (let offset = 0; offset < sentinelUrls.length; offset += PROBE_CONCURRENCY) {
        options.signal?.throwIfAborted();
        const urls = sentinelUrls.slice(offset, offset + PROBE_CONCURRENCY);
        const probes = await Promise.allSettled(urls.map(url => probeSentinel(url, fetchFn, signal)));
        options.signal?.throwIfAborted();
        const failed = probes.flatMap((probe, index) => {
          const reason = probe.status === 'rejected' ? probeFailure(probe.reason) : probe.value;
          return reason ? [`${urls[index]}: ${reason}`] : [];
        });
        if (failed.length || deadline.signal.aborted) { failures.push(`${cycle}: ${failed.join(', ') || 'discovery deadline exceeded'}`); complete = false; break; }
      }
      if (complete) {
        return {
          schemaVersion: 1,
          model: source.model.modelId,
          cycle,
          forecastHours: source.model.forecast.hours,
          sentinelUrls
        };
      }
    }

    throw new Error(`No complete DWD Split GRIB regular-lat-lon main run found across candidate cycles${deadline.signal.aborted ? '; discovery deadline exceeded' : ''}: ${failures.join('; ')}`);
  } finally { clearTimeout(timer); }
}
