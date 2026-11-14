import { SPLIT_PRODUCT } from '../../../tests/model-fixtures';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWholeDomainDescriptors, type ManifestV5 } from '@av/contracts';
import { LIFT_RENDER_STYLE, LIFT_STEP_RENDER_STYLE } from '@av/contracts/layers';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import { fixtureManifestV5, fixtureLatest } from '../../../tests/forecast-fixture';
import { fixturePointBuild, fixtureProfileBuild, retainedProfileBuild, fixturePointFetch } from '../../../tests/client-point-fixture';
import { REGION_A_BOUNDS, REGION_A_POINT, REGION_B_BOUNDS, REGION_B_POINT, autoBuild, autoCatalogRow, autoTime } from '../../../tests/auto-forecast-fixtures';
import { type PinnedBuild, type PointSeriesLoader, type RasterTileProtocol } from '@av/client';

class Element extends EventTarget {
  children: Element[] = [];
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  textContent = '';
  innerHTML = '';
  className = '';
  href = '';
  hidden = false;
  removed = false;
  remove(): void { this.removed = true; }
  ariaBusy = '';
  ariaPressed = '';
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
  prepend(...children: Element[]): void { this.children.unshift(...children); }
  setAttribute(): void {}
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
  private storage = new Map<string, string>();
  localStorage = { getItem: (key: string) => this.storage.get(key) ?? null, setItem: (key: string, value: string) => { this.storage.set(key, value); } };
  href = 'http://localhost:5173/?model=gfs';
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
  private paintQueued = false;
  options: { style?: { sources?: Record<string, { tiles?: string[] }> }; center?: [number, number]; zoom?: number; maxTileCacheSize?: number } = {};
  center = { lng: 0, lat: 0 };
  zoom = 0;
  bounds = { west: -118, east: -117, south: 32, north: 33 };
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
  getBounds() { return { getWest: () => this.bounds.west, getEast: () => this.bounds.east, getSouth: () => this.bounds.south, getNorth: () => this.bounds.north }; }
  emit(name: string, event: Record<string, unknown> = {}): void { for (const handler of this.handlers.get(name) ?? []) handler(event); }
  addControl(): void {}
  getCenter(): { lng: number; lat: number } { return this.center; }
  getZoom(): number { return this.zoom; }
  project(): { x: number; y: number } { return { x: 320, y: 240 }; }
  coveringTiles(): object[] { return Array.from({ length: 64 }, () => ({})); }
  getContainer(): { contains(target: unknown): boolean } { return { contains: () => false }; }
  fitBounds(bounds: [[number, number], [number, number]]): void {
    const [[west, south], [east, north]] = bounds;
    this.emit('movestart');
    this.center = { lng: (west + east) / 2, lat: (south + north) / 2 };
    this.emit('moveend');
  }
  jumpTo(camera: { center: [number, number]; zoom: number }, event: Record<string, unknown> = {}): void {
    this.emit('movestart', event);
    this.center = { lng: camera.center[0], lat: camera.center[1] };
    this.zoom = camera.zoom;
    this.emit('moveend', event);
  }
  setPaintProperty(id: string, property: string, value: number): void {
    const layer = this.layers.get(id);
    if (!layer || layer.paint?.[property] === value) return;
    layer.paint ??= {}; layer.paint[property] = value;
    if (autoLoadRaster && !this.paintQueued) {
      this.paintQueued = true;
      queueMicrotask(() => { this.paintQueued = false; this.emit('render'); });
    }
  }
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

const windLoads: { frame: string; signal?: AbortSignal; bounds?: readonly [number, number, number, number] }[] = [];
const windFields: unknown[] = [];
const schedulerFetches: typeof fetch[] = [];
const rasterFetches: (typeof fetch | undefined)[] = [];
const windFetches: (typeof fetch | undefined)[] = [];
const disposalOrder: string[] = [];
let windChange: (state: { style: 'trails' | 'barbs' | 'hybrid'; visible: boolean; paused: boolean; height: 'surface' | number | 'lift' }) => void;
let windState: { style: 'trails' | 'barbs' | 'hybrid'; visible: boolean; paused: boolean; height: 'surface' | number | 'lift' };
let windResolve: ((status: 'ready' | 'unavailable') => void) | null = null;
let deferWind = false;
let deferWindCancellation = false;
let windCancel: (() => void) | null = null;
let rejectWind = false;
const windStatuses: string[] = [];
let windSample = { status: 'valid', u: 3, v: 4 };
vi.mock('@av/client/wind', async importOriginal => ({ ...await importOriginal<typeof import('@av/client/wind')>(), WindDataSource: class {
  constructor(_base: string, options?: { fetchImpl?: typeof fetch }) { windFetches.push(options?.fetchImpl); }
  load(request: { frame: string; signal?: AbortSignal }) {
    windLoads.push(request);
    return rejectWind ? Promise.reject(new Error('network')) : deferWind ? new Promise((resolve, reject) => {
      windResolve = resolve;
      request.signal?.addEventListener('abort', () => {
        const cancel = () => reject(request.signal!.reason);
        if (deferWindCancellation) windCancel = cancel;
        else cancel();
      }, { once: true });
    }) : Promise.resolve('unavailable');
  }
  sample() { return windSample; }
  dispose() { disposalOrder.push('wind'); }
} }));
vi.mock('@av/client', async importOriginal => {
  const original = await importOriginal<typeof import('@av/client')>();
  return {
    ...original,
    createForecastRequestScheduler(...args: Parameters<typeof original.createForecastRequestScheduler>) {
      const scheduler = original.createForecastRequestScheduler(...args);
      schedulerFetches.push(scheduler.fetch);
      return { ...scheduler, dispose() { disposalOrder.push('scheduler'); scheduler.dispose(); } };
    },
    createSourceRasterTileProtocol(...args: Parameters<typeof original.createSourceRasterTileProtocol>) {
      rasterFetches.push(args[1]?.fetchImpl);
      const protocol = original.createSourceRasterTileProtocol(...args);
      return { ...protocol, dispose() { disposalOrder.push('raster'); protocol.dispose(); } };
    }
  };
});
vi.mock('./wind-overlay', () => ({ WindOverlay: class {
  setField(field: unknown) { windFields.push(field); }
  clear() { windFields.push(null); }
  setOptions() {}
  destroy() {}
} }));
vi.mock('./wind-controls', () => ({ createWindControls: (_host: unknown, options: { onChange: typeof windChange }) => {
  windState = { style: 'trails', visible: true, paused: false, height: 'surface' };
  windChange = state => { windState = state; options.onChange(state); };
  return { get state() { return windState; }, setStatus(status: string) { windStatuses.push(status); }, setUnits() {}, destroy() {} };
} }));
let timelineSelect: (index: number) => void;
vi.mock('./compact-timeline', () => ({ createCompactTimeline: (_host: unknown, options: { onSelect: typeof timelineSelect }) => {
  timelineSelect = options.onSelect;
  return { update() {}, destroy() {} };
} }));

let doc: Document;
let win: Window;
let manifest: ManifestV5;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const horizon = Date.parse('2026-10-31T00:00:00Z');
const ui = (id: string) => doc.elements.get(id)!;
const sourceId = () => {
  const overlays = [...map().layers.values()].filter(layer => layer.source?.startsWith('av-overlay-'));
  return (overlays.find(layer => (layer.paint?.['raster-opacity'] ?? 0) > 0) ?? overlays[0])!.source!;
};
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
  if (win.href === 'http://localhost:5173/?model=gfs') win.href = `http://localhost:5173/?model=${manifest.model}`;
  await import('./main');
  map().emit('load');
  await vi.waitFor(() => expect(modelButton(manifest.model).disabled).toBe(false));
}
beforeEach(() => {
  vi.resetModules();
  maps.length = 0; protocols.clear(); initializationError = null; autoLoadRaster = true; setWorkerUrl.mockClear();
  windLoads.length = 0; windFields.length = 0; windStatuses.length = 0; windResolve = null; deferWind = false; rejectWind = false;
  deferWindCancellation = false; windCancel = null;
  windSample = { status: 'valid', u: 3, v: 4 };
  schedulerFetches.length = 0; rasterFetches.length = 0; windFetches.length = 0; disposalOrder.length = 0;
  vi.stubEnv('AV_API_BASE', 'https://api.test');
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', '');
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

it('starts discovery before the map loads and bounds retained tile caches', async () => {
  await import('./main');
  expect(fetchMock).toHaveBeenCalled();
  expect(map().sources.size).toBe(0);
  expect(map().options.maxTileCacheSize).toBe(16);
  map().emit('load');
  await vi.waitFor(() => expect(ui('ref-agl').disabled).toBe(false));
  expect(sourceId()).toBeDefined();
});

it.each(['pagehide', 'gpu failure'])('shares the forecast scheduler and disposes it last on %s', async teardown => {
  await start();
  expect(schedulerFetches).toHaveLength(1);
  expect(windFetches[0]).toBe(schedulerFetches[0]);
  expect(rasterFetches[0]).toBe(schedulerFetches[0]);
  page('pagehide', true);
  expect(disposalOrder).not.toContain('scheduler');
  page('pageshow', true);
  expect(rasterFetches.at(-1)).toBe(schedulerFetches[0]);
  if (teardown === 'pagehide') page('pagehide', false);
  else map().emit('error', { error: new GPUInitializationError() });
  expect(disposalOrder.at(-1)).toBe('scheduler');
  expect(disposalOrder.lastIndexOf('wind')).toBeLessThan(disposalOrder.lastIndexOf('scheduler'));
  expect(disposalOrder.lastIndexOf('raster')).toBeLessThan(disposalOrder.lastIndexOf('scheduler'));
});

it('loads configured Google terrain while forecast discovery runs and disposes it on pagehide', async () => {
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'test-key');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let viewportSignal: AbortSignal | null | undefined;
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes('createSession')) {
      await gate;
      return new Response(JSON.stringify({ session: 'token', expiry: Math.floor(horizon / 1000) + 86400, tileWidth: 256 }));
    }
    if (url.includes('/viewport')) {
      viewportSignal = init?.signal;
      return new Promise(() => {});
    }
    return latest();
  });
  await import('./main');
  expect(maps).toHaveLength(0);
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/latest?'))).toBe(true);
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('createSession'))).toBe(true);
  release();
  await vi.waitFor(() => expect(maps).toHaveLength(1));
  expect(map().options.style?.sources?.['google-terrain']?.tiles?.[0]).toContain('/v1/2dtiles/');
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/latest?'))).toHaveLength(1);
  expect(viewportSignal?.aborted).toBe(false);
  page('pagehide', false);
  expect(viewportSignal?.aborted).toBe(true);
});

it('falls back with a visible warning when configured Google terrain fails', async () => {
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'test-key');
  fetchMock.mockImplementation(async input => String(input).includes('createSession') ? new Response('', { status: 403 }) : latest());
  await import('./main');
  await vi.waitFor(() => expect(maps).toHaveLength(1));
  expect(map().options.style?.sources?.basemap?.tiles?.[0]).toContain('openstreetmap.org');
  expect(ui('app').children.find(child => child.className === 'toast basemap-warning')?.textContent).toBe('Google terrain unavailable. Using OpenStreetMap.');
});

it('bounds Google session startup and falls back after timeout', async () => {
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'test-key');
  fetchMock.mockImplementation(async (input, init) => {
    if (!String(input).includes('createSession')) return latest();
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  });
  await import('./main');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(map().options.style?.sources?.basemap?.tiles?.[0]).toContain('openstreetmap.org');
  expect(ui('app').children.find(child => child.className === 'toast basemap-warning')).toBeDefined();
});

it('starts Auto discovery while Google terrain initializes and reuses the lookup', async () => {
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'test-key');
  win.href = 'http://localhost:5173/?model=auto';
  const build = autoBuild('gfs', [-180, -55, 180, 65], [1, 18, 36]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fetchMock.mockImplementation(async input => {
    const url = String(input);
    if (url.includes('createSession')) {
      await gate;
      return Response.json({ session: 'token', expiry: Math.floor(horizon / 1000) + 86400 });
    }
    if (url.includes('/viewport')) return Response.json({});
    if (url.includes('/catalog')) return Response.json({ models: [autoCatalogRow(build.manifest, 27800)] });
    return url.includes('/latest') ? Response.json(fixtureLatest(build.manifest)) : sample(input, build.manifest);
  });
  await import('./main');
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/catalog'))).toBe(true);
  expect(maps).toHaveLength(0);
  release();
  await vi.waitFor(() => expect(maps).toHaveLength(1));
  map().emit('load');
  await vi.waitFor(() => expect(ui('freshness').textContent).toContain('gfs'));
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/catalog'))).toHaveLength(1);
});

it('keeps the neutral offline basemap even with a configured Google key', async () => {
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'test-key');
  vi.stubEnv('VITE_OFFLINE_FIXTURE', 'true');
  await start();
  expect(map().options.style?.sources).toEqual({});
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('createSession'))).toBe(false);
});

it('does not construct a map after pagehide during Google session startup', async () => {
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'test-key');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sessionSignal: AbortSignal | null | undefined;
  fetchMock.mockImplementation(async (input, init) => {
    if (!String(input).includes('createSession')) return latest();
    sessionSignal = init?.signal;
    await gate;
    return new Response(JSON.stringify({ session: 'token', expiry: Math.floor(horizon / 1000) + 86400 }));
  });
  await import('./main');
  page('pagehide', false);
  expect(sessionSignal?.aborted).toBe(true);
  release();
  await vi.advanceTimersByTimeAsync(1);
  expect(maps).toHaveLength(0);
  expect(ui('app').children).toHaveLength(0);
});

it('clears stale wind immediately and ignores an overtaken frame request', async () => {
  deferWind = true;
  await start();
  const oldRequest = windLoads.at(-1)!;
  const resolveOld = windResolve!;
  await selectFrame(1);
  expect(oldRequest.signal?.aborted).toBe(true);
  expect(windFields.at(-1)).toBeNull();
  resolveOld('ready');
  await Promise.resolve();
  expect(windFields.at(-1)).toBeNull();
  windResolve!('ready');
  await Promise.resolve();
  expect(windFields.at(-1)).toMatchObject({ sample: expect.any(Function) });
  const count = windLoads.length;
  windChange({ style: 'barbs', visible: true, paused: false, height: 2400 });
  ui('units-imperial').dispatchEvent(new Event('click'));
  expect(windLoads).toHaveLength(count);
  map().emit('movestart');
  expect(windFields.at(-1)).toMatchObject({ sample: expect.any(Function) });
});

it('keeps resident wind while hidden and loads once when the frame changes', async () => {
  deferWind = true;
  await start();
  windResolve!('ready');
  await Promise.resolve();
  const count = windLoads.length;
  windChange({ ...windState, visible: false });
  map().emit('movestart'); map().emit('moveend');
  windChange({ ...windState, visible: true });
  expect(windLoads).toHaveLength(count);
  windChange({ ...windState, visible: false });
  await selectFrame(1);
  map().emit('moveend');
  expect(windLoads).toHaveLength(count);
  windChange({ ...windState, visible: true });
  expect(windLoads).toHaveLength(count + 1);
});

it('aborts hidden wind loads and skips model changes until re-enabled', async () => {
  deferWind = true;
  await start();
  const pending = windLoads.at(-1)!;
  const count = windLoads.length;
  windChange({ ...windState, visible: false });
  expect(pending.signal?.aborted).toBe(true);
  manifest = fixtureManifestV5({ model: 'icon-eu' });
  modelButton('icon-eu').dispatchEvent(new Event('click'));
  await vi.waitFor(() => expect(ui('freshness').textContent).toContain(manifest.buildId));
  await selectFrame(1);
  map().emit('moveend');
  expect(windLoads).toHaveLength(count);
  windChange({ ...windState, visible: true });
  expect(windLoads).toHaveLength(count + 1);
});

it('allocates only the latest wind viewport after retired load cancellation settles', async () => {
  deferWind = true;
  deferWindCancellation = true;
  await start();
  const first = windLoads.at(-1)!;
  for (let i = 1; i <= 5; i++) {
    map().bounds = { west: -118 + i, east: -117 + i, south: 32, north: 33 };
    map().emit('moveend');
  }
  expect(first.signal!.aborted).toBe(true);
  windChange({ ...windState, visible: false });
  map().bounds = { west: -110, east: -109, south: 32, north: 33 };
  map().emit('moveend');
  windChange({ ...windState, visible: true });
  await vi.advanceTimersByTimeAsync(1000);
  expect(windLoads).toHaveLength(1);
  windCancel!();
  await vi.waitFor(() => expect(windLoads).toHaveLength(2));
  expect(windLoads[1].bounds).toEqual([-110, 32, -109, 33]);
  windResolve!('ready');
  await Promise.resolve();
  expect(windFields.at(-1)).toMatchObject({ sample: expect.any(Function) });
});

it.each([false, true])('retries unavailable or rejected wind on a later move without a hot loop (rejected: %s)', async rejected => {
  rejectWind = rejected;
  await start();
  await Promise.resolve();
  expect(windStatuses.at(-1)).toBe('unavailable');
  const count = windLoads.length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(windLoads).toHaveLength(count);
  map().emit('moveend');
  expect(windLoads).toHaveLength(count + 1);
});

it('retains wind during a pan and while loading uncovered bounds', async () => {
  deferWind = true;
  await start();
  windResolve!('ready');
  await Promise.resolve();
  const field = windFields.at(-1);
  const count = windLoads.length;
  map().emit('movestart');
  map().bounds = { west: -117.9, east: -117.1, south: 32.1, north: 32.9 };
  map().emit('moveend');
  expect(windLoads).toHaveLength(count);
  expect(windFields.at(-1)).toBe(field);
  map().bounds = { west: -117.5, east: -116.5, south: 32, north: 33 };
  map().emit('moveend');
  expect(windLoads).toHaveLength(count + 1);
  expect(windFields.at(-1)).toBe(field);
});

it('reloads wind detail after zooming into an already covered viewport', async () => {
  deferWind = true;
  await start();
  windResolve!('ready');
  await Promise.resolve();
  const count = windLoads.length;
  map().bounds = { west: -117.9, east: -117.1, south: 32.1, north: 32.9 };
  map().zoom += 1;
  map().emit('moveend');
  expect(windLoads).toHaveLength(count + 1);
  windResolve!('ready');
  await Promise.resolve();
  map().emit('moveend');
  expect(windLoads).toHaveLength(count + 1);
});

it('preserves unavailability after an uncovered pan and restores resident wind on return', async () => {
  const status = 'unavailable';
  deferWind = true;
  await start();
  windResolve!('ready');
  await Promise.resolve();
  const original = { ...map().bounds };
  map().bounds = { west: -117.5, east: -116.5, south: 32, north: 33 };
  map().emit('moveend');
  expect(windStatuses.at(-1)).toBe('loading');
  map().emit('render');
  expect(windStatuses.at(-1)).toBe('loading');
  windResolve!(status);
  await Promise.resolve();
  expect(windFields.at(-1)).toBeNull();
  map().emit('render'); map().emit('sourcedata', { sourceId: sourceId(), tile: {} });
  expect(windStatuses.at(-1)).toBe(status);
  expect(windFields.at(-1)).toBeNull();
  const count = windLoads.length;
  map().bounds = original;
  map().emit('moveend');
  expect(windLoads).toHaveLength(count);
  expect(windStatuses.at(-1)).toBe('ready');
  expect(windFields.at(-1)).toMatchObject({ sample: expect.any(Function) });
});

it('shows wind only after its raster frame is displayed and keeps it hidden after replacement failure', async () => {
  deferWind = true;
  autoLoadRaster = false;
  win.href = `http://localhost:5173/?model=gfs&t=${encodeURIComponent(manifest.frames[0].validTime)}`;
  await start();
  windResolve!('ready');
  await Promise.resolve();
  expect(windFields.at(-1)).toBeNull();
  const first = sourceId();
  map().emit('sourcedata', { sourceId: first, tile: {} }); map().emit('render'); map().emit('render');
  expect(windFields.at(-1)).toMatchObject({ sample: expect.any(Function) });

  await selectFrame(1);
  expect(windFields.at(-1)).toBeNull();
  windResolve!('ready');
  await Promise.resolve();
  expect(windFields.at(-1)).toBeNull();
  const failed = [...map().layers.keys()].find(id => id !== first)!;
  map().emit('error', { sourceId: failed });
  expect(ui('tile-error').textContent).toContain('Forecast replacement failed');
  expect(ui('frame-status').textContent).toContain('Showing');
  expect(ui('frame-status').textContent).toContain('Selected time unavailable');
  expect(windFields.at(-1)).toBeNull();

  await selectFrame(2);
  windResolve!('ready');
  await Promise.resolve();
  expect(windFields.at(-1)).toBeNull();
  const replacement = [...map().layers.keys()].find(id => id !== first)!;
  map().emit('sourcedata', { sourceId: replacement, tile: {} }); map().emit('render'); map().emit('render');
  expect(windFields.at(-1)).toMatchObject({ sample: expect.any(Function) });
});

it('does not pair wind from a new build with the previous build raster at the same frame', async () => {
  deferWind = true;
  autoLoadRaster = false;
  win.href = `http://localhost:5173/?model=gfs&t=${encodeURIComponent(manifest.frames[0].validTime)}`;
  await start();
  const first = sourceId();
  map().emit('sourcedata', { sourceId: first, tile: {} }); map().emit('render'); map().emit('render');
  windResolve!('ready');
  await Promise.resolve();
  expect(windFields.at(-1)).toMatchObject({ sample: expect.any(Function) });

  const count = windLoads.length;
  manifest = fixtureManifestV5({ model: 'icon-eu' });
  modelButton('icon-eu').dispatchEvent(new Event('click'));
  await vi.waitFor(() => expect(windLoads.length).toBeGreaterThan(count));
  expect(windLoads.at(-1)?.frame).toBe(windLoads[0].frame);
  windResolve!('ready');
  await Promise.resolve();
  expect(windFields.at(-1)).toBeNull();
  const replacement = [...map().layers.keys()].find(id => id !== first)!;
  map().emit('sourcedata', { sourceId: replacement, tile: {} }); map().emit('render'); map().emit('render');
  expect(windFields.at(-1)).toMatchObject({ sample: expect.any(Function) });
});

it('uses URL opacity before saved opacity and shares display units', async () => {
  win.localStorage.setItem('preview-lift-opacity', '0.35');
  win.localStorage.setItem('preview-units', 'imperial');
  win.href = 'http://localhost:5173/?model=gfs&opacity=0.65';
  await start();
  expect(ui('opacity').value).toBe('0.65');
  expect(ui('units-imperial').ariaPressed).toBe('true');
  expect(ui('point-units').value).toBe('imperial');
  expect(ui('lift-units').textContent).toBe('Lift ft');
  expect(visit(ui('legend-body')).some(node => node.textContent === 'Lift above ground (ft AGL)')).toBe(true);
  ui('units-metric').dispatchEvent(new Event('click'));
  expect(win.localStorage.getItem('preview-units')).toBe('metric');
  expect(ui('point-units').value).toBe('metric');
  expect(visit(ui('legend-body')).some(node => node.textContent === 'Lift above ground (m AGL)')).toBe(true);
});

it('reports an unavailable forecast when the viewport exceeds raster memory admission', async () => {
  await start();
  Object.assign(map(), { coveringTiles: () => Array.from({ length: 256 }) });
  map().emit('resize');
  expect(map().sources.size).toBe(0);
  expect(ui('frame-status').textContent).toBe('Forecast unavailable · No forecast shown');
  expect(ui('tile-error').textContent).toContain('Forecast replacement failed');
  Object.assign(map(), { coveringTiles: () => Array.from({ length: 64 }) });
  map().emit('resize');
  await vi.waitFor(() => expect(ui('tile-error').hidden).toBe(true));
  expect(map().sources.size).toBeGreaterThan(0);
});

it('briefly marks the located position without a success message', async () => {
  let locate!: PositionCallback;
  vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: (success: PositionCallback) => { locate = success; } } });
  await start();
  vi.useFakeTimers();
  ui('locate').dispatchEvent(new Event('click'));
  locate({ coords: { latitude: 40.45, longitude: 44.3 } } as GeolocationPosition);
  expect(map().getCenter()).toEqual({ lat: 40.45, lng: 44.3 });
  expect(ui('location-status').textContent).toBe('');
  const dot = ui('map').children.at(-1)!;
  expect(dot.className).toBe('location-pulse');
  expect(dot.style).toMatchObject({ left: '320px', top: '240px' });
  expect(dot.removed).toBe(false);
  await vi.advanceTimersByTimeAsync(2000);
  expect(dot.removed).toBe(true);
  vi.useRealTimers();
});

it('leaves the map unchanged when location is denied', async () => {
  let fail!: PositionErrorCallback;
  vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: (_success: PositionCallback, error: PositionErrorCallback) => { fail = error; } } });
  await start();
  const before = map().getCenter();
  ui('locate').dispatchEvent(new Event('click'));
  expect(ui('locate').disabled).toBe(true);
  fail({ code: 1, message: 'denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
  expect(ui('location-status').textContent).toBe('Location permission denied');
  expect(map().getCenter()).toEqual(before);
  expect(ui('locate').disabled).toBe(false);
});

it.each([LIFT_STEP_RENDER_STYLE, LIFT_RENDER_STYLE, 'transparent-no-lift-v2', undefined])('explains the displayed MSL render style %s and cutoff', async style => {
  const method = manifest.descriptors.layers['usable-lift-msl'].methodId;
  manifest.descriptors.methods[method].parameters.sinkRateMps = 1.8;
  manifest.tool.liftRenderStyle = style;
  await start();
  expect(visit(ui('legend-body')).some(node => node.textContent === 'Lift above ground (m AGL)')).toBe(true);
  expect(ui('legend-no-lift').textContent).toBe('No usable lift: clear areas on the map.');
  ui('ref-msl').dispatchEvent(new Event('click'));
  await vi.waitFor(() => expect(visit(ui('legend-body')).some(node => node.textContent === 'Top of usable lift (m MSL)')).toBe(true));
  expect(ui('legend-reference').textContent).toContain('MSL includes ground elevation. Choose AGL');
  expect(ui('legend-cutoff').textContent).toContain('predicted updrafts above 1.8 m/s');
  expect(ui('legend-no-lift').textContent).toBe(style === LIFT_STEP_RENDER_STYLE || style === LIFT_RENDER_STYLE
    ? 'No usable lift: the map shows ground elevation, including at night.'
    : 'No usable lift: clear areas on the map.');
  ui('legend-key').open = true;
  ui('legend-key-toggle').focus();
  const tile = {};
  map().emit('error', { sourceId: sourceId(), tile });
  map().emit('sourcedata', { sourceId: sourceId(), tile });
  expect(ui('legend-key').open).toBe(true);
  expect(doc.activeElement).toBe(ui('legend-key-toggle'));
});

it('selects cold and ready frames during slider input before the next map draw', async () => {
  await start();
  Object.assign(map(), { coveringTiles: () => [{}] });
  map().emit('resize');
  await selectFrame(1);
  const readySource = sourceId();
  await selectFrame(2);
  const { RasterOverlay } = await import('./raster-overlay');
  const select = vi.spyOn(RasterOverlay.prototype, 'select');
  const schedule = vi.spyOn(win, 'requestAnimationFrame');
  ui('time').value = String(manifest.frames.length - 1);
  ui('time').dispatchEvent(new Event('input'));
  expect(select).toHaveBeenCalledOnce();
  expect(select.mock.calls[0][2]).toBe(manifest.frames.at(-1)!.id);
  expect(schedule).not.toHaveBeenCalled();
  ui('time').value = '1';
  ui('time').dispatchEvent(new Event('input'));
  expect(select).toHaveBeenCalledTimes(2);
  expect(sourceId()).toBe(readySource);
  expect(schedule).not.toHaveBeenCalled();
  vi.advanceTimersByTime(16);
  expect(select).toHaveBeenCalledTimes(2);
});

it('updates each cold slider selection synchronously and writes history on commit', async () => {
  await start();
  const { RasterOverlay } = await import('./raster-overlay');
  autoLoadRaster = false;
  const select = vi.spyOn(RasterOverlay.prototype, 'select');
  const replace = vi.spyOn(win.history, 'replaceState');
  for (const index of [0, 1, 2]) {
    ui('time').value = String(index);
    ui('time').dispatchEvent(new Event('input'));
  }
  expect(select.mock.calls.map(call => call[2])).toEqual(manifest.frames.slice(0, 3).map(frame => frame.id));
  expect(replace).not.toHaveBeenCalled();
  vi.advanceTimersByTime(16);
  expect(select).toHaveBeenCalledTimes(3);
  ui('time').dispatchEvent(new Event('change'));
  expect(replace).toHaveBeenCalledOnce();
  expect(new URL(win.href).searchParams.get('t')).toBe(manifest.frames[2].validTime);
});

it('wires compact timeline selections to history and retains the scale while scrubbing', async () => {
  await start();
  const scale = ui('legend-body').children[0];
  await selectFrame(0);
  await selectFrame(1);
  expect(ui('legend-body').children[0]).toBe(scale);
  const push = vi.spyOn(win.history, 'pushState');
  timelineSelect(0);
  expect(push).toHaveBeenCalledOnce();
  expect(ui('time').value).toBe('0');
  expect(new URL(win.href).searchParams.get('t')).toBe(manifest.frames[0].validTime);
  ui('ref-msl').dispatchEvent(new Event('click'));
  await Promise.resolve();
  expect(ui('legend-body').children[0]).not.toBe(scale);
});

it.each([true, false])('publishes the initial regional camera without adding history (discovery first: %s)', async discoveryFirst => {
  manifest = fixtureManifestV5({ model: 'icon-eu' });
  vi.stubEnv('VITE_MODEL', manifest.model);
  win.href = 'http://localhost:5173/?model=icon-eu';
  let release!: () => void;
  const discovery = new Promise<void>(resolve => { release = resolve; });
  fetchMock.mockImplementationOnce(async () => { await discovery; return latest(); });
  const push = vi.spyOn(win.history, 'pushState'), replace = vi.spyOn(win.history, 'replaceState');
  await import('./main');
  expect(fetchMock).toHaveBeenCalled();
  if (discoveryFirst) {
    release();
    await vi.waitFor(() => expect(ui('freshness').textContent).toContain(manifest.buildId));
    expect(replace).not.toHaveBeenCalled();
  }
  map().emit('load');
  if (!discoveryFirst) release();
  await vi.waitFor(() => expect(ui('freshness').textContent).toContain(manifest.buildId));
  expect(sourceId()).toBeDefined();
  const query = new URL(win.href).searchParams;
  expect(Number(query.get('lat'))).toBe(map().getCenter().lat);
  expect(Number(query.get('lon'))).toBe(map().getCenter().lng);
  expect(replace).toHaveBeenCalledOnce();
  expect(push).not.toHaveBeenCalled();
});

it.each(['pointerenter', 'focus', 'pointerdown'])('prepares a layer on %s while preserving the displayed selection', async event => {
  await start();
  await selectFrame(1);
  const active = sourceId();
  ui('ref-msl').dispatchEvent(new Event(event));
  const standby = [...map().layers.values()].find(layer => layer.source?.startsWith('av-overlay-') && layer.paint?.['raster-opacity'] === 0)!;
  expect((map().getSource(standby.source!) as { tiles: string[] }).tiles[0]).toContain('/usable-lift-msl/');
  expect(sourceId()).toBe(active);
  expect(ui('ref-agl').className).toContain('is-selected');
  ui('ref-msl').dispatchEvent(new Event('click'));
  expect(sourceId()).toBe(standby.source);
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
  win.href = 'http://localhost:5173/?model=gfs&lat=41&lon=-8&z=7&t=2026-10-30T06%3A00%3A00.000Z';
  await start();
  expect(ui('timestamp').textContent).toBe('Selected · 05:00 longitude time (UTC−01:00) · 06:00 UTC');
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
  expect(map().layers.get(sourceId())?.paint?.['raster-opacity']).toBe(0.5);
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
  expect(win.location.search).toContain('opacity=0.5');
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

it('keeps point selection current while skipping redraws for unchanged overlay status', async () => {
  const windgram = await import('@av/windgram');
  const render = windgram.renderPointWindgram;
  const update = vi.fn<ReturnType<typeof render>>();
  vi.spyOn(windgram, 'renderPointWindgram').mockImplementation((...args) => {
    update.mockImplementation(render(...args));
    return update;
  });
  await start();
  Object.assign(map(), { coveringTiles: () => [{}] });
  map().emit('resize');
  fetchMock.mockImplementation(async input => sample(input));
  map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
  await vi.waitFor(() => expect(ui('point-card').ariaBusy).toBe('false'));
  ui('ref-agl').dispatchEvent(new Event('click'));
  update.mockClear();
  const tile = {};
  map().emit('error', { sourceId: sourceId(), tile });
  map().emit('sourcedata', { sourceId: sourceId(), tile });
  expect(update).not.toHaveBeenCalled();
  ui('point-units').value = 'imperial';
  ui('point-units').dispatchEvent(new Event('change'));
  expect(update).toHaveBeenCalledOnce();
  expect(update.mock.calls[0][1]).toBe('imperial');
  await selectFrame(1);
  expect(update).toHaveBeenLastCalledWith(manifest.frames[1].id, 'imperial', manifest.frames[1].id);
  await selectFrame(2);
  update.mockClear();
  ui('time').value = '1';
  ui('time').dispatchEvent(new Event('input'));
  expect(update).toHaveBeenCalledOnce();
  expect(update).toHaveBeenLastCalledWith(manifest.frames[1].id, 'imperial', manifest.frames[2].id);
  await Promise.resolve();
  expect(update).toHaveBeenLastCalledWith(manifest.frames[1].id, 'imperial', manifest.frames[1].id);
  ui('point-close').dispatchEvent(new Event('click'));
  update.mockClear();
  await selectFrame(2);
  expect(update).not.toHaveBeenCalled();
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
  deferWind = true;
  await start();
  windResolve!('ready');
  await Promise.resolve();
  expect(ui('point-horizon-label').hidden).toBe(false);
  expect(ui('horizon-notice').textContent).toContain(`Map forecast ended at ${mapEnd}`);
  map().emit('click', { lngLat: { lat: 32.9, lng: -117.25 } });
  await vi.waitFor(() => expect(ui('point-card').ariaBusy).toBe('false'));
  expect(ui('point-wind').textContent).toContain(`Map wind · ${mapEnd.slice(0, 16).replace('T', ' ')} UTC · 18 km/h`);
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
  expect(ui('point-wind').textContent).toBe('');
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
  windResolve!('ready');
  await Promise.resolve();
  expect(nodes.find(child => child.className === 'av-point-time')!.textContent).toBe(time);
  const requests = fetchMock.mock.calls.length;
  ui('point-horizon').value = 'day'; ui('point-horizon').dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(ui('point-card').ariaBusy).toBe('false'));
  expect(ui('point-wind').textContent).toContain(`Map wind · ${mapEnd.slice(0, 16).replace('T', ' ')} UTC · 18 km/h`);
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
  map().emit('sourcedata', { sourceId: first, tile: {} }); map().emit('render'); map().emit('render');
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
  map().emit('sourcedata', { sourceId: first, tile: {} }); map().emit('render'); map().emit('render');
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
  map().emit('sourcedata', { sourceId: replacement, tile: {} }); map().emit('render'); map().emit('render');
  expect(time.textContent).toBe(`Point and map: ${stamp(2)} UTC`);
  const previous = new URL(win.href);
  previous.searchParams.set('t', published.frames[0].validTime);
  win.href = previous.href;
  win.dispatchEvent(new Event('popstate'));
  expect(time.textContent).toBe(`Point: ${stamp(0)} UTC · Map: ${stamp(2)} UTC`);
  await Promise.resolve();
  const restored = [...map().layers.keys()].find(id => id !== replacement)!;
  map().emit('sourcedata', { sourceId: restored, tile: {} }); map().emit('render'); map().emit('render');
  expect(time.textContent).toBe(`Point and map: ${stamp(0)} UTC`);
});
