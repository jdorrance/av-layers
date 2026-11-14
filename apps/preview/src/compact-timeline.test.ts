import { afterEach, expect, it, vi } from 'vitest';
import {
  createCompactTimeline,
  localDayKey,
  localTimeParts,
  nearestFrameIndexForDay,
  scrollLeftForCell,
  type TimelineFrame
} from './compact-timeline';

class ClassList {
  private readonly tokens = new Set<string>();
  add(...tokens: string[]): void { for (const token of tokens) this.tokens.add(token); }
  contains(token: string): boolean { return this.tokens.has(token); }
  toggle(token: string, force?: boolean): boolean {
    const next = force ?? !this.tokens.has(token);
    if (next) this.tokens.add(token);
    else this.tokens.delete(token);
    return next;
  }
}

class Element extends EventTarget {
  children: Element[] = [];
  readonly classList = new ClassList();
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  parentNode: Element | null = null;
  className = '';
  textContent = '';
  type = '';
  tabIndex = -1;
  disabled = false;
  scrollLeft = 0;
  clientWidth = 0;
  offsetLeft = 0;
  offsetWidth = 36;
  getBoundingClientRect(): { left: number } { return { left: this.offsetLeft - (this.parentNode?.scrollLeft ?? 0) }; }
  constructor(readonly tag: string) { super(); }
  get ownerDocument(): Document { return doc; }
  append(...nodes: Element[]): void {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: Element[]): void {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  removeChild(node: Element): void {
    this.children = this.children.filter(child => child !== node);
    node.parentNode = null;
  }
  remove(): void { this.parentNode?.removeChild(this); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  contains(node: Element): boolean { return this === node || this.children.some(child => child.contains(node)); }
  focus(): void { doc.activeElement = this; }
}

class Document extends EventTarget {
  elements: Element[] = [];
  activeElement: Element | null = null;
  visibilityState: DocumentVisibilityState = 'visible';
  createElement(tag: string): Element {
    const element = new Element(tag);
    this.elements.push(element);
    return element;
  }
}

let doc: Document;

function setup(timeZone?: string) {
  doc = new Document();
  const host = doc.createElement('div');
  const onSelect = vi.fn();
  const timeline = createCompactTimeline(host as unknown as HTMLElement, { onSelect, timeZone });
  return { host, onSelect, timeline };
}

function all(element: Element): Element[] {
  return [element, ...element.children.flatMap(all)];
}

function byClass(root: Element, name: string): Element {
  const element = all(root).find(candidate => candidate.className.split(/\s+/).includes(name) || candidate.classList.contains(name));
  if (!element) throw new Error(`Missing .${name}`);
  return element;
}

function cells(root: Element): Element[] {
  return all(root).filter(element => element.className.split(/\s+/).includes('ct-hour'));
}

function click(element: Element): void {
  element.dispatchEvent(new Event('click'));
}

function key(element: Element, value: string): Event {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperty(event, 'key', { value });
  element.dispatchEvent(event);
  return event;
}

const frames: TimelineFrame[] = [
  { id: 'a', validTime: '2026-11-13T18:00:00Z' },
  { id: 'b', validTime: '2026-11-13T21:00:00Z' },
  { id: 'c', validTime: '2026-11-14T00:00:00Z' }
];

afterEach(() => {
  vi.useRealTimers();
});

it('derives local date and time through IANA timezones across DST', () => {
  expect(localDayKey('2026-03-08T06:30:00Z', 'America/New_York')).toBe('2026-03-08');
  expect(localTimeParts('2026-03-08T06:30:00Z', 'America/New_York')).toMatchObject({ hour: 1, minute: 30 });
  expect(localTimeParts('2026-03-08T07:30:00Z', 'America/New_York')).toMatchObject({ hour: 3, minute: 30 });
  expect(localTimeParts('2026-11-01T05:30:00Z', 'America/New_York')).toMatchObject({ hour: 1, minute: 30 });
  expect(localTimeParts('2026-11-01T06:30:00Z', 'America/New_York')).toMatchObject({ hour: 1, minute: 30 });
  expect(localDayKey('2026-11-01T06:30:00Z', 'UTC')).toBe('2026-11-01');
});

it('chooses the nearest frame on a target day and keeps ties stable', () => {
  const day: TimelineFrame[] = [
    { id: 'a', validTime: '2026-11-14T03:00:00Z' },
    { id: 'b', validTime: '2026-11-14T10:00:00Z' },
    { id: 'c', validTime: '2026-11-14T16:00:00Z' },
    { id: 'd', validTime: '2026-11-14T22:00:00Z' }
  ];
  expect(nearestFrameIndexForDay(day, [0, 1, 2, 3], 'UTC', 12, 0)).toBe(1);
  const tied: TimelineFrame[] = [
    { id: 'a', validTime: '2026-11-14T10:00:00Z' },
    { id: 'b', validTime: '2026-11-14T14:00:00Z' }
  ];
  expect(nearestFrameIndexForDay(tied, [0, 1], 'UTC', 12, 0)).toBe(0);
});

it('keeps a cell fully visible without scrolling the page', () => {
  expect(scrollLeftForCell(100, 30, 0, 90)).toBe(40);
  expect(scrollLeftForCell(10, 30, 40, 90)).toBe(10);
  expect(scrollLeftForCell(50, 30, 40, 90)).toBe(40);
  expect(scrollLeftForCell(50, 30, 40, 0)).toBe(40);
});

it('renders published sparse frames in UTC by default', () => {
  const { host, timeline } = setup();
  timeline.update(frames, 'b');
  const root = host.children[0]!;
  expect(byClass(root, 'ct-date-line').textContent).toBe('Fri, Nov 13');
  expect(byClass(root, 'ct-time').textContent).toBe('21:00');
  expect(byClass(root, 'ct-zone').textContent).toBe('UTC');
  expect(cells(root).map(cell => byClass(cell, 'ct-hour-label').textContent)).toEqual(['18', '21', '00']);
  expect(cells(root).map(cell => cell.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
  expect(cells(root).map(cell => cell.tabIndex)).toEqual([-1, 0, -1]);
  timeline.destroy();
});

it('selects numeric frame ids only by identity', () => {
  const { host, timeline } = setup();
  const numericFrames = [{ ...frames[0]!, id: '1' }, frames[1]!];
  timeline.update(numericFrames, '1');
  expect(cells(host).map(cell => cell.getAttribute('aria-checked'))).toEqual(['true', 'false']);
  timeline.update(numericFrames, '0');
  expect(cells(host).map(cell => cell.getAttribute('aria-checked'))).toEqual(['false', 'false']);
  timeline.destroy();
});

it('uses the explicit IANA timezone for labels and selection', () => {
  const { host, timeline } = setup('America/New_York');
  timeline.update(frames, 'a');
  const root = host.children[0]!;
  expect(byClass(root, 'ct-date-line').textContent).toBe('Fri, Nov 13');
  expect(byClass(root, 'ct-time').textContent).toBe('13:00');
  expect(byClass(root, 'ct-zone').textContent).toBe('America/New_York');
  expect(cells(root).map(cell => byClass(cell, 'ct-hour-label').textContent)).toEqual(['13', '16', '19']);
  timeline.destroy();
});

it('selects frames by click and keyboard with one group tab stop', () => {
  const { host, onSelect, timeline } = setup();
  timeline.update(frames, 'a');
  const root = host.children[0]!;
  const list = byClass(root, 'ct-hours');
  const group = cells(root);
  expect(group.filter(cell => cell.tabIndex === 0)).toHaveLength(1);

  click(group[1]!);
  expect(onSelect).toHaveBeenLastCalledWith(1);

  const right = key(list, 'ArrowRight');
  expect(right.defaultPrevented).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith(2);
  expect(doc.activeElement).toBe(cells(root)[2]);

  key(list, 'Home');
  expect(onSelect).toHaveBeenLastCalledWith(0);
  key(list, 'End');
  expect(onSelect).toHaveBeenLastCalledWith(2);
  expect(cells(root).map(cell => cell.tabIndex)).toEqual([-1, -1, 0]);
  timeline.destroy();
});

it('moves to the nearest hour on adjacent days and disables boundary arrows', () => {
  const { host, onSelect, timeline } = setup('America/New_York');
  const days: TimelineFrame[] = [
    { id: 'd1a', validTime: '2026-11-13T05:00:00Z' },
    { id: 'd1b', validTime: '2026-11-13T12:00:00Z' },
    { id: 'd1c', validTime: '2026-11-13T18:00:00Z' },
    { id: 'd2a', validTime: '2026-11-14T15:00:00Z' },
    { id: 'd2b', validTime: '2026-11-14T20:00:00Z' }
  ];
  timeline.update(days, 'd1c');
  const root = host.children[0]!;
  const previous = byClass(root, 'ct-prev');
  const next = byClass(root, 'ct-next');
  expect(previous.disabled).toBe(true);
  expect(next.disabled).toBe(false);

  click(next);
  expect(onSelect).toHaveBeenLastCalledWith(4);
  expect(byClass(root, 'ct-date-line').textContent).toBe('Sat, Nov 14');
  expect(byClass(root, 'ct-time').textContent).toBe('15:00');
  expect(previous.disabled).toBe(false);
  expect(next.disabled).toBe(true);

  click(previous);
  expect(onSelect).toHaveBeenLastCalledWith(2);
  expect(byClass(root, 'ct-time').textContent).toBe('13:00');
  timeline.destroy();
});

it('plays through available frames across midnight and stops at the last', () => {
  vi.useFakeTimers();
  const { host, onSelect, timeline } = setup();
  timeline.update(frames, 'a');
  const root = host.children[0]!;
  const play = byClass(root, 'ct-play');
  click(play);
  expect(play.getAttribute('aria-pressed')).toBe('true');
  expect(onSelect).not.toHaveBeenCalled();

  vi.advanceTimersByTime(700);
  expect(onSelect).toHaveBeenLastCalledWith(1);
  expect(play.getAttribute('aria-pressed')).toBe('true');
  vi.advanceTimersByTime(700);
  expect(onSelect).toHaveBeenLastCalledWith(2);
  expect(play.getAttribute('aria-pressed')).toBe('false');

  vi.advanceTimersByTime(2100);
  expect(onSelect).toHaveBeenCalledTimes(2);

  click(play);
  expect(onSelect).toHaveBeenLastCalledWith(0);
  expect(play.getAttribute('aria-pressed')).toBe('true');
  timeline.destroy();
});

it('stops playback when the document hides and cleans up on destroy', () => {
  vi.useFakeTimers();
  const { host, onSelect, timeline } = setup();
  timeline.update(frames, 'a');
  const root = host.children[0]!;
  const play = byClass(root, 'ct-play');
  click(play);
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  expect(play.getAttribute('aria-pressed')).toBe('false');
  vi.advanceTimersByTime(1400);
  expect(onSelect).not.toHaveBeenCalled();

  doc.visibilityState = 'visible';
  click(play);
  vi.advanceTimersByTime(700);
  expect(onSelect).toHaveBeenLastCalledWith(1);
  timeline.destroy();
  vi.advanceTimersByTime(1400);
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(host.children).toHaveLength(0);
  doc.dispatchEvent(new Event('visibilitychange'));
});

it('disables controls and does not start playback when disabled', () => {
  vi.useFakeTimers();
  const { host, onSelect, timeline } = setup();
  timeline.update(frames, 'a', true);
  const root = host.children[0]!;
  const play = byClass(root, 'ct-play');
  expect(play.disabled).toBe(true);
  expect(byClass(root, 'ct-prev').disabled).toBe(true);
  expect(cells(root).every(cell => cell.disabled)).toBe(true);
  click(play);
  vi.advanceTimersByTime(1400);
  expect(onSelect).not.toHaveBeenCalled();

  timeline.update(frames, 'b', false);
  expect(play.disabled).toBe(false);
  timeline.destroy();
});

it('reveals the selected cell by scrolling whole cells', () => {
  const { host, timeline } = setup();
  timeline.update(frames, 'a');
  const root = host.children[0]!;
  const list = byClass(root, 'ct-hours');
  list.clientWidth = 72;
  list.offsetLeft = 172;
  for (const [index, cell] of cells(root).entries()) {
    cell.offsetLeft = list.offsetLeft + index * 36;
    cell.offsetWidth = 36;
  }
  key(list, 'End');
  expect(list.scrollLeft).toBe(36);
  key(list, 'Home');
  expect(list.scrollLeft).toBe(0);
  timeline.destroy();
});
