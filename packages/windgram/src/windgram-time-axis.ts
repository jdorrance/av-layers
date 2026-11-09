// Calendar, daylight windowing, and time-axis layout for Windgram charts.
// Keeps `timeAxis` (which includes unavailable daylight ticks) distinct from
// `hours` and `sampling` (which contain real forecast source data).

import { sunriseSunsetInRange } from '@av/solar';
import { localDateKey, localInstantMs, type SiteForecast } from './internal-meteo.ts';
import type { WindgramHourFilterOptions } from './scene-types.ts';
import { WINDGRAM_PRESENTATION, type WindgramPresentation } from './windgram-presentation.ts';

type ProfileHour = SiteForecast['hours'][number];
const DAYLIGHT_CACHE_LIMIT = 16;
const daylightCache = new Map<string, ReturnType<typeof sunriseSunsetInRange>>();

export interface WindgramTimeTick {
  validAt: string;
  label: string;
  x: number;
  hourIndex: number | null;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Position an interpolated sample between the actual frame times. */
export function hourX(hours: readonly { x: number }[], position: number, columnWidth: number): number {
  const last = hours.length - 1;
  if (position <= 0) return hours[0].x + position * columnWidth;
  if (position >= last) return hours[last].x + (position - last) * columnWidth;
  const lower = Math.floor(position);
  return hours[lower].x + (position - lower) * (hours[lower + 1].x - hours[lower].x);
}

/** Thin display marks inside the plot, retaining the first and last visible samples. */
export function visibleWindgramHourIndices(
  view: { hours: readonly { x: number }[]; compact: boolean; left?: number; plotWidth?: number },
  minimumSpacingPx: number = WINDGRAM_PRESENTATION.glyphs.minimumHorizontalSpacing,
): number[] {
  const selected: number[] = [];
  let lastIndex = -1;
  for (const [i, hour] of view.hours.entries()) {
    if (view.left !== undefined && view.plotWidth !== undefined && (hour.x < view.left || hour.x > view.left + view.plotWidth)) continue;
    lastIndex = i;
    if (!selected.length || hour.x - view.hours[selected.at(-1)!].x >= minimumSpacingPx) selected.push(i);
  }
  if (selected.length > 1 && selected.at(-1) !== lastIndex) selected[selected.length - 1] = lastIndex;
  return selected;
}

export function daylightForDate(profile: SiteForecast, dateKey: string, timeZone: string) {
  const { latitude, longitude } = profile.site;
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;
  const key = `${latitude},${longitude},${dateKey},${timeZone}`;
  const cached = daylightCache.get(key);
  if (cached !== undefined) return cached;
  // Resolve both midnights locally: DST days can have 23 or 25 hours.
  const daylight = sunriseSunsetInRange(latitude, longitude, localInstantMs(dateKey, 0, timeZone), localInstantMs(dateKey, 24, timeZone));
  if (daylightCache.size >= DAYLIGHT_CACHE_LIMIT) daylightCache.delete(daylightCache.keys().next().value!);
  daylightCache.set(key, daylight);
  return daylight;
}

function spansLocalDates(hours: readonly ProfileHour[], timeZone: string): boolean {
  return hours.length > 1 && localDateKey(hours[0].validAt, timeZone) !== localDateKey(hours.at(-1)!.validAt, timeZone);
}

/** Sunrise through sunset, bracketed by available forecast samples.
 * A multi-day profile stays contiguous so its controls retain their time indices.
 * Explicit dates with only nighttime data retain an empty daylight frame.
 * Polar days/nights and undated forecasts outside daylight retain their hours.
 */
export function selectWindgramHours(profile: SiteForecast, options: WindgramHourFilterOptions) {
  const window = options.hours;
  const selected = Array.isArray(window) ? new Set(window.map((h) => h.validAt)) : null;
  const dayWindow = window && !Array.isArray(window) && 'dateKey' in window ? window : null;
  const hours = profile.hours.filter(
    (h) => (!selected || selected.has(h.validAt)) && (!dayWindow || localDateKey(h.validAt, dayWindow.timeZone) === dayWindow.dateKey),
  );
  const daySource = dayWindow ? hours : null;
  const timeZone = dayWindow?.timeZone ?? options.timeZone;
  const dateKey = dayWindow?.dateKey ?? (hours.length && !selected && !spansLocalDates(hours, timeZone)
    ? localDateKey(hours[0].validAt, timeZone) : null);
  const daylight = dateKey ? daylightForDate(profile, dateKey, timeZone) : null;
  if (!hours.length || !daylight) return { hours, daySource, daylight };
  const times = hours.map(hour => Date.parse(hour.validAt));
  const start = daylight.sunrise, end = daylight.sunset;
  if (times.at(-1)! < start || times[0] > end) return { hours: dayWindow ? [] : hours, daySource, daylight };
  let first = times.length - 1;
  while (first > 0 && times[first] > start) first--;
  const last = times.findIndex(time => time >= end);
  return { hours: hours.slice(first, last < 0 ? hours.length : last + 1), daySource, daylight };
}

export function formatWindgramHourLabel(validAtOrMs: string | number, labelTime: Intl.DateTimeFormat): string {
  return labelTime.format(new Date(validAtOrMs)).replace(/\s/g, '').replace(':00', '').replace('AM', 'a').replace('PM', 'p');
}

/**
 * Computes daylight-aware horizontal layout and `timeAxis` ticks (including empty pre/post
 * daylight columns outside the run's coverage at every screen width).
 */
export function buildWindgramTimeLayout(
  profile: SiteForecast,
  { hours, daySource, daylight }: ReturnType<typeof selectWindgramHours>,
  presentation: WindgramPresentation,
) {
  const stepSource = hours.length > 1 ? hours : daySource && daySource.length > 1 ? daySource : profile.hours;
  const steps = stepSource
    .slice(1)
    .map((hour, i) => Date.parse(hour.validAt) - Date.parse(stepSource[i].validAt))
    .filter(step => step > 0);
  const cadence = steps.length ? median(steps) : 3_600_000;
  const firstTime = Date.parse(hours[0]?.validAt ?? '');
  const lastTime = Date.parse(hours.at(-1)?.validAt ?? '');
  const overlapsDaylight = Boolean(daylight && firstTime <= daylight.sunset && lastTime >= daylight.sunrise);
  const before = overlapsDaylight && daylight ? Math.max(0, Math.ceil((firstTime - daylight.sunrise) / cadence)) : 0;
  const after = overlapsDaylight && daylight ? Math.max(0, Math.ceil((daylight.sunset - lastTime) / cadence)) : 0;
  const emptyTimes: number[] = [];
  if (!hours.length && daylight && daySource) {
    const sourceTime = Date.parse(profile.hours[0]?.validAt ?? '');
    const alignment = Number.isFinite(sourceTime) ? sourceTime : 0;
    const start = alignment + Math.floor((daylight.sunrise - alignment) / cadence) * cadence;
    const end = alignment + Math.ceil((daylight.sunset - alignment) / cadence) * cadence;
    for (let time = start; time <= end; time += cadence) emptyTimes.push(time);
  }
  const { left, right, top, plotWidth } = presentation;
  if (hours.length) {
    for (let i = before; i > 0; i--) emptyTimes.push(firstTime - i * cadence);
    for (let i = 1; i <= after; i++) emptyTimes.push(lastTime + i * cadence);
  }
  const crop = daylight && (overlapsDaylight || emptyTimes.length);
  const start = crop ? daylight.sunrise : (Number.isFinite(firstTime) ? firstTime : 0) - cadence / 2;
  const end = crop ? daylight.sunset : (Number.isFinite(lastTime) ? lastTime : 0) + cadence / 2;
  const columnWidth = plotWidth * cadence / (end > start ? end - start : cadence);
  const xAt = (time: number) => left + (time - start) / cadence * columnWidth;
  return { left, right, top, columnWidth, plotWidth, xAt, emptyTimes };
}
