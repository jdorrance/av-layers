import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client-api';
import { MAX_POINT_RESPONSE_BYTES, estimateProfileResponseBytes, manifestV5Schema, maxProfileFrames } from './index';
import { pointLiftExpectation, pointSeriesSelection } from './client-point';
import type { PointSeries } from './client-types';
import { fixturePointBuild, fixturePointFetch, fixtureProfileBuild, retainedProfileBuild, retainedPointBuild, retainedLegacyPointBuild, fixturePointSample } from '../../../tests/client-point-fixture';

const point = { lat: 32.9, lon: -117.25 };
function setup() {
  const build = retainedPointBuild();
  const fetchImpl = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(fixturePointSample(build, String(input)))));
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
  return { build, fetchImpl, loader: api.pointSeries(build, point) };
}

describe('cached point forecast pages', () => {
  it.each([3, 4] as const)('keeps the v%s day selection within 24 hours while preserving its full forecast', async version => {
    const build = retainedLegacyPointBuild(version), m = build.manifest;
    if (m.version === 5) throw new Error('Expected legacy manifest');
    expect(pointSeriesSelection(build).frames).toEqual(m.frames.slice(0, 24).map(frame => frame.id));
    expect(pointSeriesSelection(build, 'forecast').frames.at(-1)).toBe('f384');
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input)), ids = url.searchParams.get('frame')!.split(','), layers = url.searchParams.get('layers')!.split(',');
      return new Response(JSON.stringify({ model: m.model, buildId: m.buildId, ...point, method: m.method, source: m.source,
        expiresAt: m.expiresAt, coverage: m.coverage, frames: m.frames.filter(frame => ids.includes(frame.id)).map(frame => ({
          ...frame, layers: Object.fromEntries(layers.map(layer => [layer, { value: 500, status: 'valid', support: 0, interpolated: false }]))
        })) }));
    });
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(m.createdAt) });
    expect((await api.pointSeries(build, point).load('day')).frames).toHaveLength(24);
    expect(fetchImpl.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('frame')!.split(',').length)).toEqual([1, 23]);
  });

  it('pages native profiles within the byte budget and merges fine-surface lift', async () => {
    const max = maxProfileFrames(30, 24);
    expect(estimateProfileResponseBytes(max, 30, 24)).toBeLessThanOrEqual(MAX_POINT_RESPONSE_BYTES);
    expect(estimateProfileResponseBytes(max + 1, 30, 24)).toBeGreaterThan(MAX_POINT_RESPONSE_BYTES);
    const build = retainedProfileBuild(), m = build.manifest;
    if (m.version !== 5) throw new Error('Expected v5');
    const urls: URL[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      urls.push(new URL(String(input)));
      return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
    });
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(m.createdAt) });
    const series = await api.pointSeries(build, point).load('forecast');
    const profiles = urls.filter(url => url.pathname.endsWith('/profile'));
    expect(profiles.length).toBeGreaterThan(1);
    for (const url of profiles) {
      const frames = url.searchParams.get('frame')!.split(','), layers = url.searchParams.get('layers')!.split(',');
      expect(estimateProfileResponseBytes(frames.length, 4, layers.length)).toBeLessThanOrEqual(MAX_POINT_RESPONSE_BYTES);
      expect(layers).not.toContain('mslp-hpa');
      expect(layers).not.toContain('sensible-heat-flux');
      expect(layers).not.toContain('latent-heat-flux');
    }
    const fineFrames = urls.filter(url => url.pathname.endsWith('/sample')).flatMap(url => url.searchParams.get('frame')!.split(','));
    expect(fineFrames).toEqual(m.frames.slice(0, m.mapFrameCount).map(frame => frame.id));
    expect(series.frames.every(frame => frame.profile?.status === 'valid' && frame.derived !== undefined)).toBe(true);
    expect(series.frames[0]?.layers['usable-lift-msl']).toMatchObject({ surfaceId: 'gfs-fine' });
    expect(series.frames.at(-1)?.layers['usable-lift-msl']).toBeUndefined();
    expect(series.layers).toContain('usable-lift-msl');
    expect(series.layers).not.toContain('cloud-cover-total');
    expect(pointSeriesSelection(build, 'forecast').layers).toEqual(series.layers);
  });

  it.each([{ lift: [] }, { lift: ['usable-lift-agl'] }] as const)('requests only the lift channels a profiled build publishes ($lift)', async ({ lift }) => {
    const build = fixtureProfileBuild({ layers: ['precip-rate', ...lift], frameHours: [1, 2], mapFrameCount: 1 });
    manifestV5Schema.parse(build.manifest);
    const fetchImpl = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(fixturePointFetch(build, String(input)))));
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
    const series = await api.pointSeries(build, point).load('forecast');
    const samples = fetchImpl.mock.calls.map(([input]) => new URL(String(input))).filter(url => url.pathname.endsWith('/sample'));
    expect(pointLiftExpectation(build)).toEqual({ layers: lift, frames: new Set(lift.length ? ['f001'] : []) });
    expect(samples.map(url => [url.searchParams.get('frame'), url.searchParams.get('layers')])).toEqual(lift.length ? [['f001', lift[0]]] : []);
    expect(series.layers).toEqual([...lift, 'precip-rate']);
    expect(series.frames.map(frame => frame.profile?.status)).toEqual(['valid', 'valid']);
    expect(series.frames[0].layers['usable-lift-agl']?.value).toBe(lift.length ? 500 : undefined);
    expect(series.frames[1].layers['usable-lift-agl']).toBeUndefined();
  });

  it('pages the native horizon without counting a cached map prefix against its budget', async () => {
    const build = fixtureProfileBuild({ frameHours: Array.from({ length: 24 }, (_, i) => i + 1), mapFrameCount: 2 });
    build.manifest.descriptors.maxSampleValues = 2;
    const fetchImpl = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(fixturePointFetch(build, String(input)))));
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
    const loader = api.pointSeries(build, point);
    await loader.load('day');
    const before = fetchImpl.mock.calls.length;
    const series = await loader.load('forecast');
    const urls = fetchImpl.mock.calls.slice(before).map(([input]) => new URL(String(input)));
    expect(series.frames).toHaveLength(24);
    expect(urls.map(url => [url.pathname.split('/').at(-1), url.searchParams.get('frame')?.split(',').length])).toEqual([['profile', 22]]);
  });

  it('publishes selected and remaining lift samples independently of a pending profile', async () => {
    const build = fixtureProfileBuild({ frameHours: [1, 2], mapFrameCount: 2 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/profile') && url.searchParams.get('frame') === 'f002') await gate;
      return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
    });
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
    const onProgress = vi.fn<(series: PointSeries, total: number, loading: boolean) => void>();
    const pending = api.pointSeries(build, point).load('day', undefined, { frameId: 'f002', onProgress });
    try {
      await vi.waitFor(() => expect(onProgress).toHaveBeenCalledTimes(2));
      const requests = fetchImpl.mock.calls.map(([input]) => new URL(String(input)));
      expect(requests.map(url => [url.pathname.split('/').at(-1), url.searchParams.get('frame')])).toEqual([
        ['sample', 'f002'], ['profile', 'f002'], ['sample', 'f001']
      ]);
      const [early, total, loading] = onProgress.mock.calls[0]!;
      expect(early.frames.map(frame => frame.id)).toEqual(['f002']);
      expect(early.frames[0].layers).toEqual(fixturePointSample(build, String(requests[0])).frames[0].layers);
      expect(early.frames[0].profile).toBeUndefined();
      expect([total, loading]).toEqual([2, true]);
      expect(onProgress.mock.calls[1]![0].frames.map(frame => [frame.id, frame.layers['usable-lift-agl'].value, frame.profile])).toEqual([
        ['f001', 500, undefined], ['f002', 500, undefined]
      ]);
    } finally { release(); }
    const series = await pending;
    expect(series.frames.map(frame => frame.id)).toEqual(['f001', 'f002']);
    expect(series.frames[1].layers['usable-lift-agl']).toEqual(onProgress.mock.calls[0]![0].frames[0].layers['usable-lift-agl']);
    expect(series.frames[1].profile?.status).toBe('valid');
    expect(onProgress.mock.lastCall).toEqual([series, 2, false]);
  });

  it.each(['f001', 'f002,f003'])('retains sample pages after a failed profile page (%s) and fetches only missing profiles on reload', async failedFrames => {
    const build = fixtureProfileBuild({ frameHours: [1, 2, 3], mapFrameCount: 2 });
    let fail = true;
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (fail && url.pathname.endsWith('/profile') && url.searchParams.get('frame') === failedFrames) {
        return new Response(null, { status: 429 });
      }
      return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
    });
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
    const loader = api.pointSeries(build, point), onProgress = vi.fn<(series: PointSeries, total: number, loading: boolean) => void>();
    await expect(loader.load('forecast', undefined, { onProgress })).rejects.toMatchObject({ status: 429 });
    const [partial, total, loading] = onProgress.mock.lastCall!;
    expect(partial.frames.map(frame => frame.id)).toEqual(['f001', 'f002']);
    expect(partial.frames.map(frame => frame.layers['usable-lift-agl'].value)).toEqual([500, 500]);
    expect(partial.frames[0].profile?.status).toBe(failedFrames === 'f001' ? undefined : 'valid');
    expect(partial.frames[1].profile).toBeUndefined();
    expect([total, loading]).toEqual([3, false]);
    fail = false;
    const settled = fetchImpl.mock.calls.length;
    const recovered = await loader.load('forecast');
    expect(recovered.frames.map(frame => frame.profile?.status)).toEqual(['valid', 'valid', 'valid']);
    const retry = fetchImpl.mock.calls.slice(settled).map(([input]) => new URL(String(input)));
    expect(retry.every(url => url.pathname.endsWith('/profile'))).toBe(true);
    expect(retry.flatMap(url => url.searchParams.get('frame')!.split(','))).toEqual(failedFrames === 'f001' ? ['f001', 'f002', 'f003'] : ['f002', 'f003']);
  });

  it('rejects a profile completing after expiry without publishing or reusing it', async () => {
    const build = fixtureProfileBuild({ frameHours: [1], mapFrameCount: 1 });
    let now = Date.parse(build.manifest.createdAt), release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      if (new URL(String(input)).pathname.endsWith('/profile')) await gate;
      return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
    });
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => now });
    const loader = api.pointSeries(build, point), onProgress = vi.fn();
    const pending = expect(loader.load('day', undefined, { onProgress })).rejects.toThrow('Build expired');
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledOnce());
    now = build.expiresAtMs;
    release();
    await pending;
    expect(onProgress).toHaveBeenCalledOnce();
    await expect(loader.load('day')).rejects.toThrow('Build expired');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reuses selected lift while a superseded profile response is discarded', async () => {
    const build = fixtureProfileBuild({ frameHours: [1, 2, 3], mapFrameCount: 2 });
    let release!: () => void, firstProfile = true;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      if (new URL(String(input)).pathname.endsWith('/profile') && firstProfile) {
        firstProfile = false;
        await gate;
      }
      return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
    });
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
    const loader = api.pointSeries(build, point), onProgress = vi.fn();
    const superseded = expect(loader.load('forecast', undefined, { onProgress })).rejects.toThrow();
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledTimes(2));
    const day = await loader.load('day');
    await superseded;
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(day.frames.map(frame => frame.profile?.status)).toEqual(['valid', 'valid']);
    expect(onProgress).toHaveBeenCalledTimes(2);
    const fineFrames = fetchImpl.mock.calls.map(([input]) => new URL(String(input)))
      .filter(url => url.pathname.endsWith('/sample')).map(url => url.searchParams.get('frame'));
    expect(fineFrames).toEqual(['f001', 'f002']);
  });

  it('keeps unprefixed v5 point days within 24 hours and preserves the full forecast', async () => {
    const build = fixturePointBuild({ frameHours: [1, 2, 24, 27, 72], mapFrameCount: 5 });
    if (build.manifest.version !== 5) throw new Error('Expected v5');
    delete build.manifest.mapFrameCount;
    expect(pointSeriesSelection(build).frames).toEqual(['f001', 'f002', 'f024']);
    const fetchImpl = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(fixturePointSample(build, String(input)))));
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
    const loader = api.pointSeries(build, point);
    expect((await loader.load('day')).frames.map(frame => frame.id)).toEqual(['f001', 'f002', 'f024']);
    expect((await loader.load('forecast')).frames.map(frame => frame.id)).toEqual(['f001', 'f002', 'f024', 'f027', 'f072']);
    expect(fetchImpl.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('frame')!.split(',').length)).toEqual([1, 2, 2]);
  });

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
