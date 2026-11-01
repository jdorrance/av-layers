import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { computeFreshness, latestSchema, manifestSchema, validateArtifactRecords } from '@av/contracts';

class FakeElement {
  children: FakeElement[] = [];
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
  append(...children: FakeElement[]): void { this.children.push(...children); }
  add(child: FakeElement): void { this.append(child); }
  replaceChildren(...children: FakeElement[]): void { this.children = children; this.selected = ''; }
  addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener); }
  remove(): void { this.hidden = true; }
  dispatch(name: string): void { this.listeners.get(name)?.(); }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ['configured', 'https://api.example.test:9443/prefix'],
  ['default', undefined]
])('loads the built Windy module with %s API base, shows stale horizons and tile errors, normalizes clicks, cancels stale requests, and expires a pending series', async (_name, configuredBase) => {
  const pluginDir = resolve(import.meta.dirname, '..');
  const rollup = resolve(pluginDir, 'node_modules/rollup/dist/bin/rollup');
  const base = configuredBase ?? 'http://localhost:8787';
  const env = { ...process.env };
  delete env.AV_API_BASE;
  if (configuredBase) env.AV_API_BASE = configuredBase;
  execFileSync(process.execPath, [rollup, '-c'], { cwd: pluginDir, env, stdio: 'pipe' });

  const elements: FakeElement[] = [];
  const target = new FakeElement('target');
  const document = {
    body: new FakeElement('body'), head: new FakeElement('head'),
    getElementById: () => null,
    createElement: (tag: string) => { const element = new FakeElement(tag); elements.push(element); return element; }
  };
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
    manifest, templates: { 'precip-rate': `${base}/f/{frame}/{z}/{x}/{y}.webp` },
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
  let click: ((event: { latlng: { lat: number; lng: number } }) => void) | undefined;
  const tileListeners = new Map<string, (event: { tile: object }) => void>();
  const layer = {
    url: '', setUrl(url: string) { this.url = url; }, setOpacity: vi.fn(),
    on: vi.fn((name: string, listener: (event: { tile: object }) => void) => tileListeners.set(name, listener)),
    off: vi.fn((name: string) => tileListeners.delete(name))
  };
  const map = { on: vi.fn((_name, listener) => { click = listener; }), off: vi.fn(), addLayer: vi.fn(), removeLayer: vi.fn() };
  const store = { get: () => hostTime, set: vi.fn(), on: vi.fn(), off: vi.fn() };
  vi.stubGlobal('document', document);
  vi.stubGlobal('Option', FakeOption);
  vi.stubGlobal('fetch', fetchImpl);
  vi.stubGlobal('W', { map: { map }, store, broadcast: { emit: vi.fn() } });
  vi.stubGlobal('L', { tileLayer: (url: string) => { layer.url = url; return layer; } });
  const regularUrl = `${pathToFileURL(resolve(pluginDir, 'dist/plugin.js')).href}?test=${_name}-${Date.now()}`;
  const regular = await import(/* @vite-ignore */ regularUrl);
  expect(typeof regular.default).toBe('function');
  const url = `${pathToFileURL(resolve(pluginDir, 'dist/plugin.min.js')).href}?test=${_name}-${Date.now()}`;
  const loaded = await import(/* @vite-ignore */ url);
  expect(loaded.__pluginConfig.name).toBe('windy-plugin-av-layer');
  const app = new loaded.default({ target, anchor: target });
  expect(typeof app.onopen).toBe('function');
  expect(typeof app.$destroy).toBe('function');
  app.onopen();
  await vi.waitFor(() => expect(map.addLayer).toHaveBeenCalledTimes(1));
  expect(fetchImpl.mock.calls[0][0]).toBe(`${base}/v1/models/gfs/latest?expand=manifest`);
  expect(layer.url).toContain('/f/f006/');
  const horizonNotice = elements.find(element => element.className === 'av-warning')!;
  expect(horizonNotice.hidden).toBe(false);
  expect(horizonNotice.textContent).toContain('Forecast ended at 2026-10-30T06:00:00.000Z');
  const tileError = elements.find(element => element.className === 'av-error')!;
  const failed = { tile: {} }, successful = { tile: {} };
  tileListeners.get('tileloadstart')?.(failed);
  tileListeners.get('tileloadstart')?.(successful);
  tileListeners.get('tileerror')?.(failed);
  tileListeners.get('tileload')?.(successful);
  tileListeners.get('load')?.(successful);
  expect(tileError.hidden).toBe(false);
  expect(tileError.textContent).toContain('Overlay tile failed to load');
  expect(horizonNotice.hidden).toBe(false);
  tileListeners.get('tileload')?.(failed);
  expect(tileError.hidden).toBe(true);
  expect(horizonNotice.hidden).toBe(false);
  const selects = elements.filter(element => element.tag === 'select');
  expect(selects[0].children.map(option => [option.value, option.disabled, option.textContent])).toEqual([['gfs', false, 'GFS']]);
  expect(selects[2].value).toBe('f006');
  selects[2].value = 'f003';
  selects[2].dispatch('change');
  expect(store.set).toHaveBeenCalledWith('timestamp', Date.parse('2026-10-30T03:00:00.000Z'));

  click?.({ latlng: { lat: 1, lng: 190 } });
  const button = elements.find(element => element.textContent === 'Sample clicked point')!;
  button.dispatch('click');
  expect(sampleSignal?.aborted).toBe(false);
  expect(fetchImpl.mock.calls[1][0]).toContain('lon=-170');
  resolveSample(new Response(JSON.stringify({ model: 'gfs', buildId: 'b1', lat: 1, lon: -170, method: manifest.method, source: manifest.source, coverage: manifest.coverage, expiresAt, frames: frames.map(frame => ({ ...frame, layers: { 'precip-rate': { value: 1, status: 'valid', support: 0, interpolated: false } } })) })));
  const series = elements.find(element => element.className === 'av-series')!;
  await vi.waitFor(() => expect(series.children).toHaveLength(1));

  button.dispatch('click');
  const firstSignal = sampleSignal;
  click?.({ latlng: { lat: 2, lng: 3 } });
  expect(firstSignal?.aborted).toBe(true);
  expect(series.children).toHaveLength(0);

  button.dispatch('click');
  expect(sampleSignal?.aborted).toBe(false);
  clock.mockReturnValue(expiresAtMs);
  selects[2].value = 'f006';
  selects[2].dispatch('change');
  expect(sampleSignal?.aborted).toBe(true);
  expect(map.removeLayer).toHaveBeenCalledTimes(1);
  expect(horizonNotice.hidden).toBe(true);
  expect(tileListeners.size).toBe(0);
  resolveSample(new Response(JSON.stringify({ model: 'gfs', buildId: 'b1', lat: 2, lon: 3, expiresAt, frames: [] })));
  await Promise.resolve();
  await Promise.resolve();
  expect(series.children).toHaveLength(0);
  app.$destroy();
  expect(map.off).toHaveBeenCalledTimes(1);
  expect(target.children[0].hidden).toBe(true);
});
