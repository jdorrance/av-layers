import { WIND_HEIGHTS } from '@av/contracts/wind-data';
import './wind-controls.css';

export type WindStyle = 'trails' | 'barbs' | 'hybrid';
export type WindHeight = 'surface' | number | 'lift';
export type WindUnits = 'metric' | 'imperial';
export type WindStatus = 'ready' | 'loading' | 'unavailable';

export interface WindControlState {
  readonly style: WindStyle;
  readonly visible: boolean;
  readonly paused: boolean;
  readonly height: WindHeight;
}

export interface WindControlsOptions {
  onChange(state: WindControlState): void;
}

export interface WindControls {
  readonly state: WindControlState;
  setStatus(status: WindStatus): void;
  setUnits(units: WindUnits): void;
  destroy(): void;
}

const STYLES: readonly WindStyle[] = ['trails', 'barbs', 'hybrid'];
const STOPS: readonly number[] = WIND_HEIGHTS;
const DEFAULT_FIXED_HEIGHT = STOPS[0];
const STORAGE_KEY = 'av.wind-controls.v1';
const METRES_PER_FOOT = 0.3048;

const STYLE_LABELS: Record<WindStyle, string> = {
  trails: 'White trails',
  barbs: 'XC barbs',
  hybrid: 'Flow and sparse barbs'
};

const STATUS_LABELS: Record<WindStatus, string> = {
  ready: '',
  loading: 'Loading wind',
  unavailable: 'Wind unavailable'
};

type IconName = WindStyle | 'eye' | 'eye-off' | 'pause' | 'play' | 'chevron';

const ICONS: Record<IconName, string> = {
  trails: '<svg viewBox="0 0 20 16" width="20" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"><path d="M1 3.5c3-3 5 3 9 0s6 3 9 0"/><path d="M1 8c3-3 5 3 9 0s6 3 9 0"/><path d="M1 12.5c3-3 5 3 9 0s6 3 9 0"/></svg>',
  barbs: '<svg viewBox="0 0 20 16" width="20" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"><path d="M5 15 14 2"/><path d="m14 2 3 3"/><path d="m11.8 5 3 3"/><path d="m9.6 8 3 3"/></svg>',
  hybrid: '<svg viewBox="0 0 20 16" width="20" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"><path d="M1 4c3-3 5 3 9 0s6 3 9 0"/><path d="M1 11c3-3 5 3 9 0s6 3 9 0"/><path d="M11 10 16 3"/><path d="m16 3 2 2"/></svg>',
  eye: '<svg viewBox="0 0 16 12" width="14" height="11" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M1 6s2.5-4 7-4 7 4 7 4-2.5 4-7 4-7-4-7-4Z"/><circle cx="8" cy="6" r="1.8"/></svg>',
  'eye-off': '<svg viewBox="0 0 16 12" width="14" height="11" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M1 6s2.5-4 7-4 7 4 7 4-2.5 4-7 4-7-4-7-4Z"/><path d="m2 1 12 10"/></svg>',
  pause: '<svg viewBox="0 0 10 12" width="9" height="11" fill="currentColor"><rect x="1" y="1" width="2.7" height="10" rx="0.6"/><rect x="6.3" y="1" width="2.7" height="10" rx="0.6"/></svg>',
  play: '<svg viewBox="0 0 10 12" width="9" height="11" fill="currentColor"><path d="M1.5 1.2v9.6c0 .5.5.8.9.5l7.1-4.8a.6.6 0 0 0 0-1L2.4.7a.6.6 0 0 0-.9.5Z"/></svg>',
  chevron: '<svg viewBox="0 0 8 5" width="7" height="5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="m1 1 3 3 3-3"/></svg>'
};

interface StoredState {
  style?: WindStyle;
  visible?: boolean;
  height?: WindHeight;
  fixedHeight?: number;
}

function icon(name: IconName, className: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = ICONS[name];
  return span;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function button(className: string): HTMLButtonElement {
  const node = element('button', className);
  node.type = 'button';
  return node;
}

function isStyle(value: unknown): value is WindStyle {
  return STYLES.includes(value as WindStyle);
}

function storedStop(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return;
  return STOPS.reduce((nearest, stop) => Math.abs(stop - value) < Math.abs(nearest - value) ? stop : nearest);
}

function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function stopValue(meters: number, units: WindUnits): number {
  return units === 'imperial' ? Math.round(meters / METRES_PER_FOOT) : meters;
}

function stopLabel(meters: number, units: WindUnits): string {
  return grouped(stopValue(meters, units));
}

function valueText(meters: number, units: WindUnits): string {
  return `${stopLabel(meters, units)} ${units === 'imperial' ? 'ft' : 'm'} AGL`;
}

function readStored(): StoredState | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Record<string, unknown>;
    const stored: StoredState = {};
    if (isStyle(value.style)) stored.style = value.style;
    if (typeof value.visible === 'boolean') stored.visible = value.visible;
    stored.height = value.height === 'surface' || value.height === 'lift' ? value.height : storedStop(value.height);
    stored.fixedHeight = storedStop(value.fixedHeight);
    return stored;
  } catch {
    return null;
  }
}

function persist(state: WindControlState, fixedHeight: number): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({
      style: state.style,
      visible: state.visible,
      height: state.height,
      fixedHeight
    }));
  } catch {
    return;
  }
}

export function createWindControls(parent: HTMLElement, options: WindControlsOptions): WindControls {
  const doc = parent.ownerDocument;
  const stored = readStored();
  let state: WindControlState = {
    style: stored?.style ?? 'trails',
    visible: stored?.visible ?? true,
    paused: false,
    height: stored?.height ?? 'surface'
  };
  let fixedHeight = typeof state.height === 'number' ? state.height : stored?.fixedHeight ?? DEFAULT_FIXED_HEIGHT;
  let units: WindUnits = 'metric';
  let status: WindStatus = 'ready';
  let destroyed = false;

  const root = element('div', 'wind-controls');
  root.setAttribute('data-style', state.style);
  root.setAttribute('data-visible', String(state.visible));
  root.setAttribute('data-paused', String(state.paused));
  root.setAttribute('data-status', status);

  const menu = element('div', 'wind-controls-menu');
  const trigger = button('wind-controls-trigger');
  trigger.setAttribute('aria-haspopup', 'dialog');
  const triggerGlyph = element('span', 'wind-controls-trigger-glyph');
  const triggerState = element('span', 'wind-controls-trigger-state');
  const triggerChevron = icon('chevron', 'wind-controls-chevron');
  trigger.append(triggerGlyph, triggerState, triggerChevron);

  const popup = element('div', 'wind-controls-popup');
  popup.hidden = true;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Wind display');
  trigger.setAttribute('aria-controls', 'wind-controls-popup');
  popup.id = 'wind-controls-popup';

  const styleGroup = element('div', 'wind-controls-styles');
  styleGroup.setAttribute('role', 'radiogroup');
  styleGroup.setAttribute('aria-label', 'Wind style');
  const styleButtons = new Map<WindStyle, HTMLButtonElement>();
  for (const style of STYLES) {
    const choice = button('wind-controls-style');
    choice.setAttribute('role', 'radio');
    choice.setAttribute('aria-label', STYLE_LABELS[style]);
    choice.append(icon(style, 'wind-controls-style-icon'));
    choice.addEventListener('click', () => {
      selectStyle(style);
      closeMenu(true);
    });
    styleButtons.set(style, choice);
    styleGroup.append(choice);
  }

  const actionGroup = element('div', 'wind-controls-actions');
  actionGroup.setAttribute('role', 'group');
  actionGroup.setAttribute('aria-label', 'Wind actions');
  const visibility = button('wind-controls-action');
  const visibilityIcon = element('span', 'wind-controls-action-icon');
  const visibilityLabel = element('span', 'wind-controls-action-label');
  visibility.append(visibilityIcon, visibilityLabel);
  const pause = button('wind-controls-action');
  const pauseIcon = element('span', 'wind-controls-action-icon');
  const pauseLabel = element('span', 'wind-controls-action-label');
  pause.append(pauseIcon, pauseLabel);
  actionGroup.append(visibility, pause);

  popup.append(styleGroup, actionGroup);
  menu.append(trigger, popup);

  const statusLine = element('p', 'wind-controls-status');
  statusLine.setAttribute('role', 'status');
  statusLine.setAttribute('aria-live', 'polite');
  statusLine.hidden = true;

  const rail = element('div', 'wind-controls-rail');
  const lift = button('wind-controls-lift');
  const liftTitle = element('span', 'wind-controls-lift-title');
  liftTitle.textContent = 'Top of lift';
  const liftAuto = element('span', 'wind-controls-lift-auto');
  liftAuto.textContent = 'auto';
  lift.append(liftTitle, liftAuto);

  const scale = element('div', 'wind-controls-scale');
  const unitLine = element('span', 'wind-controls-unit');
  const axis = element('div', 'wind-controls-axis');
  const ticks = STOPS.map((height, index) => {
    const tick = element('span', 'wind-controls-tick');
    tick.setAttribute('aria-hidden', 'true');
    tick.style.setProperty('--wind-controls-position', String(index / (STOPS.length - 1)));
    axis.append(tick);
    return { tick, height, labelled: [0, 2, 5, 9].includes(index) };
  });
  const range = element('input', 'wind-controls-range');
  range.type = 'range';
  range.min = '0';
  range.max = String(STOPS.length - 1);
  range.step = '1';
  range.value = String(STOPS.indexOf(fixedHeight));
  range.setAttribute('aria-label', 'Wind height');
  const readout = element('output', 'wind-controls-value');
  axis.append(range, readout);
  scale.append(unitLine, axis);

  const surface = button('wind-controls-surface');
  surface.textContent = 'Surface';
  rail.append(lift, scale, surface);

  root.append(menu, statusLine, rail);
  parent.appendChild(root);

  function snapshot(): WindControlState {
    return Object.freeze({ ...state });
  }

  function notify(commit: boolean): void {
    if (commit) persist(state, fixedHeight);
    options.onChange(snapshot());
  }

  function renderHeight(): void {
    const numeric = typeof state.height === 'number';
    const index = STOPS.indexOf(fixedHeight);
    range.value = String(index);
    range.setAttribute('aria-valuetext', valueText(fixedHeight, units));
    unitLine.textContent = units === 'imperial' ? 'ft AGL' : 'm AGL';
    for (const { tick, height, labelled } of ticks) {
      const value = stopValue(height, units);
      tick.textContent = labelled ? value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value) : '';
    }
    readout.textContent = stopLabel(fixedHeight, units);
    readout.hidden = !numeric;
    readout.style.setProperty('--wind-controls-position', String(index / (STOPS.length - 1)));
    scale.setAttribute('data-height', numeric ? 'fixed' : String(state.height));
    lift.setAttribute('aria-pressed', String(state.height === 'lift'));
    lift.className = state.height === 'lift' ? 'wind-controls-lift is-selected' : 'wind-controls-lift';
    surface.setAttribute('aria-pressed', String(state.height === 'surface'));
    surface.className = state.height === 'surface' ? 'wind-controls-surface is-selected' : 'wind-controls-surface';
  }

  function render(): void {
    root.setAttribute('data-style', state.style);
    root.setAttribute('data-visible', String(state.visible));
    root.setAttribute('data-paused', String(state.paused));
    const pausedActive = state.visible && state.paused && state.style !== 'barbs';
    triggerGlyph.innerHTML = ICONS[state.style];
    triggerState.innerHTML = !state.visible ? ICONS['eye-off'] : pausedActive ? ICONS.pause : '';
    triggerState.hidden = !(!state.visible || pausedActive);
    const statusText = !state.visible ? 'off' : pausedActive ? 'paused' : 'visible';
    trigger.setAttribute('aria-label', `Wind controls, ${STYLE_LABELS[state.style]}, ${statusText}`);
    trigger.setAttribute('aria-expanded', String(!popup.hidden));

    for (const style of STYLES) {
      const choice = styleButtons.get(style)!;
      const selected = style === state.style;
      choice.className = selected ? 'wind-controls-style is-selected' : 'wind-controls-style';
      choice.setAttribute('aria-checked', String(selected));
      choice.tabIndex = selected ? 0 : -1;
    }

    visibilityIcon.innerHTML = state.visible ? ICONS.eye : ICONS['eye-off'];
    visibilityLabel.textContent = state.visible ? 'On' : 'Off';
    visibility.setAttribute('aria-label', state.visible ? 'Hide wind' : 'Show wind');
    visibility.setAttribute('aria-pressed', String(state.visible));

    const pausedAvailable = state.visible && state.style !== 'barbs';
    pause.disabled = !pausedAvailable;
    pauseIcon.innerHTML = state.paused ? ICONS.play : ICONS.pause;
    pauseLabel.textContent = state.paused ? 'Play' : 'Pause';
    pause.setAttribute('aria-label', state.paused ? 'Resume wind' : 'Pause wind');
    pause.setAttribute('aria-pressed', String(state.paused));

    renderStatus();
    renderHeight();
  }

  function renderStatus(): void {
    root.setAttribute('data-status', status);
    trigger.setAttribute('aria-busy', String(state.visible && status === 'loading'));
    statusLine.textContent = STATUS_LABELS[status];
    statusLine.hidden = !state.visible || status === 'ready';
  }

  function selectStyle(style: WindStyle): void {
    if (destroyed) return;
    state = { ...state, style, visible: true };
    render();
    notify(true);
  }

  function selectHeight(height: WindHeight): void {
    if (destroyed || state.height === height) return;
    state = { ...state, height };
    renderHeight();
    notify(true);
  }

  function openMenu(focusFirst: boolean): void {
    if (destroyed || !popup.hidden) return;
    popup.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    if (focusFirst) styleButtons.get(state.style)?.focus({ preventScroll: true });
  }

  function closeMenu(restoreFocus: boolean): void {
    if (destroyed || popup.hidden) return;
    popup.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  trigger.addEventListener('click', event => {
    const keyboard = 'detail' in event && event.detail === 0;
    if (popup.hidden) openMenu(keyboard);
    else closeMenu(keyboard);
  });

  styleGroup.addEventListener('keydown', event => {
    const key = event.key;
    const offset = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
    if (!offset && key !== 'Home' && key !== 'End') return;
    event.preventDefault();
    const current = STYLES.indexOf(state.style);
    const next = key === 'Home' ? 0 : key === 'End' ? STYLES.length - 1 : (current + offset + STYLES.length) % STYLES.length;
    selectStyle(STYLES[next]);
    styleButtons.get(STYLES[next])?.focus({ preventScroll: true });
  });

  visibility.addEventListener('click', () => {
    if (destroyed) return;
    state = { ...state, visible: !state.visible };
    render();
    notify(true);
  });

  pause.addEventListener('click', () => {
    if (destroyed || pause.disabled) return;
    state = { ...state, paused: !state.paused };
    render();
    notify(true);
  });

  lift.addEventListener('click', () => selectHeight('lift'));
  surface.addEventListener('click', () => selectHeight('surface'));

  range.addEventListener('input', () => {
    const index = Number(range.value);
    if (!Number.isInteger(index) || index < 0 || index >= STOPS.length) return;
    fixedHeight = STOPS[index];
    state = { ...state, height: fixedHeight };
    renderHeight();
    notify(false);
  });
  range.addEventListener('change', () => persist(state, fixedHeight));
  range.addEventListener('pointerup', () => selectHeight(fixedHeight));

  const onOutside = (event: PointerEvent): void => {
    if (popup.hidden) return;
    const target = event.target as Element | null;
    if (target && menu.contains(target)) return;
    const focusable = target?.closest?.('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex], [contenteditable]:not([contenteditable="false"])');
    closeMenu(false);
    if (!focusable) deferFocus();
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || popup.hidden) return;
    event.preventDefault();
    closeMenu(true);
  };
  const onPointerUp = (): void => finishFocus();
  let focusPending = false;
  let focusAtDismiss: Element | null = null;

  function deferFocus(): void {
    if (focusPending) return;
    focusPending = true;
    focusAtDismiss = doc.activeElement;
    doc.addEventListener('pointerup', onPointerUp, true);
    doc.addEventListener('pointercancel', onPointerUp, true);
  }

  function finishFocus(): void {
    if (!focusPending) return;
    focusPending = false;
    doc.removeEventListener('pointerup', onPointerUp, true);
    doc.removeEventListener('pointercancel', onPointerUp, true);
    if (!destroyed && (doc.activeElement === focusAtDismiss || doc.activeElement === doc.body || !doc.activeElement)) trigger.focus({ preventScroll: true });
  }

  doc.addEventListener('pointerdown', onOutside, true);
  doc.addEventListener('keydown', onKeydown);

  render();

  return {
    get state() {
      return snapshot();
    },
    setStatus(next: WindStatus) {
      if (destroyed || !(next in STATUS_LABELS)) return;
      status = next;
      renderStatus();
    },
    setUnits(next: WindUnits) {
      units = next === 'imperial' ? 'imperial' : 'metric';
      renderHeight();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      focusPending = false;
      doc.removeEventListener('pointerdown', onOutside, true);
      doc.removeEventListener('pointerup', onPointerUp, true);
      doc.removeEventListener('pointercancel', onPointerUp, true);
      doc.removeEventListener('keydown', onKeydown);
      root.remove();
    }
  };
}
