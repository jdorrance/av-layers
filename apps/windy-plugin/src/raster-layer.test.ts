import { afterEach, expect, it, vi } from 'vitest';
import { windyTileOptions } from '@av/contracts/client';
import { WindyRasterLayer, type NativeRasterSource, type RasterSourceEvent } from './raster-layer';

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

it('updates native URLs/opacity and detaches the exact source listeners on close', () => {
  const { layer, listeners, map, native, source, api } = fixture();
  const error = vi.fn();
  layer.on('tileerror', error);
  layer.addTo(map);
  const lateError = listeners.get('error')!;
  layer.setUrl('https://tiles.example/tiles/gfs/build-1/precip-rate/f006/{z}/{x}/{y}.webp');
  layer.setOpacity(0.7);
  expect(api.addProtocol).toHaveBeenCalledTimes(2);
  const initialScheme = api.addProtocol.mock.calls[0][0];
  const currentScheme = api.addProtocol.mock.calls[1][0];
  expect(currentScheme).not.toBe(initialScheme);
  expect(native.setUrl.mock.calls[0][0]).toMatch(new RegExp(`^${currentScheme}://`));
  expect(api.removeProtocol).toHaveBeenCalledWith(initialScheme);
  expect(native.setOpacity).toHaveBeenCalledWith(0.7);
  layer.remove();
  expect(listeners.size).toBe(0);
  expect(source.off).toHaveBeenCalledTimes(4);
  expect(map.removeLayer).toHaveBeenCalledWith(native);
  expect(api.removeProtocol).toHaveBeenCalledWith(currentScheme);
  lateError({ tile: {} });
  expect(error).not.toHaveBeenCalled();
  layer.remove();
  expect(map.removeLayer).toHaveBeenCalledTimes(1);
  expect(api.removeProtocol).toHaveBeenCalledTimes(2);
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

it('cancels queued and active requests when replacing the native source generation or closing it', async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
    const signal = init!.signal!;
    signals.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })));
  const { layer, api, create, native } = fixture();
  const oldHandler = api.addProtocol.mock.calls[0][1];
  const template = create.mock.calls[0][0];
  const tileUrl = template.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0');
  const pending = Promise.allSettled(Array.from({ length: 3 }, () => oldHandler({ url: tileUrl }, new AbortController())));
  expect(signals).toHaveLength(2); // One request remains in the shared bounded queue.
  layer.setUrl('https://tiles.example/tiles/gfs/build-1/precip-rate/f006/{z}/{x}/{y}.webp');
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect((await pending).map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
  expect(signals).toHaveLength(2); // The cancelled queued request never fetched.

  const newHandler = api.addProtocol.mock.calls[1][1];
  const currentUrl = native.setUrl.mock.calls[0][0].replace('{z}', '0').replace('{x}', '0').replace('{y}', '0');
  const final = Promise.allSettled([newHandler({ url: currentUrl }, new AbortController())]);
  expect(signals).toHaveLength(3);
  expect(signals[2].aborted).toBe(false);
  layer.remove();
  expect(signals[2].aborted).toBe(true);
  expect((await final)[0].status).toBe('rejected');
  expect(api.removeProtocol).toHaveBeenCalledTimes(2);
});
