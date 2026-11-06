import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client-api';
import type { PointSeries } from './client-types';
import { fixturePointBuild, retainedPointBuild, fixturePointSample } from '../../../tests/client-point-fixture';

const point = { lat: 32.9, lon: -117.25 };
function setup() {
  const build = retainedPointBuild();
  const fetchImpl = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(fixturePointSample(build, String(input)))));
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
  return { build, fetchImpl, loader: api.pointSeries(build, point) };
}

describe('cached point forecast pages', () => {
  it('publishes the selected hour before the remaining 23-frame page and reuses the complete range', async () => {
    const { build, fetchImpl, loader } = setup(), selected = build.manifest.frames[19].id;
    const updates: PointSeries[] = [], totals: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fetchImpl.mockImplementation(async input => {
      if (fetchImpl.mock.calls.length === 2) await gate;
      return new Response(JSON.stringify(fixturePointSample(build, String(input))));
    });
    const pending = loader.load('day', undefined, { frameId: selected, onProgress(series, total) { updates.push(series); totals.push(total); } });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(updates).toHaveLength(1);
    expect(updates[0].frames.map(frame => frame.id)).toEqual([selected]);
    expect(updates[0].layers).toHaveLength(11);
    expect(totals).toEqual([24]);
    const requests = fetchImpl.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('frame')!.split(','));
    expect(requests.map(ids => ids.length)).toEqual([1, 23]);
    expect(requests[1]).not.toContain(selected);
    release();
    expect((await pending).frames).toHaveLength(24);
    expect(updates[1].frames.map(frame => frame.id)).toEqual(build.manifest.frames.slice(0, 24).map(frame => frame.id));
    await loader.load('day');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('loads all 40 irregular map frames through three bounded pages with the selected hour first', async () => {
    const hours = [...Array.from({ length: 24 }, (_, i) => i + 1), ...Array.from({ length: 16 }, (_, i) => 27 + i * 3)];
    const build = fixturePointBuild({ frameHours: [...hours, 75, 78], mapFrameCount: 40 });
    const fetchImpl = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(fixturePointSample(build, String(input)))));
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
    const progress = vi.fn(), loader = api.pointSeries(build, point);
    const series = await loader.load('day', undefined, { frameId: 'f072', onProgress: progress });
    expect(series.frames.map(frame => frame.id)).toEqual(hours.map(hour => `f${String(hour).padStart(3, '0')}`));
    expect(progress.mock.calls.map(([view, total]) => [view.frames.length, total])).toEqual([[1, 40], [24, 40], [40, 40]]);
    const frames = fetchImpl.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('frame')!.split(','));
    expect(frames.map(page => page.length)).toEqual([1, 23, 16]);
    expect(frames[0]).toEqual(['f072']);
    expect(frames.flat()).toHaveLength(new Set(frames.flat()).size);
    for (const page of frames) expect(page.length * 11).toBeLessThanOrEqual(256);
    expect((await loader.load('forecast')).frames).toHaveLength(42);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await loader.load('day');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('prioritizes a late native hour and stops further progress after close', async () => {
    const { fetchImpl, loader } = setup(), onProgress = vi.fn((_series: PointSeries, _total: number) => loader.dispose());
    await expect(loader.load('forecast', undefined, { frameId: 'f384', onProgress })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledOnce();
    const frame = onProgress.mock.calls[0]?.[0] as PointSeries | undefined;
    expect(frame?.frames.map(value => value.id)).toEqual(['f384']);
    expect(frame?.frames[0].layers['usable-lift-msl']).toMatchObject({ value: null, status: 'unavailable' });
    expect(frame?.frames[0].layers['thermal-top-msl']).toMatchObject({ value: 2500, status: 'valid' });
  });

  it('reaches the complete native horizon through validated bounded scalar pages and reuses both ranges', async () => {
    const { build, fetchImpl, loader } = setup();
    const day = await loader.load('day'), full = await loader.load('forecast');
    expect(day.frames.length).toBeLessThan(full.frames.length);
    expect(full.frames).toHaveLength(build.manifest.frames.length);
    expect(full.frames.at(-1)?.validTime).toBe(new Date(Date.parse(build.manifest.cycle) + 384 * 3600000).toISOString());
    expect(full.frames.length * full.layers.length).toBeGreaterThan(256);
    expect(full).not.toHaveProperty('version');
    expect(Object.keys(full).sort()).toEqual(['frames', 'layers']);
    for (const [input] of fetchImpl.mock.calls) {
      const url = new URL(String(input));
      expect(url.pathname).toMatch(/\/sample$/);
      expect(url.searchParams.get('frame')!.split(',').length * url.searchParams.get('layers')!.split(',').length).toBeLessThanOrEqual(256);
    }
    const last = full.frames.at(-1)!;
    expect(last.layers['usable-lift-msl']).toMatchObject({ status: 'unavailable', value: null });
    expect(last.layers['thermal-top-msl']).toMatchObject({ status: 'valid', value: 2500 });
    expect(last.layers['cloud-cover-total']).toMatchObject({ status: 'valid', value: 0 });
    const calls = fetchImpl.mock.calls.length;
    expect((await loader.load('day')).frames).toEqual(day.frames);
    expect((await loader.load('forecast')).frames).toEqual(full.frames);
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  });

  it('cancels a superseded range, serializes reads and preserves completed frames', async () => {
    const { build, fetchImpl, loader } = setup();
    let active = 0, peak = 0;
    fetchImpl.mockImplementation(async (input, init) => {
      active++; peak = Math.max(peak, active);
      try {
        if (fetchImpl.mock.calls.length === 2) await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
        return new Response(JSON.stringify(fixturePointSample(build, String(input))));
      } finally { active--; }
    });
    const full = loader.load('forecast');
    const rejected = expect(full).rejects.toThrow();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const day = await loader.load('day');
    await rejected;
    expect(day.frames.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await loader.load('forecast');
    expect(peak).toBe(1);
    const initialIds = new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('frame')!.split(',');
    expect(fetchImpl.mock.calls.slice(2).every(([input]) => new URL(String(input)).searchParams.get('frame')!.split(',').every(id => !initialIds.includes(id)))).toBe(true);
  });

  it('rejects a selection exceeding the page budget before transfer and disposes the point cache', async () => {
    const { build, fetchImpl, loader } = setup();
    build.manifest.descriptors.maxSampleValues = 11;
    await expect(loader.load('forecast')).rejects.toThrow('page budget exceeded');
    expect(fetchImpl).not.toHaveBeenCalled();
    loader.dispose();
    await expect(loader.load('day')).rejects.toThrow('closed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('aborts the active page when its point is closed', async () => {
    const { fetchImpl, loader } = setup();
    let signal: AbortSignal | null | undefined;
    fetchImpl.mockImplementation(async (_input, init) => {
      signal = init?.signal;
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal?.reason), { once: true }));
    });
    const pending = loader.load('forecast'), rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(signal?.aborted).toBe(false));
    loader.dispose();
    await rejected;
    expect(signal?.aborted).toBe(true);
    await expect(loader.load('day')).rejects.toThrow('closed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['model', 'buildId', 'cycle', 'expiresAt', 'method-id', 'method-hash', 'manifest'] as const)('rejects changed %s before reading its warm cache', async key => {
    const { build, fetchImpl, loader } = setup();
    await loader.load('day');
    const calls = fetchImpl.mock.calls.length;
    if (key === 'model') build.manifest.model = 'rrfs';
    else if (key === 'buildId') build.manifest.buildId = 'different-build';
    else if (key === 'expiresAt') build.manifest.expiresAt = '2099-01-01T00:00:00.000Z';
    else if (key === 'cycle') build.manifest.cycle = '2026-11-01T00:00:00.000Z';
    else if (key === 'method-id') build.manifest.method.id = 'changed-method';
    else if (key === 'method-hash') build.manifest.method.hash = 'f'.repeat(64);
    else build.manifest = structuredClone(build.manifest);
    await expect(loader.load('day')).rejects.toThrow('pinned build changed');
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  });

  it('rejects in-flight method drift before inserting that page into the cache', async () => {
    const { build, fetchImpl, loader } = setup(), original = { ...build.manifest.method };
    fetchImpl.mockImplementationOnce(async input => {
      build.manifest.method = { ...original, hash: 'f'.repeat(64) };
      const payload = fixturePointSample(build, String(input));
      payload.frames[0].layers['thermal-top-msl'].value = 9999;
      return new Response(JSON.stringify(payload));
    });
    await expect(loader.load('day')).rejects.toThrow('pinned build changed');
    build.manifest.method = original;
    const recovered = await loader.load('day');
    expect(recovered.frames[0].layers['thermal-top-msl'].value).toBe(2500);
    const first = new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('frame');
    expect(new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get('frame')).toBe(first);
  });
});
