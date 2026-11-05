import { afterEach, expect, it, vi } from 'vitest';
import { fixtureBuild } from '../../../tests/forecast-fixture';
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

const callbacks = () => ({ onModel: vi.fn(), onOpacity: vi.fn(), onBack: vi.fn() });

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
  phase: 'ready', model: 'gfs', buildId: 'build-1', frameId: 'f003', layerId: 'usable-lift-msl', opacity: 0.5,
  badge: 'Host frame f003', message: null, horizonNotice: null
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
  expect(controls.map(control => control.id)).toEqual(['av-model', 'av-opacity']);
  expect(controls.map(control => nodes.find(node => node.tag === 'label' && node.htmlFor === control.id)?.textContent)).toEqual(['Model', 'Opacity']);
  expect(nodes.find(node => node.className === 'av-error')?.role).toBe('alert');
  expect(nodes.find(node => node.className === 'av-warning')?.role).toBe('status');
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
