import { describe, expect, it, vi } from 'vitest';
import { candidateIconCycles, discoverIconEuRun, iconRunSentinelUrls } from './discover.js';
import { ICON_EU_FORECAST_HOURS, ICON_EU_HALF_LEVELS, ICON_EU_MODEL_LEVELS } from './constants.js';
import { formatIconRunStamp, iconRegularFieldUrl } from './fields.js';

const now = new Date('2026-10-08T16:00:00Z');
const cycles = candidateIconCycles(now);
const lastHour = ICON_EU_FORECAST_HOURS.at(-1)!;

describe('ICON-EU run admission', () => {
  it('probes every required surface field and both profile and half-level endpoints', () => {
    const urls = iconRunSentinelUrls(cycles[0]);
    expect(new Set(urls).size).toBe(urls.length);
    for (const field of ['PS', 'T_2M', 'QV_2M', 'MH', 'ASHFL_S', 'ALHFL_S']) {
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
  });
  it('bounds concurrent HEAD requests while admitting a complete run', async () => {
    let active = 0, maximum = 0, release = () => {}, occupied = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const full = new Promise<void>(resolve => { occupied = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      maximum = Math.max(maximum, ++active);
      expect(init?.method).toBe('HEAD');
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
