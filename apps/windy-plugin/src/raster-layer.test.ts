import { afterEach, expect, it, vi } from 'vitest';
import { windyTileOptions } from '@av/contracts/client';
import { fixtureBuild } from '../../../tests/forecast-fixture';
import { forecastStackZIndex, WindyRasterLayer, type NativeRasterSource, type RasterSourceEvent } from './raster-layer';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const url = (frame: string) => `https://tiles.example/tiles/gfs/build-1/precip-rate/${frame}/{z}/{x}/{y}.webp`;
function fixture() {
  const handlers = new Map<string, Set<() => void>>();
  let moving = false;
  const renderMap = {
    setPaintProperty: vi.fn(),
    on: (event: string, listener: () => void) => { const listeners = handlers.get(event) ?? new Set(); listeners.add(listener); handlers.set(event, listeners); },
    off: (event: string, listener: () => void) => handlers.get(event)?.delete(listener),
    isMoving: () => moving,
    getZoom: () => 7,
    getBounds: () => ({ getWest: () => -118, getEast: () => -117, getSouth: () => 32, getNorth: () => 33 })
  };
  const natives: ReturnType<typeof nativeLayer>[] = [];
  function nativeLayer() {
    const listeners = new Map<string, (event: RasterSourceEvent) => void>();
    const source: NativeRasterSource = {
      on: vi.fn((event, listener) => { listeners.set(event, listener); }),
      off: vi.fn((event, listener) => { if (listeners.get(event) === listener) listeners.delete(event); })
    };
    const value = { listeners, layer: () => ({ id: `slot-${natives.length}` }), source: () => source, sourceObject: source, setUrl: vi.fn(), setOpacity: vi.fn(), alwaysLoadTiles: false, loading: true, isLoading: () => value.loading };
    return value;
  }
  const map = { maplibreMap: renderMap, addLayer: vi.fn(), removeLayer: vi.fn() };
  const create = vi.fn((_url: string, _options: ReturnType<typeof windyTileOptions>) => { const native = nativeLayer(); natives.push(native); return native; });
  const api = { tileLayer: create, addProtocol: vi.fn(), removeProtocol: vi.fn() };
  const layer = new WindyRasterLayer(api, 'https://tiles.example', url('f003'), windyTileOptions(7, 0.5, 'NOAA'));
  const emit = (event: string) => { for (const listener of handlers.get(event) ?? []) listener(); };
  const complete = (native = natives.at(-1)!) => { native.loading = false; native.listeners.get('data')?.({ tile: {} }); emit('render'); };
  return { layer, map, api, create, natives, handlers, emit, complete, move: (value: boolean) => { moving = value; emit(value ? 'movestart' : 'render'); } };
}

it('loads hidden staging tiles and commits only successful render readiness', async () => {
  const f = fixture(), statuses = vi.fn();
  f.layer.onStatus(statuses); f.layer.addTo(f.map);
  const first = f.natives[0];
  expect(first.alwaysLoadTiles).toBe(true);
  expect(f.create.mock.calls[0][1]).toMatchObject({ opacity: 0, maxNativeZoom: 7 });
  f.emit('render');
  expect(first.setOpacity).not.toHaveBeenCalled();
  f.complete();
  expect(first.setOpacity).toHaveBeenCalledWith(0.5);
  f.layer.setUrl(url('f006'));
  expect(f.map.removeLayer).not.toHaveBeenCalledWith(first);
  const replacement = f.natives[1];
  replacement.loading = false;
  f.emit('render'); // Settled alone does not prove successful tiles.
  expect(f.map.removeLayer).not.toHaveBeenCalledWith(first);
  f.complete(replacement);
  await Promise.resolve();
  expect(f.map.removeLayer).toHaveBeenCalledWith(first);
  expect(statuses).toHaveBeenLastCalledWith('ready', url('f006'));
  f.layer.remove();
});

it.each([false, true])('settles a stationary viewport with no tiles and retries on movement (old raster: %s)', async committed => {
  const f = fixture(), statuses = vi.fn();
  f.layer.onStatus(statuses); f.layer.addTo(f.map);
  if (committed) { f.complete(); await Promise.resolve(); f.layer.setUrl(url('f006')); }
  const empty = f.natives.at(-1)!, tile = {};
  empty.loading = false;
  f.emit('render');
  expect(f.map.removeLayer).not.toHaveBeenCalledWith(empty);
  f.move(true);
  empty.listeners.get('dataloading')?.({ tile });
  empty.listeners.get('dataabort')?.({ tile });
  f.emit('idle');
  expect(f.map.removeLayer).not.toHaveBeenCalledWith(empty);
  f.move(false);
  f.emit('idle');
  expect(f.map.removeLayer).toHaveBeenCalledExactlyOnceWith(empty);
  expect(statuses).toHaveBeenLastCalledWith('error', committed ? url('f003') : '');
  f.emit('idle');
  expect(f.natives.at(-1)).toBe(empty);
  f.move(true); f.move(false); f.emit('moveend');
  expect(f.natives.at(-1)).not.toBe(empty);
  f.complete();
  await Promise.resolve();
  expect(statuses).toHaveBeenLastCalledWith('ready', url(committed ? 'f006' : 'f003'));
  f.layer.remove();
});

it.each(['ready', 'supersede', 'move', 'freeze', 'remove', 'expire'] as const)('warms committed Windy frames only while current (%s)', async action => {
  const build = fixtureBuild({ buildId: 'build-1' }, 'https://tiles.example');
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(build.manifest.createdAt));
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(Uint8Array.of(82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80), {
    headers: { 'content-type': 'image/webp', 'content-length': '12' }
  }));
  vi.stubGlobal('fetch', fetchImpl);
  const f = fixture();
  try {
    f.layer.setBuild(build); f.layer.addTo(f.map); f.complete();
    expect(fetchImpl).not.toHaveBeenCalled();
    if (action === 'supersede') f.layer.setUrl(url('f006'));
    else if (action === 'move') f.move(true);
    else if (action === 'freeze') f.layer.freeze();
    else if (action === 'remove') f.layer.remove();
    else if (action === 'expire') vi.mocked(Date.now).mockReturnValue(build.expiresAtMs + 1);
    await Promise.resolve();
    if (action === 'ready') {
      expect(fetchImpl).toHaveBeenCalled();
      expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('/f006/'))).toBe(true);
      const started = fetchImpl.mock.calls.length;
      f.emit('idle'); f.emit('idle');
      expect(fetchImpl).toHaveBeenCalledTimes(started);
    } else expect(fetchImpl).not.toHaveBeenCalled();
  } finally { f.layer.remove(); }
});

it('retains the committed layer on failed or superseded staging generations', async () => {
  const f = fixture(), statuses = vi.fn();
  f.layer.onStatus(statuses); f.layer.addTo(f.map); f.complete();
  const first = f.natives[0];
  f.layer.setUrl(url('f006'));
  const failed = f.natives[1], late = failed.listeners.get('data')!;
  failed.listeners.get('error')?.({ tile: {} });
  expect(f.map.removeLayer).not.toHaveBeenCalledWith(failed);
  failed.listeners.get('error')?.({});
  expect(f.map.removeLayer).toHaveBeenCalledWith(failed);
  expect(f.map.removeLayer).not.toHaveBeenCalledWith(first);
  expect(statuses).toHaveBeenLastCalledWith('error', url('f003'));
  f.layer.setUrl(url('f009'), 9);
  expect(f.create.mock.calls.at(-1)?.[1].maxNativeZoom).toBe(9);
  late({ tile: {} }); f.emit('render');
  expect(f.map.removeLayer).not.toHaveBeenCalledWith(first);
  f.move(true); f.complete();
  expect(f.map.removeLayer).not.toHaveBeenCalledWith(first);
  f.move(false);
  await Promise.resolve();
  expect(f.map.removeLayer).toHaveBeenCalledWith(first);
  expect(f.api.addProtocol).toHaveBeenCalledTimes(1);
  expect(f.api.removeProtocol).not.toHaveBeenCalled();
  f.layer.remove();
});

it('bridges committed LeafletGL tile errors and removes exact listeners on disposal', () => {
  const f = fixture(), errors = vi.fn(), loads = vi.fn();
  f.layer.on('tileerror', errors); f.layer.on('tileload', loads);
  f.layer.addTo(f.map); f.complete();
  const first = f.natives[0], tile = { tile: {} }, late = first.listeners.get('error')!;
  first.listeners.get('dataloading')?.(tile); first.listeners.get('error')?.(tile);
  first.listeners.get('data')?.(tile);
  expect(errors).toHaveBeenCalledWith(tile); expect(loads).toHaveBeenCalledWith(tile);
  f.layer.setOpacity(0.7); expect(first.setOpacity).toHaveBeenLastCalledWith(0.7);
  f.layer.remove();
  expect(first.sourceObject.off).toHaveBeenCalledTimes(4);
  expect(first.listeners.size).toBe(0);
  expect([...f.handlers.values()].every(listeners => listeners.size === 0)).toBe(true);
  expect(f.api.removeProtocol).toHaveBeenCalledTimes(1);
  late({ tile: {} }); expect(errors).toHaveBeenCalledTimes(1);
  f.layer.remove(); expect(f.api.removeProtocol).toHaveBeenCalledTimes(1);
  expect(() => f.layer.addTo(f.map)).toThrow('disposed');
});

it('cleans a partially mounted layer whose source is unavailable', () => {
  const f = fixture();
  f.create.mockImplementationOnce(() => ({ source: () => undefined, layer: () => ({ id: 'broken' }), isLoading: () => true, alwaysLoadTiles: false, setUrl: vi.fn(), setOpacity: vi.fn() }) as never);
  expect(() => f.layer.addTo(f.map)).toThrow('source is unavailable');
  expect(f.map.removeLayer).toHaveBeenCalledTimes(1);
  expect(f.api.removeProtocol).toHaveBeenCalledTimes(1);
});

it('stacks above weather colors and below wind particles', () => {
  expect(forecastStackZIndex(undefined)).toBe(1);
  expect(forecastStackZIndex({ MAIN: 10, PARTICLES: 12 })).toBe(11);
  expect(forecastStackZIndex({ MAIN: 10, PARTICLES: 11 })).toBe(10.5);
});

it.each(['commit', 'failure', 'freeze'] as const)('preserves prefetched target bytes across URL changes until %s', async outcome => {
  const build = fixtureBuild({ buildId: 'build-1' }, 'https://tiles.example');
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(build.manifest.createdAt));
  const requests: { url: string; signal: AbortSignal; resolve(response: Response): void }[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>((url, init) => new Promise((resolve, reject) => {
    const signal = init!.signal!;
    requests.push({ url: String(url), signal, resolve });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })));
  const f = fixture();
  let interactive: Promise<unknown> | null = null;
  try {
    f.layer.setBuild(build);
    f.layer.addTo(f.map); f.complete(); f.emit('idle');
    expect(requests.length).toBeGreaterThan(0);
    const target = requests[0];
    f.layer.setUrl(url('f006'));
    expect(target.signal.aborted).toBe(false);
    const [scheme, load] = f.api.addProtocol.mock.calls[0];
    interactive = load({ url: `${scheme}://${target.url}` }, new AbortController());
    void interactive!.catch(() => {});
    expect(requests.filter(request => request.url === target.url)).toHaveLength(1);
    const bytes = new Uint8Array([82,73,70,70,4,0,0,0,87,69,66,80]);
    target.resolve(new Response(bytes, { headers: { 'content-type': 'image/webp', 'content-length': '12', 'cache-control': 'public, max-age=3600' } }));
    await interactive;
    if (outcome === 'commit') f.complete();
    else if (outcome === 'freeze') f.layer.freeze();
    else f.natives.at(-1)!.listeners.get('error')?.({});
    expect(requests.some(request => request !== target && request.signal.aborted)).toBe(true);
    expect(requests.filter(request => request.url === target.url)).toHaveLength(1);
  } finally { f.layer.remove(); await interactive?.catch(() => {}); }
});

it('commits a viewport that loaded some tiles and reports the tiles that failed', async () => {
  const f = fixture(), errors = vi.fn();
  f.layer.on('tileerror', errors);
  f.layer.addTo(f.map); f.complete();
  f.layer.setUrl(url('f006'));
  const next = f.natives.at(-1)!, bad = {};
  next.listeners.get('error')?.({ tile: bad });
  expect(f.map.removeLayer).not.toHaveBeenCalledWith(next);
  expect(errors).not.toHaveBeenCalled();
  next.loading = false;
  next.listeners.get('data')?.({ tile: {} });
  f.emit('render');
  expect(errors).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(next.setOpacity).toHaveBeenCalledWith(0.5);
  expect(errors).toHaveBeenCalledWith({ tile: bad });
  expect(f.map.removeLayer).toHaveBeenCalledWith(f.natives[0]);
  f.layer.remove();
});

it('bounds handover to the frozen committed slot and one replacement slot', () => {
  const f = fixture();
  f.layer.addTo(f.map); f.complete();
  f.layer.setUrl(url('f006'));
  const oldStaging = f.natives.at(-1)!;
  f.layer.freeze();
  expect(f.map.removeLayer).toHaveBeenCalledWith(oldStaging);
  const replacement = new WindyRasterLayer(f.api, 'https://tiles.example', url('f009'), windyTileOptions(7, 0.5, 'NOAA'));
  replacement.addTo(f.map);
  const removed = new Set(f.map.removeLayer.mock.calls.map(([native]) => native));
  expect(f.map.addLayer.mock.calls.filter(([native]) => !removed.has(native))).toHaveLength(2);
  f.emit('idle');
  f.layer.setUrl(url('f012'));
  expect(f.natives).toHaveLength(3);
  replacement.remove(); f.layer.remove();
});
