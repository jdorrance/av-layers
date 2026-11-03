import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createProductDescriptors, ICON_EU_PRODUCT, type Manifest } from '@av/contracts';
import { fixtureManifest, fixtureLatest } from '../../../tests/forecast-fixture';
import { OVERLAY_LAYER_ID, type RasterTileProtocol } from '@av/contracts/client';

class Element extends EventTarget {
  children: Element[] = [];
  style: Record<string, string> = {};
  textContent = '';
  className = '';
  href = '';
  hidden = false;
  disabled = false;
  tabIndex = -1;
  private selected = '';
  constructor(readonly tag: string) { super(); }
  get value(): string { return this.selected || this.children[0]?.value || ''; }
  set value(value: string) { this.selected = value; }
  append(...children: Element[]): void { this.children.push(...children); }
  add(child: Element): void { this.append(child); }
  replaceChildren(...children: Element[]): void { this.children = children; this.selected = ''; }
}
class OptionElement extends Element {
  constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; }
}
class Document extends EventTarget {
  elements = new Map<string, Element>();
  constructor() {
    super();
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    for (const [, tag, id] of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) this.elements.set(id!, new Element(tag!));
  }
  getElementById(id: string): Element | null { return this.elements.get(id) ?? null; }
  createElement(tag: string): Element { return new Element(tag); }
}
class Window extends EventTarget {
  setInterval = globalThis.setInterval;
  clearInterval = globalThis.clearInterval;
}
class GPUInitializationError extends Error {}
let initializationError: Error | null = null;
const setWorkerUrl = vi.fn();
const maps: MapMock[] = [];
const map = () => maps.at(-1)!;
class MapMock {
  handlers = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  sources = new Map<string, unknown>();
  layers = new Map<string, { id: string; source?: string }>();
  removed = false;
  constructor() { if (initializationError) throw initializationError; maps.push(this); }
  on(name: string, listener: (event: Record<string, unknown>) => void): void {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(listener); this.handlers.set(name, handlers);
  }
  emit(name: string, event: Record<string, unknown> = {}): void { for (const handler of this.handlers.get(name) ?? []) handler(event); }
  addControl(): void {}
  fitBounds(): void {}
  setPaintProperty(): void {}
  addSource(id: string, source: unknown): void { this.sources.set(id, source); }
  getSource(id: string): unknown { return this.sources.get(id); }
  removeSource(id: string): void { this.sources.delete(id); }
  addLayer(layer: { id: string; source?: string }): void { this.layers.set(layer.id, layer); }
  getLayer(id: string): unknown { return this.layers.get(id); }
  removeLayer(id: string): void { this.layers.delete(id); }
  remove(): void { this.removed = true; }
}
const protocols = new Map<string, RasterTileProtocol['load']>();
vi.mock('maplibre-gl', () => ({ Map: MapMock, NavigationControl: class {}, GPUInitializationError, setWorkerUrl, addProtocol: (name: string, load: RasterTileProtocol['load']) => protocols.set(name, load), removeProtocol: (name: string) => protocols.delete(name) }));
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/assets/map-worker.js' }));

let doc: Document;
let win: Window;
let manifest: Manifest;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const horizon = Date.parse('2026-10-31T00:00:00Z');
const ui = (id: string) => doc.elements.get(id)!;
const sourceId = () => map().layers.get(OVERLAY_LAYER_ID)!.source!;
function latest() { return new Response(JSON.stringify(fixtureLatest(manifest, 'https://api.test'))); }

function page(name: 'pagehide' | 'pageshow', persisted: boolean): void {
  const event = new Event(name);
  Object.defineProperty(event, 'persisted', { value: persisted });
  win.dispatchEvent(event);
}
async function start(): Promise<void> {
  await import('./main');
  map().emit('load');
  await vi.waitFor(() => expect(ui('model').disabled).toBe(false));
}
beforeEach(() => {
  vi.resetModules();
  maps.length = 0; protocols.clear(); initializationError = null; setWorkerUrl.mockClear();
  vi.stubEnv('AV_API_BASE', 'https://api.test');
  vi.useFakeTimers();
  vi.setSystemTime(horizon - 3600_000);
  manifest = fixtureManifest();
  doc = new Document(); win = new Window();
  fetchMock = vi.fn<typeof fetch>(async () => latest());
  vi.stubGlobal('document', doc); vi.stubGlobal('window', win);
  vi.stubGlobal('Option', OptionElement); vi.stubGlobal('fetch', fetchMock);
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
  ui('frame').value = manifest.frames[1]!.id;
  ui('frame').dispatchEvent(new Event('change'));
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
  expect(ui('horizon-notice').textContent).toContain('Forecast ended at 2026-10-31T00:00:00.000Z');
  expect(ui('tile-error').hidden).toBe(false);
  expect(ui('frame').disabled).toBe(false);
  expect(map().layers.has(OVERLAY_LAYER_ID)).toBe(true);
});

it('shows exhausted forecasts immediately and refreshes the warning after timer throttling', async () => {
  vi.setSystemTime(horizon + 6 * 3600_000);
  await start();
  expect(ui('horizon-notice').hidden).toBe(false);
  expect(ui('frame').disabled).toBe(false);
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
  expect(ui('model').disabled).toBe(true);
  page('pagehide', true);
  expect(oldSignal?.aborted).toBe(true);
  expect(map().removed).toBe(false);
  page('pageshow', true);
  await vi.waitFor(() => expect(ui('model').disabled).toBe(false));
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
  const links = ui('meta').children.flatMap(child => child.children);
  expect(links.some(link => link.href === manifest.source.provenanceUrl)).toBe(true);
  const currentSource = sourceId();
  page('pagehide', true); page('pageshow', true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(sourceId()).not.toBe(currentSource);
  expect(map().removed).toBe(false);
});

it('stops the previous freshness interval when a replacement load fails', async () => {
  const schedule = vi.spyOn(win, 'setInterval'), cancel = vi.spyOn(win, 'clearInterval');
  await start();
  const interval = schedule.mock.results[0].value;
  fetchMock.mockResolvedValueOnce(new Response('', { status: 400 }));
  ui('model').dispatchEvent(new Event('change'));
  expect(cancel).toHaveBeenCalledWith(interval);
  await vi.waitFor(() => expect(ui('error').textContent).toContain('HTTP 400'));
  expect(vi.getTimerCount()).toBe(0);
  expect(ui('model').disabled).toBe(false);
  expect(ui('frame').children).toHaveLength(0);
  expect(ui('frame').disabled).toBe(true);
});

it('allows retrying a point request interrupted by BFCache navigation', async () => {
  await start();
  map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
  let sampleSignal: AbortSignal | null | undefined;
  fetchMock.mockImplementationOnce((_url, init) => {
    sampleSignal = init?.signal;
    return new Promise((_resolve, reject) => sampleSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  });
  ui('series-button').dispatchEvent(new Event('click'));
  expect(ui('series-button').disabled).toBe(true);
  page('pagehide', true);
  expect(sampleSignal?.aborted).toBe(true);
  page('pageshow', true);
  await Promise.resolve(); await Promise.resolve();
  expect(ui('series-button').disabled).toBe(false);
  expect(ui('series-status').textContent).toContain('Point request interrupted');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('makes point values keyboard-scrollable only while the series has results', async () => {
  await start();
  expect(ui('series').tabIndex).toBe(-1);
  map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
    model: manifest.model, buildId: manifest.buildId, lat: 32.9, lon: -117.25,
    method: manifest.method, source: manifest.source, coverage: manifest.coverage, expiresAt: manifest.expiresAt,
    frames: manifest.frames.map(frame => ({
      ...frame,
      layers: Object.fromEntries(manifest.layers.map(layer => [layer, { value: 1, status: 'valid', support: 0, interpolated: false }]))
    }))
  })));
  ui('series-button').dispatchEvent(new Event('click'));
  await vi.waitFor(() => expect(ui('series').children).toHaveLength(1));
  expect(ui('series').tabIndex).toBe(0);

  map().emit('click', { lngLat: { lat: 33, lng: -117 } });
  expect(ui('series').children).toHaveLength(0);
  expect(ui('series').tabIndex).toBe(-1);
});


it('cancels the old raster generation and removes protocols on replacement and BFCache suspension', async () => {
  await start();
  const url = (map().getSource(sourceId()) as { tiles: string[] }).tiles[0].replace('{z}', '0').replace('{x}', '0').replace('{y}', '0');
  const scheme = url.split('://')[0], loader = protocols.get(scheme)!;
  expect(protocols.size).toBe(1);
  fetchMock.mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); }));
  const pending = loader({ url }, new AbortController());
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  ui('frame').value = manifest.frames[1].id; ui('frame').dispatchEvent(new Event('change'));
  await cancelled;
  expect(protocols.has(scheme)).toBe(false); expect(protocols.size).toBe(1);
  page('pagehide', true); expect(protocols.size).toBe(0);
  page('pageshow', true); expect(protocols.size).toBe(1);
});

it('cleans a partially mounted overlay and displays frame-change errors, then permits recovery', async () => {
  await start();
  const addLayer = map().addLayer.bind(map());
  let failedProtocol: { load: RasterTileProtocol['load']; url: string };
  vi.spyOn(map(), 'addLayer').mockImplementationOnce(layer => {
    addLayer(layer);
    const source = map().sources.get(layer.source!) as { tiles: string[] };
    failedProtocol = { load: [...protocols.values()][0], url: source.tiles[0].replace(/\{[zxy]\}/g, '0') };
    throw new Error('GPU context unavailable');
  });
  ui('frame').value = manifest.frames[1].id;
  ui('frame').dispatchEvent(new Event('change'));
  expect(protocols.size).toBe(0); expect(map().sources.size).toBe(0); expect(map().layers.size).toBe(0);
  expect(ui('error').hidden).toBe(false); expect(ui('error').textContent).toContain('GPU context unavailable');
  expect(ui('timestamp').textContent).toBe('Overlay unavailable');
  await expect(failedProtocol!.load({ url: failedProtocol!.url }, new AbortController())).rejects.toMatchObject({ name: 'AbortError' });
  ui('frame').value = manifest.frames[0].id; ui('frame').dispatchEvent(new Event('change'));
  expect(protocols.size).toBe(1); expect(map().sources.size).toBe(1); expect(ui('error').hidden).toBe(true);
});

it('configures the bundled worker and reports unsupported graphics without starting requests', async () => {
  initializationError = new GPUInitializationError('WebGL2 unavailable');
  await import('./main');
  expect(setWorkerUrl).toHaveBeenCalledWith('/assets/map-worker.js');
  expect(ui('error').hidden).toBe(false);
  expect(ui('error').textContent).toContain('WebGL2');
  expect(ui('model').disabled).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(protocols.size).toBe(0);
});

it('stops a pending point request and keeps sampling disabled after graphics recovery fails', async () => {
  await start();
  map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
  let sampleSignal: AbortSignal | null | undefined;
  fetchMock.mockImplementationOnce((_url, init) => {
    sampleSignal = init?.signal;
    return new Promise((_resolve, reject) => sampleSignal?.addEventListener('abort', () => reject(sampleSignal?.reason)));
  });
  ui('series-button').dispatchEvent(new Event('click'));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  map().emit('error', { error: new GPUInitializationError('Context recreation failed') });
  await vi.advanceTimersByTimeAsync(0);
  expect(sampleSignal?.aborted).toBe(true);
  expect(ui('error').textContent).toContain('WebGL2');
  expect(ui('frame').disabled).toBe(true);
  expect(ui('series-button').disabled).toBe(true);
  expect(map().removed).toBe(true);
  expect(protocols.size).toBe(0);
  page('pageshow', true);
  map().emit('click', { lngLat: { lat: 33, lng: -117 } });
  ui('series-button').dispatchEvent(new Event('click'));
  expect(ui('series-button').disabled).toBe(true);
  expect(protocols.size).toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('loads ICON layers and hourly frames directly from its published manifest', async () => {
  await start();
  manifest = fixtureManifest({ model: 'icon-eu', buildId: 'icon-hourly', layers: [...ICON_EU_PRODUCT.layers],
    grid: ICON_EU_PRODUCT.grid, descriptors: createProductDescriptors(ICON_EU_PRODUCT),
    frames: [4, 5, 7].map(hour => ({ id: `f${String(hour).padStart(3, '0')}`,
      validTime: `2026-10-30T${String(hour).padStart(2, '0')}:00:00.000Z`,
      intervalStart: `2026-10-30T${String(hour - 1).padStart(2, '0')}:00:00.000Z`,
      intervalEnd: `2026-10-30T${String(hour).padStart(2, '0')}:00:00.000Z` }))
  });
  ui('model').value = 'icon-eu'; ui('model').dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(ui('freshness').textContent).toContain('icon-hourly'));
  expect(ui('layer').children.map(option => option.value)).toEqual(ICON_EU_PRODUCT.layers);
  expect(ui('frame').children.map(option => option.value)).toEqual(['f004', 'f005', 'f007']);
  expect(fetchMock.mock.calls.at(-1)![0]).toContain('/models/icon-eu/latest?');
});

it('lets a user switch back to GFS when ICON has no publication yet', async () => {
  await start();
  fetchMock.mockImplementation(async url => String(url).includes('/icon-eu/')
    ? new Response(JSON.stringify({ detail: 'No publication available for icon-eu' }), { status: 503 }) : latest());
  ui('model').value = 'icon-eu'; ui('model').dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(ui('error').textContent).toContain('No publication available'));
  expect(ui('model').disabled).toBe(false);
  expect(ui('frame').children).toHaveLength(0);
  ui('model').value = 'gfs'; ui('model').dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(ui('frame').disabled).toBe(false));
  expect(ui('error').hidden).toBe(true);
  expect(ui('frame').children.map(option => option.value)).toEqual(manifest.frames.map(frame => frame.id));
});

it('keeps the selected forecast without background requests on focus or elapsed time', async () => {
  await start();
  win.dispatchEvent(new Event('focus'));
  doc.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
