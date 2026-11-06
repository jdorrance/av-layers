import { afterEach, expect, it, vi } from 'vitest';
import { fixtureBuild } from '../../../tests/forecast-fixture';
import { fixturePointBuild, retainedPointBuild, fixturePointSample } from '../../../tests/client-point-fixture';
import { ApiClient } from '@av/contracts/client';
import { PluginPanel } from './view';
import type { ControllerState } from './controller';

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  listeners = new Map<string, ((event: Event) => void)[]>();
  style: { background?: string } = {};
  textContent = '';
  hidden = false;
  className = '';
  id = '';
  htmlFor = '';
  role = '';
  value = '';
  disabled = false;
  type = '';
  min = '';
  max = '';
  step = '';
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

const callbacks = () => ({ onModel: vi.fn(), onOpacity: vi.fn(), onBack: vi.fn(), onPointHorizon: vi.fn() });

function installDom(active: FakeElement | null = null): { activeElement: FakeElement | null } {
  const document = {
    activeElement: active,
    getElementById: () => null,
    createElement: (tag: string) => new FakeElement(tag),
    head: new FakeElement('head')
  };
  vi.stubGlobal('document', document);
  vi.stubGlobal('Option', class extends FakeElement {
    constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; }
  });
  return document;
}

function visit(element: FakeElement): FakeElement[] {
  return [element, ...element.children.flatMap(visit)];
}

const ready: ControllerState = {
  phase: 'ready', model: 'gfs', buildId: 'build-1', frameId: 'f003', displayedFrameId: 'f003', layerId: 'usable-lift-msl', opacity: 0.5,
  badge: 'Host frame f003', message: null, notice: null, horizonNotice: null
};

afterEach(() => vi.unstubAllGlobals());

it('offers the published models and follows the selected build', () => {
  installDom();
  const panel = new PluginPanel(callbacks());
  panel.renderBuild(fixtureBuild({ buildId: 'build-1' }));
  panel.renderState(ready);
  const nodes = visit(panel.root as unknown as FakeElement);
  const model = nodes.find(element => element.id === 'av-model')!;
  expect(model.value).toBe('gfs');
  expect(model.children.map(option => option.value)).toEqual(['gfs', 'icon-eu', 'rrfs']);
  expect(nodes.some(element => element.id === 'av-layer' || element.id === 'av-frame')).toBe(false);
  panel.renderBuild(fixtureBuild({ model: 'icon-eu', buildId: 'build-1' }));
  expect(model.value).toBe('icon-eu');
});

it('associates visible labels with the model and opacity controls', () => {
  installDom();
  const panel = new PluginPanel(callbacks());
  const nodes = visit(panel.root as unknown as FakeElement);
  const controls = nodes.filter(element => element.tag === 'select' || element.tag === 'input');
  expect(controls.map(control => control.id)).toEqual(['av-model', 'av-opacity', 'av-units', 'av-point-horizon']);
  expect(controls.map(control => nodes.find(node => node.tag === 'label' && node.htmlFor === control.id)?.textContent)).toEqual(['Model', 'Opacity', 'Units', 'Point horizon']);
  expect(nodes.find(node => node.className === 'av-notice')?.role).toBe('status');
  expect(nodes.find(node => node.className === 'av-error')?.role).toBe('alert');
  expect(nodes.find(node => node.className === 'av-warning')?.role).toBe('status');
});

it('offers a horizon choice only when a pinned build has additional point frames', () => {
  installDom();
  const matching = fixturePointBuild({ frameHours: [1, 2, 3], mapFrameCount: 3 });
  for (const [build, hidden] of [[matching, true], [retainedPointBuild(), false]] as const) {
    const panel = new PluginPanel(callbacks());
    panel.renderBuild(build);
    const nodes = visit(panel.root as unknown as FakeElement);
    expect(nodes.find(node => node.id === 'av-point-horizon')?.hidden).toBe(hidden);
    expect(nodes.find(node => node.htmlFor === 'av-point-horizon')?.hidden).toBe(hidden);
  }
});

it('keeps native panel control keys separate from page shortcuts while allowing Escape and Tab', () => {
  installDom();
  const handlers = callbacks();
  const panel = new PluginPanel(handlers);
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
  const controls = visit(panel.root as unknown as FakeElement).filter(element => ['select', 'input', 'button'].includes(element.tag));
  for (const control of controls) {
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', ' ', 'f', 'Home']) {
      const event = keydown(key);
      expect(control.dispatchEvent(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    }
  }
  expect(pageKeys).toEqual([]);
  expect(hostTime).toBe(9);
  const opacity = visit(panel.root as unknown as FakeElement).find(element => element.id === 'av-opacity')!;
  opacity.value = '0.55';
  opacity.dispatchEvent(new Event('input', { bubbles: true }));
  expect(handlers.onOpacity).toHaveBeenCalledWith(0.55);
  for (const key of ['Escape', 'Tab']) expect(opacity.dispatchEvent(keydown(key))).toBe(true);
  expect(pageKeys).toEqual(['Escape', 'Tab']);
  expect(map.dispatchEvent(keydown('ArrowRight'))).toBe(false);
  expect(hostTime).toBe(10);
});

it('leaves native mobile header gestures to the host and hides both pane elements together', () => {
  installDom();
  const panel = new PluginPanel(callbacks());
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

it('keeps horizon warnings visible alongside errors and removes them on expiry', () => {
  installDom();
  const panel = new PluginPanel(callbacks());
  const state: ControllerState = { ...ready, message: 'Overlay tile failed to load', horizonNotice: 'Forecast ended — update overdue.' };
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

it('leaves the opacity slider alone while it is being dragged', () => {
  const opacity = new FakeElement('input');
  installDom(opacity);
  const panel = new PluginPanel(callbacks());
  const input = visit(panel.root as unknown as FakeElement).find(element => element.id === 'av-opacity')!;
  const document = globalThis.document as { activeElement: FakeElement | null };
  document.activeElement = input;
  input.value = '0.33';
  panel.renderState({ ...ready, opacity: 0.9 });
  expect(input.value).toBe('0.33');
  document.activeElement = null;
  panel.renderState({ ...ready, opacity: 0.9 });
  expect(input.value).toBe('0.9');
});

it('inspects the full point forecast independently of an unchanged Windy map frame', async () => {
  installDom();
  const build = retainedPointBuild(), m = build.manifest;
  if (m.version !== 5) throw new Error('Expected v5');
  const fetchImpl = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(fixturePointSample(build, String(input)))));
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(m.createdAt) });
  const point = { lat: 32.9, lon: -117.25 }, loader = api.pointSeries(build, point), handlers = callbacks(), chooseFrame = vi.fn();
  const panel = new PluginPanel(handlers), mapId = m.frames[m.mapFrameCount! - 1].id;
  const state = { ...ready, buildId: m.buildId, frameId: mapId, displayedFrameId: mapId };
  panel.renderState(state); panel.loadPoint(point);
  panel.renderPoint(await loader.load('day'), build, mapId, chooseFrame);
  let nodes = visit(panel.root as unknown as FakeElement);
  const horizon = nodes.find(element => element.id === 'av-point-horizon')!;
  horizon.value = 'forecast'; horizon.dispatchEvent(new Event('change'));
  expect(handlers.onPointHorizon).toHaveBeenCalledWith('forecast');
  panel.renderPoint(await loader.load('forecast'), build, mapId, chooseFrame);
  nodes = visit(panel.root as unknown as FakeElement);
  const chart = nodes.find(element => element.className === 'av-point-chart')!;
  expect(chart.children).toHaveLength(m.frames.length);
  chart.children.at(-1)!.dispatchEvent(new Event('click'));
  expect(chooseFrame).toHaveBeenCalledWith(m.frames.at(-1)!.id);
  panel.renderState({ ...state, opacity: 0.75 });
  const time = nodes.find(element => element.className === 'av-point-time')!;
  expect(time.textContent).toContain(`Point: ${m.frames.at(-1)!.validTime.slice(0, 10)}`);
  expect(time.textContent).toContain(`Map: ${m.frames[m.mapFrameCount! - 1].validTime.slice(0, 10)}`);
  const units = nodes.find(element => element.id === 'av-units')!;
  units.value = 'imperial'; units.dispatchEvent(new Event('change'));
  const summary = nodes.find(element => element.className === 'av-point-values')!.textContent;
  expect(summary).toContain('Native top 8202 ft'); expect(summary).toContain('Cloud 0%');
  expect(summary).toContain('MSL —'); expect(summary).toContain('Terrain unknown'); expect(summary).not.toContain('Blue');
  expect(nodes.find(element => element.className === 'av-point-legend')!.textContent).toContain('Heights MSL');
  panel.renderState({ ...state, frameId: null, displayedFrameId: null });
  expect(time.textContent).toContain(`Point: ${m.frames.at(-1)!.validTime.slice(0, 10)}`);
  expect(time.textContent).toContain('Map: unavailable');
  panel.renderPoint(await loader.load('forecast'), build, null, chooseFrame);
  nodes = visit(panel.root as unknown as FakeElement);
  expect(nodes.find(element => element.className === 'av-point-time')!.textContent).toContain('Map: unavailable');
});

it.each([false, true])('preserves the point through Windy progress and terminal failure (late page fails=%s)', async fail => {
  installDom();
  const hours = [...Array.from({ length: 24 }, (_, i) => i + 1), ...Array.from({ length: 16 }, (_, i) => 27 + i * 3)];
  const build = fixturePointBuild({ frameHours: [...hours, 75, 78], mapFrameCount: 40 }), m = build.manifest;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    if (fetchImpl.mock.calls.length === (fail ? 3 : 2)) await gate;
    if (fail && fetchImpl.mock.calls.length === 3) throw new Error('Late page failed');
    return new Response(JSON.stringify(fixturePointSample(build, String(input))));
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(m.createdAt) });
  const panel = new PluginPanel(callbacks()), point = { lat: 32.9, lon: -117.25 };
  panel.renderState({ ...ready, buildId: m.buildId, frameId: 'f072', displayedFrameId: m.frames[0].id });
  panel.loadPoint(point);
  const pending = api.pointSeries(build, point).load('day', undefined, { frameId: 'f072', onProgress(series, total) {
    panel.renderPoint(series, build, 'f072', vi.fn(), total);
  } });
  const rejected = fail ? expect(pending).rejects.toThrow('Late page failed') : null;
  try {
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(fail ? 3 : 2));
    const nodes = visit(panel.root as unknown as FakeElement);
    expect(nodes.some(node => node.textContent === `${fail ? 24 : 1}/40 frames · Loading…`)).toBe(true);
    expect(nodes.find(node => node.className === 'av-point-chart')?.children).toHaveLength(fail ? 24 : 1);
    expect(nodes.find(node => node.className === 'av-point-values')?.textContent).toContain('Native top 2500 m');
    expect(nodes.find(node => node.className === 'av-point-time')?.textContent).toContain(' · Map: ');
    expect(panel.pointFrame).toBe('f072');
    expect(nodes.find(node => node.id === 'av-point-horizon')?.children[0].textContent).toBe('Map forecast');
    panel.renderState({ ...ready, buildId: m.buildId, frameId: 'f069', displayedFrameId: m.frames[0].id });
    expect(nodes.find(node => node.className === 'av-point-values')?.textContent).toBe('Loading selected point hour…');
  } finally { release(); }
  if (fail) {
    await rejected;
    panel.pointError('Late page failed');
    const nodes = visit(panel.root as unknown as FakeElement), summary = nodes.find(node => node.className === 'av-point-values')!;
    expect(panel.pointFrame).toBe('f069');
    expect(summary.textContent).toBe('Selected point hour unavailable.');
    expect(nodes.find(node => node.className === 'av-point-time')?.textContent).toContain(m.frames[38].validTime.slice(0, 16).replace('T', ' '));
    const units = nodes.find(node => node.id === 'av-units')!;
    units.value = 'imperial'; units.dispatchEvent(new Event('change'));
    expect(summary.textContent).toBe('Selected point hour unavailable.');
    const chart = nodes.find(node => node.className === 'av-point-chart')!;
    expect(chart.children).toHaveLength(24);
    chart.children.find(node => node.value === 'f072')!.dispatchEvent(new Event('click'));
    expect(summary.textContent).toContain('Native top 8202 ft');
    return;
  }
  await pending;
  const nodes = visit(panel.root as unknown as FakeElement);
  expect(nodes.some(node => node.textContent.startsWith('40 frames ·'))).toBe(true);
  expect(nodes.find(node => node.className === 'av-point-chart')?.children).toHaveLength(40);
  expect(panel.pointFrame).toBe('f069');
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});

it('keeps selected point time separate from pending and failed Windy raster replacements', async () => {
  installDom();
  const build = fixturePointBuild(), m = build.manifest;
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: async input => new Response(JSON.stringify(fixturePointSample(build, String(input)))), now: () => Date.parse(m.createdAt) });
  const panel = new PluginPanel(callbacks()), first = m.frames[0], second = m.frames[1];
  const state = { ...ready, buildId: m.buildId, frameId: second.id, displayedFrameId: null };
  panel.renderState(state);
  panel.renderPoint(await api.pointSeries(build, { lat: 32.9, lon: -117.25 }).load('day'), build, second.id, vi.fn());
  const time = visit(panel.root as unknown as FakeElement).find(element => element.className === 'av-point-time')!;
  const stamp = (value: string) => value.slice(0, 16).replace('T', ' ');
  expect(time.textContent).toBe(`Point: ${stamp(second.validTime)} UTC · Map: unavailable`);
  panel.renderState({ ...state, displayedFrameId: first.id, notice: 'Loading selected forecast.' });
  const split = `Point: ${stamp(second.validTime)} UTC · Map: ${stamp(first.validTime)} UTC`;
  expect(time.textContent).toBe(split);
  panel.renderState({ ...state, displayedFrameId: first.id, message: 'Forecast replacement failed.' });
  expect(time.textContent).toBe(split);
  panel.renderState({ ...state, displayedFrameId: second.id });
  expect(time.textContent).toBe(`Point and map: ${stamp(second.validTime)} UTC`);
  panel.renderState(state);
  expect(time.textContent).toContain('Map: unavailable');
});
