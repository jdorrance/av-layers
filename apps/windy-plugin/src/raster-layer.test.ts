import { afterEach, expect, it, vi } from 'vitest';
import { windyTileOptions } from '@av/contracts/client';
import { forecastStackZIndex, WindyRasterLayer, type NativeRasterSource, type RasterSourceEvent } from './raster-layer';

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const listeners = new Map<string, (event: RasterSourceEvent) => void>();
  const source: NativeRasterSource = {
    on: vi.fn((event, listener) => { listeners.set(event, listener); }),
    off: vi.fn((event, listener) => { if (listeners.get(event) === listener) listeners.delete(event); })
  };
  const native = { source: () => source, setUrl: vi.fn(), setOpacity: vi.fn() };
  const map = { addLayer: vi.fn(), removeLayer: vi.fn() };
  const create = vi.fn<(url: string, options: ReturnType<typeof windyTileOptions>) => typeof native>(() => native);
  const api = { tileLayer: create, addProtocol: vi.fn(), removeProtocol: vi.fn() };
  const layer = new WindyRasterLayer(api, 'https://tiles.example', 'https://tiles.example/tiles/gfs/build-1/precip-rate/f003/{z}/{x}/{y}.webp', windyTileOptions(7, 0.5, 'NOAA'));
  return { listeners, source, native, map, create, layer, api };
}

it('bridges actual LeafletGL source events without assuming classic Leaflet tile events', () => {
  const { layer, listeners, map, native, create } = fixture();
  const starts = vi.fn(), errors = vi.fn(), loads = vi.fn(), unloads = vi.fn();
  layer.on('tileloadstart', starts);
  layer.on('tileerror', errors);
  layer.on('tileload', loads);
  layer.on('tileunload', unloads);
  layer.addTo(map);
  expect(map.addLayer).toHaveBeenCalledWith(native);
  expect(create.mock.calls[0]?.[1]).toMatchObject({ maxNativeZoom: 7, maxZoom: 18 });
  expect([...listeners.keys()]).toEqual(['dataloading', 'data', 'error', 'dataabort']);
  const failed = { tile: {} }, successful = { tile: {} };
  listeners.get('data')?.({}); // TileJSON/metadata events have no tile.
  listeners.get('error')?.({});
  expect(loads).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
  listeners.get('dataloading')?.(failed);
  listeners.get('dataloading')?.(successful);
  listeners.get('error')?.(failed);
  listeners.get('data')?.(successful);
  listeners.get('dataabort')?.(failed);
  expect(starts.mock.calls).toEqual([[failed], [successful]]);
  expect(errors).toHaveBeenCalledWith(failed);
  expect(loads).toHaveBeenCalledWith(successful);
  expect(unloads).toHaveBeenCalledWith(failed);
  layer.remove();
});

it('keeps one protocol across native URL changes and detaches the exact source listeners on close', () => {
  const { layer, listeners, map, native, source, api } = fixture();
  const error = vi.fn();
  layer.on('tileerror', error);
  layer.addTo(map);
  const lateError = listeners.get('error')!;
  const scheme = api.addProtocol.mock.calls[0][0];
  for (const frame of ['f006', 'f009', 'f012']) {
    const url = `https://tiles.example/tiles/gfs/build-1/precip-rate/${frame}/{z}/{x}/{y}.webp`;
    layer.setUrl(url);
    expect(native.setUrl).toHaveBeenLastCalledWith(`${scheme}://${url}`);
  }
  layer.setOpacity(0.7);
  expect(api.addProtocol).toHaveBeenCalledTimes(1);
  expect(api.removeProtocol).not.toHaveBeenCalled();
  expect(native.setOpacity).toHaveBeenCalledWith(0.7);
  layer.remove();
  expect(listeners.size).toBe(0);
  expect(source.off).toHaveBeenCalledTimes(4);
  expect(map.removeLayer).toHaveBeenCalledWith(native);
  expect(api.removeProtocol).toHaveBeenCalledWith(scheme);
  lateError({ tile: {} });
  expect(error).not.toHaveBeenCalled();
  layer.remove();
  expect(map.removeLayer).toHaveBeenCalledTimes(1);
  expect(api.removeProtocol).toHaveBeenCalledTimes(1);
  expect(() => layer.addTo(map)).toThrow('disposed');
});

it('cleans up a partially mounted host layer when the required source API is unavailable', () => {
  const native = { source: () => undefined, setUrl: vi.fn(), setOpacity: vi.fn() };
  const map = { addLayer: vi.fn(), removeLayer: vi.fn() };
  const api = { tileLayer: () => native, addProtocol: vi.fn(), removeProtocol: vi.fn() };
  const layer = new WindyRasterLayer(api, 'https://tiles.example', 'https://tiles.example/tiles/gfs/build-1/precip-rate/f003/{z}/{x}/{y}.webp', windyTileOptions(7, 0.5, 'NOAA'));
  expect(() => layer.addTo(map)).toThrow('Windy raster source is unavailable');
  expect(map.removeLayer).toHaveBeenCalledWith(native);
  layer.remove();
  expect(map.removeLayer).toHaveBeenCalledTimes(1);
  expect(api.removeProtocol).toHaveBeenCalledTimes(1);
});

it('honors native cancellation and shares the request bound with deferred previous URLs until close', async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
    const signal = init!.signal!;
    signals.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })));
  const { layer, api, create, native, map } = fixture();
  layer.addTo(map);
  const handler = api.addProtocol.mock.calls[0][1];
  const template = create.mock.calls[0][0];
  const tileUrl = template.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0');
  const nativeControllers = Array.from({ length: 3 }, () => new AbortController());
  // LeafletGL clearTiles aborts the controllers supplied to the protocol.
  native.setUrl.mockImplementation(() => nativeControllers.forEach(controller => controller.abort()));
  const pending = Promise.allSettled(nativeControllers.map(controller => handler({ url: tileUrl }, controller)));
  let final: Promise<PromiseSettledResult<unknown>[]> = Promise.resolve([]);
  try {
    expect(signals).toHaveLength(2); // One request remains in the shared bounded queue.
    layer.setUrl('https://tiles.example/tiles/gfs/build-1/precip-rate/f006/{z}/{x}/{y}.webp');
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect((await pending).map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(signals).toHaveLength(2); // The cancelled queued request never fetched.

    const currentUrl = native.setUrl.mock.calls[0][0].replace('{z}', '0').replace('{x}', '0').replace('{y}', '0');
    // A deferred old URL still resolves through the registered protocol while
    // native metadata catches up. Both URLs use the same two-request limit.
    final = Promise.allSettled([currentUrl, tileUrl, currentUrl].map(url => handler({ url }, new AbortController())));
    expect(signals).toHaveLength(4);
    expect(signals.slice(2).every(signal => !signal.aborted)).toBe(true);
    expect(fetch).toHaveBeenLastCalledWith('https://tiles.example/tiles/gfs/build-1/precip-rate/f003/0/0/0.webp', expect.any(Object));
    expect(api.addProtocol).toHaveBeenCalledTimes(1);
    expect(api.removeProtocol).not.toHaveBeenCalled();
    layer.remove();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect((await final).map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(signals).toHaveLength(4);
    expect(api.removeProtocol).toHaveBeenCalledTimes(1);
  } finally {
    layer.remove();
    await pending;
    await final;
  }
});

it('preserves the registered protocol after a native URL update fails and cleans it up on close', () => {
  const { layer, api, native, map } = fixture();
  layer.addTo(map);
  native.setUrl.mockImplementationOnce(() => { throw new Error('native update failed'); });
  expect(() => layer.setUrl('https://tiles.example/tiles/gfs/build-1/precip-rate/f006/{z}/{x}/{y}.webp')).toThrow('native update failed');
  expect(api.addProtocol).toHaveBeenCalledTimes(1);
  expect(api.removeProtocol).not.toHaveBeenCalled();
  layer.remove();
  expect(api.removeProtocol).toHaveBeenCalledTimes(1);
  expect(map.removeLayer).toHaveBeenCalledTimes(1);
});

it('stacks the forecast just above the weather color and below wind particles', () => {
  expect(forecastStackZIndex(undefined)).toBe(1);
  expect(forecastStackZIndex({ MAIN: 10 })).toBe(11);
  expect(forecastStackZIndex({ MAIN: 10, PARTICLES: 12 })).toBe(11);
  expect(forecastStackZIndex({ MAIN: 10, PARTICLES: 11 })).toBe(10.5);
  expect(forecastStackZIndex({ MAIN: 10, PARTICLES: 40, PARTICLES_HIGH_ZOOM: 11 })).toBe(10.5);
  expect(forecastStackZIndex({ MAIN: 10, PARTICLES: 9 })).toBe(11);
});
