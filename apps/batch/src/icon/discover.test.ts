import { describe, expect, it, vi } from 'vitest';
import { candidateIconCycles, discoverIconEuRun, iconRunSentinelUrls } from './discover.js';
import { ICON_EU_DISCOVERY_CANDIDATES, ICON_EU_FORECAST_HOURS, ICON_EU_HALF_LEVELS, ICON_EU_MODEL_LEVELS } from './constants.js';
import { formatIconRunStamp, iconRegularFieldUrl } from './fields.js';
import { DEFAULT_PROBE_TIMEOUT_MS } from '@av/contracts';

const now = new Date('2026-10-08T16:00:00Z');
const cycles = candidateIconCycles(now);
const lastHour = ICON_EU_FORECAST_HOURS.at(-1)!;

describe('ICON-EU run admission', () => {
  it('probes every required surface field and both profile and half-level endpoints', () => {
    const urls = iconRunSentinelUrls(cycles[0]);
    expect(new Set(urls).size).toBe(urls.length);
    for (const field of ['PS', 'T_2M', 'QV_2M', 'ASHFL_S', 'ALHFL_S']) {
      expect(urls).toContain(iconRegularFieldUrl(field, cycles[0], { hour: lastHour }));
    }
    for (const field of ['T', 'P']) for (const level of [ICON_EU_MODEL_LEVELS[0], ICON_EU_MODEL_LEVELS.at(-1)]) {
      expect(urls).toContain(iconRegularFieldUrl(field, cycles[0], { hour: lastHour, level }));
    }
    for (const level of [ICON_EU_HALF_LEVELS[0], ICON_EU_HALF_LEVELS.at(-1)]) {
      expect(urls).toContain(iconRegularFieldUrl('HHL', cycles[0], { level }));
    }
  });
  it.each(['PS', 'T_2M', 'QV_2M', 'T', 'P', 'HHL'])('skips a run with a missing %s endpoint', async field => {
    const level = field === 'T' ? ICON_EU_MODEL_LEVELS.at(-1) : field === 'P' ? ICON_EU_MODEL_LEVELS[0] : field === 'HHL' ? ICON_EU_HALF_LEVELS[0] : undefined;
    const missing = iconRegularFieldUrl(field, cycles[0], { hour: lastHour, level });
    const fetchImpl = vi.fn<typeof fetch>(async input => new Response(null, { status: String(input) === missing ? 404 : 200 }));
    const result = await discoverIconEuRun({ now, fetchImpl });
    expect(result.cycle).toBe(cycles[1]);
    expect(fetchImpl.mock.calls.some(([input]) => String(input) === missing)).toBe(true);
    expect(fetchImpl.mock.calls.filter(([input]) => String(input) === missing)).toHaveLength(1);
  });
  it('bounds concurrent one-byte GET probes while admitting a complete run', async () => {
    let active = 0, maximum = 0, release = () => {}, occupied = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const full = new Promise<void>(resolve => { occupied = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      maximum = Math.max(maximum, ++active);
      expect(init?.method ?? 'GET').toBe('GET');
      expect(new Headers(init?.headers).get('Range')).toBe('bytes=0-0');
      if (active === 4) occupied();
      try { await gate; return new Response(null); } finally { active--; }
    });
    const pending = discoverIconEuRun({ now, fetchImpl });
    await full;
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    release();
    const result = await pending;
    expect(maximum).toBe(4);
    expect(active).toBe(0);
    expect(result.cycle).toBe(cycles[0]);
    expect(fetchImpl).toHaveBeenCalledTimes(iconRunSentinelUrls(cycles[0]).length);
  });
  it.each(['transport', 408, 429, 503])('retries a transient %s probe before abandoning the latest run', async failure => {
    const sentinel = iconRunSentinelUrls(cycles[0])[0], cancelled: ReturnType<typeof vi.fn>[] = [];
    let attempts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const retry = String(input) === sentinel && ++attempts <= 2;
      if (retry && failure === 'transport') throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect timed out'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
      const cancel = vi.fn(); cancelled.push(cancel);
      return new Response(new ReadableStream({ cancel }), { status: retry ? Number(failure) : 200 });
    });
    expect((await discoverIconEuRun({ now, fetchImpl })).cycle).toBe(cycles[0]);
    expect(attempts).toBe(3);
    expect(fetchImpl.mock.calls.every(([input]) => String(input).includes(formatIconRunStamp(cycles[0]).runStamp))).toBe(true);
    expect(cancelled.every(cancel => cancel.mock.calls.length === 1)).toBe(true);
  });
  it('cancels missing-object response bodies before checking an older cycle', async () => {
    const sentinel = iconRunSentinelUrls(cycles[0])[0], cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async input => String(input) === sentinel
      ? new Response(new ReadableStream({ cancel }), { status: 404 }) : new Response(null));
    expect((await discoverIconEuRun({ now, fetchImpl })).cycle).toBe(cycles[1]);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('reports exhausted probe URLs and transport causes for each candidate cycle', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect timed out'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }); });
    const error = await discoverIconEuRun({ now, fetchImpl }).catch(error => error);
    expect(error.message).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(error.message).toContain('after 3 attempts');
    for (const cycle of cycles) expect(error.message).toContain(iconRunSentinelUrls(cycle)[0]);
    expect(fetchImpl).toHaveBeenCalledTimes(cycles.length * 4 * 3);
  });
  it('bounds discovery time across retries and candidate cycles', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      }));
      const pending = discoverIconEuRun({ now, fetchImpl }).catch(error => error);
      await vi.advanceTimersByTimeAsync(DEFAULT_PROBE_TIMEOUT_MS * ICON_EU_DISCOVERY_CANDIDATES);
      expect((await pending).message).toContain('discovery deadline exceeded');
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('rejects a deadline that expires while cancelling the final successful response', async () => {
    vi.useFakeTimers();
    try {
      const last = iconRunSentinelUrls(cycles[0]).at(-1);
      const fetchImpl = vi.fn<typeof fetch>(async input => new Response(new ReadableStream({ cancel() {
        if (String(input) === last) vi.advanceTimersByTime(DEFAULT_PROBE_TIMEOUT_MS * ICON_EU_DISCOVERY_CANDIDATES);
      } })));
      await expect(discoverIconEuRun({ now, fetchImpl })).rejects.toThrow('discovery deadline exceeded');
    } finally { vi.useRealTimers(); }
  });
  it('cancels retry backoff before issuing another attempt', async () => {
    const controller = new AbortController();
    let released = () => {};
    const responseCancelled = new Promise<void>(resolve => { released = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel: released }), { status: 503 }));
    const pending = discoverIconEuRun({ now, fetchImpl, signal: controller.signal });
    await responseCancelled;
    controller.abort(new Error('cancel retry'));
    await expect(pending).rejects.toThrow('cancel retry');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it('cancels active probes without admitting another batch or older cycle', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const pending = discoverIconEuRun({ now, fetchImpl, signal: controller.signal });
    controller.abort(new Error('cancel discovery'));
    await expect(pending).rejects.toThrow('cancel discovery');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls.every(([input]) => String(input).includes(formatIconRunStamp(cycles[0]).runStamp))).toBe(true);
  });
});
