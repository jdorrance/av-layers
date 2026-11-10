import type { PointFrame, pointMapLift } from '@av/client';
import type { WindgramReading } from './scene-types.ts';
import { METRES_PER_THOUSAND_FEET } from './windgram-format.ts';

export interface FieldNode {
  readonly altitudeM: number;
  readonly value: number;
}

export interface HourSampling {
  readonly validAt: string;
  readonly temperatureC: readonly FieldNode[];
  readonly dewPointC: readonly FieldNode[];
  readonly lapseCPer1000Ft: readonly FieldNode[];
  readonly relativeHumidityPercent: readonly FieldNode[];
  readonly windU: readonly FieldNode[];
  readonly windV: readonly FieldNode[];
  readonly verticalVelocityPaS: readonly FieldNode[];
}

export interface PublishedForecastHour {
  readonly validAt: string;
  readonly modelTerrainM: number | null;
  readonly mapLift: ReturnType<typeof pointMapLift>;
  readonly surface: {
    readonly temperatureC: number | null;
    readonly dewPointC: number | null;
    readonly windSpeedMps: number | null;
    readonly windDirectionDeg: number | null;
    readonly windU: number | null;
    readonly windV: number | null;
    readonly windGustMps: number | null;
    readonly precipitationMmHr: number | null;
    readonly capeJkg: number | null;
    readonly pblHeightM: number | null;
  };
  readonly levels: Readonly<NonNullable<PointFrame['profile']>['levels']>;
  readonly thermalTopM: number | null;
  readonly thermalVelocityMps: number | null;
  readonly surfaceLclM: number | null;
  readonly effectiveCloudLimitM: number | null;
  readonly layerWind: WindgramReading['publishedLayerWind'];
}

export interface SiteForecast {
  readonly model: string;
  readonly site: {
    readonly latitude: number;
    readonly longitude: number;
    readonly timeZone: string;
  };
  readonly semantics: {
    readonly gust: 'hourMax' | 'instant' | null;
    readonly precipitation: 'instantRate' | 'windowMeanRate' | null;
  };
  readonly hours: readonly PublishedForecastHour[];
}

/** Environmental temperature gradient in °C per 1,000 ft between two level samples. */
export function lapseRateCPer1000Ft(
  lower: { readonly heightM: number; readonly temperatureC: number },
  upper: { readonly heightM: number; readonly temperatureC: number }
): number | null {
  const dz = upper.heightM - lower.heightM;
  if (!(dz > 0) || !Number.isFinite(lower.temperatureC) || !Number.isFinite(upper.temperatureC)) return null;
  return ((upper.temperatureC - lower.temperatureC) / dz) * METRES_PER_THOUSAND_FEET;
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
/** Format an ISO timestamp as YYYY-MM-DD in the given IANA timeZone. */
export function localDateKey(iso: string, timeZone: string): string {
  let formatter = dateFormats.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFormats.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(iso));
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const instantFormats = new Map<string, Intl.DateTimeFormat>();
/** Convert a local clock time to UTC milliseconds. */
export function localInstantMs(dateKey: string, hour: number, timeZone: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  const targetUtc = Date.UTC(y!, m! - 1, d!, 0, 0, 0) + hour * 3_600_000;
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return targetUtc;
  let formatter = instantFormats.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      second: '2-digit', hourCycle: 'h23'
    });
    instantFormats.set(timeZone, formatter);
  }
  const localWallMs = (utcMs: number): number => {
    const parts = formatter!.formatToParts(new Date(utcMs));
    const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  };
  let guess = targetUtc;
  for (let i = 0; i < 3; i++) {
    const diff = targetUtc - localWallMs(guess);
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}
