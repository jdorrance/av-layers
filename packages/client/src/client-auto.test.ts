import { afterEach, expect, it, vi } from 'vitest';
import { ApiClient, resolveAutoBuild, selectBestCatalogModel } from './index.js';
import { ARMENIA_BOUNDS, AUCKLAND, NEW_ZEALAND_BOUNDS, YEREVAN, autoBuild, autoCatalogRow, autoTime } from '../../../tests/auto-forecast-fixtures.js';
import { fixtureLatest } from '../../../tests/forecast-fixture.js';
import { fixturePointSample } from '../../../tests/client-point-fixture.js';

const global = autoBuild('gfs', [-180, -55, 180, 65], [1, 18, 36, 60, 72]);
const regional = autoBuild('icon-eu', [-23.5, 29.5, 62.5, 70.5], [1, 18, 36, 60, 72]);
const armenia = autoBuild('wrf-armenia-3km', ARMENIA_BOUNDS, [1, 18, 36]);
const fine = autoBuild('wrf-armenia-1km', ARMENIA_BOUNDS, [1, 18, 36]);
const nz = autoBuild('wrf-nz-3km', NEW_ZEALAND_BOUNDS, [1, 18, 36]);
const models = [autoCatalogRow(global.manifest, 27_800), autoCatalogRow(regional.manifest, 6500), autoCatalogRow(armenia.manifest, 3000),
  autoCatalogRow(fine.manifest, 1000), autoCatalogRow(nz.manifest, 3000)];

afterEach(() => vi.restoreAllMocks());

it('ranks live coverage by spacing within both advertised time bounds', () => {
  const select = (point: typeof YEREVAN, hour: number, rows = models) => selectBestCatalogModel({ ...point, models: rows,
    nowMs: Date.parse(autoTime(0)), validTimeMs: Date.parse(autoTime(hour)) });
  expect(select(YEREVAN, 18)).toBe(fine.manifest.model);
  expect(select(YEREVAN, 60)).toBe(regional.manifest.model);
  expect(select(YEREVAN, 0)).toBeNull();
  expect(select(AUCKLAND, 18)).toBe(nz.manifest.model);
  expect(select(AUCKLAND, 18, [...models.slice(0, -1), { ...models.at(-1)!, expiresAt: autoTime(-1) }])).toBe('gfs');
});

it('skips a hole in rendered time and verifies sparse point coverage before accepting a model', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(autoTime(0)));
  const hole = autoBuild(fine.manifest.model, ARMENIA_BOUNDS, [1, 12, 36], 2);
  const builds = new Map([hole, armenia, regional, global].map(build => [build.manifest.model, build]));
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input)), model = url.pathname.split('/')[3];
    if (url.pathname.endsWith('/catalog')) return Response.json({ models });
    const build = builds.get(model)!;
    if (url.pathname.endsWith('/latest')) return Response.json(fixtureLatest(build.manifest));
    const payload = fixturePointSample(build, String(input));
    if (model === armenia.manifest.model) for (const frame of payload.frames) for (const layer of Object.values(frame.layers)) {
      layer.status = 'outside-domain'; layer.value = null;
    }
    return Response.json(payload);
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });
  const selection = await resolveAutoBuild(api, { ...YEREVAN, layers: ['usable-lift-agl'],
    validTimeMs: Date.parse(autoTime(18)), signal: new AbortController().signal });
  expect(selection?.build.manifest.model).toBe('icon-eu');
  expect(selection?.frame.id).toBe('f018');
  const paths = fetchImpl.mock.calls.map(([input]) => new URL(String(input)).pathname);
  expect(paths).toEqual(['/v1/catalog', `/v1/models/${hole.manifest.model}/latest`, `/v1/models/${armenia.manifest.model}/latest`,
    `/v1/models/${armenia.manifest.model}/runs/${armenia.manifest.buildId}/sample`, '/v1/models/icon-eu/latest',
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
  const selection = await resolveAutoBuild(api, { ...YEREVAN, layers: ['usable-lift-msl'],
    validTimeMs: Date.parse(autoTime(18)), signal: new AbortController().signal });
  expect(selection?.build.manifest.model).toBe('icon-eu');
});
