import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_PRODUCT, PRODUCTS } from '@av/contracts/models';
import { fixtureLatest, fixtureManifestV5 } from '../../../tests/forecast-fixture.js';
import { ARMENIA_BOUNDS, AUCKLAND, NEW_ZEALAND_BOUNDS, YEREVAN, autoBuild, autoCatalogRow, autoTime } from '../../../tests/auto-forecast-fixtures.js';
import { fixturePointSample } from '../../../tests/client-point-fixture.js';

class FakeElement {
  children: FakeElement[] = [];
  parent?: FakeElement;
  listeners = new Map<string, (event?: unknown) => void>();
  style: Record<string, string> = {};
  textContent = '';
  innerHTML = '';
  className = '';
  id = '';
  hidden = false;
  disabled = false;
  type = '';
  min = '';
  max = '';
  step = '';
  private selected = '';
  constructor(readonly tag: string) {}
  get ownerDocument(): Document { return document; }
  get value(): string { return this.selected || this.children[0]?.value || ''; }
  set value(value: string) { this.selected = value; }
  append(...children: FakeElement[]): void {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }
  add(child: FakeElement): void { this.append(child); }
  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) child.parent = undefined;
    this.children = [];
    this.append(...children);
    this.selected = '';
  }
  addEventListener(name: string, listener: (event?: unknown) => void): void { this.listeners.set(name, listener); }
  focus(): void {}
  remove(): void {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }
  dispatch(name: string, event?: unknown): void { this.listeners.get(name)?.(event); }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ['configured', 'https://api.example.test:9443/prefix'],
  ['default', undefined]
])('loads the built Windy module with %s API base, follows the host time, keeps the overlay when the pane closes, and removes it on expiry', async (_name, configuredBase) => {
  const pluginDir = resolve(import.meta.dirname, '..');
  const vite = resolve(pluginDir, 'node_modules/vite/bin/vite.js');
  const base = configuredBase ?? 'http://localhost:8787';
  const env = { ...process.env };
  delete env.AV_API_BASE;
  if (configuredBase) env.AV_API_BASE = configuredBase;
  execFileSync(process.execPath, [vite, 'build'], { cwd: pluginDir, env, stdio: 'pipe' });

  const elements: FakeElement[] = [];
  let target = new FakeElement('target');
  const document = Object.assign(new EventTarget(), {
    body: new FakeElement('body'), head: new FakeElement('head'),
    getElementById: () => null,
    createElement: (tag: string) => { const element = new FakeElement(tag); elements.push(element); return element; }
  });
  const win = new EventTarget();
  const addWindowListener = vi.spyOn(win, 'addEventListener');
  const removeWindowListener = vi.spyOn(win, 'removeEventListener');
  const addVisibilityListener = vi.spyOn(document, 'addEventListener');
  const removeVisibilityListener = vi.spyOn(document, 'removeEventListener');
  class FakeOption extends FakeElement {
    constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; }
  }
  const hostTime = Date.parse('2026-10-30T06:00:00.000Z');
  const now = hostTime + 1000;
  const expiresAtMs = now + 60_000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const expiresAt = new Date(expiresAtMs).toISOString();
  const frames = ['03', '06'].map(hour => ({ id: `f0${hour}`, validTime: `2026-10-30T${hour}:00:00.000Z`, intervalStart: '2026-10-30T00:00:00.000Z', intervalEnd: `2026-10-30T${hour}:00:00.000Z` }));
  const model = DEFAULT_PRODUCT.modelId, layerId = DEFAULT_PRODUCT.layers[0];
  const manifest = fixtureManifestV5({ model, expiresAt, frames, layers: [layerId] });
  const latest = fixtureLatest(manifest, base), [west, south, east, north] = manifest.descriptors.bounds;
  const point = { lat: (south + north) / 2, lon: (west + east) / 2 };
  const fetchImpl = vi.fn<typeof fetch>(url => {
    if (String(url).includes('/latest?')) return Promise.resolve(new Response(JSON.stringify(latest)));
    if (String(url).includes('/sample?')) {
      const query = new URL(String(url)).searchParams;
      return Promise.resolve(new Response(JSON.stringify({
        version: 5, model, buildId: manifest.buildId, lat: Number(query.get('lat')), lon: Number(query.get('lon')),
        method: manifest.method, source: manifest.source, expiresAt,
        surfaces: manifest.surfaces.map(({ id, kind, layers, coverage }) => ({ id, kind, layers, coverage })),
        frames: manifest.frames.filter(frame => query.get('frame')!.split(',').includes(frame.id)).map(frame => ({ ...frame, layers: { [layerId]: { value: 1200, status: 'valid', support: 0, interpolated: false, surfaceId: manifest.surfaces[0].id } } }))
      })));
    }
    return Promise.reject(new Error(`unexpected ${String(url)}`));
  });
  const clickListeners = new Map<string, Set<(point: WindySingleclickPoint) => void>>();
  const singleclick = {
    on: vi.fn((name: string, listener: (point: WindySingleclickPoint) => void) => {
      const listeners = clickListeners.get(name) ?? new Set<(point: WindySingleclickPoint) => void>();
      listeners.add(listener);
      clickListeners.set(name, listeners);
    }),
    off: vi.fn((name: string, listener: (point: WindySingleclickPoint) => void) => {
      const listeners = clickListeners.get(name);
      listeners?.delete(listener);
      if (listeners?.size === 0) clickListeners.delete(name);
    }),
    emit(name: string, point: WindySingleclickPoint): void {
      for (const listener of clickListeners.get(name) ?? []) listener(point);
    }
  };
  const tileListeners = new Map<string, (event: { tile: object }) => void>();
  const source = {
    on: vi.fn((name: string, listener: (event: { tile: object }) => void) => tileListeners.set(name, listener)),
    off: vi.fn((name: string) => tileListeners.delete(name))
  };
  const layer = {
    url: '', options: {} as { zIndex?: number }, setUrl(url: string) { this.url = url; }, setOpacity: vi.fn(),
    source: () => source, layer: () => ({ id: 'windy-forecast' }), isLoading: () => false, alwaysLoadTiles: false
  };
  const renderListeners = new Map<string, Set<() => void>>();
  let center = { lat: point.lat, lng: point.lon };
  const map = { on: vi.fn(), off: vi.fn(), addLayer: vi.fn(), removeLayer: vi.fn(), maplibreMap: {
    setPaintProperty: vi.fn(),
    on: (name: string, listener: () => void) => { const listeners = renderListeners.get(name) ?? new Set(); listeners.add(listener); renderListeners.set(name, listeners); },
    off: (name: string, listener: () => void) => renderListeners.get(name)?.delete(listener),
    isMoving: () => false,
    getCenter: () => center,
    getZoom: () => 7,
    getBounds: () => ({ getWest: () => -118, getEast: () => -117, getSouth: () => 32, getNorth: () => 33 })
  } };
  let hostTimestamp = hostTime;
  const timestampListeners = new Set<(value: unknown) => void>();
  const store = {
    get: () => hostTimestamp, set: vi.fn(),
    on: vi.fn((_event: string, listener: (value: unknown) => void) => timestampListeners.add(listener)),
    off: vi.fn((_event: string, listener: (value: unknown) => void) => timestampListeners.delete(listener))
  };
  function moveHostTime(timestamp: number): void {
    hostTimestamp = timestamp;
    for (const listener of [...timestampListeners]) listener(timestamp);
  }
  let destroyApp: (() => void) | undefined;
  // Host unmount can happen after the request; Back must release resources immediately.
  const broadcast = { emit: vi.fn() };
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', win);
  vi.stubGlobal('Option', FakeOption);
  vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => String(input).includes('/tiles/')
    ? Promise.resolve(new Response(Uint8Array.of(82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80), { headers: { 'content-type': 'image/webp', 'content-length': '12' } }))
    : fetchImpl(input, init));
  vi.stubGlobal('W', { map: { map, layerOrder: { MAIN: 200, PARTICLES: 400, PARTICLES_HIGH_ZOOM: 450 } }, singleclick: { singleclick }, store, broadcast });
  const protocols = new Map<string, unknown>();
  vi.stubGlobal('L', {
    tileLayer: (url: string, options: { zIndex?: number }) => { layer.url = url; layer.options = options; return layer; },
    addProtocol: (scheme: string, handler: unknown) => { protocols.set(scheme, handler); },
    removeProtocol: (scheme: string) => { protocols.delete(scheme); }
  });
  const url = `${pathToFileURL(resolve(pluginDir, 'dist/plugin.min.js')).href}?test=${_name}-${Date.now()}`;
  const loaded = await import(/* @vite-ignore */ url);
  expect(loaded.__pluginConfig.name).toBe('windy-plugin-av-layer');
  expect(typeof loaded.default).toBe('function');
  const metadata = JSON.parse(readFileSync(resolve(pluginDir, 'dist/plugin.json'), 'utf8'));
  const openWeatherPicker = vi.fn(() => destroyApp?.());
  const click = (point: WindySingleclickPoint): void => {
    // Windy routes claimed clicks to the open plugin; otherwise its weather
    // picker opens and dismisses a conflicting native pane.
    if (metadata.listenToSingleclick && clickListeners.has(metadata.name)) {
      singleclick.emit(metadata.name, point);
    } else {
      openWeatherPicker();
    }
  };
  const installPackage = JSON.parse(readFileSync(resolve(pluginDir, 'dist/package.json'), 'utf8'));
  expect(metadata).toEqual(loaded.__pluginConfig);
  expect(installPackage).toEqual({ name: metadata.name, version: metadata.version, type: 'module', main: 'plugin.min.js' });
  let app = new loaded.default({ target, anchor: target });
  // Native mobile sliders must find their header immediately after mounting,
  // before opening starts network or map work.
  expect(target.children).toHaveLength(2);
  expect(target.children[0].className.split(' ')).toContain('plugin__mobile-header');
  expect(target.children[1].className.split(' ')).toContain('plugin__content');
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(map.on).not.toHaveBeenCalled();
  expect(singleclick.on).not.toHaveBeenCalled();
  expect(addWindowListener).not.toHaveBeenCalled();
  expect(addVisibilityListener).not.toHaveBeenCalled();
  const initialApp = app, initialTarget = target, mounted = [...target.children];
  target = new FakeElement('replacement-target');
  app = new loaded.default({ target, anchor: target });
  expect(initialTarget.children).toHaveLength(0);
  expect(target.children).toEqual(mounted);
  destroyApp = () => app.$destroy();
  expect(typeof app.onopen).toBe('function');
  expect(typeof app.$destroy).toBe('function');
  app.onopen();
  await vi.waitFor(() => expect(map.addLayer).toHaveBeenCalledTimes(1));
  tileListeners.get('data')?.({ tile: {} });
  for (const listener of renderListeners.get('render') ?? []) listener();
  expect(metadata.listenToSingleclick).toBe(true);
  expect(singleclick.on).toHaveBeenCalledTimes(1);
  expect(addWindowListener).toHaveBeenCalledTimes(3);
  expect(addVisibilityListener).toHaveBeenCalledTimes(1);
  expect(map.on).not.toHaveBeenCalled();
  expect(fetchImpl.mock.calls[0][0]).toBe(`${base}/v1/models/${model}/latest?expand=manifest`);
  expect(layer.url).toContain(`/tiles/${model}/${manifest.buildId}/${layerId}/f006/`);
  expect(layer.options.zIndex).toBe(201);
  expect(protocols.size).toBe(1);
  const horizonNotice = elements.find(element => element.className === 'av-warning')!;
  expect(horizonNotice.hidden).toBe(false);
  expect(horizonNotice.textContent).toContain('Map forecast ended at 2026-10-30T06:00:00.000Z');
  const mapTime = elements.find(element => element.className === 'av-map-time')!;
  await Promise.resolve();
  expect(mapTime.textContent).toContain('Host frame f006 · 2026-10-30T06:00:00.000Z');
  const tileError = elements.find(element => element.className === 'av-error')!;
  const failed = { tile: {} }, successful = { tile: {} };
  tileListeners.get('dataloading')?.(failed);
  tileListeners.get('dataloading')?.(successful);
  tileListeners.get('error')?.(failed);
  tileListeners.get('data')?.(successful);
  tileListeners.get('load')?.(successful);
  expect(tileError.hidden).toBe(false);
  expect(tileError.textContent).toContain('Overlay tile failed to load');
  expect(horizonNotice.hidden).toBe(false);
  // Simulate changed wall time while the scheduled timeout has not fired.
  clock.mockReturnValue(hostTime - 60_000);
  win.dispatchEvent(new Event('focus'));
  expect(horizonNotice.hidden).toBe(true);
  expect(tileError.hidden).toBe(false);
  clock.mockReturnValue(now);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(horizonNotice.hidden).toBe(false);
  expect(tileError.hidden).toBe(false);
  tileListeners.get('data')?.(failed);
  expect(tileError.hidden).toBe(true);
  expect(horizonNotice.hidden).toBe(false);
  const selects = elements.filter(element => element.tag === 'select');
  expect(selects).toHaveLength(3);
  expect(selects[0].children.map(option => [option.value, option.disabled, option.textContent])).toEqual([
    ...PRODUCTS.map(product => [product.modelId, false, product.label]), ['auto', false, 'Auto']
  ]);
  const opacity = elements.find(element => element.id === 'av-opacity')!;
  opacity.value = '0.4';
  opacity.dispatch('input');
  expect(layer.setOpacity).toHaveBeenCalledWith(0.4);
  expect(map.addLayer).toHaveBeenCalledTimes(1);
  expect(store.set).not.toHaveBeenCalled();

  // A replaced app must not drop the live overlay or start another build.
  initialApp.$destroy();
  initialApp.onopen();
  expect(target.children).toEqual(mounted);
  expect(map.removeLayer).not.toHaveBeenCalled();
  expect(fetchImpl).toHaveBeenCalledTimes(1);

  // The open pane owns point clicks; frame inspection reuses its pinned series.
  click({ lat: point.lat, lon: point.lon });
  await vi.waitFor(() => expect(elements.findLast(element => element.className === 'av-point-chart')).toBeTruthy());
  expect(openWeatherPicker).not.toHaveBeenCalled();
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  const chart = elements.findLast(element => element.className === 'av-point-chart')!;
  chart.children[0].dispatch('keydown', { key: 'Home', preventDefault() {} });
  selects[1].value = 'imperial'; selects[1].dispatch('change');
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(layer.url).toContain('/f003/');
  expect(elements.findLast(element => element.className === 'av-point-values')?.textContent).toContain('MSL 3937 ft');
  let pointSignal: AbortSignal | null | undefined;
  fetchImpl.mockImplementationOnce((_url, init) => {
    pointSignal = init?.signal;
    return new Promise((_resolve, reject) => pointSignal?.addEventListener('abort', () => reject(pointSignal?.reason)));
  });
  click({ lat: point.lat + 0.01, lon: point.lon });
  await vi.waitFor(() => expect(pointSignal?.aborted).toBe(false));
  app.$destroy();
  expect(pointSignal?.aborted).toBe(true);
  expect(singleclick.off).toHaveBeenCalledTimes(1);
  expect(map.removeLayer).not.toHaveBeenCalled();
  expect(store.off).not.toHaveBeenCalled();
  expect(removeWindowListener).not.toHaveBeenCalled();
  expect(removeVisibilityListener).not.toHaveBeenCalled();
  expect(target.children).toHaveLength(0);
  expect(protocols.size).toBe(1);

  clock.mockReturnValue(now);
  const reopened = new loaded.default({ target, anchor: target });
  destroyApp = () => reopened.$destroy();
  reopened.onopen();
  await Promise.resolve();
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  expect(map.addLayer).toHaveBeenCalledTimes(2);
  const root = target.children.find(element => element.className.split(' ').includes('av-panel'))!;
  const mobileHeader = target.children.find(element => element.className.split(' ').includes('plugin__mobile-header'))!;
  expect(target.children).toEqual([mobileHeader, root]);
  expect(document.body.children).not.toContain(root);
  expect(addWindowListener).toHaveBeenCalledTimes(3);
  elements.find(element => element.className === 'av-back')!.dispatch('click');
  expect(broadcast.emit.mock.calls).toEqual([
    ['rqstClose', loaded.__pluginConfig.name],
    ['rqstOpen', 'menu']
  ]);
  expect(root.hidden).toBe(true);
  expect(mobileHeader.hidden).toBe(true);
  expect(map.removeLayer).not.toHaveBeenCalled();
  expect(protocols.size).toBe(1);
  moveHostTime(hostTime + 24 * 3600_000);
  expect(map.removeLayer).toHaveBeenCalledTimes(2);
  expect(mapTime.textContent).toContain('Overlay hidden');
  expect(tileListeners.size).toBe(0);

  const pendingSignals: AbortSignal[] = [];
  fetchImpl.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    const signal = init!.signal!; pendingSignals.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const otherModels = PRODUCTS.filter(product => product.modelId !== model);
  selects[0].value = otherModels[0].modelId; selects[0].dispatch('change');
  selects[0].value = otherModels[1].modelId; selects[0].dispatch('change');
  expect(pendingSignals[0].aborted).toBe(true);
  expect(pendingSignals[1].aborted).toBe(false);
  expect(map.removeLayer).toHaveBeenCalledTimes(2);

  clock.mockReturnValue(expiresAtMs);
  win.dispatchEvent(new Event('pageshow'));
  expect(map.removeLayer).toHaveBeenCalledTimes(2);
  expect(horizonNotice.hidden).toBe(true);
  expect(tileListeners.size).toBe(0);
  expect(protocols.size).toBe(1); // The map session owns protocol registration; build bytes were evicted.
  expect(store.off).toHaveBeenCalledTimes(1);
  expect(removeWindowListener).not.toHaveBeenCalled();
  expect(removeVisibilityListener).not.toHaveBeenCalled();
  reopened.$destroy();
  expect(target.children).toHaveLength(0);
  win.dispatchEvent(new Event('pagehide'));
  expect(pendingSignals[1].aborted).toBe(true);
  expect(protocols.size).toBe(0);

  if (_name === 'configured') {
    const gfs = autoBuild('gfs', [-180, -55, 180, 65], [1, 18, 36, 60, 72]);
    const armenia = autoBuild('wrf-armenia-1km', ARMENIA_BOUNDS, [1, 18, 36]);
    const nz = autoBuild('wrf-nz-3km', NEW_ZEALAND_BOUNDS, [1, 18, 36]);
    const builds = new Map([gfs, armenia, nz].map(build => [build.manifest.model, build]));
    const models = [autoCatalogRow(gfs.manifest, 27_800), autoCatalogRow(armenia.manifest, 1000), autoCatalogRow(nz.manifest, 3000)];
    fetchImpl.mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/catalog')) return Response.json({ models });
      const build = builds.get(url.pathname.split('/').at(url.pathname.endsWith('/latest') ? -2 : -4)!);
      if (!build) return new Response(null, { status: 404 });
      if (url.pathname.endsWith('/latest')) return Response.json(fixtureLatest(build.manifest, base));
      return Response.json(fixturePointSample(build, String(input)));
    });
    center = { lat: YEREVAN.lat, lng: YEREVAN.lon };
    hostTimestamp = Date.parse(autoTime(18));
    clock.mockReturnValue(Date.parse(autoTime(0)));
    const automatic = new loaded.default({ target });
    automatic.onopen();
    selects[0].value = 'auto'; selects[0].dispatch('change');
    await vi.waitFor(() => expect(layer.url).toContain(`/tiles/${armenia.manifest.model}/${armenia.manifest.buildId}/usable-lift-msl/f018/`));
    center = { lat: AUCKLAND.lat, lng: AUCKLAND.lon };
    for (const listener of renderListeners.get('movestart') ?? []) listener();
    for (const listener of renderListeners.get('moveend') ?? []) listener();
    await vi.waitFor(() => expect(layer.url).toContain(`/tiles/${nz.manifest.model}/${nz.manifest.buildId}/usable-lift-msl/f018/`));
    moveHostTime(Date.parse(autoTime(60)));
    await vi.waitFor(() => expect(layer.url).toContain(`/tiles/gfs/${gfs.manifest.buildId}/usable-lift-msl/f060/`));
    expect(selects[0].value).toBe('auto');
    expect(store.set).not.toHaveBeenCalled();
    automatic.$destroy();
    win.dispatchEvent(new Event('pagehide'));
    expect(timestampListeners.size).toBe(0);
  }
});
