import { afterEach, expect, it, vi } from 'vitest';
import { fixtureBuild, fixtureManifest } from '../../../tests/forecast-fixture';
import { PluginPanel } from './view';
import type { ControllerState } from './controller';

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  listeners = new Map<string, ((event: Event) => void)[]>();
  style: { background?: string } = {};
  textContent = '';
  hidden = false;
  href = '';
  target = '';
  rel = '';
  className = '';
  id = '';
  htmlFor = '';
  role = '';
  value = '';
  constructor(readonly tag: string) {}
  append(...children: FakeElement[]): void {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }
  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...children);
  }
  add(option: FakeElement): void { this.append(option); }
  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    if (event.bubbles && !event.cancelBubble) this.parent?.dispatchEvent(event);
    return !event.defaultPrevented;
  }
}

afterEach(() => vi.unstubAllGlobals());

it('associates visible labels with each keyboard control and exposes failures as alerts', () => {
  vi.stubGlobal('document', { getElementById: () => null, createElement: (tag: string) => new FakeElement(tag), head: new FakeElement('head') });
  vi.stubGlobal('Option', class extends FakeElement { constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; } });
  const panel = new PluginPanel({ onModel: vi.fn(), onLayer: vi.fn(), onFrame: vi.fn(), onOpacity: vi.fn(), onSeries: vi.fn(), onBack: vi.fn() });
  const visit = (element: FakeElement): FakeElement[] => [element, ...element.children.flatMap(visit)];
  const nodes = visit(panel.root as unknown as FakeElement);
  const controls = nodes.filter(element => element.tag === 'select' || element.tag === 'input');
  expect(controls).toHaveLength(4);
  expect(new Set(controls.map(control => control.id)).size).toBe(4);
  expect(controls.map(control => nodes.find(node => node.tag === 'label' && node.htmlFor === control.id)?.textContent)).toEqual(['Model', 'Layer', 'Frame', 'Opacity']);
  expect(nodes.find(node => node.className === 'av-error')?.role).toBe('alert');
  expect(nodes.find(node => node.className === 'av-warning')?.role).toBe('status');
});

it('keeps native panel control keys separate from page shortcuts while allowing Escape and Tab', () => {
  vi.stubGlobal('document', { getElementById: () => null, createElement: (tag: string) => new FakeElement(tag), head: new FakeElement('head') });
  vi.stubGlobal('Option', class extends FakeElement { constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; } });
  const callbacks = { onModel: vi.fn(), onLayer: vi.fn(), onFrame: vi.fn(), onOpacity: vi.fn(), onSeries: vi.fn(), onBack: vi.fn() };
  const panel = new PluginPanel(callbacks);
  const body = new FakeElement('body'), map = new FakeElement('canvas');
  body.append(panel.root as unknown as FakeElement, map);
  const pageKeys: string[] = [];
  let hostTime = 9;
  body.addEventListener('keydown', event => {
    const { key } = event as KeyboardEvent;
    pageKeys.push(key);
    if (key === 'ArrowRight') { hostTime++; event.preventDefault(); }
  });
  const keydown = (key: string) => Object.assign(new Event('keydown', { bubbles: true, cancelable: true }), { key });
  const visit = (element: FakeElement): FakeElement[] => [element, ...element.children.flatMap(visit)];
  const nodes = visit(panel.root as unknown as FakeElement);
  const controls = nodes.filter(element => ['select', 'input', 'button', 'summary'].includes(element.tag));
  for (const control of controls) {
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', ' ', 'f', 'Home']) {
      const event = keydown(key);
      expect(control.dispatchEvent(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    }
  }
  expect(pageKeys).toEqual([]);
  expect(hostTime).toBe(9);

  // Native range changes remain allowed; its input event still reaches the panel callback.
  const opacity = nodes.find(element => element.id === 'av-opacity')!;
  opacity.value = '0.55';
  opacity.dispatchEvent(new Event('input', { bubbles: true }));
  expect(callbacks.onOpacity).toHaveBeenCalledWith(0.55);
  for (const key of ['Escape', 'Tab']) expect(opacity.dispatchEvent(keydown(key))).toBe(true);
  expect(pageKeys).toEqual(['Escape', 'Tab']);

  // Keyboard use outside the panel still belongs to the host.
  expect(map.dispatchEvent(keydown('ArrowRight'))).toBe(false);
  expect(hostTime).toBe(10);
});

it('leaves native mobile header gestures to the host and hides both pane elements together', () => {
  vi.stubGlobal('document', { getElementById: () => null, createElement: (tag: string) => new FakeElement(tag), head: new FakeElement('head') });
  vi.stubGlobal('Option', class extends FakeElement { constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; } });
  const panel = new PluginPanel({ onModel: vi.fn(), onLayer: vi.fn(), onFrame: vi.fn(), onOpacity: vi.fn(), onSeries: vi.fn(), onBack: vi.fn() });
  const target = new FakeElement('target');
  target.append(panel.mobileHeader as unknown as FakeElement, panel.root as unknown as FakeElement);
  const startSlide = vi.fn();
  target.addEventListener('pointerdown', startSlide);
  const gesture = new Event('pointerdown', { bubbles: true, cancelable: true });
  expect((panel.mobileHeader as unknown as FakeElement).dispatchEvent(gesture)).toBe(true);
  expect(startSlide).toHaveBeenCalledWith(gesture);
  panel.setVisible(false);
  expect(panel.mobileHeader.hidden).toBe(true);
  expect(panel.root.hidden).toBe(true);
  panel.setVisible(true);
  expect(panel.mobileHeader.hidden).toBe(false);
  expect(panel.root.hidden).toBe(false);
});

it('renders build-specific opaque or transparent no-lift legends and discloses diagnostics inside details', () => {
  vi.stubGlobal('document', { getElementById: () => null, createElement: (tag: string) => new FakeElement(tag), head: new FakeElement('head') });
  vi.stubGlobal('Option', class extends FakeElement { constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; } });
  const callbacks = { onModel: vi.fn(), onLayer: vi.fn(), onFrame: vi.fn(), onOpacity: vi.fn(), onSeries: vi.fn(), onBack: vi.fn() };
  for (const [color, label] of [['#00000000', 'no usable lift (transparent)'], ['#55184d', 'no usable lift']]) {
    const panel = new PluginPanel(callbacks);
    const build = fixtureBuild({
      buildId: color === '#00000000' ? 'transparent' : 'opaque',
      descriptors: { ...fixtureManifest().descriptors, palettes: [
        { id: 'lift', units: 'm', edges: [0, 300], colors: ['#55184d'], noLiftColor: color },
        { id: 'rain', units: 'mm/h', edges: [0.1, 0.5], colors: ['#b9e5ff'], transparentBelow: 0.1, provisional: true }
      ] }
    });
    panel.renderBuild(build);
    const visit = (element: FakeElement): FakeElement[] => [element, ...element.children.flatMap(visit)];
    const nodes = visit(panel.root as unknown as FakeElement);
    const row = nodes.find(element => element.className === 'av-legend-row' && element.children.some(child => child.textContent === label));
    expect(row?.children[0].style.background).toBe(color);
    expect(row?.children[1].textContent).toBe(label);
    const headings = nodes.filter(element => element.tag === 'h2').map(element => element.textContent);
    expect(headings).toContain('lift · m');
    expect(headings).not.toContain('rain · mm/h');
    expect(nodes.some(element => element.tag === 'details' && element.className === 'av-diagnostics')).toBe(true);
  }
});

it('normalizes wrapped longitudes and clears existing series when clicking a new point', () => {
  vi.stubGlobal('document', { getElementById: () => null, createElement: (tag: string) => new FakeElement(tag), head: new FakeElement('head') });
  vi.stubGlobal('Option', class extends FakeElement { constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; } });
  const panel = new PluginPanel({ onModel: vi.fn(), onLayer: vi.fn(), onFrame: vi.fn(), onOpacity: vi.fn(), onSeries: vi.fn(), onBack: vi.fn() });
  panel.renderBuild(fixtureBuild());
  panel.setClicked(32.9, 190);
  expect(panel.clickedPoint).toEqual({ lat: 32.9, lon: -170 });
  panel.renderSeries(
    {
      frames: [{ id: 'f003', validTime: '2026-10-30T03:00:00Z', intervalStart: '2026-10-30T00:00:00Z', intervalEnd: '2026-10-30T03:00:00Z', layers: { 'precip-rate': { value: 1, status: 'valid', support: 0, interpolated: false } } }],
      method: { id: 'dry-lenschow-pbl-1p2-v1' },
      source: { provider: 'NOAA', provenanceKey: 'builds/gfs/build-1/provenance.json', provenanceSha256: 'a'.repeat(64) },
      coverage: { id: 'soaring-land-v1' },
      expiresAt: '2026-10-31T00:00:00Z'
    },
    ['precip-rate'],
    panel.clickedPoint!
  );
  const visit = (element: FakeElement): FakeElement[] => [element, ...element.children.flatMap(visit)];
  const series = visit(panel.root as unknown as FakeElement).find(element => element.className === 'av-series')!;
  expect(series.children).toHaveLength(1);
  panel.setClicked(40.1, 44.5);
  expect(series.children).toHaveLength(0);
});

it('keeps horizon warnings visible alongside errors and removes them on expiry', () => {
  vi.stubGlobal('document', { getElementById: () => null, createElement: (tag: string) => new FakeElement(tag), head: new FakeElement('head') });
  vi.stubGlobal('Option', class extends FakeElement { constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; } });
  const panel = new PluginPanel({ onModel: vi.fn(), onLayer: vi.fn(), onFrame: vi.fn(), onOpacity: vi.fn(), onSeries: vi.fn(), onBack: vi.fn() });
  const state: ControllerState = {
    phase: 'ready', model: 'gfs', buildId: 'build-1', frameId: 'f003', layerId: 'precip-rate', opacity: 0.5,
    badge: 'Explicit frame f003', message: 'Overlay tile failed to load', horizonNotice: 'Forecast ended — update overdue.'
  };
  panel.renderState(state);
  const children = (panel.root as unknown as FakeElement).children;
  const warning = children.find(element => element.className === 'av-warning')!;
  const error = children.find(element => element.className === 'av-error')!;
  expect(warning.hidden).toBe(false);
  expect(warning.textContent).toBe(state.horizonNotice);
  expect(error.hidden).toBe(false);
  expect(error.textContent).toBe(state.message);
  panel.renderState({ ...state, message: null });
  expect(warning.hidden).toBe(false);
  expect(error.hidden).toBe(true);
  panel.renderState({ ...state, phase: 'expired', message: 'Build expired', horizonNotice: null });
  expect(warning.hidden).toBe(true);
  expect(error.textContent).toBe('Build expired');
});

it.each(['https://api.test/provenance.json', 'http://localhost:8787/provenance.json', 'javascript:alert(1)'])('links HTTP(S) provenance in build diagnostics: %s', provenanceUrl => {
  vi.stubGlobal('document', { getElementById: () => null, createElement: (tag: string) => new FakeElement(tag), head: new FakeElement('head') });
  vi.stubGlobal('Option', class extends FakeElement { constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; } });
  const panel = new PluginPanel({ onModel: vi.fn(), onLayer: vi.fn(), onFrame: vi.fn(), onOpacity: vi.fn(), onSeries: vi.fn(), onBack: vi.fn() });
  const build = fixtureBuild();
  build.manifest.source.provenanceUrl = provenanceUrl;
  panel.renderBuild(build);
  const visit = (element: FakeElement): FakeElement[] => [element, ...element.children.flatMap(visit)];
  const diagnostics = (panel.root as unknown as FakeElement).children.find(element => element.tag === 'details')!;
  const link = visit(diagnostics).find(element => element.tag === 'a');
  if (provenanceUrl.startsWith('http')) {
    expect(link?.href).toBe(provenanceUrl);
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toContain('noopener');
  } else expect(link).toBeUndefined();
});


it('reuses legend nodes for unchanged state and refreshes them for layer or immutable build changes', () => {
  vi.stubGlobal('document', { getElementById: () => null, createElement: (tag: string) => new FakeElement(tag), head: new FakeElement('head') });
  vi.stubGlobal('Option', class extends FakeElement { constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; } });
  const panel = new PluginPanel({ onModel: vi.fn(), onLayer: vi.fn(), onFrame: vi.fn(), onOpacity: vi.fn(), onSeries: vi.fn(), onBack: vi.fn() });
  const build = fixtureBuild({ buildId: 'build-1' });
  const state: ControllerState = { phase: 'ready', model: 'gfs', buildId: 'build-1', frameId: 'f003', layerId: 'usable-lift-msl', opacity: 0.5, badge: 'f003', message: null, horizonNotice: null };
  panel.renderBuild(build);
  const legend = (panel.root as unknown as FakeElement).children.find(element => element.className === 'av-legend')!;
  const initial = legend.children[0];
  panel.renderState(state);
  panel.renderState({ ...state, opacity: 0.8, badge: 'Host time changed' });
  panel.renderState({ ...state, message: 'Tile failed', horizonNotice: 'Forecast ended' });
  panel.renderBuild(build);
  expect(legend.children[0]).toBe(initial);

  panel.renderState({ ...state, layerId: 'precip-rate' });
  const rain = legend.children[0];
  expect(rain).not.toBe(initial);
  expect(rain.children[0].textContent).toBe('rain · mm/h');
  panel.renderState({ ...state, layerId: 'precip-rate', opacity: 0.2 });
  expect(legend.children[0]).toBe(rain);

  panel.renderBuild(fixtureBuild({ ...build.manifest, buildId: 'recolored', layers: ['precip-rate'], descriptors: {
    ...build.manifest.descriptors, palettes: build.manifest.descriptors.palettes.map(palette => palette.id === 'rain' ? { ...palette, colors: ['#123456'] } : palette)
  }, artifacts: undefined }));
  const recolored = legend.children[0];
  expect(recolored).not.toBe(rain);
  expect(recolored.children[1].children[0].style.background).toBe('#123456');

  panel.renderBuild(fixtureBuild({ buildId: 'build-2' }));
  expect(legend.children[0]).not.toBe(recolored);
  expect(legend.children[0].children[0].textContent).toBe('lift · m');
});
