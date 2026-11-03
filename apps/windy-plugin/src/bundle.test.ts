import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { computeFreshness, latestSchema, manifestSchema, validateArtifactRecords } from '@av/contracts';

class FakeElement {
  children: FakeElement[] = [];
  parent?: FakeElement;
  listeners = new Map<string, () => void>();
  style: Record<string, string> = {};
  textContent = '';
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
  addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener); }
  remove(): void {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }
  dispatch(name: string): void { this.listeners.get(name)?.(); }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ['configured', 'https://api.example.test:9443/prefix'],
  ['default', undefined]
])('loads the built Windy module with %s API base, routes clicks without closing its pane, shows stale horizons and tile errors, cancels stale requests, and expires a pending series', async (_name, configuredBase) => {
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
  const fixture = manifestSchema.parse(JSON.parse(readFileSync(new URL('../../../scripts/fixtures/manifest.contract.json', import.meta.url), 'utf8')));
  const manifest = manifestSchema.parse({
    ...fixture, buildId: 'b1', source: { ...fixture.source, provenanceKey: 'builds/gfs/b1/provenance.json' }, expiresAt, frames, layers: ['precip-rate'],
    samples: { ...fixture.samples, key: 'builds/gfs/b1/samples.bin', channelCount: frames.length, bytes: fixture.samples.storedCells * frames.length * 5 },
    artifacts: frames.map(frame => ({
      layer: 'precip-rate', frame: frame.id,
      tilesKey: `builds/gfs/b1/precip-rate/${frame.id}.pmtiles`,
      tilesSha256: 'a'.repeat(64)
    }))
  });
  validateArtifactRecords(manifest);
  const latest = latestSchema.parse({
    pointer: { version: 1, model: 'gfs', latestBuildId: 'b1', retained: [{
      buildId: 'b1', manifestKey: 'builds/gfs/b1/manifest.json', cycle: manifest.cycle, expiresAt
    }] },
    manifest, templates: { 'precip-rate': `${base}/tiles/gfs/b1/precip-rate/{frame}/{z}/{x}/{y}.webp` },
    bounds: [-180, -55, 180, 65], maxNativeZoom: manifest.coverage.maxZoom, palettes: [], coverage: manifest.coverage,
    freshness: computeFreshness(manifest, now)
  });
  let resolveSample!: (response: Response) => void;
  let sampleSignal: AbortSignal | null | undefined;
  const fetchImpl = vi.fn<typeof fetch>((url, init) => {
    if (String(url).includes('/latest?')) return Promise.resolve(new Response(JSON.stringify(latest)));
    sampleSignal = init?.signal;
    return new Promise(resolve => { resolveSample = resolve; });
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
    url: '', setUrl(url: string) { this.url = url; }, setOpacity: vi.fn(),
    source: () => source
  };
  const map = { on: vi.fn(), off: vi.fn(), addLayer: vi.fn(), removeLayer: vi.fn() };
  const store = { get: () => hostTime, set: vi.fn(), on: vi.fn(), off: vi.fn() };
  let destroyApp: (() => void) | undefined;
  // Host unmount can happen after the request; Back must release resources immediately.
  const broadcast = { emit: vi.fn() };
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', win);
  vi.stubGlobal('Option', FakeOption);
  vi.stubGlobal('fetch', fetchImpl);
  vi.stubGlobal('W', { map: { map }, singleclick: { singleclick }, store, broadcast });
  const protocols = new Map<string, unknown>();
  vi.stubGlobal('L', {
    tileLayer: (url: string) => { layer.url = url; return layer; },
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
  expect(singleclick.on).toHaveBeenCalledWith(metadata.name, expect.any(Function));
  expect(clickListeners.get(metadata.name)?.size).toBe(1);
  expect(addWindowListener).toHaveBeenCalledTimes(2);
  expect(addVisibilityListener).toHaveBeenCalledTimes(1);
  expect(map.on).not.toHaveBeenCalled();
  expect(fetchImpl.mock.calls[0][0]).toBe(`${base}/v1/models/gfs/latest?expand=manifest`);
  expect(layer.url).toContain('/tiles/gfs/b1/precip-rate/f006/');
  expect(protocols.size).toBe(1);
  const horizonNotice = elements.find(element => element.className === 'av-warning')!;
  expect(horizonNotice.hidden).toBe(false);
  expect(horizonNotice.textContent).toContain('Forecast ended at 2026-10-30T06:00:00.000Z');
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
  expect(selects[0].children.map(option => [option.value, option.disabled, option.textContent])).toEqual([
    ['gfs', false, 'GFS'],
    ['icon-eu', false, 'ICON-EU']
  ]);
  expect(selects[2].value).toBe('f006');
  selects[2].value = 'f003';
  selects[2].dispatch('change');
  expect(store.set).toHaveBeenCalledWith('timestamp', Date.parse('2026-10-30T03:00:00.000Z'));

  click({ lat: 1, lon: 190 });
  expect(openWeatherPicker).not.toHaveBeenCalled();
  expect(target.children).toHaveLength(2);
  expect(map.removeLayer).not.toHaveBeenCalled();
  const pointStatus = elements.find(element => element.textContent.startsWith('Clicked '))!;
  const button = elements.find(element => element.textContent === 'Sample clicked point')!;
  button.dispatch('click');
  expect(sampleSignal?.aborted).toBe(false);
  // A delayed callback from the replaced app must not touch the current app's
  // panel, controller, or pending point request.
  initialApp.$destroy();
  initialApp.onopen();
  expect(sampleSignal?.aborted).toBe(false);
  expect(target.children).toEqual(mounted);
  expect(map.removeLayer).not.toHaveBeenCalled();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  win.dispatchEvent(new Event('focus'));
  expect(button.disabled).toBe(true);
  expect(sampleSignal?.aborted).toBe(false);
  expect(fetchImpl.mock.calls[1][0]).toContain('lat=1');
  expect(fetchImpl.mock.calls[1][0]).toContain('lon=-170');
  resolveSample(new Response(JSON.stringify({ model: 'gfs', buildId: 'b1', lat: 1, lon: -170, method: manifest.method, source: manifest.source, coverage: manifest.coverage, expiresAt, frames: frames.map(frame => ({ ...frame, layers: { 'precip-rate': { value: 1, status: 'valid', support: 0, interpolated: false } } })) })));
  const series = elements.find(element => element.className === 'av-series')!;
  await vi.waitFor(() => expect(series.children).toHaveLength(1));

  button.dispatch('click');
  const firstSignal = sampleSignal;
  click({ lat: 2, lon: 3 });
  expect(firstSignal?.aborted).toBe(true);
  expect(series.children).toHaveLength(0);

  button.dispatch('click');
  expect(sampleSignal?.aborted).toBe(false);
  clock.mockReturnValue(expiresAtMs);
  win.dispatchEvent(new Event('pageshow'));
  expect(sampleSignal?.aborted).toBe(true);
  expect(map.removeLayer).toHaveBeenCalledTimes(1);
  expect(horizonNotice.hidden).toBe(true);
  expect(tileListeners.size).toBe(0);
  expect(protocols.size).toBe(0);
  click({ lat: 5, lon: 6 });
  expect(pointStatus.textContent).toBe('');
  expect(button.disabled).toBe(true);
  resolveSample(new Response(JSON.stringify({ model: 'gfs', buildId: 'b1', lat: 2, lon: 3, expiresAt, frames: [] })));
  await Promise.resolve();
  await Promise.resolve();
  expect(series.children).toHaveLength(0);
  app.$destroy();
  expect(singleclick.off).toHaveBeenCalledTimes(1);
  expect(removeWindowListener).toHaveBeenCalledTimes(2);
  expect(removeWindowListener).toHaveBeenCalledWith('focus', addWindowListener.mock.calls[0][1]);
  expect(removeWindowListener).toHaveBeenCalledWith('pageshow', addWindowListener.mock.calls[1][1]);
  expect(removeVisibilityListener).toHaveBeenCalledTimes(1);
  expect(removeVisibilityListener).toHaveBeenCalledWith('visibilitychange', addVisibilityListener.mock.calls[0][1]);
  expect(clickListeners.size).toBe(0);
  expect(map.off).not.toHaveBeenCalled();
  expect(target.children).toHaveLength(0);

  // A live view must close before opening the menu, releasing its
  // pending point request, time subscription, click listener and raster protocol.
  clock.mockReturnValue(now);
  const previousElementCount = elements.length;
  const reopened = new loaded.default({ target, anchor: target });
  destroyApp = () => reopened.$destroy();
  reopened.onopen();
  try {
    await vi.waitFor(() => expect(map.addLayer).toHaveBeenCalledTimes(2));
    const reopenedElements = elements.slice(previousElementCount);
    const root = reopenedElements.find(element => element.className.split(' ').includes('av-panel'))!;
    const mobileHeader = reopenedElements.find(element => element.className.split(' ').includes('plugin__mobile-header'))!;
    expect(root.className.split(' ')).toContain('plugin__content');
    expect(target.children).toEqual([mobileHeader, root]);
    expect(target.children).toContain(root);
    expect(document.body.children).not.toContain(root);
    expect(clickListeners.get(metadata.name)?.size).toBe(1);
    expect(addWindowListener).toHaveBeenCalledTimes(4);
    expect(addVisibilityListener).toHaveBeenCalledTimes(2);
    click({ lat: 3, lon: 4 });
    reopenedElements.find(element => element.textContent === 'Sample clicked point')!.dispatch('click');
    expect(sampleSignal?.aborted).toBe(false);
    expect(protocols.size).toBe(1);
    app.$destroy();
    expect(sampleSignal?.aborted).toBe(false);
    expect(target.children).toEqual([mobileHeader, root]);
    expect(protocols.size).toBe(1);
    reopenedElements.find(element => element.className === 'av-back')!.dispatch('click');
    expect(broadcast.emit.mock.calls).toEqual([
      ['rqstClose', loaded.__pluginConfig.name],
      ['rqstOpen', 'menu']
    ]);
    expect(sampleSignal?.aborted).toBe(true);
    expect(singleclick.off).toHaveBeenCalledTimes(2);
    expect(removeWindowListener).toHaveBeenCalledTimes(4);
    expect(removeVisibilityListener).toHaveBeenCalledTimes(2);
    expect(clickListeners.size).toBe(0);
    expect(map.on).not.toHaveBeenCalled();
    expect(map.off).not.toHaveBeenCalled();
    expect(openWeatherPicker).not.toHaveBeenCalled();
    expect(store.off).toHaveBeenCalledTimes(2);
    expect(map.removeLayer).toHaveBeenCalledTimes(2);
    expect(tileListeners.size).toBe(0);
    expect(protocols.size).toBe(0);
    expect(root.hidden).toBe(true);
    expect(mobileHeader.hidden).toBe(true);
    expect(target.children).toEqual([mobileHeader, root]);
    destroyApp?.();
    expect(target.children).toHaveLength(0);
  } finally {
    reopened.$destroy();
  }
  expect(removeWindowListener).toHaveBeenCalledTimes(4);
  expect(removeVisibilityListener).toHaveBeenCalledTimes(2);
});
