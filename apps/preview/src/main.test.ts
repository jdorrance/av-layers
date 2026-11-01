import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computeFreshness, manifestSchema, type Manifest } from '@av/contracts';
import { OVERLAY_LAYER_ID } from '@av/contracts/client';

class Element extends EventTarget {
  children: Element[] = [];
  style: Record<string, string> = {};
  textContent = '';
  className = '';
  href = '';
  hidden = false;
  disabled = false;
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
const maps: MapMock[] = [];
const map = () => maps.at(-1)!;
class MapMock {
  handlers = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  sources = new Map<string, unknown>();
  layers = new Map<string, { id: string; source?: string }>();
  removed = false;
  constructor() { maps.push(this); }
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
vi.mock('maplibre-gl', () => ({ default: { Map: MapMock, NavigationControl: class {} } }));

let doc: Document;
let win: Window;
let manifest: Manifest;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const horizon = Date.parse('2026-10-31T00:00:00Z');
const ui = (id: string) => doc.elements.get(id)!;
const sourceId = () => map().layers.get(OVERLAY_LAYER_ID)!.source!;
function latest() {
  return new Response(JSON.stringify({
    pointer: { version: 1, model: manifest.model, latestBuildId: manifest.buildId, retained: [{
      buildId: manifest.buildId, manifestKey: `builds/gfs/${manifest.buildId}/manifest.json`, cycle: manifest.cycle, expiresAt: manifest.expiresAt
    }] },
    manifest,
    templates: Object.fromEntries(manifest.layers.map(layer => [layer, `https://api.test/tiles/${layer}/{frame}/{z}/{x}/{y}.webp`])),
    bounds: [-180, -55, 180, 65], maxNativeZoom: manifest.coverage.maxZoom, palettes: [], coverage: manifest.coverage,
    freshness: computeFreshness(manifest)
  }));
}
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
  maps.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(horizon - 3600_000);
  manifest = manifestSchema.parse(JSON.parse(readFileSync(new URL('../../../scripts/fixtures/manifest.contract.json', import.meta.url), 'utf8')));
  doc = new Document(); win = new Window();
  fetchMock = vi.fn<typeof fetch>(async () => latest());
  vi.stubGlobal('document', doc); vi.stubGlobal('window', win);
  vi.stubGlobal('Option', OptionElement); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  page('pagehide', false);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
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

it('preserves a loaded map across BFCache restoration and links its source receipts', async () => {
  manifest.source.provenanceUrl = 'https://api.test/v1/models/gfs/runs/build/provenance';
  await start();
  const links = ui('meta').children.flatMap(child => child.children);
  expect(links.some(link => link.href === manifest.source.provenanceUrl)).toBe(true);
  const currentSource = sourceId();
  page('pagehide', true); page('pageshow', true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(sourceId()).toBe(currentSource);
  expect(map().removed).toBe(false);
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
