import { SPLIT_PRODUCT } from '../../../tests/model-fixtures';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createProductDescriptors, CELL_BYTES, computeFreshness, latestSchema, manifestV5Schema, type Manifest } from '@av/contracts';
import { fixtureManifest, fixtureLatest } from '../../../tests/forecast-fixture';
import { type RasterTileProtocol } from '@av/contracts/client';

class Element extends EventTarget {
  children: Element[] = [];
  style: Record<string, string> = {};
  textContent = '';
  className = '';
  href = '';
  hidden = false;
  disabled = false;
  tabIndex = -1;
  max = '';
  min = '';
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
  jumpTo(camera: { center: [number, number]; zoom: number }): void {
    this.center = { lng: camera.center[0], lat: camera.center[1] };
    this.zoom = camera.zoom;
  }
  setPaintProperty(id: string, property: string, value: number): void { const layer = this.layers.get(id); if (layer) { layer.paint ??= {}; layer.paint[property] = value; } }
  addSource(id: string, source: unknown): void { this.sources.set(id, source); }
  getSource(id: string): unknown { return this.sources.get(id); }
  removeSource(id: string): void { this.sources.delete(id); }
  addLayer(layer: { id: string; source?: string }): void { this.layers.set(layer.id, layer); this.emit('sourcedata', { sourceId: layer.source, tile: {} }); this.emit('render'); }
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
const sourceId = () => [...map().layers.values()].find(layer => layer.source?.startsWith('av-overlay-'))!.source!;
function modelButton(id: string): Element {
  const button = ui('models').children.find(child => child.value === id);
  if (!button) throw new Error(`Missing model button ${id}`);
  return button;
}
async function selectFrame(index: number): Promise<void> {
  ui('time').value = String(index);
  ui('time').dispatchEvent(new Event('input'));
  vi.advanceTimersByTime(16);
  await Promise.resolve();
}
function latest() { return new Response(JSON.stringify(fixtureLatest(manifest, 'https://api.test'))); }

function v5Manifest() {
  const base = fixtureManifest();
  const { version: _version, coverage, grid, samples: _samples, ...rest } = base;
  if (grid.kind !== 'regular-latlon') throw new Error('fixture requires a regular latitude/longitude grid');
  const prefix = `builds/${base.model}/${base.buildId}`;
  const fineGrid = { ...grid, width: grid.width * 2, height: grid.height * 2, dx: grid.dx / 2, dy: grid.dy / 2 };
  const blocks = (value: typeof grid) => Math.ceil(value.width / 16) * Math.ceil(value.height / 16);
  const surface = (id: string, kind: 'native' | 'fine', layers: string[], gridValue: typeof grid, gridHash: string, coverageHash: string, maxZoom: number, terrain: boolean) => {
    const blockCount = blocks(gridValue), channelCount = base.frames.length * layers.length;
    return {
      id, kind, grid: gridValue, gridHash,
      coverage: { id, hash: coverageHash, maskKey: `coverage/${coverageHash}/manifest.json`, maxZoom, gridHash },
      layers,
      samples: {
        format: 'cell-major-block-shards-v1' as const, blockSize: 16 as const, channelOrder: 'frame-then-layer' as const,
        channelCount, coverageHash, blockCount, storedCells: blockCount,
        shards: [{ firstBlock: 0, blockCount, storedCells: blockCount, bytes: blockCount * channelCount * CELL_BYTES, key: `${prefix}/surfaces/${id}/samples/0.bin`, sha256: 'd'.repeat(64) }]
      },
      ...(terrain ? { terrain: {
        dataId: 'e'.repeat(64), key: `terrain/prepared/${'e'.repeat(64)}/manifest.json`, sha256: 'e'.repeat(64),
        verticalDatum: 'EGM2008', surface: 'DSM', gridHash, coverageHash, layoutVersion: 1 as const
      } } : {})
    };
  };
  return manifestV5Schema.parse({
    ...rest, version: 5,
    surfaces: [
      surface('gfs-native', 'native', ['precip-rate'], grid, 'a'.repeat(64), coverage.hash, 7, false),
      surface('gfs-fine', 'fine', ['usable-lift-msl', 'usable-lift-agl'], fineGrid, 'b'.repeat(64), 'c'.repeat(64), 9, true)
    ]
  });
}

function v5Latest(manifestValue = v5Manifest()) {
  return latestSchema.parse({
    pointer: { version: 1, model: manifestValue.model, latestBuildId: manifestValue.buildId, retained: [{ buildId: manifestValue.buildId, manifestKey: `builds/${manifestValue.model}/${manifestValue.buildId}/manifest.json`, cycle: manifestValue.cycle, expiresAt: manifestValue.expiresAt }] },
    manifest: manifestValue,
    templates: Object.fromEntries(manifestValue.layers.map(layer => [layer, `https://api.test/tiles/${manifestValue.model}/${manifestValue.buildId}/${layer}/{frame}/{z}/{x}/{y}.webp`])),
    freshness: computeFreshness(manifestValue, Date.parse(manifestValue.createdAt))
  });
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
  maps.length = 0; protocols.clear(); initializationError = null; setWorkerUrl.mockClear();
  vi.stubEnv('AV_API_BASE', 'https://api.test');
  vi.useFakeTimers();
  vi.setSystemTime(horizon - 3600_000);
  manifest = fixtureManifest();
  vi.stubEnv('VITE_MODEL', manifest.model);
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
  expect(ui('horizon-notice').textContent).toContain('Forecast ended at 2026-10-31T00:00:00.000Z');
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
  const links = ui('meta').children.flatMap(child => child.children);
  expect(links.some(link => link.href === manifest.source.provenanceUrl)).toBe(true);
  const currentSource = sourceId();
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
  let sampleSignal: AbortSignal | null | undefined;
  fetchMock.mockImplementationOnce((_url, init) => {
    sampleSignal = init?.signal;
    return new Promise((_resolve, reject) => sampleSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  });
  map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
  expect(sampleSignal?.aborted).toBe(false);
  page('pagehide', true);
  expect(sampleSignal?.aborted).toBe(true);
  page('pageshow', true);
  await Promise.resolve(); await Promise.resolve();
  expect(ui('point-status').textContent).toContain('Point request interrupted');
  expect(ui('time').disabled).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('makes point values keyboard-scrollable only while the card is open', async () => {
  await start();
  expect(ui('point-body').tabIndex).toBe(-1);
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
    model: manifest.model, buildId: manifest.buildId, lat: 32.9, lon: -117.25,
    method: manifest.method, source: manifest.source, coverage: manifest.coverage, expiresAt: manifest.expiresAt,
    frames: manifest.frames.map(frame => ({
      ...frame,
      layers: Object.fromEntries(manifest.layers.map(layer => [layer, { value: 1, status: 'valid', support: 0, interpolated: false }]))
    }))
  })));
  map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
  await vi.waitFor(() => expect(ui('point-body').children).toHaveLength(1));
  expect(ui('point-body').tabIndex).toBe(0);
  expect(ui('point-card').hidden).toBe(false);

  map().emit('click', { lngLat: { lat: 33, lng: -117 } });
  expect(ui('point-body').children).toHaveLength(0);
  expect(ui('point-body').tabIndex).toBe(-1);
  expect(ui('point-card').hidden).toBe(true);
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
  expect(fetchMock).toHaveBeenCalledTimes(2);
  map().emit('error', { error: new GPUInitializationError('Context recreation failed') });
  await vi.advanceTimersByTimeAsync(0);
  expect(sampleSignal?.aborted).toBe(true);
  expect(ui('error').textContent).toContain('WebGL2');
  expect(ui('time').disabled).toBe(true);
  expect(ui('point-card').hidden).toBe(true);
  expect(map().removed).toBe(true);
  expect(protocols.size).toBe(0);
  page('pageshow', true);
  map().emit('click', { lngLat: { lat: 33, lng: -117 } });
  expect(protocols.size).toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('loads ICON hourly frames and keeps the AGL lift layer', async () => {
  await start();
  ui('ref-agl').dispatchEvent(new Event('click'));
  manifest = fixtureManifest({ model: 'icon-eu', buildId: 'icon-hourly', layers: [...SPLIT_PRODUCT.layers],
    grid: SPLIT_PRODUCT.grid, descriptors: createProductDescriptors(SPLIT_PRODUCT),
    frames: [4, 5, 7].map(hour => ({ id: `f${String(hour).padStart(3, '0')}`,
      validTime: `2026-10-30T${String(hour).padStart(2, '0')}:00:00.000Z`,
      intervalStart: `2026-10-30T${String(hour - 1).padStart(2, '0')}:00:00.000Z`,
      intervalEnd: `2026-10-30T${String(hour).padStart(2, '0')}:00:00.000Z` }))
  });
  modelButton('icon-eu').dispatchEvent(new Event('click'));
  await vi.waitFor(() => expect(ui('freshness').textContent).toContain('icon-hourly'));
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

it('selects the v5 surface max zoom for each layer and renders a v5 sample with surface ownership', async () => {
  const published = v5Manifest();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(v5Latest(published))));
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

  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
    version: 5, model: published.model, buildId: published.buildId, lat: 32.9, lon: -117.25,
    method: published.method, source: published.source, expiresAt: published.expiresAt,
    surfaces: published.surfaces.map(({ id, kind, layers, coverage }) => ({ id, kind, layers, coverage })),
    frames: published.frames.map(frame => ({
      ...frame,
      layers: Object.fromEntries(published.layers.map(layer => {
        const surface = published.surfaces.find(item => item.layers.includes(layer))!;
        return [layer, { value: layer === 'precip-rate' ? 1 : 500, status: 'valid', support: 0, interpolated: false, surfaceId: surface.id }];
      }))
    }))
  })));
  map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
  await vi.waitFor(() => expect(ui('point-body').children).toHaveLength(1));
  expect(ui('point-status').textContent).toContain('coverage gfs-native, gfs-fine');
  expect(ui('point-body').children[0].children.some(row => row.children.some(cell => cell.textContent.includes('gfs-fine')))).toBe(true);
});

it('uses Google terrain, remembers the view in the query string, and restores it from the back button', async () => {
  await start();
  const tiles = map().options.style?.sources?.basemap?.tiles ?? [];
  expect(tiles[0]).toContain('lyrs=p');
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
