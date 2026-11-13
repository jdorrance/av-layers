import { SPLIT_PRODUCT } from '../../../tests/model-fixtures';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWholeDomainDescriptors, type ManifestV5 } from '@av/contracts';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import { fixtureManifestV5, fixtureLatest } from '../../../tests/forecast-fixture';
import { fixturePointBuild, fixtureProfileBuild, retainedProfileBuild, fixturePointFetch } from '../../../tests/client-point-fixture';
import { REGION_A_BOUNDS, REGION_A_POINT, REGION_B_BOUNDS, REGION_B_POINT, autoBuild, autoCatalogRow, autoTime } from '../../../tests/auto-forecast-fixtures';
import { type PinnedBuild, type PointSeriesLoader, type RasterTileProtocol } from '@av/client';

class Element extends EventTarget {
  children: Element[] = [];
  style: Record<string, string> = {};
  textContent = '';
  innerHTML = '';
  className = '';
  href = '';
  hidden = false;
  ariaBusy = '';
  open = false;
  disabled = false;
  tabIndex = -1;
  max = '';
  min = '';
  private selected = '';
  constructor(readonly tag: string) { super(); }
  get ownerDocument(): Document { return doc; }
  get value(): string { return this.selected || this.children[0]?.value || ''; }
  set value(value: string) { this.selected = value; }
  append(...children: Element[]): void { this.children.push(...children); }
  focus(): void { doc.activeElement = this; }
  contains(node: Element): boolean { return visit(this).includes(node); }
  add(child: Element): void { this.append(child); }
  replaceChildren(...children: Element[]): void { this.children = children; this.selected = ''; }
}
class OptionElement extends Element {
  constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; }
}
class Document extends EventTarget {
  elements = new Map<string, Element>();
  activeElement: Element | null = null;
  constructor() {
    super();
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    for (const [, tag, id] of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) this.elements.set(id!, new Element(tag!));
    for (const [, id, options] of html.matchAll(/<select[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
      for (const [, value, text] of options.matchAll(/<option\s+value="([^"]+)"[^>]*>([^<]*)<\/option>/g)) this.elements.get(id)!.add(new OptionElement(text, value));
    }
  }
  getElementById(id: string): Element | null { return this.elements.get(id) ?? null; }
  createElement(tag: string): Element { return new Element(tag); }
}
class Window extends EventTarget {
  setInterval = globalThis.setInterval;
  clearInterval = globalThis.clearInterval;
  requestAnimationFrame = (callback: FrameRequestCallback): number => globalThis.setTimeout(() => callback(Date.now()), 16) as unknown as number;
  cancelAnimationFrame = (handle: number): void => globalThis.clearTimeout(handle);
  href = 'http://localhost:5173/';
  get location(): { pathname: string; search: string; href: string } {
    const url = new URL(this.href);
    return { pathname: url.pathname, search: url.search, href: this.href };
  }
  history = {
    pushState: (_state: unknown, _title: unknown, url?: string | URL | null) => {
      if (url) this.href = new URL(String(url), this.href).href;
    },
    replaceState: (_state: unknown, _title: unknown, url?: string | URL | null) => {
      if (url) this.href = new URL(String(url), this.href).href;
    }
  };
}
class GPUInitializationError extends Error {}
let initializationError: Error | null = null;
let autoLoadRaster = true;
const setWorkerUrl = vi.fn();
const maps: MapMock[] = [];
const map = () => maps.at(-1)!;
class MapMock {
  handlers = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  sources = new Map<string, unknown>();
  layers = new Map<string, { id: string; source?: string; paint?: Record<string, number> }>();
  removed = false;
  options: { style?: { sources?: Record<string, { tiles?: string[] }> }; center?: [number, number]; zoom?: number } = {};
  center = { lng: 0, lat: 0 };
  zoom = 0;
  constructor(options?: MapMock['options']) {
    if (initializationError) throw initializationError;
    this.options = options ?? {};
    if (options?.center) this.center = { lng: options.center[0], lat: options.center[1] };
    if (typeof options?.zoom === 'number') this.zoom = options.zoom;
    maps.push(this);
  }
  on(name: string, listener: (event: Record<string, unknown>) => void): void {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(listener); this.handlers.set(name, handlers);
  }
  off(name: string, listener: (event: Record<string, unknown>) => void): void { this.handlers.set(name, (this.handlers.get(name) ?? []).filter(value => value !== listener)); }
  isSourceLoaded(): boolean { return true; }
  getBounds() { return { getWest: () => -118, getEast: () => -117, getSouth: () => 32, getNorth: () => 33 }; }
  emit(name: string, event: Record<string, unknown> = {}): void { for (const handler of this.handlers.get(name) ?? []) handler(event); }
  addControl(): void {}
  getCenter(): { lng: number; lat: number } { return this.center; }
  getZoom(): number { return this.zoom; }
  getContainer(): { contains(target: unknown): boolean } { return { contains: () => false }; }
  fitBounds(bounds: [[number, number], [number, number]]): void {
    const [[west, south], [east, north]] = bounds;
    this.center = { lng: (west + east) / 2, lat: (south + north) / 2 };
  }
  jumpTo(camera: { center: [number, number]; zoom: number }, event: Record<string, unknown> = {}): void {
    this.emit('movestart', event);
    this.center = { lng: camera.center[0], lat: camera.center[1] };
    this.zoom = camera.zoom;
    this.emit('moveend', event);
  }
  setPaintProperty(id: string, property: string, value: number): void { const layer = this.layers.get(id); if (layer) { layer.paint ??= {}; layer.paint[property] = value; } }
  addSource(id: string, source: unknown): void { this.sources.set(id, source); }
  getSource(id: string): unknown { return this.sources.get(id); }
  removeSource(id: string): void { this.sources.delete(id); }
  addLayer(layer: { id: string; source?: string }): void {
    this.layers.set(layer.id, layer);
    if (autoLoadRaster) { this.emit('sourcedata', { sourceId: layer.source, tile: {} }); this.emit('render'); }
  }
  getLayer(id: string): unknown { return this.layers.get(id); }
  removeLayer(id: string): void { this.layers.delete(id); }
  remove(): void { this.removed = true; }
}
const protocols = new Map<string, RasterTileProtocol['load']>();
vi.mock('maplibre-gl', () => ({ Map: MapMock, NavigationControl: class {}, GPUInitializationError, setWorkerUrl, addProtocol: (name: string, load: RasterTileProtocol['load']) => protocols.set(name, load), removeProtocol: (name: string) => protocols.delete(name) }));
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/assets/map-worker.js' }));

let doc: Document;
let win: Window;
let manifest: ManifestV5;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const horizon = Date.parse('2026-10-31T00:00:00Z');
const ui = (id: string) => doc.elements.get(id)!;
const sourceId = () => [...map().layers.values()].find(layer => layer.source?.startsWith('av-overlay-'))!.source!;
function modelButton(id: string): Element {
  const button = ui('models').children.find(child => child.value === id);
  if (!button) throw new Error(`Missing model button ${id}`);
  return button;
}
function visit(element: Element): Element[] {
  return [element, ...element.children.flatMap(visit)];
}
async function selectFrame(index: number): Promise<void> {
  ui('time').value = String(index);
  ui('time').dispatchEvent(new Event('input'));
  vi.advanceTimersByTime(16);
  await Promise.resolve();
}
function latest() { return new Response(JSON.stringify(fixtureLatest(manifest, 'https://api.test'))); }

function sample(input: RequestInfo | URL, publication = manifest): Response {
  const build: PinnedBuild = { manifest: publication, templates: {}, expiresAtMs: Date.parse(publication.expiresAt) };
  return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
}

function page(name: 'pagehide' | 'pageshow', persisted: boolean): void {
  const event = new Event(name);
  Object.defineProperty(event, 'persisted', { value: persisted });
  win.dispatchEvent(event);
}
async function start(): Promise<void> {
  await import('./main');
  map().emit('load');
  await vi.waitFor(() => expect(modelButton(manifest.model).disabled).toBe(false));
}
beforeEach(() => {
  vi.resetModules();
  maps.length = 0; protocols.clear(); initializationError = null; autoLoadRaster = true; setWorkerUrl.mockClear();
  vi.stubEnv('AV_API_BASE', 'https://api.test');
  vi.useFakeTimers();
  vi.setSystemTime(horizon - 3600_000);
  manifest = fixtureManifestV5();
  vi.stubEnv('VITE_MODEL', manifest.model);
  doc = new Document(); win = new Window();
  fetchMock = vi.fn<typeof fetch>(async () => latest());
  vi.stubGlobal('document', doc); vi.stubGlobal('window', win);
  vi.stubGlobal('Option', OptionElement);
  vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => String(input).includes('/tiles/')
    ? Promise.resolve(new Response(Uint8Array.of(82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80), { headers: { 'content-type': 'image/webp', 'content-length': '12' } }))
    : fetchMock(input, init));
});
afterEach(() => {
  page('pagehide', false);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

it('keeps the incomplete-map warning until every failed tile recovers or leaves the viewport', async () => {
  await start();
  const id = sourceId(), a = {}, b = {}, c = {};
  map().emit('error', { sourceId: id, tile: a });
  map().emit('error', { sourceId: id, tile: c });
  expect(ui('tile-error').className).toBe('toast error');
  expect(ui('tile-error').textContent).toContain('Overlay tile failed to load — forecast display may be incomplete.');
  map().emit('sourcedata', { sourceId: id, tile: b, isSourceLoaded: true });
  expect(ui('tile-error').hidden).toBe(false);
  map().emit('sourcedata', { sourceId: id, isSourceLoaded: true });
  expect(ui('tile-error').hidden).toBe(false);
  map().emit('sourcedata', { sourceId: id, tile: a });
  expect(ui('tile-error').hidden).toBe(false);
  map().emit('sourcedataabort', { sourceId: id, tile: c });
  expect(ui('tile-error').hidden).toBe(true);
});

it('keeps source-level errors through unrelated successes and ignores events from replaced sources', async () => {
  await start();
  const oldSource = sourceId();
  map().emit('error', { sourceId: oldSource });
  map().emit('sourcedata', { sourceId: oldSource, tile: {}, isSourceLoaded: true });
  expect(ui('tile-error').hidden).toBe(false);
  await selectFrame(1);
  expect(sourceId()).not.toBe(oldSource);
  expect(ui('tile-error').hidden).toBe(true);
  map().emit('error', { sourceId: oldSource, tile: {} });
  map().emit('error', { sourceId: 'basemap', tile: {} });
  expect(ui('tile-error').hidden).toBe(true);
});

it('shows the horizon warning as time advances without hiding tile errors or disabling historical viewing', async () => {
  vi.setSystemTime(horizon - 1000);
  await start();
  expect(ui('horizon-notice').hidden).toBe(true);
  map().emit('error', { sourceId: sourceId(), tile: {} });
  vi.advanceTimersByTime(5000);
  expect(ui('horizon-notice').hidden).toBe(false);
  expect(ui('horizon-notice').textContent).toContain('Map forecast ended at 2026-10-31T00:00:00.000Z');
  expect(ui('tile-error').hidden).toBe(false);
  expect(ui('time').disabled).toBe(false);
  expect(map().layers.has(sourceId())).toBe(true);
});

it('shows exhausted forecasts immediately and refreshes the warning after timer throttling', async () => {
  vi.setSystemTime(horizon + 6 * 3600_000);
  await start();
  expect(ui('horizon-notice').hidden).toBe(false);
  expect(ui('time').disabled).toBe(false);
  vi.setSystemTime(horizon - 1);
  win.dispatchEvent(new Event('focus'));
  expect(ui('horizon-notice').hidden).toBe(true);
  vi.setSystemTime(horizon);
  doc.dispatchEvent(new Event('visibilitychange'));
  expect(ui('horizon-notice').hidden).toBe(false);
});

it('restarts a BFCache-interrupted load and ignores the old request if it resolves late', async () => {
  let finishOld!: (response: Response) => void;
  let oldSignal: AbortSignal | null | undefined;
  fetchMock.mockImplementationOnce((_url, init) => {
    oldSignal = init?.signal;
    return new Promise(resolve => { finishOld = resolve; });
  });
  await import('./main'); map().emit('load');
  expect(modelButton(manifest.model).disabled).toBe(true);
  page('pagehide', true);
  expect(oldSignal?.aborted).toBe(true);
  expect(map().removed).toBe(false);
  page('pageshow', true);
  await vi.waitFor(() => expect(modelButton(manifest.model).disabled).toBe(false));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const currentSource = sourceId();
  finishOld(latest());
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(sourceId()).toBe(currentSource);
  expect(ui('freshness').textContent).not.toContain('Loading');
});

it('preserves a loaded build across BFCache restoration and renews its raster generation', async () => {
  manifest.source.provenanceUrl = 'https://api.test/v1/models/gfs/runs/build/provenance';
  await start();
  map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
  expect(ui('meta').children).toHaveLength(0);
  ui('point-build-details').open = true;
  ui('point-build-details').dispatchEvent(new Event('toggle'));
  const links = ui('meta').children.flatMap(child => child.children);
  expect(links.some(link => link.href === manifest.source.provenanceUrl)).toBe(true);
  const currentSource = sourceId();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  page('pagehide', true); page('pageshow', true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(sourceId()).not.toBe(currentSource);
  expect(map().removed).toBe(false);
});

it('stops the previous freshness interval when a replacement load fails', async () => {
  const schedule = vi.spyOn(win, 'setInterval'), cancel = vi.spyOn(win, 'clearInterval');
  await start();
  const interval = schedule.mock.results[0].value;
  fetchMock.mockResolvedValueOnce(new Response('', { status: 400 }));
  modelButton(manifest.model).dispatchEvent(new Event('click'));
  expect(cancel).toHaveBeenCalledWith(interval);
  await vi.waitFor(() => expect(ui('error').textContent).toContain('HTTP 400'));
  expect(vi.getTimerCount()).toBeGreaterThan(0); // The committed overlay keeps its expiry deadline.
  expect(modelButton(manifest.model).disabled).toBe(false);
  expect(ui('days').children).toHaveLength(0);
  expect(ui('time').disabled).toBe(true);
});

it('allows retrying a point request interrupted by BFCache navigation', async () => {
  await start();
  const { ApiClient } = await import('@av/client');
  const createLoader = vi.spyOn(ApiClient.prototype, 'pointSeries');
  let sampleSignal: AbortSignal | null | undefined;
  fetchMock.mockImplementationOnce((_url, init) => {
    sampleSignal = init?.signal;
    return new Promise((_resolve, reject) => sampleSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  });
  map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
  await vi.waitFor(() => expect(sampleSignal?.aborted).toBe(false));
  const dispose = vi.spyOn(createLoader.mock.results[0].value as PointSeriesLoader, 'dispose');
  createLoader.mockRestore();
  page('pagehide', true);
  expect(sampleSignal?.aborted).toBe(true);
  expect(dispose).toHaveBeenCalledOnce();
  page('pageshow', true);
  await Promise.resolve(); await Promise.resolve();
  expect(ui('point-status').textContent).toContain('Point request interrupted');
  expect(ui('time').disabled).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('makes point values keyboard-scrollable only while the card is open', async () => {
  await start();
  expect(ui('point-body').tabIndex).toBe(-1);
  fetchMock.mockImplementation(async input => sample(input));
  map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
  await vi.waitFor(() => expect(ui('point-body').children).toHaveLength(1));
  expect(ui('point-body').tabIndex).toBe(0);
  expect(ui('point-card').hidden).toBe(false);
  expect(ui('point-settings').open).toBe(false);
  expect(ui('point-location').textContent).toBe('32.900°, -117.250°');

  await vi.waitFor(() => expect(ui('point-card').ariaBusy).toBe('false'));
  const chart = ui('point-body').children[0], requests = fetchMock.mock.calls.length;
  page('pagehide', true); page('pageshow', true);
  expect(ui('point-card').hidden).toBe(false);
  expect(ui('point-body').children[0]).toBe(chart);
  expect(fetchMock).toHaveBeenCalledTimes(requests);

  ui('point-close').dispatchEvent(new Event('click'));
  expect(ui('point-body').children).toHaveLength(0);
  expect(ui('point-body').tabIndex).toBe(-1);
  expect(ui('point-card').hidden).toBe(true);
});

it('loads the point renderer on demand while the sample runs and ignores it after close', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const loadRenderer = vi.fn(async (importOriginal: () => Promise<typeof import('@av/windgram')>) => {
    await gate;
    return importOriginal();
  });
  vi.doMock('@av/windgram', loadRenderer);
  try {
    await start();
    expect(loadRenderer).not.toHaveBeenCalled();
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
    await vi.waitFor(() => {
      expect(loadRenderer).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(ui('point-status').textContent).toBe('Loading forecast…');
    ui('point-close').dispatchEvent(new Event('click'));
    expect(fetchMock.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
    release();
    await vi.dynamicImportSettled();
    expect(ui('point-body').children).toHaveLength(0);
    expect(ui('point-card').hidden).toBe(true);
  } finally { release(); vi.doUnmock('@av/windgram'); }
});


it('keeps one session protocol during selection and recreates it after BFCache suspension', async () => {
  await start();
  const scheme = [...protocols.keys()][0];
  await selectFrame(1);
  expect(protocols.size).toBe(1); expect(protocols.has(scheme)).toBe(true);
  page('pagehide', true); expect(protocols.size).toBe(0);
  page('pageshow', true); expect(protocols.size).toBe(1); expect(protocols.has(scheme)).toBe(false);
});

it('retains the committed overlay after staging mount failure and permits retry', async () => {
  await start();
  const active = sourceId();
  vi.spyOn(map(), 'addLayer').mockImplementationOnce(layer => { map().layers.set(layer.id, layer); throw new Error('GPU context unavailable'); });
  await selectFrame(1);
  expect(protocols.size).toBe(1); expect(map().sources.has(active)).toBe(true);
  expect(ui('error').textContent).toContain('GPU context unavailable');
  await selectFrame(0);
  expect(protocols.size).toBe(1); expect(ui('error').hidden).toBe(true);
});

it('configures the bundled worker and reports unsupported graphics without starting requests', async () => {
  initializationError = new GPUInitializationError('WebGL2 unavailable');
  await import('./main');
  expect(setWorkerUrl).toHaveBeenCalledWith('/assets/map-worker.js');
  expect(ui('error').hidden).toBe(false);
  expect(ui('error').textContent).toContain('WebGL2');
  expect(modelButton(manifest.model).disabled).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(protocols.size).toBe(0);
});

it('stops a pending point request and keeps sampling disabled after graphics recovery fails', async () => {
  await start();
  let sampleSignal: AbortSignal | null | undefined;
  fetchMock.mockImplementationOnce((_url, init) => {
    sampleSignal = init?.signal;
    return new Promise((_resolve, reject) => sampleSignal?.addEventListener('abort', () => reject(sampleSignal?.reason)));
  });
  map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  map().emit('error', { error: new GPUInitializationError('Context recreation failed') });
  await vi.advanceTimersByTimeAsync(0);
  expect(sampleSignal?.aborted).toBe(true);
  expect(ui('error').textContent).toContain('WebGL2');
  expect(ui('time').disabled).toBe(true);
  expect(ui('point-card').hidden).toBe(true);
  expect(map().removed).toBe(true);
  expect(protocols.size).toBe(0);
  const jumpTo = vi.spyOn(map(), 'jumpTo');
  win.href = 'http://localhost:5173/?lat=41&lon=-8&z=7';
  win.dispatchEvent(new Event('popstate'));
  expect(jumpTo).not.toHaveBeenCalled();
  page('pageshow', true);
  map().emit('click', { lngLat: { lat: 33, lng: -117 } });
  expect(protocols.size).toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('labels the map clock as longitude time alongside UTC', async () => {
  win.href = 'http://localhost:5173/?lat=41&lon=-8&z=7&t=2026-10-30T06%3A00%3A00.000Z';
  await start();
  expect(ui('timestamp').textContent).toBe('05:00 longitude time (UTC−01:00) · 06:00 UTC');
});

it('uses the default camera when a shared URL has an invalid latitude', async () => {
  win.href = 'http://localhost:5173/?model=gfs&lat=200&lon=20&z=4';
  await start();
  expect(map().getCenter()).toEqual({ lng: 0, lat: 20 });
  expect(map().getZoom()).toBe(2);
});

it('loads ICON hourly frames and keeps the AGL lift layer', async () => {
  await start();
  ui('ref-agl').dispatchEvent(new Event('click'));
  const retained = { ...SPLIT_PRODUCT, layers: ['usable-lift-msl', 'usable-lift-agl'] as const };
  manifest = fixtureManifestV5({ model: 'icon-eu', layers: [...retained.layers],
    descriptors: createWholeDomainDescriptors(retained),
    frames: [4, 5, 7].map(hour => ({ id: `f${String(hour).padStart(3, '0')}`,
      validTime: `2026-10-30T${String(hour).padStart(2, '0')}:00:00.000Z`,
      intervalStart: `2026-10-30T${String(hour - 1).padStart(2, '0')}:00:00.000Z`,
      intervalEnd: `2026-10-30T${String(hour).padStart(2, '0')}:00:00.000Z` }))
  });
  modelButton('icon-eu').dispatchEvent(new Event('click'));
  await vi.waitFor(() => expect(ui('freshness').textContent).toContain(manifest.buildId));
  expect(ui('ref-agl').className).toContain('is-selected');
  expect(ui('time').max).toBe('2');
  expect((map().getSource(sourceId()) as { tiles: string[] }).tiles[0]).toContain('/usable-lift-agl/');
  expect(map().getCenter().lng).toBeCloseTo((-23.5 + 62.5) / 2);
  expect(fetchMock.mock.calls.at(-1)![0]).toContain('/models/icon-eu/latest?');
});

it('lets a user switch back to GFS when ICON has no publication yet', async () => {
  await start();
  fetchMock.mockImplementation(async url => String(url).includes('/icon-eu/')
    ? new Response(JSON.stringify({ detail: 'No publication available for icon-eu' }), { status: 503 }) : latest());
  modelButton('icon-eu').dispatchEvent(new Event('click'));
  await vi.waitFor(() => expect(ui('error').textContent).toContain('No publication available'));
  expect(modelButton('gfs').disabled).toBe(false);
  expect(ui('days').children).toHaveLength(0);
  modelButton('gfs').dispatchEvent(new Event('click'));
  await vi.waitFor(() => expect(ui('time').disabled).toBe(false));
  expect(ui('error').hidden).toBe(true);
  expect(ui('time').max).toBe(String(manifest.frames.length - 1));
});

it('keeps the selected forecast without background requests on focus or elapsed time', async () => {
  await start();
  win.dispatchEvent(new Event('focus'));
  doc.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('selects the v5 surface max zoom for each layer and renders scalar builds with the series chart', async () => {
  const published = fixtureManifestV5();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(fixtureLatest(published))));
  await start();
  const source = () => map().getSource(sourceId()) as { maxzoom: number; tiles: string[] };
  expect(source().maxzoom).toBe(9);
  expect(source().tiles[0]).toContain('/usable-lift-agl/');
  expect(map().layers.get(sourceId())?.paint?.['raster-opacity']).toBe(0.7);
  ui('ref-msl').dispatchEvent(new Event('click'));
  await Promise.resolve();
  expect(source().maxzoom).toBe(9);
  expect(source().tiles[0]).toContain('/usable-lift-msl/');
  ui('ref-agl').dispatchEvent(new Event('click'));
  await Promise.resolve();
  expect(source().tiles[0]).toContain('/usable-lift-agl/');

  fetchMock.mockImplementation(async input => sample(input, published));
  map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
  await vi.waitFor(() => expect(ui('point-body').children).toHaveLength(1));
  expect(ui('point-status').hidden).toBe(true);
  const nodes = visit(ui('point-body').children[0]);
  expect(nodes.find(child => child.className === 'av-point-chart')).toBeTruthy();
  expect(nodes.some(child => child.className === 'av-windgram-host')).toBe(false);
});

it.each(MODEL_OPTIONS.filter(model => model.bounds[2] - model.bounds[0] < 360))('starts $modelId inside its configured bounds', async model => {
  manifest = fixtureManifestV5({ model: model.modelId });
  vi.stubEnv('VITE_MODEL', manifest.model);
  await start();
  const [west, south, east, north] = model.bounds;
  expect(map().getCenter()).toEqual({ lng: (west + east) / 2, lat: (south + north) / 2 });
  expect((map().getSource(sourceId()) as { tiles: string[] }).tiles[0]).toContain(`/${model.modelId}/`);
  expect(win.location.search).toContain(`model=${model.modelId}`);
});

it('preserves an explicit camera at startup and during history navigation', async () => {
  manifest = fixtureManifestV5({ model: 'icon-eu' });
  win.href = 'http://localhost:5173/?model=icon-eu&lat=12&lon=34&z=9';
  await start();
  expect(map().getCenter()).toEqual({ lat: 12, lng: 34 });
  expect(map().getZoom()).toBe(9);
  win.href = 'http://localhost:5173/?model=icon-eu&lat=-23&lon=145&z=5';
  win.dispatchEvent(new Event('popstate'));
  expect(map().getCenter()).toEqual({ lat: -23, lng: 145 });
  expect(map().getZoom()).toBe(5);
});

it('starts Auto from a neutral world view when the URL supplies no camera', async () => {
  const build = autoBuild('gfs', [-180, -55, 180, 65], [1, 18, 36]);
  fetchMock.mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/catalog')) return Response.json({ models: [autoCatalogRow(build.manifest, 27800)] });
    return path.endsWith('/latest') ? Response.json(fixtureLatest(build.manifest)) : sample(input, build.manifest);
  });
  win.href = 'http://localhost:5173/?model=auto';
  await import('./main');
  map().emit('load');
  await vi.waitFor(() => expect((map().getSource(sourceId()) as { tiles: string[] }).tiles[0]).toContain('/gfs/'));
  expect(map().getCenter()).toEqual({ lng: 0, lat: 20 });
  expect(map().getZoom()).toBe(2);
});

it('uses the attributed OpenStreetMap basemap and restores the view from the back button', async () => {
  await start();
  expect(map().options.style?.sources?.basemap).toMatchObject({
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    maxzoom: 19,
    attribution: expect.stringContaining('href="https://www.openstreetmap.org/copyright"')
  });
  expect(win.location.search).toContain('model=gfs');
  expect(win.location.search).toContain('ref=agl');
  expect(win.location.search).toContain('opacity=0.7');
  ui('opacity').value = '0.4';
  ui('opacity').dispatchEvent(new Event('input'));
  expect(win.location.search).toContain('opacity=0.4');
  const saved = win.href;
  ui('ref-msl').dispatchEvent(new Event('click'));
  expect(win.location.search).toContain('ref=msl');
  win.href = saved;
  win.dispatchEvent(new Event('popstate'));
  expect(ui('ref-agl').className).toContain('is-selected');
  expect(ui('opacity').value).toBe('0.4');
  modelButton('rrfs').dispatchEvent(new Event('click'));
  expect(map().getCenter().lat).toBeCloseTo((21.12 + 52.63) / 2);
  expect(map().getCenter().lng).toBeCloseTo((-134.12 + -60.89) / 2);
});

it('keeps the latest history URL when a prior model request is aborted', async () => {
  await start();
  const icon = fixtureManifestV5({ model: 'icon-eu', layers: ['usable-lift-msl', 'usable-lift-agl'] });
  const rrfs = fixtureManifestV5({ model: 'rrfs', layers: ['usable-lift-msl', 'usable-lift-agl'] });
  let finishIcon!: () => void;
  const iconGate = new Promise<void>(resolve => { finishIcon = resolve; });
  fetchMock.mockImplementation(async input => {
    if (String(input).includes('/icon-eu/')) {
      await iconGate;
      return new Response(JSON.stringify(fixtureLatest(icon)));
    }
    return new Response(JSON.stringify(fixtureLatest(rrfs)));
  });
  win.href = 'http://localhost:5173/?model=icon-eu';
  win.dispatchEvent(new Event('popstate'));
  const restored = 'http://localhost:5173/?lat=39&model=rrfs&lon=-97&z=4';
  win.href = restored;
  win.dispatchEvent(new Event('popstate'));
  try {
    await vi.waitFor(() => expect((map().getSource(sourceId()) as { tiles: string[] }).tiles[0]).toContain('/rrfs/'));
    expect(win.href).toBe(restored);
  } finally { finishIcon(); }
  await Promise.resolve();
  expect(win.href).toBe(restored);
});

it('preserves Auto and its requested time when a map move overtakes an earlier regional build', async () => {
  const regionA = autoBuild('wrf-region-a-1km', REGION_A_BOUNDS, [1, 18, 36]);
  const regionB = autoBuild('wrf-region-b-3km', REGION_B_BOUNDS, [1, 18, 36]);
  const builds = new Map([regionA, regionB].map(build => [build.manifest.model, build]));
  const models = [autoCatalogRow(regionA.manifest, 1000), autoCatalogRow(regionB.manifest, 3000)];
  let releaseRegionA!: () => void;
  const pending = new Promise<void>(resolve => { releaseRegionA = resolve; });
  let regionASignal: AbortSignal | null | undefined;
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/catalog')) return Response.json({ models });
    const build = builds.get(url.pathname.split('/')[3])!;
    if (url.pathname.endsWith('/latest')) {
      if (build === regionA) { regionASignal = init?.signal; await pending; }
      return Response.json(fixtureLatest(build.manifest));
    }
    return sample(input, build.manifest);
  });
  const t = autoTime(18);
  const tile = () => (map().getSource(sourceId()) as { tiles: string[] }).tiles[0];
  const expectedTile = `/tiles/${regionB.manifest.model}/${regionB.manifest.buildId}/usable-lift-agl/f018/`;
  win.href = `http://localhost:5173/?model=auto&lat=${REGION_A_POINT.lat}&lon=${REGION_A_POINT.lon}&z=9&t=${encodeURIComponent(t)}`;
  await import('./main');
  map().emit('load');
  try {
    await vi.waitFor(() => expect(regionASignal?.aborted).toBe(false));
    map().jumpTo({ center: [REGION_B_POINT.lon, REGION_B_POINT.lat], zoom: 9 });
    await vi.waitFor(() => expect(tile()).toContain(expectedTile));
    expect(regionASignal?.aborted).toBe(true);
  } finally { releaseRegionA(); }
  await vi.advanceTimersByTimeAsync(0);
  expect(tile()).toContain(expectedTile);
  const state = new URL(win.href).searchParams;
  expect(state.get('model')).toBe('auto');
  expect(state.get('t')).toBe(t);
});

it('keeps a held Auto timeline change when a prior map lookup finishes', async () => {
  const build = autoBuild('wrf-region-a-1km', REGION_A_BOUNDS, [1, 18, 36]);
  const models = [autoCatalogRow(build.manifest, 1000)];
  let catalog = Promise.resolve(models);
  let catalogSignal: AbortSignal | null | undefined;
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/catalog')) {
      catalogSignal = init?.signal;
      return Response.json({ models: await catalog });
    }
    if (url.pathname.endsWith('/latest')) return Response.json(fixtureLatest(build.manifest));
    return sample(input, build.manifest);
  });
  win.href = `http://localhost:5173/?model=auto&lat=${REGION_A_POINT.lat}&lon=${REGION_A_POINT.lon}&z=9&t=${encodeURIComponent(autoTime(18))}`;
  const tile = () => (map().getSource(sourceId()) as { tiles: string[] }).tiles[0];
  await import('./main');
  map().emit('load');
  await vi.waitFor(() => expect(tile()).toContain('/f018/'));

  let finishLookup!: (result: typeof models) => void;
  catalog = new Promise(resolve => { finishLookup = resolve; });
  map().emit('moveend');
  const staleLookup = catalogSignal;
  await selectFrame(2);
  try {
    expect(staleLookup?.aborted).toBe(true);
  } finally { finishLookup([]); }
  await vi.advanceTimersByTimeAsync(0);
  expect(tile()).toContain('/f036/');
  expect(ui('time').disabled).toBe(false);

  catalog = Promise.resolve(models);
  ui('time').dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(fetchMock.mock.calls.some(([input]) => {
    const url = new URL(String(input));
    return url.pathname.endsWith('/sample') && url.searchParams.get('frame') === 'f036';
  })).toBe(true));
  expect(new URL(win.href).searchParams.get('t')).toBe(autoTime(36));
});

it.each(['map movement', 'explicit selection'])('lets %s overtake a pending Auto history restore', async action => {
  const regionA = autoBuild('wrf-region-a-1km', REGION_A_BOUNDS, [18, 36]);
  const regionB = autoBuild('wrf-region-b-3km', REGION_B_BOUNDS, [18, 36]);
  const gfs = autoBuild('gfs', REGION_A_BOUNDS, [18, 36]);
  const builds = new Map([regionA, regionB, gfs].map(build => [build.manifest.model, build]));
  const models = [autoCatalogRow(regionA.manifest, 1000), autoCatalogRow(regionB.manifest, 3000)];
  let releaseRegionB!: () => void;
  const pending = new Promise<void>(resolve => { releaseRegionB = resolve; });
  let regionBSignal: AbortSignal | null | undefined;
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/catalog')) return Response.json({ models });
    const build = builds.get(url.pathname.split('/')[3])!;
    if (url.pathname.endsWith('/latest')) {
      if (build === regionB) { regionBSignal = init?.signal; await pending; }
      return Response.json(fixtureLatest(build.manifest));
    }
    return sample(input, build.manifest);
  });
  const autoUrl = (point: typeof REGION_A_POINT, hour: number) =>
    `http://localhost:5173/?model=auto&lat=${point.lat}&lon=${point.lon}&z=9&t=${encodeURIComponent(autoTime(hour))}`;
  const tile = () => (map().getSource(sourceId()) as { tiles: string[] }).tiles[0];
  win.href = autoUrl(REGION_A_POINT, 18);
  await import('./main');
  map().emit('load');
  await vi.waitFor(() => expect(tile()).toContain('/f018/'));

  win.href = autoUrl(REGION_B_POINT, 36);
  win.dispatchEvent(new Event('popstate'));
  try {
    await vi.waitFor(() => expect(regionBSignal?.aborted).toBe(false));
    if (action === 'map movement') map().jumpTo({ center: [REGION_A_POINT.lon, REGION_A_POINT.lat], zoom: 9 });
    else modelButton('gfs').dispatchEvent(new Event('click'));
    expect(regionBSignal?.aborted).toBe(true);
    await vi.waitFor(() => {
      expect(tile()).toContain('/f036/');
      const state = new URL(win.href).searchParams;
      expect(state.get('model')).toBe(action === 'map movement' ? 'auto' : 'gfs');
      if (action === 'map movement') expect(Number(state.get('lat'))).toBe(REGION_A_POINT.lat);
      expect(state.get('t')).toBe(autoTime(36));
    });
  } finally { releaseRegionB(); }
  await vi.advanceTimersByTimeAsync(0);
  expect(tile()).toContain(action === 'map movement' ? '/wrf-region-a-1km/' : '/gfs/');
});

it('reuses one pinned point series for chart clicks, keyboard scrubbing and unit changes', async () => {
  await start();
  fetchMock.mockImplementation(async input => sample(input));
  map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
  await vi.waitFor(() => expect(ui('point-body').children).toHaveLength(1));
  const series = ui('point-body').children[0];
  const nodes = visit(series);
  const chart = nodes.find(child => child.className === 'av-point-chart')!;
  chart.children[0].dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'ArrowRight' }));
  await vi.advanceTimersByTimeAsync(16);
  expect((map().getSource(sourceId()) as { tiles: string[] }).tiles[0]).toContain(`/${manifest.frames[1].id}/`);
  ui('point-units').value = 'imperial'; ui('point-units').dispatchEvent(new Event('change'));
  await vi.advanceTimersByTimeAsync(16);
  expect(ui('point-body').children[0]).toBe(series);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('shows the map lift pair while the selected native profile is pending', async () => {
  const build = fixtureProfileBuild(), published = build.manifest;
  if (published.version !== 5) throw new Error('Expected v5');
  let release!: () => void;
  const profileGate = new Promise<void>(resolve => { release = resolve; });
  fetchMock.mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/latest')) return new Response(JSON.stringify(fixtureLatest(published)));
    if (url.pathname.endsWith('/profile')) await profileGate;
    return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
  });
  vi.stubGlobal('Node', Element);
  await start();
  map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
  const panel = (name: string) => visit(ui('point-body')).find(child => child.className === name);
  try {
    await vi.waitFor(() => expect(panel('av-windgram-lift-summary')?.textContent).toBe('MSL 2000 m · AGL 500 m'));
    expect(panel('av-windgram-profile-status')?.textContent).toBe('Loading native profile…');
    expect(panel('av-windgram-host')?.hidden).toBe(true);
    const requests = fetchMock.mock.calls.length;
    const pointerDown = new Event('pointerdown');
    Object.defineProperty(pointerDown, 'target', { value: ui('ref-msl') });
    doc.dispatchEvent(pointerDown);
    ui('ref-msl').dispatchEvent(new Event('click'));
    expect(panel('av-windgram-lift-summary')?.textContent).toContain('MSL 2000 m · AGL 500 m');
    expect(fetchMock).toHaveBeenCalledTimes(requests);
  } finally { release(); }
  await vi.waitFor(() => expect(panel('av-windgram-host')?.innerHTML).toContain('class="windgram'));
  expect(panel('av-windgram-profile-status')?.hidden).toBe(true);
  expect(panel('av-windgram-lift-summary')?.hidden).toBe(true);
  expect(ui('point-status').hidden).toBe(true);
});

it('pages the full native point forecast while later point times keep the raster prefix unchanged', async () => {
  const pointBuild = retainedProfileBuild(), published = pointBuild.manifest;
  if (published.version !== 5) throw new Error('Expected v5');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let loadingLaterHours = false;
  const firstPointOnlyFrame = published.frames[24].id;
  const mapEnd = published.frames[23].validTime;
  vi.setSystemTime(Date.parse(mapEnd) + 1);
  fetchMock.mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/latest')) return new Response(JSON.stringify(fixtureLatest(published)));
    if (url.pathname.endsWith('/profile') && url.searchParams.get('frame')?.split(',').includes(firstPointOnlyFrame)) {
      loadingLaterHours = true;
      await gate;
    }
    return new Response(JSON.stringify(fixturePointFetch(pointBuild, String(input))));
  });
  await start();
  expect(ui('point-horizon-label').hidden).toBe(false);
  expect(ui('horizon-notice').textContent).toContain(`Map forecast ended at ${mapEnd}`);
  map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
  await vi.waitFor(() => expect(ui('point-card').ariaBusy).toBe('false'));
  const chart = ui('point-body').children[0];
  const raster = () => (map().getSource(sourceId()) as { tiles: string[] }).tiles[0];
  const mapUrl = raster(), mapTime = ui('time').value;
  ui('point-horizon').value = 'forecast'; ui('point-horizon').dispatchEvent(new Event('change'));
  try {
    await vi.waitFor(() => expect(loadingLaterHours).toBe(true));
    expect(ui('point-body').children[0]).toBe(chart);
    expect(ui('point-status').hidden).toBe(false);
    expect(ui('point-status').textContent).toBe('Loading forecast…');
  } finally { release(); }
  await vi.waitFor(() => expect(ui('point-card').ariaBusy).toBe('false'));
  expect(ui('point-status').hidden).toBe(true);
  const series = ui('point-body').children[0], nodes = visit(series);
  const dayTabs = nodes.find(child => child.className === 'av-windgram-days')!;
  expect(dayTabs.children.length).toBeGreaterThan(1);
  dayTabs.children.at(-1)!.dispatchEvent(new Event('click'));
  await vi.advanceTimersByTimeAsync(16);
  expect(raster()).toBe(mapUrl); expect(ui('time').value).toBe(mapTime);
  const time = nodes.find(child => child.className === 'av-point-time')!.textContent;
  expect(time).toContain('Point: ');
  expect(time).toContain(' · Map: ');
  const summary = nodes.find(child => child.className === 'av-windgram-lift-summary')!.textContent;
  expect(summary).toContain('MSL unavailable · AGL unavailable');
  expect(nodes.find(child => child.className === 'av-windgram-profile-status')?.hidden).toBe(true);
  const cameraOnly = new URL(win.href);
  cameraOnly.searchParams.set('z', '5');
  win.href = cameraOnly.href;
  win.dispatchEvent(new Event('popstate'));
  expect(nodes.find(child => child.className === 'av-point-time')!.textContent).toBe(time);
  const requests = fetchMock.mock.calls.length;
  ui('point-horizon').value = 'day'; ui('point-horizon').dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(ui('point-card').ariaBusy).toBe('false'));
  expect(fetchMock).toHaveBeenCalledTimes(requests);
});

it('labels an unprefixed v5 point day as 24 hours while keeping its full forecast available', async () => {
  const build = fixturePointBuild({ frameHours: Array.from({ length: 48 }, (_, index) => index + 1), mapFrameCount: 48 }), m = build.manifest;
  if (m.version !== 5) throw new Error('Expected v5');
  delete m.mapFrameCount;
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(fixtureLatest(m))));
  await start();
  expect(ui('point-horizon-label').hidden).toBe(false);
  expect(ui('point-horizon').children[0].textContent).toBe('24 hours');
});

it.each([[false, false], [true, false], [true, true]])('keeps 40-frame progress and last-good map (fails=%s, selected hour loaded=%s)', async (fail, keepKnown) => {
  const hours = [...Array.from({ length: 24 }, (_, i) => i + 1), ...Array.from({ length: 16 }, (_, i) => 27 + i * 3)];
  const build = fixtureProfileBuild({ frameHours: hours, mapFrameCount: 40, profileLevels: 200 }), published = build.manifest;
  if (published.version !== 5) throw new Error('Expected v5');
  const requests: string[][] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fetchMock.mockImplementation(async input => {
    if (String(input).includes('/latest?')) return new Response(JSON.stringify(fixtureLatest(published)));
    const profile = new URL(String(input)).pathname.endsWith('/profile');
    if (profile) requests.push(new URL(String(input)).searchParams.get('frame')!.split(','));
    if (profile && requests.length === (fail ? 3 : 2)) await gate;
    if (fail && profile && requests.length === 3) throw new Error('Late page failed');
    return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
  });
  autoLoadRaster = false;
  await start();
  expect(ui('point-horizon-label').hidden).toBe(true);
  await selectFrame(0);
  const first = sourceId();
  map().emit('sourcedata', { sourceId: first, tile: {} }); map().emit('render');
  await selectFrame(39);
  map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
  try {
    await vi.waitFor(() => expect(requests).toHaveLength(fail ? 3 : 2));
    expect(ui('point-card').ariaBusy).toBe('true');
    expect(requests[0]).toEqual(['f072']);
    expect(requests.length).toBe(fail ? 3 : 2);
    const nodes = visit(ui('point-body').children[0]);
    expect(nodes.find(child => child.className === 'av-windgram-host')?.innerHTML).toContain('class="windgram');
    expect(nodes.find(child => child.className === 'av-windgram-lift-summary')?.textContent).toContain('MSL 2000 m · AGL 500 m');
    expect(nodes.find(child => child.className === 'av-point-incomplete')?.hidden).toBe(true);
    const stamp = (index: number) => published.frames[index].validTime.slice(0, 16).replace('T', ' ');
    expect(nodes.find(child => child.className === 'av-point-time')?.textContent).toBe(`Point: ${stamp(39)} UTC · Map: ${stamp(0)} UTC`);
    if (!keepKnown) {
      await selectFrame(38);
      expect(nodes.find(child => child.className === 'av-windgram-profile-status')?.textContent).toBe('Loading native profile…');
      expect(nodes.find(child => child.className === 'av-point-time')?.textContent).toBe(`Point: ${stamp(38)} UTC · Map: ${stamp(0)} UTC`);
    }
  } finally { release(); }
  if (fail) {
    await vi.waitFor(() => expect(ui('point-card').ariaBusy).toBe('false'));
    expect(ui('point-status').hidden).toBe(false);
    expect(ui('point-status').textContent).toBe('Late page failed');
    const nodes = visit(ui('point-body').children[0]);
    const dayTabs = nodes.find(child => child.className === 'av-windgram-days')!;
    expect(nodes.find(child => child.className === 'av-windgram-lift-summary')?.textContent).toContain('MSL 2000 m · AGL 500 m');
    expect(nodes.find(child => child.className === 'av-windgram-profile-status')?.hidden).toBe(keepKnown);
    const incomplete = nodes.find(child => child.className === 'av-point-incomplete')!;
    expect(incomplete.hidden).toBe(false); expect((incomplete as unknown as HTMLElement).role).toBe('status');
    expect(incomplete.textContent).toBe('Forecast incomplete. Some hours could not be loaded.');
    expect(nodes.find(child => child.className === 'av-point-time')?.textContent).toContain(published.frames[keepKnown ? 39 : 38].validTime.slice(0, 16).replace('T', ' '));
    ui('point-units').value = 'imperial'; ui('point-units').dispatchEvent(new Event('change'));
    expect(nodes.find(child => child.className === 'av-windgram-lift-summary')?.textContent).toContain('MSL 6562 ft · AGL 1640 ft');
    dayTabs.children.at(-1)!.dispatchEvent(new Event('click'));
    expect(nodes.find(child => child.className === 'av-windgram-lift-summary')?.textContent).toContain('MSL 6562 ft · AGL 1640 ft');
    expect(incomplete.hidden).toBe(false);
    return;
  }
  await vi.waitFor(() => expect(ui('point-card').ariaBusy).toBe('false'));
  expect(requests).toHaveLength(3);
  expect(requests[0]).toEqual(['f072']);
  const finalNodes = visit(ui('point-body').children[0]);
  expect(finalNodes.find(child => child.className === 'av-windgram-host')?.innerHTML).toContain('class="windgram');
  expect(finalNodes.find(child => child.className === 'av-point-incomplete')?.hidden).toBe(true);
  expect(finalNodes.find(child => child.className === 'av-point-time')?.textContent).toContain(published.frames[38].validTime.slice(0, 16).replace('T', ' '));
});

it('labels the displayed raster through pending, failed and successful point-time replacements', async () => {
  const pointBuild = fixtureProfileBuild(), published = pointBuild.manifest;
  if (published.version !== 5) throw new Error('Expected v5');
  fetchMock.mockImplementation(async input => new Response(JSON.stringify(String(input).includes('/latest?')
    ? fixtureLatest(published) : fixturePointFetch(pointBuild, String(input)))));
  autoLoadRaster = false;
  await start();
  await selectFrame(0);
  map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
  await vi.waitFor(() => expect(ui('point-body').children).toHaveLength(1));
  const series = ui('point-body').children[0], time = series.children.find(child => child.className === 'av-point-time')!;
  const stamp = (index: number) => published.frames[index].validTime.slice(0, 16).replace('T', ' ');
  expect(time.textContent).toContain(`Point: ${stamp(0)} UTC · Map: unavailable`);
  const first = sourceId();
  map().emit('sourcedata', { sourceId: first, tile: {} }); map().emit('render');
  expect(time.textContent).toBe(`Point and map: ${stamp(0)} UTC`);
  await selectFrame(1);
  const pending = [...map().layers.keys()].find(id => id !== first)!;
  expect(time.textContent).toBe(`Point: ${stamp(1)} UTC · Map: ${stamp(0)} UTC`);
  map().emit('error', { sourceId: pending });
  expect(ui('tile-error').textContent).toContain('Forecast replacement failed');
  expect(time.textContent).toBe(`Point: ${stamp(1)} UTC · Map: ${stamp(0)} UTC`);
  expect(map().getSource(first)).toBeDefined();
  await selectFrame(2);
  const replacement = [...map().layers.keys()].find(id => id !== first)!;
  expect(time.textContent).toBe(`Point: ${stamp(2)} UTC · Map: ${stamp(0)} UTC`);
  map().emit('sourcedata', { sourceId: replacement, tile: {} }); map().emit('render');
  expect(time.textContent).toBe(`Point and map: ${stamp(2)} UTC`);
  const previous = new URL(win.href);
  previous.searchParams.set('t', published.frames[0].validTime);
  win.href = previous.href;
  win.dispatchEvent(new Event('popstate'));
  expect(time.textContent).toBe(`Point: ${stamp(0)} UTC · Map: ${stamp(2)} UTC`);
  await Promise.resolve();
  const restored = [...map().layers.keys()].find(id => id !== replacement)!;
  map().emit('sourcedata', { sourceId: restored, tile: {} }); map().emit('render');
  expect(time.textContent).toBe(`Point and map: ${stamp(0)} UTC`);
});
