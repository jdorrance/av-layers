import { afterEach, expect, it, vi } from 'vitest';
import { WIND_FINE_CELL_BYTES, WIND_OVERVIEW_CELL_BYTES, WIND_OVERVIEW_VALUES, windOverviewLayout } from '@av/contracts/wind-data';
import { STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_VALID } from '@av/contracts/layers';
import { planSample } from '@av/forecast/sampler';
import { decodePackedWindChunk, encodeWindColumns, samplePackedWindColumns, windTargetHeight } from '@av/forecast/wind';
import { fixtureBuild } from '../../../tests/forecast-fixture.ts';
import { WindDataSource } from './client-wind.ts';

const bounds = [-1, -1, 2, 2] as const;
function build() {
  const result = fixtureBuild();
  result.expiresAtMs = Date.now() + 60000;
  result.manifest.expiresAt = new Date(result.expiresAtMs).toISOString();
  result.manifest.recipe.id = 'gfs';
  result.manifest.descriptors.bounds = [...bounds];
  const grid = { kind: 'regular-latlon' as const, width: 2, height: 2, lon0: 0, lat0: 0, dx: 1, dy: 1, earthRadiusM: 6371000, wrapLongitude: false };
  for (const surface of result.manifest.surfaces) surface.grid = grid;
  return result;
}
const column = { surface: { u: 1, v: 2 }, levels: [{ height: 100, wind: { u: 2, v: 4 } }, { height: 1000, wind: { u: 4, v: 8 } }] };
const wind = encodeWindColumns(Array.from({ length: 256 }, (_, index) => index % 16 < 2 && Math.floor(index / 16) < 2 ? column : null));
const fine = new Uint8Array(64 * 64 * WIND_FINE_CELL_BYTES), view = new DataView(fine.buffer);
for (let i = 0; i < 64 * 64; i++) {
  const inside = i % 64 < 2 && Math.floor(i / 64) < 2;
  view.setFloat32(i * WIND_FINE_CELL_BYTES, inside ? 100 : 0, true); view.setFloat32(i * WIND_FINE_CELL_BYTES + 4, inside ? 550 : 0, true);
  view.setUint8(i * WIND_FINE_CELL_BYTES + 8, inside ? 16 : 15);
}
const descriptor = (frame: string) => JSON.stringify({ version: 3, frame, levels: 2, tileSize: 16, fineTileSize: 64,
  wind: [{ sha256: 'a'.repeat(64), bytes: wind.length, indexSha256: 'b'.repeat(64), count: 1 }],
  fine: [{ sha256: 'c'.repeat(64), bytes: fine.length, indexSha256: 'd'.repeat(64), count: 1 }] });
const reply = (bytes: Uint8Array) => new Response(Uint8Array.from(bytes), { headers: { 'content-type': 'application/octet-stream' } });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('loads once per view and samples surface, AGL, and lift without requests', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? wind : fine));
  const globalFetch = vi.fn(); vi.stubGlobal('fetch', globalFetch);
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  expect(await source.load({ build: pinned, frame: pinned.manifest.frames[0].id, bounds })).toBe('ready');
  expect(source.sample(0.5, 0.5, 'surface')).toEqual({ status: 'valid', u: 1, v: 2 });
  expect(source.sample(0.5, 0.5, 450)).toEqual({ status: 'valid', u: 3, v: 6 });
  expect(source.sample(0.5, 0.5, 'lift')).toEqual({ status: 'valid', u: 3, v: 6 });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(globalFetch).not.toHaveBeenCalled();
  pinned.expiresAtMs = Date.now() - 1;
  expect(source.sample(0.5, 0.5, 'surface').status).toBe('unavailable');
  source.dispose();
});

it('preserves fractional AGL and lift targets beside missing vertical brackets', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  const gapped = encodeWindColumns(Array.from({ length: 256 }, () => ({
    surface: { u: 1, v: 2 }, levels: [
      { height: 100, wind: { u: 1, v: 2 } }, null,
      { height: 300, wind: { u: 3, v: 6 } }, { height: 400, wind: { u: 4, v: 8 } }
    ]
  })));
  const companion = Uint8Array.from(fine), targets = new DataView(companion.buffer);
  targets.setFloat32(0, 99.6, true); targets.setFloat32(4, 299.6, true);
  const metadata = JSON.parse(descriptor(frame));
  metadata.levels = 4; metadata.wind[0].bytes = gapped.length;
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? gapped : companion));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  expect(await source.load({ build: pinned, frame, bounds })).toBe('ready');
  expect(source.sample(0, 0, 'lift')).toEqual({ status: 'unavailable', u: null, v: null });
  expect(source.sample(0, 0, 200)).toEqual({ status: 'unavailable', u: null, v: null });
  expect(source.sample(0, 0, 'surface')).toEqual({ status: 'valid', u: 1, v: 2 });
  source.dispose();
});

it.each([0, 4])('rejects nonfinite companion targets at byte %s', async offset => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, companion = Uint8Array.from(fine);
  new DataView(companion.buffer).setFloat32(offset, NaN, true);
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? wind : companion));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  await expect(source.load({ build: pinned, frame, bounds })).rejects.toThrow('Invalid numeric companion');
  expect(source.sample(0, 0, 'surface').status).toBe('unavailable');
  source.dispose();
});

it('returns unavailable for old builds and cancels a superseded request', async () => {
  let call = 0;
  const fetcher = vi.fn<typeof fetch>((_url, init) => ++call === 1 ? new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })) : Promise.resolve(new Response(null, { status: 409 })));
  vi.stubGlobal('fetch', fetcher);
  const source = new WindDataSource('https://api.test'), pinned = build();
  const pending = source.load({ build: pinned, frame: pinned.manifest.frames[0].id, bounds });
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(await source.load({ build: pinned, frame: pinned.manifest.frames[0].id, bounds })).toBe('unavailable');
  await rejection;
  expect(source.sample(0.5, 0.5, 'surface').status).toBe('unavailable');
  source.dispose();
});

it('waits for aborted loads to release their responses before starting replacements', async () => {
  let finish!: () => void;
  let calls = 0;
  const fetcher = vi.fn<typeof fetch>((_url, init) => ++calls === 1
    ? new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => { finish = () => reject(init!.signal!.reason); }, { once: true }))
    : Promise.resolve(new Response(null, { status: 404 })));
  const pinned = build(), source = new WindDataSource('https://api.test', { fetchImpl: fetcher }), frame = pinned.manifest.frames[0].id;
  const first = source.load({ build: pinned, frame, bounds });
  const aborted = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const second = source.load({ build: pinned, frame, bounds });
  await Promise.resolve();
  expect(fetcher).toHaveBeenCalledTimes(1);
  finish();
  await aborted;
  expect(await second).toBe('unavailable');
  expect(fetcher).toHaveBeenCalledTimes(2);
  source.dispose();
});

it('rejects oversized descriptors before parsing or requesting chunks', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(' '.repeat(32 * 1024 + 1), { headers: { 'content-type': 'application/json' } }));
  const pinned = build(), source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  await expect(source.load({ build: pinned, frame: pinned.manifest.frames[0].id, bounds })).rejects.toThrow('exceeds budget');
  expect(fetcher).toHaveBeenCalledTimes(1);
  source.dispose();
});

function globalBuild(wrapLongitude: boolean) {
  const pinned = build();
  pinned.expiresAtMs = Date.now() + 600_000;
  pinned.manifest.expiresAt = new Date(pinned.expiresAtMs).toISOString();
  pinned.manifest.descriptors.bounds = [-180, -1, 180, 2];
  const grid = { kind: 'regular-latlon' as const, width: 1440, height: 2, lon0: -180, lat0: 0, dx: 0.25, dy: 1, earthRadiusM: 6371000, wrapLongitude };
  for (const surface of pinned.manifest.surfaces) surface.grid = grid;
  return pinned;
}

const globalWind = encodeWindColumns(Array.from({ length: 256 }, () => column));
const globalFine = new Uint8Array(64 * 64 * WIND_FINE_CELL_BYTES), globalFineView = new DataView(globalFine.buffer);
for (let i = 0; i < 64 * 64; i++) {
  globalFineView.setFloat32(i * WIND_FINE_CELL_BYTES, 100, true); globalFineView.setFloat32(i * WIND_FINE_CELL_BYTES + 4, 550, true); globalFineView.setUint8(i * WIND_FINE_CELL_BYTES + 8, 16);
}

it('loads both seam edges for wrapping grids and keeps regional grids unwrapped', async () => {
  const pinned = globalBuild(true), frame = pinned.manifest.frames[0].id;
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? globalWind : globalFine));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  expect(await source.load({ build: pinned, frame, bounds: [179.85, 0, 179.95, 1] })).toBe('ready');
  const east = source.sample(0.5, 179.95, 450);
  expect(east).toEqual({ status: 'valid', u: 3, v: 6 });
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/wind/0'))).toBe(true);
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/fine/0'))).toBe(true);
  expect(await source.load({ build: pinned, frame, bounds: [-179.95, 0, -179.85, 1] })).toBe('ready');
  expect(source.sample(0.5, -179.95, 450)).toEqual(east);
  fetcher.mockClear();
  expect(await source.load({ build: globalBuild(false), frame, bounds: [179.55, 0, 179.7, 1] })).toBe('ready');
  expect(source.sample(0.5, 179.6, 450).status).toBe('valid');
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/wind/0') || String(url).endsWith('/fine/0'))).toBe(false);
  source.dispose();
});

it('finishes multiple slow chunk waves within the workload deadline', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
  const pinned = globalBuild(true), frame = pinned.manifest.frames[0].id;
  const fetcher = vi.fn<typeof fetch>((url, init) => {
    if (String(url).endsWith(`/data/${frame}`)) return Promise.resolve(new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(reply(String(url).includes('/wind/') ? globalWind : globalFine)), 2_000);
      init!.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(init!.signal!.reason); }, { once: true });
    });
  });
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  const load = source.load({ build: pinned, frame, bounds: [-170, 0, 0, 1] });
  await vi.advanceTimersByTimeAsync(35_000);
  expect(await load).toBe('ready');
  expect(fetcher.mock.calls.length).toBeGreaterThan(40);
  expect(source.sample(0.5, -100, 450).status).toBe('valid');
  source.dispose();
});

it('times out a hanging body and cancels it', async () => {
  vi.useFakeTimers();
  const pinned = build(), frame = pinned.manifest.frames[0].id, cancel = vi.fn();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ pull() {}, cancel }), { headers: { 'content-type': 'application/json' } }));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  const load = source.load({ build: pinned, frame, bounds });
  const rejected = expect(load).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
  source.dispose();
});

it('propagates caller abort to an in-flight request', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, caller = new AbortController();
  const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  const load = source.load({ build: pinned, frame, bounds, signal: caller.signal });
  const rejected = expect(load).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  caller.abort();
  await rejected;
  expect(fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true);
  source.dispose();
});

it('aborts a queued caller without starting the next fetch early', async () => {
  let finish!: () => void, calls = 0;
  const fetcher = vi.fn<typeof fetch>((_url, init) => ++calls === 1
    ? new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => { finish = () => reject(init!.signal!.reason); }, { once: true }))
    : Promise.resolve(new Response(null, { status: 404 })));
  const pinned = build(), frame = pinned.manifest.frames[0].id, caller = new AbortController();
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  const first = source.load({ build: pinned, frame, bounds });
  const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  const queued = source.load({ build: pinned, frame, bounds, signal: caller.signal });
  const queuedRejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  caller.abort();
  await queuedRejected;
  const next = source.load({ build: pinned, frame, bounds });
  await Promise.resolve();
  expect(fetcher).toHaveBeenCalledOnce();
  finish();
  await firstRejected;
  expect(await next).toBe('unavailable');
  expect(fetcher).toHaveBeenCalledTimes(2);
  source.dispose();
});

it('reuses decoded tiles across repeated samples without retaining coordinate caches', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? wind : fine));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  expect(await source.load({ build: pinned, frame, bounds })).toBe('ready');
  const internals = source as unknown as { current: { wind: Map<number, unknown>; fine: Map<number, unknown> } };
  const windTiles = [...internals.current.wind], fineTiles = [...internals.current.fine];
  const expected = source.sample(0.5, 0.5, 450);
  for (let i = 0; i < 3; i++) expect(source.sample(0.5, 0.5, 450)).toEqual(expected);
  expect([...internals.current.wind]).toEqual(windTiles);
  expect([...internals.current.fine]).toEqual(fineTiles);
  for (const [key, tile] of windTiles) expect(internals.current.wind.get(key)).toBe(tile);
  for (const [key, tile] of fineTiles) expect(internals.current.fine.get(key)).toBe(tile);
  expect(fetcher).toHaveBeenCalledTimes(3);
  source.dispose();
});

it('matches the reference sampler for mixed fine statuses and contributor counts', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id, bytes = Uint8Array.from(fine), fineView = new DataView(bytes.buffer);
  const packed = decodePackedWindChunk(wind), grid = pinned.manifest.surfaces[0].grid;
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(descriptor(frame), { headers: { 'content-type': 'application/json' } })
    : reply(String(url).includes('/wind/') ? wind : bytes));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  const patterns = [[0, 0, 0, 0], [0, 1, 1, 0], [1, 1, 1, 1], [0, 2, 0, 3], [2, 0, 3, 0], [1, 2, 0, 0], [4, 5, 0, 0]];
  for (const stored of [false, true]) for (const pattern of patterns) {
    pinned.manifest.tool.useStoredMslNoLift = stored ? true : undefined;
    for (let i = 0; i < 4; i++) {
      const pos = (Math.floor(i / 2) * 64 + i % 2) * WIND_FINE_CELL_BYTES;
      fineView.setFloat32(pos, 100 + i * 20, true); fineView.setFloat32(pos + 4, 400 + i * 100, true);
      fineView.setUint8(pos + 8, 16 | (pattern[i] & 3 ? 2 : 0) | ((pattern[i] & 3) << 2)); fineView.setUint8(pos + 9, pattern[i] & ~3);
    }
    expect(await source.load({ build: pinned, frame, bounds })).toBe('ready');
    for (const [lat, lon] of [[0, 0], [0, 0.5], [0.5, 0.5], [0.2, 0.7]]) for (const height of [450, 'lift'] as const) {
      const plan = planSample(grid, lat, lon)!;
      const cells = plan.contributors.map(item => {
        const pos = (item.row * 64 + item.column) * WIND_FINE_CELL_BYTES, packed = fineView.getUint8(pos + 8);
        return { value: fineView.getFloat32(pos + (height === 'lift' ? 4 : 0), true), flags: height === 'lift' ? ((packed >> 2) & 3) | fineView.getUint8(pos + 9) : packed & 3 };
      });
      const selected = windTargetHeight(plan, cells, height === 'lift' ? { lift: true } : { agl: height }, stored);
      let expected;
      if (selected.status !== STATUS_VALID || selected.value === null) expected = { status: selected.status === STATUS_NO_LIFT ? 'no-lift' : selected.status === STATUS_OUTSIDE ? 'outside' : 'unavailable', u: null, v: null };
      else {
        const result = samplePackedWindColumns(plan, plan.contributors.map(() => packed), plan.contributors.map(item => item.row * 16 + item.column), selected.value);
        expected = { status: result.status === STATUS_VALID ? 'valid' : result.status === STATUS_OUTSIDE ? 'outside' : 'unavailable', u: result.u, v: result.v };
      }
      expect(source.sample(lat, lon, height)).toEqual(expected);
    }
  }
  source.dispose();
});

it('renders a bounded whole-world overview and retains wrapped seam samples', async () => {
  const pinned = globalBuild(true), frame = pinned.manifest.frames[0].id;
  pinned.manifest.descriptors.bounds = [-180, -90, 180, 90];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { height: 721, lat0: -90, dy: 0.25 });
  const metadata = JSON.parse(descriptor(frame));
  metadata.overview = [2, 4, 8, 16].map(stride => {
    const layout = windOverviewLayout(pinned.manifest.surfaces[0].grid, stride);
    return { stride, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: layout.count, bytes: layout.count * layout.chunkBytes }] };
  });
  const bytes = new Uint8Array(32 * 32 * WIND_OVERVIEW_CELL_BYTES), view = new DataView(bytes.buffer);
  for (let cell = 0; cell < 32 * 32; cell++) for (let mode = 0; mode < WIND_OVERVIEW_VALUES; mode++) {
    const offset = cell * WIND_OVERVIEW_CELL_BYTES + mode * 9;
    view.setFloat32(offset, mode + 1, true); view.setFloat32(offset + 4, (mode + 1) * 2, true);
  }
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } }) : reply(bytes));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  expect(await source.load({ build: pinned, frame, bounds: [-180, -85, 180, 85] })).toBe('ready');
  const requests = fetcher.mock.calls.slice(1).map(([url]) => String(url));
  expect(requests).toHaveLength(18);
  expect(requests.every(url => url.includes('/overview-8/'))).toBe(true);
  expect(requests.length * bytes.length).toBeLessThan(4 * 1024 * 1024);
  expect(source.sample(0, 179.95, 'surface')).toEqual({ status: 'valid', u: 1, v: 2 });
  expect(source.sample(0, -179.95, 20)).toEqual({ status: 'valid', u: 2, v: 4 });
  expect(source.sample(0, 0, 'lift')).toEqual({ status: 'valid', u: 12, v: 24 });
  source.dispose();
});

it('preserves per-mode missing overview cells without inventing calm or bridging masks', async () => {
  const pinned = globalBuild(true), frame = pinned.manifest.frames[0].id, metadata = JSON.parse(descriptor(frame));
  const layout = windOverviewLayout(pinned.manifest.surfaces[0].grid, 2);
  metadata.overview = [{ stride: 2, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: layout.count, bytes: layout.count * layout.chunkBytes }] }];
  const bytes = new Uint8Array(layout.chunkBytes), view = new DataView(bytes.buffer);
  for (let cell = 0; cell < 32 * 32; cell++) for (let mode = 0; mode < WIND_OVERVIEW_VALUES; mode++) {
    const offset = cell * WIND_OVERVIEW_CELL_BYTES + mode * 9;
    if (mode === 0) { view.setFloat32(offset, 3, true); view.setFloat32(offset + 4, 4, true); }
    else view.setUint8(offset + 8, mode === WIND_OVERVIEW_VALUES - 1 ? STATUS_NO_LIFT : 2);
  }
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith(`/data/${frame}`)
    ? new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } }) : reply(bytes));
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  expect(await source.load({ build: pinned, frame, bounds: [-180, -1, 180, 2] })).toBe('ready');
  expect(source.sample(0.5, 0, 'surface')).toEqual({ status: 'valid', u: 3, v: 4 });
  expect(source.sample(0.5, 0, 20)).toEqual({ status: 'unavailable', u: null, v: null });
  expect(source.sample(0.5, 0, 'lift')).toEqual({ status: 'no-lift', u: null, v: null });
  expect(source.sample(3, 0, 'surface')).toEqual({ status: 'outside', u: null, v: null });
  source.dispose();
});

it('registers averaged overview centers and partial edge cells to the source grid', async () => {
  const pinned = build(), frame = pinned.manifest.frames[0].id;
  pinned.manifest.descriptors.bounds = [-129, -1, 129, 1];
  for (const surface of pinned.manifest.surfaces) Object.assign(surface.grid, { width: 259, height: 1, lon0: -129 });
  const metadata = JSON.parse(descriptor(frame)), layout = windOverviewLayout(pinned.manifest.surfaces[0].grid, 2);
  metadata.levels = 77;
  metadata.wind[0].count = 17; metadata.wind[0].bytes = 17 * (12 + 256 * (9 + 13 * 77));
  metadata.fine[0].count = 5; metadata.fine[0].bytes = 5 * fine.length;
  metadata.overview = [{ stride: 2, shards: [{ sha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64), count: layout.count, bytes: layout.count * layout.chunkBytes }] }];
  const fetcher = vi.fn<typeof fetch>(async url => {
    if (String(url).endsWith(`/data/${frame}`)) return new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } });
    const tile = Number(String(url).split('/').at(-1)), bytes = new Uint8Array(layout.chunkBytes), view = new DataView(bytes.buffer);
    for (let i = 0; i < 32 * 32; i++) for (let mode = 0; mode < WIND_OVERVIEW_VALUES; mode++) {
      const x = (tile * 32 + i % 32) * 2, offset = i * WIND_OVERVIEW_CELL_BYTES + mode * 9;
      if (x >= 259 || i >= 32) view.setUint8(offset + 8, STATUS_OUTSIDE);
      else view.setFloat32(offset, (x + Math.min(x + 1, 258)) / 2, true);
    }
    return reply(bytes);
  });
  const source = new WindDataSource('https://api.test', { fetchImpl: fetcher });
  expect(await source.load({ build: pinned, frame, bounds: [-129, -1, 129, 1] })).toBe('ready');
  for (const x of [1, 29, 64.5, 255, 256, 257, 258]) expect(source.sample(0, x - 129, 'surface').u).toBeCloseTo(x);
  expect(source.sample(0, -129, 'surface').u).toBe(0.5);
  expect(fetcher.mock.calls.slice(1).every(([url]) => String(url).includes('/overview-2/'))).toBe(true);
  source.dispose();
});
