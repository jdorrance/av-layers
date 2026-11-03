import { DEFAULT_PROBE_TIMEOUT_MS } from '@av/contracts';
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
 * ICON-EU main run is admitted for acquisition. Includes `MH` at the last forecast
 * hour because DWD publishes mixing height after model-level and flux fields.
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
  const bottomHalfLevel = ICON_EU_HALF_LEVELS.at(-1)!;
  const lowestLevel = ICON_EU_MODEL_LEVELS[0]!;
  const highestLevel = ICON_EU_MODEL_LEVELS.at(-1)!;
  return [
    iconRegularFieldUrl('HSURF', cycle, { baseUrl: options.baseUrl }),
    iconRegularFieldUrl('HHL', cycle, { level: bottomHalfLevel, baseUrl: options.baseUrl }),
    iconRegularFieldUrl('T', cycle, { hour: lastHour, level: lowestLevel, baseUrl: options.baseUrl }),
    iconRegularFieldUrl('P', cycle, { hour: lastHour, level: highestLevel, baseUrl: options.baseUrl }),
    iconRegularFieldUrl('ASHFL_S', cycle, { hour: lastHour, baseUrl: options.baseUrl }),
    iconRegularFieldUrl('ALHFL_S', cycle, { hour: lastHour, baseUrl: options.baseUrl }),
    iconRegularFieldUrl('MH', cycle, { hour: lastHour, baseUrl: options.baseUrl })
  ];
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

  for (const cycle of candidates) {
    options.signal?.throwIfAborted();
    const sentinelUrls = iconRunSentinelUrls(cycle, { baseUrl });
    const probes = await Promise.allSettled(
      sentinelUrls.map(url => {
        const timeout = AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS);
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        return fetchFn(url, { method: 'HEAD', signal });
      })
    );
    options.signal?.throwIfAborted();
    if (probes.every(p => p.status === 'fulfilled' && p.value.ok)) {
      return {
        schemaVersion: 1,
        model: 'icon-eu',
        cycle,
        forecastHours: ICON_EU_FORECAST_HOURS,
        sentinelUrls
      };
    }
  }

  throw new Error('No complete DWD ICON-EU regular-lat-lon main run found across candidate cycles');
}
