import { afterEach, expect, it, vi } from 'vitest';
import { fixtureBuild } from '../../../tests/forecast-fixture';
import { fixturePointBuild, fixtureProfileBuild, retainedPointBuild, retainedProfileBuild, retainedLegacyPointBuild, fixturePointFetch } from '../../../tests/client-point-fixture';
import { disposePointWindgram, renderPointWindgram } from '@av/windgram';
import { ApiClient, pointSeriesSelection } from '@av/contracts/client';
import { PluginPanel } from './view';
import type { ControllerState } from './controller';

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  listeners = new Map<string, ((event: Event) => void)[]>();
  style: { background?: string; cssText?: string } = {};
  textContent = '';
  innerHTML = '';
  hidden = false;
  ariaBusy = '';
  className = '';
  id = '';
  htmlFor = '';
  role = '';
  ariaLabel = '';
  ariaPressed = '';
  scrollLeft = 0;
  scrollTop = 0;
  offsetLeft = 0;
  offsetWidth = 20;
  clientWidth = 0;
  value = '';
  disabled = false;
  type = '';
  min = '';
  max = '';
  step = '';
  checked = false;
  tabIndex = -1;
  constructor(readonly tag: string) {}
  get ownerDocument(): Document { return document; }
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
  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener));
  }
  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    if (event.bubbles && !event.cancelBubble) this.parent?.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  focus(): void { (document as unknown as { activeElement: FakeElement | null }).activeElement = this; }
  contains(value: unknown): boolean { return visit(this).includes(value as FakeElement); }
  querySelector(selector: string): FakeElement | null {
    return visit(this).slice(1).find(node => selector.startsWith('.') ? node.className === selector.slice(1)
      : selector === 'button[aria-pressed="true"]' ? node.tag === 'button' && node.ariaPressed === 'true' : node.tag === selector) ?? null;
  }
}

const callbacks = () => ({ onModel: vi.fn(), onOpacity: vi.fn(), onBack: vi.fn(), onPointHorizon: vi.fn() });

function installDom(active: FakeElement | null = null) {
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
  const unprefixed = fixturePointBuild({ frameHours: Array.from({ length: 48 }, (_, index) => index + 1), mapFrameCount: 48 });
  if (unprefixed.manifest.version !== 5) throw new Error('Expected v5');
  delete unprefixed.manifest.mapFrameCount;
  for (const [build, hidden, label] of [[matching, true, 'Map forecast'], [retainedPointBuild(), false, 'Map forecast'],
    [retainedLegacyPointBuild(), false, '24 hours'], [unprefixed, false, '24 hours']] as const) {
    const panel = new PluginPanel(callbacks());
    panel.renderBuild(build);
    const nodes = visit(panel.root as unknown as FakeElement);
    expect(nodes.find(node => node.id === 'av-point-horizon')?.hidden).toBe(hidden);
    expect(nodes.find(node => node.id === 'av-point-horizon')?.children[0].textContent).toBe(label);
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
  const state: ControllerState = { ...ready, message: 'Overlay tile failed to load', horizonNotice: 'Map forecast ended — update overdue.' };
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
  const build = retainedProfileBuild(), m = build.manifest;
  if (m.version !== 5) throw new Error('Expected v5');
  const fetchImpl = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(fixturePointFetch(build, String(input)))));
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(m.createdAt) });
  const point = { lat: 32.9, lon: -117.25 }, loader = api.pointSeries(build, point), handlers = callbacks(), chooseFrame = vi.fn();
  const panel = new PluginPanel(handlers), mapId = m.frames[m.mapFrameCount! - 1].id;
  const state = { ...ready, buildId: m.buildId, frameId: mapId, displayedFrameId: mapId };
  panel.renderState(state); panel.loadPoint(point);
  panel.pointLoading(pointSeriesSelection(build).frames, mapId);
  panel.renderPoint(await loader.load('day'), build, chooseFrame);
  let nodes = visit(panel.root as unknown as FakeElement);
  const horizon = nodes.find(element => element.id === 'av-point-horizon')!;
  horizon.value = 'forecast'; horizon.dispatchEvent(new Event('change'));
  expect(handlers.onPointHorizon).toHaveBeenCalledWith('forecast');
  panel.pointLoading(pointSeriesSelection(build, 'forecast').frames, mapId);
  panel.renderPoint(await loader.load('forecast'), build, chooseFrame);
  nodes = visit(panel.root as unknown as FakeElement);
  const dayTabs = nodes.find(element => element.className === 'av-windgram-days')!;
  expect(dayTabs.children.length).toBeGreaterThan(1);
  dayTabs.children.at(-1)!.dispatchEvent(new Event('click'));
  expect(chooseFrame).toHaveBeenCalled();
  const chosenId = chooseFrame.mock.calls.at(-1)![0] as string;
  const chosenFrame = m.frames.find(f => f.id === chosenId)!;
  panel.renderState({ ...state, opacity: 0.75 });
  const time = nodes.find(element => element.className === 'av-point-time')!;
  expect(time.textContent).toContain(`Point: ${chosenFrame.validTime.slice(0, 10)}`);
  expect(time.textContent).toContain(`Map: ${m.frames[m.mapFrameCount! - 1].validTime.slice(0, 10)}`);
  const units = nodes.find(element => element.id === 'av-units')!;
  units.value = 'imperial'; units.dispatchEvent(new Event('change'));
  const summary = nodes.find(element => element.className === 'av-windgram-lift-summary')!.textContent;
  expect(summary).toContain('MSL unavailable · AGL unavailable');
  expect(nodes.find(element => element.className === 'av-windgram-profile-status')?.hidden).toBe(true);
  expect(nodes.find(element => element.className === 'av-windgram-key')!.innerHTML).toContain('windgram-legend');
  panel.renderState({ ...state, frameId: null, displayedFrameId: null });
  expect(time.textContent).toContain(`Point: ${chosenFrame.validTime.slice(0, 10)}`);
  expect(time.textContent).toContain('Map: unavailable');
  panel.renderPoint(await loader.load('forecast'), build, chooseFrame);
  nodes = visit(panel.root as unknown as FakeElement);
  expect(nodes.find(element => element.className === 'av-point-time')!.textContent).toContain('Map: unavailable');
});

it('navigates forecast hours via windgram keyboard controls', async () => {
  installDom();
  const build = fixtureProfileBuild({ frameHours: [1, 2, 4, 7, 13], mapFrameCount: 5 });
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: async input => new Response(JSON.stringify(fixturePointFetch(build, String(input)))), now: () => Date.parse(build.manifest.createdAt) });
  const panel = new PluginPanel(callbacks()), chooseFrame = vi.fn();
  panel.loadPoint({ lat: 32.9, lon: -117.25 });
  panel.pointLoading(pointSeriesSelection(build).frames, 'f001');
  panel.renderPoint(await api.pointSeries(build, { lat: 32.9, lon: -117.25 }).load('day'), build, chooseFrame);
  const nodes = visit(panel.root as unknown as FakeElement);
  const host = nodes.find(node => node.className === 'av-windgram-host')!;
  expect(host.innerHTML).toContain('class="windgram');
  expect(nodes.find(node => node.className === 'av-point-incomplete')?.hidden).toBe(true);
  const key = (value: string) => Object.assign(new Event('keydown', { cancelable: true }), { key: value });
  host.dispatchEvent(key('ArrowRight'));
  expect(chooseFrame).toHaveBeenLastCalledWith('f002');
  host.dispatchEvent(key('ArrowLeft'));
  expect(chooseFrame).toHaveBeenLastCalledWith('f001');
  host.dispatchEvent(key('End'));
  expect(chooseFrame).toHaveBeenLastCalledWith('f007');
  host.dispatchEvent(key('Home'));
  expect(chooseFrame).toHaveBeenLastCalledWith('f001');
  const steps = nodes.filter(node => node.className === 'av-windgram-step');
  for (let count = 0; count < 4; count++) steps[1].dispatchEvent(new Event('click'));
  expect(chooseFrame).toHaveBeenLastCalledWith('f013');
});

it('refreshes the same chart on a page append and resize, and disposes the observer and inspector', async () => {
  const owner = installDom();
  const disconnect = vi.fn();
  let resize!: () => void;
  Object.assign(owner, {
    defaultView: Object.assign(new EventTarget(), {
      getComputedStyle: () => ({ maxHeight: 'none' }),
      ResizeObserver: class {
        constructor(callback: () => void) { resize = callback; }
        observe() { }
        disconnect = disconnect;
      }
    })
  });
  const build = fixtureProfileBuild({ frameHours: [1, 2, 4, 7, 13], mapFrameCount: 5 }), point = { lat: 32.9, lon: -117.25 };
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: async input => new Response(JSON.stringify(fixturePointFetch(build, String(input)))), now: () => Date.parse(build.manifest.createdAt) });
  const payload = await api.pointSeries(build, point).load('day'), container = new FakeElement('div');
  const onFrame = vi.fn();
  renderPointWindgram(container as unknown as HTMLElement, { frames: payload.frames.slice(0, 1) }, build, { point, frameId: 'f001', unitSystem: 'metric', totalFrames: 5, loading: true, onFrame });
  const section = container.children[0];
  const inspect = visit(container).find(node => node.tag === 'input')!;
  inspect.checked = true; inspect.dispatchEvent(new Event('change'));
  const nodes = visit(container);
  expect(nodes.filter(node => node.tag === 'input')).toHaveLength(1);
  expect(nodes.find(node => node.className === 'windgram-inspection')?.children).toHaveLength(2);
  const host = nodes.find(node => node.className === 'av-windgram-host')!;
  const firstSvg = host.innerHTML;
  const update = renderPointWindgram(container as unknown as HTMLElement, payload, build, { point, frameId: 'f001', unitSystem: 'metric', totalFrames: 5, loading: false, onFrame });
  expect(container.children[0]).toBe(section);
  expect(inspect.checked).toBe(true);
  expect(host.innerHTML).not.toBe(firstSvg);
  const fullSvg = host.innerHTML;
  host.clientWidth = 620;
  resize();
  expect(host.innerHTML).not.toBe(fullSvg);
  const keydown = host.listeners.get('keydown')?.[0];
  expect(keydown).toBeDefined();
  update('f002');
  expect(host.listeners.get('keydown')?.[0]).toBe(keydown);
  disposePointWindgram(container as unknown as HTMLElement);
  expect(disconnect).toHaveBeenCalledOnce();
  expect(host.listeners.get('keydown')).toHaveLength(0);
});

it('re-renders the windgram SVG and key when units change while keeping same-day selection updates lightweight', async () => {
  installDom();
  const build = fixtureProfileBuild({ frameHours: [1, 2, 4, 7, 13], mapFrameCount: 5 });
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: async input => new Response(JSON.stringify(fixturePointFetch(build, String(input)))), now: () => Date.parse(build.manifest.createdAt) });
  const payload = await api.pointSeries(build, { lat: 32.9, lon: -117.25 }).load('day'), container = new FakeElement('div');
  const update = renderPointWindgram(container as unknown as HTMLElement, payload, build, { point: { lat: 32.9, lon: -117.25 }, frameId: 'f001', unitSystem: 'metric', onFrame: vi.fn() });
  const nodes = visit(container);
  const readout = nodes.find(n => n.className === 'av-windgram-lift-summary')!;
  const weather = nodes.find(n => n.className === 'windgram-readout')!;
  const keyHost = nodes.find(n => n.className === 'av-windgram-key')!;
  expect(readout.textContent).toContain('MSL 2000 m · AGL 500 m');
  expect(weather.textContent).toContain('Model surface wind 5.0 m/s');
  expect(keyHost.innerHTML).toContain('m/s');
  update('f004');
  update('f007', 'metric', 'f002');
  expect(readout.textContent).toContain('MSL 2000 m · AGL 500 m');
  update('f007', 'imperial');
  expect(readout.textContent).toContain('MSL 6562 ft · AGL 1640 ft');
  expect(weather.textContent).toContain('Model surface wind 9.7 kt');
  expect(keyHost.innerHTML).toContain('kt');
});

it('keeps missing pages recorded in the incomplete notice independently of loading', async () => {
  installDom();
  const build = fixtureProfileBuild({ frameHours: [1, 2, 4, 7, 13], mapFrameCount: 5 });
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: async input => new Response(JSON.stringify(fixturePointFetch(build, String(input)))), now: () => Date.parse(build.manifest.createdAt) });
  const payload = await api.pointSeries(build, { lat: 32.9, lon: -117.25 }).load('day');
  const container = new FakeElement('div'), partial = { frames: [payload.frames[0], payload.frames[2], payload.frames[3], payload.frames[4]] };
  const update = renderPointWindgram(container as unknown as HTMLElement, partial, build, { point: { lat: 32.9, lon: -117.25 }, frameId: 'f001', unitSystem: 'metric', totalFrames: 5, loading: false, onFrame: vi.fn() });
  const nodes = visit(container);
  const notice = nodes.find(node => node.className === 'av-point-incomplete')!;
  expect(notice.hidden).toBe(false);
  update('f013', 'imperial');
  expect(notice.hidden).toBe(false);
  expect(nodes.find(node => node.className === 'av-windgram-lift-summary')?.textContent).toContain('MSL 6562 ft · AGL 1640 ft');
});

it('keeps the live readout quiet when the selected hour has no lift change', async () => {
  installDom();
  const build = fixtureProfileBuild({ frameHours: [1, 2, 4], mapFrameCount: 1 }), point = { lat: 32.9, lon: -117.25 };
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: async input => new Response(JSON.stringify(fixturePointFetch(build, String(input)))), now: () => Date.parse(build.manifest.createdAt) });
  const payload = await api.pointSeries(build, point).load('forecast'), container = new FakeElement('div');
  const update = renderPointWindgram(container as unknown as HTMLElement, payload, build, { point, frameId: 'f002', unitSystem: 'metric', onFrame: vi.fn() });
  const readout = visit(container).find(node => node.className === 'windgram-readout')!;
  expect(readout.textContent).toContain('AGL unavailable');
  let content = readout.textContent;
  const write = vi.fn((next: string) => { content = next; });
  Object.defineProperty(readout, 'textContent', { get: () => content, set: write });
  update('f002', 'metric', 'f001');
  expect(write).not.toHaveBeenCalled();
  update('f001');
  expect(readout.textContent).toContain('500 m AGL');
  expect(write).toHaveBeenCalledOnce();
});

it.each([[false, false], [true, false], [true, true]])('preserves Windy progress and terminal failure (fails=%s, selected hour loaded=%s)', async (fail, keepKnown) => {
  installDom();
  const hours = [...Array.from({ length: 24 }, (_, i) => i + 1), ...Array.from({ length: 16 }, (_, i) => 27 + i * 3)];
  const build = fixtureProfileBuild({ frameHours: [...hours, 75, 78], mapFrameCount: 40, profileLevels: 200 }), m = build.manifest;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pages: number[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    const page = new URL(String(input)).pathname.endsWith('/profile');
    if (page) pages.push(pages.length + 1);
    if (page && pages.length === (fail ? 3 : 2)) await gate;
    if (fail && page && pages.length === 3) throw new Error('Late page failed');
    return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(m.createdAt) });
  const panel = new PluginPanel(callbacks()), point = { lat: 32.9, lon: -117.25 };
  panel.renderState({ ...ready, buildId: m.buildId, frameId: 'f072', displayedFrameId: m.frames[0].id });
  panel.loadPoint(point);
  const frameIds = pointSeriesSelection(build).frames;
  panel.pointLoading(frameIds, 'f072');
  const location = visit(panel.root as unknown as FakeElement).find(node => node.className === 'av-point-location')!;
  expect(location.parent?.className).toBe('av-point-settings');
  expect(location.textContent).toBe('32.900°, -117.250°');
  const pending = api.pointSeries(build, point).load('day', undefined, { frameId: 'f072', onProgress(series, _total, loading) {
    panel.renderPoint(series, build, vi.fn(), loading);
  } });
  const rejected = fail ? expect(pending).rejects.toThrow('Late page failed') : null;
  try {
    await vi.waitFor(() => expect(pages).toHaveLength(fail ? 3 : 2));
    const nodes = visit(panel.root as unknown as FakeElement);
    expect(nodes.find(node => node.className === 'av-point')?.ariaBusy).toBe('true');
    panel.pointLoading(frameIds, 'f072');
    const status = nodes.find(node => node.className === 'av-muted' && node.parent?.className === 'av-point');
    expect(status?.hidden).toBe(false);
    expect(status?.textContent).toBe('Loading forecast…');
    expect(nodes.find(node => node.className === 'av-windgram-host')?.innerHTML).toContain('class="windgram');
    expect(nodes.find(node => node.className === 'av-windgram-lift-summary')?.textContent).toContain('MSL 2000 m · AGL 500 m');
    expect(nodes.find(node => node.className === 'av-point-incomplete')?.hidden).toBe(true);
    expect(nodes.find(node => node.className === 'av-point-time')?.textContent).toContain(' · Map: ');
    expect(panel.pointFrame).toBe('f072');
    expect(nodes.find(node => node.id === 'av-point-horizon')?.children[0].textContent).toBe('Map forecast');
    if (!keepKnown) {
      panel.renderState({ ...ready, buildId: m.buildId, frameId: 'f069', displayedFrameId: m.frames[0].id });
      expect(nodes.find(node => node.className === 'av-windgram-profile-status')?.textContent).toBe('Loading native profile…');
    }
  } finally { release(); }
  if (fail) {
    await rejected;
    panel.pointError('Late page failed');
    const nodes = visit(panel.root as unknown as FakeElement), summary = nodes.find(node => node.className === 'av-windgram-lift-summary')!;
    const status = nodes.find(node => node.className === 'av-muted' && node.parent?.className === 'av-point');
    expect(status?.hidden).toBe(false);
    expect(status?.textContent).toBe('Late page failed');
    expect(panel.pointFrame).toBe(keepKnown ? 'f072' : 'f069');
    expect(summary.textContent).toContain('MSL 2000 m · AGL 500 m');
    expect(nodes.find(node => node.className === 'av-windgram-profile-status')?.hidden).toBe(keepKnown);
    const incomplete = nodes.find(node => node.className === 'av-point-incomplete')!;
    expect(incomplete.hidden).toBe(false); expect(incomplete.role).toBe('status');
    expect(incomplete.textContent).toBe('Forecast incomplete. Some hours could not be loaded.');
    expect(nodes.find(node => node.className === 'av-point-time')?.textContent).toContain(m.frames[keepKnown ? 39 : 38].validTime.slice(0, 16).replace('T', ' '));
    const units = nodes.find(node => node.id === 'av-units')!;
    units.value = 'imperial'; units.dispatchEvent(new Event('change'));
    expect(summary.textContent).toContain('MSL 6562 ft · AGL 1640 ft');
    const dayTabs = nodes.find(node => node.className === 'av-windgram-days')!;
    dayTabs.children.at(-1)!.dispatchEvent(new Event('click'));
    expect(summary.textContent).toContain('MSL 6562 ft · AGL 1640 ft');
    expect(incomplete.hidden).toBe(false);
    return;
  }
  await pending;
  const nodes = visit(panel.root as unknown as FakeElement);
  expect(nodes.find(node => node.className === 'av-point')?.ariaBusy).toBe('false');
  expect(nodes.find(node => node.className === 'av-windgram-host')?.innerHTML).toContain('class="windgram');
  expect(nodes.find(node => node.className === 'av-point-incomplete')?.hidden).toBe(true);
  expect(panel.pointFrame).toBe('f069');
  expect(pages).toHaveLength(3);
});

it('keeps selected point time separate from pending and failed Windy raster replacements', async () => {
  installDom();
  const build = fixtureProfileBuild(), m = build.manifest;
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: async input => new Response(JSON.stringify(fixturePointFetch(build, String(input)))), now: () => Date.parse(m.createdAt) });
  const panel = new PluginPanel(callbacks()), first = m.frames[0], second = m.frames[1];
  const state = { ...ready, buildId: m.buildId, frameId: second.id, displayedFrameId: null };
  panel.renderState(state);
  panel.loadPoint({ lat: 32.9, lon: -117.25 });
  panel.pointLoading(pointSeriesSelection(build).frames, second.id);
  panel.renderPoint(await api.pointSeries(build, { lat: 32.9, lon: -117.25 }).load('day'), build, vi.fn());
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

it('keeps a point hour in the planned horizon when the legacy map time lies beyond it', () => {
  installDom();
  const build = retainedLegacyPointBuild(), frames = pointSeriesSelection(build).frames;
  const mapFrame = build.manifest.frames[frames.length];
  const panel = new PluginPanel(callbacks());
  panel.loadPoint({ lat: 32.9, lon: -117.25 });
  expect(panel.pointLoading(frames, mapFrame.id)).toBe(frames[0]);
  panel.renderState({ ...ready, frameId: mapFrame.id, displayedFrameId: mapFrame.id });
  panel.pointError('A later page failed');
  expect(panel.pointFrame).toBe(frames[0]);
});
