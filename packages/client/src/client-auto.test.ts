import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '@av/contracts/format';
import { ApiClient, resolveAutoBuild, selectBestCatalogModel } from './index.js';
import { REGION_A_BOUNDS, REGION_B_POINT, REGION_B_BOUNDS, REGION_A_POINT, autoBuild, autoCatalogRow, autoTime } from '../../../tests/auto-forecast-fixtures.js';
import { fixtureLatest } from '../../../tests/forecast-fixture.js';
import { fixturePointSample } from '../../../tests/client-point-fixture.js';

const global = autoBuild('gfs', [-180, -55, 180, 65], [1, 18, 36, 60, 72]);
const regional = autoBuild('icon-eu', [-23.5, 29.5, 62.5, 70.5], [1, 18, 36, 60, 72]);
const regionA = autoBuild('av-wrf', REGION_A_BOUNDS, [1, 18, 36]);
const fine = autoBuild('wrf-region-a-1km', REGION_A_BOUNDS, [1, 18, 36]);
const nz = autoBuild('wrf-nz-3km', REGION_B_BOUNDS, [1, 18, 36]);
const models = [autoCatalogRow(global.manifest, 27_800), autoCatalogRow(regional.manifest, 6500), autoCatalogRow(regionA.manifest, 3000),
  autoCatalogRow(fine.manifest, 1000), autoCatalogRow(nz.manifest, 3000)];

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('ranks live coverage by spacing within both advertised time bounds', () => {
  const select = (point: typeof REGION_A_POINT, hour: number, rows = models) => selectBestCatalogModel({ ...point, models: rows,
    nowMs: Date.parse(autoTime(0)), validTimeMs: Date.parse(autoTime(hour)) });
  expect(select(REGION_A_POINT, 18)).toBe(fine.manifest.model);
  expect(select(REGION_A_POINT, 60)).toBe(regional.manifest.model);
  expect(select(REGION_A_POINT, 0)).toBeNull();
  expect(select(REGION_B_POINT, 18)).toBe(nz.manifest.model);
  expect(select(REGION_B_POINT, 18, [...models.slice(0, -1), { ...models.at(-1)!, expiresAt: autoTime(-1) }])).toBe('gfs');
});

it.each(['outside-domain', 'unavailable'] as const)('skips a rendered time hole and a point with %s status', async status => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(autoTime(0)));
  const hole = autoBuild(fine.manifest.model, REGION_A_BOUNDS, [1, 12, 36], 2);
  const builds = new Map([hole, regionA, regional, global].map(build => [build.manifest.model, build]));
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input)), model = url.pathname.split('/')[3];
    if (url.pathname.endsWith('/catalog')) return Response.json({ models });
    const build = builds.get(model)!;
    if (url.pathname.endsWith('/latest')) return Response.json(fixtureLatest(build.manifest));
    const payload = fixturePointSample(build, String(input));
    if (model === regionA.manifest.model) for (const frame of payload.frames) for (const layer of Object.values(frame.layers)) {
      layer.status = status; layer.value = null;
    }
    return Response.json(payload);
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });
  const selection = await resolveAutoBuild(api, { ...REGION_A_POINT, layers: ['usable-lift-agl'],
    validTimeMs: Date.parse(autoTime(18)), signal: new AbortController().signal });
  expect(selection?.build.manifest.model).toBe('icon-eu');
  expect(selection?.frame.id).toBe('f018');
  const paths = fetchImpl.mock.calls.map(([input]) => new URL(String(input)).pathname);
  expect(paths).toEqual(['/v1/catalog', `/v1/models/${hole.manifest.model}/latest`, `/v1/models/${regionA.manifest.model}/latest`,
    `/v1/models/${regionA.manifest.model}/runs/${regionA.manifest.buildId}/sample`, '/v1/models/icon-eu/latest',
    `/v1/models/icon-eu/runs/${regional.manifest.buildId}/sample`]);
});

it('accepts older catalog rows through generated bounds and checks the pinned build', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(autoTime(0)));
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/catalog')) return Response.json({ models: [{ model: 'gfs', available: true }, { model: 'icon-eu', available: true }] });
    if (path.endsWith('/latest')) return Response.json(fixtureLatest(regional.manifest));
    return Response.json(fixturePointSample(regional, String(input)));
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });
  const selection = await resolveAutoBuild(api, { ...REGION_A_POINT, layers: ['usable-lift-msl'],
    validTimeMs: Date.parse(autoTime(18)), signal: new AbortController().signal });
  expect(selection?.build.manifest.model).toBe('icon-eu');
});


it.each(['latest', 'sample'] as const)('falls back to the coarser model after a finer %s deadline', async route => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(autoTime(0)));
  // Native signal deadlines otherwise use a separate clock from Vitest's request timers.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), milliseconds);
    return controller.signal;
  });
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/catalog')) return Response.json({ models: [models[1]!, models[2]!] });
    const build = path.startsWith(`/v1/models/${regionA.manifest.model}/`) ? regionA : regional;
    if (build === regionA && path.endsWith(`/${route}`)) return new Promise(() => {});
    if (path.endsWith('/latest')) return Response.json(fixtureLatest(build.manifest));
    return Response.json(fixturePointSample(build, String(input)));
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });
  const selection = resolveAutoBuild(api, { ...REGION_A_POINT, layers: ['usable-lift-msl'],
    validTimeMs: Date.parse(autoTime(18)), signal: new AbortController().signal });
  const fallback = expect(selection).resolves.toMatchObject({ build: { manifest: { model: 'icon-eu' } }, frame: { id: 'f018' } });
  await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
  await fallback;
});
