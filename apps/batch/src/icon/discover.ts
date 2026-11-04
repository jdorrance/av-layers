import { DEFAULT_PROBE_TIMEOUT_MS } from '@av/contracts';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ICON_EU_BASE_URL,
  ICON_EU_CYCLE_HOURS_UTC,
  ICON_EU_DISCOVERY_CANDIDATES,
  ICON_EU_DISCOVERY_LAG_HOURS,
  ICON_EU_FORECAST_HOURS,
  ICON_EU_HALF_LEVELS,
  ICON_EU_MODEL_LEVELS
} from './constants.js';
import { iconRegularFieldUrl, validateIconCycle } from './fields.js';

const PROBE_CONCURRENCY = 4;
const PROBE_ATTEMPTS = 3;
const DISCOVERY_TIMEOUT_MS = ICON_EU_DISCOVERY_CANDIDATES * DEFAULT_PROBE_TIMEOUT_MS;

export interface IconDiscoveryResult {
  readonly schemaVersion: 1;
  readonly model: 'icon-eu';
  readonly cycle: string;
  readonly forecastHours: readonly number[];
  readonly sentinelUrls: readonly string[];
}

export function candidateIconCycles(
  now = new Date(),
  lagHours = ICON_EU_DISCOVERY_LAG_HOURS,
  count = ICON_EU_DISCOVERY_CANDIDATES
): string[] {
  const cycleStepHours = 24 / ICON_EU_CYCLE_HOURS_UTC.length;
  const anchorMs = now.getTime() - lagHours * 3_600_000;
  const anchor = new Date(anchorMs);
  const alignedHour = Math.floor(anchor.getUTCHours() / cycleStepHours) * cycleStepHours;
  const latest = Date.UTC(
    anchor.getUTCFullYear(),
    anchor.getUTCMonth(),
    anchor.getUTCDate(),
    alignedHour,
    0,
    0,
    0
  );
  const candidates: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const candidate = new Date(latest - i * cycleStepHours * 3_600_000);
    if (ICON_EU_CYCLE_HOURS_UTC.includes(candidate.getUTCHours())) {
      candidates.push(candidate.toISOString());
    }
  }
  return candidates;
}

/**
 * Sentinel URLs that must be present on DWD Open Data before a 00/06/12/18 UTC
 * ICON-EU main run is admitted. Probes cover field families and profile endpoints;
 * acquisition still checks every required object.
 */
export function iconRunSentinelUrls(
  cycleIso: string,
  options: {
    readonly lastForecastHour?: number;
    readonly baseUrl?: string;
  } = {}
): string[] {
  const cycle = validateIconCycle(cycleIso);
  const lastHour = options.lastForecastHour ?? ICON_EU_FORECAST_HOURS.at(-1)!;
  const topHalfLevel = ICON_EU_HALF_LEVELS[0]!;
  const bottomHalfLevel = ICON_EU_HALF_LEVELS.at(-1)!;
  const lowestLevel = ICON_EU_MODEL_LEVELS[0]!;
  const highestLevel = ICON_EU_MODEL_LEVELS.at(-1)!;
  return [
    iconRegularFieldUrl('HSURF', cycle, { baseUrl: options.baseUrl }),
    ...[topHalfLevel, bottomHalfLevel].map(level => iconRegularFieldUrl('HHL', cycle, { level, baseUrl: options.baseUrl })),
    ...['PS', 'T_2M', 'QV_2M', 'ASHFL_S', 'ALHFL_S'].map(field => iconRegularFieldUrl(field, cycle, { hour: lastHour, baseUrl: options.baseUrl })),
    ...['T', 'P'].flatMap(field => [lowestLevel, highestLevel].map(level => iconRegularFieldUrl(field, cycle, { hour: lastHour, level, baseUrl: options.baseUrl })))
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
    if (attempt + 1 < PROBE_ATTEMPTS) await delay(250 * (attempt + 1), undefined, { signal });
  }
  return `${failure} after ${PROBE_ATTEMPTS} attempts`;
}

export async function discoverIconEuRun(
  options: {
    readonly now?: Date;
    readonly baseUrl?: string;
    readonly fetchImpl?: typeof fetch;
    readonly signal?: AbortSignal;
    readonly cacheDir?: string;
  } = {}
): Promise<IconDiscoveryResult> {
  options.signal?.throwIfAborted();
  const fetchFn = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? ICON_EU_BASE_URL;
  const candidates = candidateIconCycles(options.now);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('ICON-EU discovery deadline exceeded')), DISCOVERY_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const failures: string[] = [];

  try {
    for (const cycle of candidates) {
      options.signal?.throwIfAborted();
      if (deadline.signal.aborted) break;
      const sentinelUrls = iconRunSentinelUrls(cycle, { baseUrl });
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
          model: 'icon-eu',
          cycle,
          forecastHours: ICON_EU_FORECAST_HOURS,
          sentinelUrls
        };
      }
    }

    throw new Error(`No complete DWD ICON-EU regular-lat-lon main run found across candidate cycles${deadline.signal.aborted ? '; discovery deadline exceeded' : ''}: ${failures.join('; ')}`);
  } finally { clearTimeout(timer); }
}
