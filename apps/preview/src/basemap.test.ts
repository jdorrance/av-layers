import type { Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, expect, it, vi } from 'vitest';
import { googleTerrainStyle } from './basemap';

const SOURCE_ID = 'google-terrain';
const session = { session: 'session-token', expiry: '4102444800', tileWidth: 512, tileHeight: 512, imageFormat: 'png' };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

class MapMock {
  handlers = new Map<string, Array<() => void>>();
  sources = new Map<string, { attribution?: string; setTiles?: (tiles: string[]) => void }>();
  fired: Array<{ type: string; data: unknown }> = [];
  bounds = { west: -118, east: -117, south: 32, north: 33 };
  zoom = 8;
  getBounds() {
    return {
      getWest: () => this.bounds.west,
      getEast: () => this.bounds.east,
      getSouth: () => this.bounds.south,
      getNorth: () => this.bounds.north
    };
  }
  getZoom(): number { return this.zoom; }
  getSource(id: string): { attribution?: string; setTiles?: (tiles: string[]) => void } | undefined { return this.sources.get(id); }
  on(type: string, listener: () => void): void {
    const listeners = this.handlers.get(type) ?? [];
    listeners.push(listener);
    this.handlers.set(type, listeners);
  }
  off(type: string, listener: () => void): void {
    this.handlers.set(type, (this.handlers.get(type) ?? []).filter(value => value !== listener));
  }
  fire(type: string, data: unknown): void { this.fired.push({ type, data }); }
  emit(type: string): void { for (const listener of this.handlers.get(type) ?? []) listener(); }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('creates a terrain session and raster style with the returned tile size', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    expect(String(input)).toBe('https://tile.googleapis.com/v1/createSession?key=style-key');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ mapType: 'terrain', language: 'en-US', region: 'US', layerTypes: ['layerRoadmap'] });
    return json(session);
  });
  vi.stubGlobal('fetch', fetchMock);

  const basemap = await googleTerrainStyle('style-key');
  const source = basemap.style.sources![SOURCE_ID] as { type: string; tiles: string[]; tileSize: number; maxzoom: number; attribution: string };

  expect(source.type).toBe('raster');
  expect(source.tiles).toEqual(['https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=session-token&key=style-key']);
  expect(source.tileSize).toBe(512);
  expect(source.maxzoom).toBe(22);
  expect(source.attribution).toBe('Google Maps');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  basemap.dispose();
});

it('reuses a session until its expiry', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
    calls++;
    return json({ ...session, expiry: String(calls * 100) });
  }));

  const first = await googleTerrainStyle('reuse-key');
  await googleTerrainStyle('reuse-key');
  expect(calls).toBe(1);

  vi.setSystemTime(100_001);
  await googleTerrainStyle('reuse-key');
  expect(calls).toBe(2);
  first.dispose();
});

it('refreshes viewport attribution from the current view', async () => {
  const viewportParams: URLSearchParams[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/createSession') return json(session);
    viewportParams.push(url.searchParams);
    return json({ copyright: 'Map data ©2026', maxZoomRects: [] });
  }));

  const basemap = await googleTerrainStyle('viewport-key');
  const map = new MapMock();
  map.sources.set(SOURCE_ID, { attribution: 'Google Maps' });
  basemap.attach(map as unknown as MapLibreMap);

  await vi.waitFor(() => expect(basemap.attribution).toBe('Google Maps · Map data ©2026'));
  expect(viewportParams[0]!.get('session')).toBe('session-token');
  expect(viewportParams[0]!.get('key')).toBe('viewport-key');
  expect(viewportParams[0]!.get('zoom')).toBe('8');
  expect(viewportParams[0]!.get('north')).toBe('33');
  expect(viewportParams[0]!.get('south')).toBe('32');
  expect(viewportParams[0]!.get('east')).toBe('-117');
  expect(viewportParams[0]!.get('west')).toBe('-118');
  expect(map.sources.get(SOURCE_ID)!.attribution).toBe('Google Maps · Map data ©2026');
  expect(map.fired.at(-1)?.type).toBe('sourcedata');

  map.bounds = { west: 170, east: -170, south: -90, north: 90 };
  map.zoom = 30;
  map.emit('moveend');
  await vi.waitFor(() => expect(viewportParams).toHaveLength(3));
  expect(viewportParams[1]!.get('zoom')).toBe('22');
  expect(viewportParams[1]!.get('north')).toBe('90');
  expect(viewportParams[1]!.get('south')).toBe('-90');
  expect(viewportParams[1]!.get('east')).toBe('180');
  expect(viewportParams[1]!.get('west')).toBe('170');
  expect(viewportParams[2]!.get('west')).toBe('-180');
  expect(viewportParams[2]!.get('east')).toBe('-170');
  basemap.dispose();
});

it('normalizes repeated worlds and merges antimeridian copyrights', async () => {
  const bounds: string[][] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/createSession') return json(session);
    const pair = [url.searchParams.get('west')!, url.searchParams.get('east')!];
    bounds.push(pair);
    return json({ copyright: `copyright ${pair[0]}` });
  }));
  const basemap = await googleTerrainStyle('wrapped-key');
  const map = new MapMock();
  map.bounds = { west: 530, east: 550, south: -10, north: 10 };
  map.sources.set(SOURCE_ID, {});
  basemap.attach(map as unknown as MapLibreMap);
  await vi.waitFor(() => expect(basemap.attribution).toContain('copyright -180'));
  expect(bounds).toEqual([['170', '180'], ['-180', '-170']]);
  basemap.dispose();
});

it('removes expired tiles and renews the attached session', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
    if (String(input).includes('createSession')) return json({ ...session, session: `token-${++calls}`, expiry: String(calls * 100) });
    return json({ copyright: 'Map data' });
  }));
  const basemap = await googleTerrainStyle('renew-key');
  const map = new MapMock();
  const setTiles = vi.fn();
  map.sources.set(SOURCE_ID, { setTiles });
  basemap.attach(map as unknown as MapLibreMap);
  await vi.advanceTimersByTimeAsync(100_000);
  expect(setTiles.mock.calls[0]).toEqual([[]]);
  expect(setTiles.mock.calls[1][0][0]).toContain('session=token-2');
  basemap.dispose();
  await vi.advanceTimersByTimeAsync(100_000);
  expect(calls).toBe(2);
});

it('aborts an in-flight session renewal on dispose', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let renewalSignal: AbortSignal | null | undefined;
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>((input, init) => {
    if (!String(input).includes('createSession')) return Promise.resolve(json({}));
    if (++calls === 1) return Promise.resolve(json({ ...session, expiry: '100' }));
    renewalSignal = init?.signal;
    return new Promise((_resolve, reject) => renewalSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  }));
  const basemap = await googleTerrainStyle('renew-abort-key');
  const map = new MapMock();
  const setTiles = vi.fn();
  map.sources.set(SOURCE_ID, { setTiles });
  basemap.attach(map as unknown as MapLibreMap);
  await vi.advanceTimersByTimeAsync(100_000);
  expect(setTiles).toHaveBeenCalledWith([]);
  expect(renewalSignal?.aborted).toBe(false);
  basemap.dispose();
  expect(renewalSignal?.aborted).toBe(true);
});

it('aborts stale viewport requests and stops on dispose', async () => {
  const signals: AbortSignal[] = [];
  const pending: Array<(response: Response) => void> = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).includes('/v1/createSession')) return json(session);
    signals.push(init!.signal!);
    return new Promise<Response>(resolve => { pending.push(resolve); });
  }));

  const basemap = await googleTerrainStyle('abort-key');
  const map = new MapMock();
  map.sources.set(SOURCE_ID, {});
  basemap.attach(map as unknown as MapLibreMap);
  await vi.waitFor(() => expect(signals).toHaveLength(1));

  map.emit('moveend');
  await vi.waitFor(() => expect(signals).toHaveLength(2));
  expect(signals[0]!.aborted).toBe(true);
  expect(signals[1]!.aborted).toBe(false);

  basemap.dispose();
  expect(signals[1]!.aborted).toBe(true);
  pending.forEach(resolve => resolve(json({ copyright: 'late' })));
});

it('honors the startup abort signal', async () => {
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>((_input, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  }));

  const pending = googleTerrainStyle('cancel-key', controller.signal);
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(DOMException);
  expect(signal?.aborted).toBe(true);
});
