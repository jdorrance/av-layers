import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapForecastHorizonNotice, buildAgeMs, datasetRange, frameBadge, hostTimestampMs, longitudeOffsetHours, matchHostFrame, selectExplicitFrame, selectHostFrame, syncTimestampForFrame, watchBuildExpiry } from './index';

afterEach(() => vi.useRealTimers());

it('keeps the clock on its own side of the date line at exact boundaries', () => {
  expect([179.99, 180, 540, -179.99, -180, -540].map(longitudeOffsetHours)).toEqual([12, 12, 12, -12, -12, -12]);
});

it('expires at the deadline without waiting for the freshness interval', () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const expire = vi.fn(); const dispose = watchBuildExpiry(1000, expire, []);
  vi.advanceTimersByTime(999); expect(expire).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(expire).toHaveBeenCalledTimes(1);
  dispose();
});

it.each(['visibilitychange', 'pageshow', 'focus'])('checks expiry on %s after timer throttling', event => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const target = new EventTarget(), expire = vi.fn();
  const dispose = watchBuildExpiry(1000, expire, [target]);
  vi.setSystemTime(1001); target.dispatchEvent(new Event(event));
  expect(expire).toHaveBeenCalledTimes(1);
  vi.runAllTimers(); expect(expire).toHaveBeenCalledTimes(1);
  dispose();
});

it('cancels expiry timers and resume listeners on build replacement or teardown', () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const target = new EventTarget(), expire = vi.fn();
  const dispose = watchBuildExpiry(1000, expire, [target]); dispose();
  vi.setSystemTime(1001); target.dispatchEvent(new Event('pageshow')); vi.runAllTimers();
  expect(expire).not.toHaveBeenCalled();
});

const frames = [
  { id: 'f003', validTime: '2026-10-30T03:00:00.000Z', intervalStart: '2026-10-30T00:00:00.000Z', intervalEnd: '2026-10-30T06:00:00.000Z' },
  { id: 'f006', validTime: '2026-10-30T06:00:00.000Z', intervalStart: '2026-10-30T03:00:00.000Z', intervalEnd: '2026-10-30T09:00:00.000Z' },
  { id: 'f009', validTime: '2026-10-30T09:00:00.000Z', intervalStart: '2026-10-30T06:00:00.000Z', intervalEnd: '2026-10-30T12:00:00.000Z' }
];

it('calculates age from build creation rather than fetch time', () => {
  expect(buildAgeMs('2026-10-30T00:00:00.000Z', Date.parse('2026-10-30T06:00:00.000Z'))).toBe(6 * 3600_000);
  expect(buildAgeMs('2026-10-30T07:00:00.000Z', Date.parse('2026-10-30T06:00:00.000Z'))).toBe(0);
});

describe('frame selection', () => {
  it('selects an explicit frame by stable id only', () => {
    expect(selectExplicitFrame(frames, 'f006')?.validTime).toBe('2026-10-30T06:00:00.000Z');
    expect(selectExplicitFrame(frames, 'f007')).toBeNull();
  });

  it('matches a host timestamp only when it equals a frame', () => {
    expect(matchHostFrame(frames, Date.parse('2026-10-30T06:00:00.400Z'))?.id).toBe('f006');
    expect(matchHostFrame(frames, Date.parse('2026-10-30T04:00:00.000Z'))).toBeNull();
  });

  it('never substitutes the nearest frame for an off-frame host time', () => {
    const selected = selectExplicitFrame(frames, 'f003');
    const host = Date.parse('2026-10-30T04:59:00.000Z');
    expect(matchHostFrame(frames, host)).toBeNull();
    const badge = frameBadge(selected, null, host);
    expect(badge.kind).toBe('off-frame');
    expect(badge.text).toContain('f003');
  });

  it('follows the latest frame at or before the host time', () => {
    const at = (value: string) => Date.parse(value);
    expect(selectHostFrame(frames, at('2026-10-30T04:59:00.000Z'))?.id).toBe('f003');
    expect(selectHostFrame(frames, at('2026-10-30T06:00:00.000Z'))?.id).toBe('f006');
    expect(selectHostFrame(frames, at('2026-10-30T02:00:00.000Z'))?.id).toBe('f003');
    expect(selectHostFrame(frames, at('2026-10-30T18:00:00.000Z'))?.id).toBe('f009');
    expect(selectHostFrame([], at('2026-10-30T06:00:00.000Z'))).toBeNull();
    expect(selectHostFrame(frames, Number.NaN)).toBeNull();
  });

  it('reads host timestamps from milliseconds, seconds, numeric strings and Dates', () => {
    const ms = Date.parse('2026-10-30T06:00:00.000Z');
    expect(hostTimestampMs(ms)).toBe(ms);
    expect(hostTimestampMs(ms / 1000)).toBe(ms);
    expect(hostTimestampMs(String(ms / 1000))).toBe(ms);
    expect(hostTimestampMs(new Date(ms))).toBe(ms);
    expect(hostTimestampMs('  ')).toBeNull();
    expect(hostTimestampMs('soon')).toBeNull();
    expect(hostTimestampMs(Number.MAX_VALUE)).toBeNull();
    expect(hostTimestampMs(null)).toBeNull();
  });

  it('reports an in-frame host badge and an explicit badge without host time', () => {
    const selected = selectExplicitFrame(frames, 'f009');
    expect(frameBadge(selected, selected, Date.parse('2026-10-30T09:00:00.000Z')).kind).toBe('in-frame');
    expect(frameBadge(selected, null, null).kind).toBe('explicit');
  });
});

describe('host timestamp synchronization', () => {
  it('derives the plugin frame interval range', () => {
    expect(datasetRange(frames)).toEqual({
      startMs: Date.parse('2026-10-30T00:00:00.000Z'),
      endMs: Date.parse('2026-10-30T12:00:00.000Z')
    });
  });

  it('returns no range for missing or invalid frames', () => {
    expect(datasetRange([])).toBeNull();
    expect(datasetRange([{ ...frames[0], intervalEnd: frames[0].intervalStart }])).toBeNull();
  });

  it('syncs an explicit frame timestamp only inside the verified range', () => {
    const range = datasetRange(frames);
    expect(syncTimestampForFrame(frames[1], range)).toBe(Date.parse('2026-10-30T06:00:00.000Z'));
    expect(syncTimestampForFrame({ ...frames[1], validTime: '2026-10-30T18:00:00.000Z' }, range)).toBeNull();
  });

  it('does not sync when the dataset range is unavailable', () => {
    expect(syncTimestampForFrame(frames[0], null)).toBeNull();
    expect(syncTimestampForFrame(frames[0], { startMs: NaN, endMs: Infinity })).toBeNull();
    expect(syncTimestampForFrame(frames[0], { startMs: 2, endMs: 1 })).toBeNull();
  });
});

it('shows map forecast exhaustion at the last valid time, independently of interval ends or retention', () => {
  const manifest = { frames: [...frames].reverse() };
  const horizon = Date.parse('2026-10-30T09:00:00Z');
  expect(mapForecastHorizonNotice(manifest, horizon - 1)).toBeNull();
  expect(mapForecastHorizonNotice(manifest, horizon)).toContain('Map forecast ended at 2026-10-30T09:00:00.000Z');
  expect(mapForecastHorizonNotice(manifest, horizon + 6 * 3600_000)).toContain('Showing historical forecast');
});

it('uses the rendered prefix when the point forecast continues', () => {
  const manifest = { frames, version: 5, mapFrameCount: 2 };
  const horizon = Date.parse(frames[1].validTime);
  expect(mapForecastHorizonNotice(manifest, horizon - 1)).toBeNull();
  expect(mapForecastHorizonNotice(manifest, horizon)).toContain(`Map forecast ended at ${frames[1].validTime}`);
  expect(horizon).toBeLessThan(Date.parse(frames.at(-1)!.validTime));
});
