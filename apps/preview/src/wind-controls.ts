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
  initial?: Partial<Pick<WindControlState, 'style' | 'visible' | 'height'>>;
}

export interface WindControls {
  readonly state: WindControlState;
  setStatus(status: WindStatus): void;
  setQuality?(overview: boolean): void;
  setState?(next: Partial<Pick<WindControlState, 'style' | 'visible' | 'height'>>): void;
  setUnits(units: WindUnits): void;
  destroy(): void;
}

const STYLES: readonly WindStyle[] = ['trails', 'barbs', 'hybrid'];
const STOPS: readonly number[] = WIND_HEIGHTS;
const STORAGE_KEY = 'av.wind-controls.v1', METRES_PER_FOOT = 0.3048;
const STYLE_LABELS: Record<WindStyle, string> = { trails: 'White trails', barbs: 'XC barbs', hybrid: 'Flow and sparse barbs' };
const STATUS_LABELS: Record<WindStatus, string> = { ready: '', loading: 'Loading wind', unavailable: 'Wind unavailable' };

const svg = (w: number, h: number, vw: number, vh: number, attrs: string, body: string) =>
  `<svg viewBox="0 0 ${vw} ${vh}" width="${w}" height="${h}" ${attrs}>${body}</svg>`;
const stroke = 'fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"';
const eyeBase = '<path d="M1 6s2.5-4 7-4 7 4 7 4-2.5 4-7 4-7-4-7-4Z"/>';
const ICONS = {
  trails: svg(20, 16, 20, 16, stroke, '<path d="M1 3.5c3-3 5 3 9 0s6 3 9 0"/><path d="M1 8c3-3 5 3 9 0s6 3 9 0"/><path d="M1 12.5c3-3 5 3 9 0s6 3 9 0"/>'),
  barbs: svg(20, 16, 20, 16, stroke, '<path d="M5 15 14 2"/><path d="m14 2 3 3"/><path d="m11.8 5 3 3"/><path d="m9.6 8 3 3"/>'),
  hybrid: svg(20, 16, 20, 16, stroke, '<path d="M1 4c3-3 5 3 9 0s6 3 9 0"/><path d="M1 11c3-3 5 3 9 0s6 3 9 0"/><path d="M11 10 16 3"/><path d="m16 3 2 2"/>'),
  eye: svg(14, 11, 16, 12, 'fill="none" stroke="currentColor" stroke-width="1.2"', `${eyeBase}<circle cx="8" cy="6" r="1.8"/>`),
  'eye-off': svg(14, 11, 16, 12, 'fill="none" stroke="currentColor" stroke-width="1.2"', `${eyeBase}<path d="m2 1 12 10"/>`),
  pause: svg(9, 11, 10, 12, 'fill="currentColor"', '<rect x="1" y="1" width="2.7" height="10" rx="0.6"/><rect x="6.3" y="1" width="2.7" height="10" rx="0.6"/>'),
  play: svg(9, 11, 10, 12, 'fill="currentColor"', '<path d="M1.5 1.2v9.6c0 .5.5.8.9.5l7.1-4.8a.6.6 0 0 0 0-1L2.4.7a.6.6 0 0 0-.9.5Z"/>'),
  chevron: svg(7, 5, 8, 5, 'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"', '<path d="m1 1 3 3 3-3"/>')
} as const;
type IconName = keyof typeof ICONS;

const attr = (n: Element, map: Record<string, string | boolean>) => { for (const [k, v] of Object.entries(map)) n.setAttribute(k, String(v)); };
const isStyle = (v: unknown): v is WindStyle => STYLES.includes(v as WindStyle);
const storedStop = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v > 0 ? STOPS.reduce((best, s) => Math.abs(s - v) < Math.abs(best - v) ? s : best) : undefined;
const stopValue = (m: number, u: WindUnits): number => u === 'imperial' ? Math.round(m / METRES_PER_FOOT) : m;
const stopLabel = (m: number, u: WindUnits): string => String(stopValue(m, u)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function readStored() {
  try {
    const p = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '') as Record<string, unknown>;
    if (!p || typeof p !== 'object') return null;
    return {
      style: isStyle(p.style) ? p.style : undefined,
      visible: typeof p.visible === 'boolean' ? p.visible : undefined,
      height: (p.height === 'surface' || p.height === 'lift' ? p.height : storedStop(p.height)) as WindHeight | undefined,
      fixedHeight: storedStop(p.fixedHeight)
    };
  } catch { return null; }
}

const persist = (s: WindControlState, fixedHeight: number) => {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ style: s.style, visible: s.visible, height: s.height, fixedHeight })); } catch { /* ignore */ }
};

export function createWindControls(parent: HTMLElement, options: WindControlsOptions): WindControls {
  const doc = parent.ownerDocument, stored = readStored(), init = options.initial;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
    const n = doc.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n;
  };
  const btn = (cls: string, text?: string) => { const b = el('button', cls, text); b.type = 'button'; return b; };
  const icon = (name: IconName, cls: string) => { const s = el('span', cls); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICONS[name]; return s; };

  let state: WindControlState = {
    style: init?.style ?? stored?.style ?? 'trails',
    visible: init?.visible ?? stored?.visible ?? true,
    paused: false,
    height: init?.height ?? stored?.height ?? 'surface'
  };
  let fixedHeight = typeof state.height === 'number' ? state.height : stored?.fixedHeight ?? STOPS[0];
  let units: WindUnits = 'metric', status: WindStatus = 'ready', overview = false, destroyed = false;

  const root = el('div', 'wind-controls'), menu = el('div', 'wind-controls-menu'), trigger = btn('wind-controls-trigger');
  attr(trigger, { 'aria-haspopup': 'dialog', 'aria-controls': 'wind-controls-popup' });
  const triggerGlyph = el('span', 'wind-controls-trigger-glyph'), triggerState = el('span', 'wind-controls-trigger-state');
  trigger.append(triggerGlyph, triggerState, icon('chevron', 'wind-controls-chevron'));

  const popup = el('div', 'wind-controls-popup');
  popup.hidden = true; popup.id = 'wind-controls-popup'; attr(popup, { role: 'dialog', 'aria-label': 'Wind display' });

  const styleGroup = el('div', 'wind-controls-styles');
  attr(styleGroup, { role: 'radiogroup', 'aria-label': 'Wind style' });
  const styleButtons = new Map<WindStyle, HTMLButtonElement>();
  for (const style of STYLES) {
    const choice = btn('wind-controls-style');
    attr(choice, { role: 'radio', 'aria-label': STYLE_LABELS[style] });
    choice.append(icon(style, 'wind-controls-style-icon'));
    choice.addEventListener('click', () => { selectStyle(style); closeMenu(true); });
    styleButtons.set(style, choice); styleGroup.append(choice);
  }

  const actionGroup = el('div', 'wind-controls-actions');
  attr(actionGroup, { role: 'group', 'aria-label': 'Wind actions' });
  const visibility = btn('wind-controls-action'), visibilityIcon = el('span', 'wind-controls-action-icon'), visibilityLabel = el('span', 'wind-controls-action-label');
  visibility.append(visibilityIcon, visibilityLabel);
  const pause = btn('wind-controls-action'), pauseIcon = el('span', 'wind-controls-action-icon'), pauseLabel = el('span', 'wind-controls-action-label');
  pause.append(pauseIcon, pauseLabel);
  actionGroup.append(visibility, pause); popup.append(styleGroup, actionGroup); menu.append(trigger, popup);

  const statusLine = el('p', 'wind-controls-status');
  attr(statusLine, { role: 'status', 'aria-live': 'polite' }); statusLine.hidden = true;

  const rail = el('div', 'wind-controls-rail'), lift = btn('wind-controls-lift');
  lift.append(el('span', 'wind-controls-lift-title', 'Top of lift'), el('span', 'wind-controls-lift-auto', 'auto'));
  const scale = el('div', 'wind-controls-scale'), unitLine = el('span', 'wind-controls-unit'), axis = el('div', 'wind-controls-axis');
  const ticks = STOPS.map((height, index) => {
    const tick = el('span', 'wind-controls-tick');
    tick.setAttribute('aria-hidden', 'true');
    tick.style.setProperty('--wind-controls-position', String(index / (STOPS.length - 1)));
    axis.append(tick);
    return { tick, height, labelled: [0, 2, 5, 9].includes(index) };
  });
  const range = Object.assign(el('input', 'wind-controls-range'), { type: 'range', min: '0', max: String(STOPS.length - 1), step: '1', value: String(STOPS.indexOf(fixedHeight)) });
  range.setAttribute('aria-label', 'Wind height');
  const readout = el('output', 'wind-controls-value'), surface = btn('wind-controls-surface', 'Surface');
  axis.append(range, readout); scale.append(unitLine, axis); rail.append(lift, scale, surface);
  root.append(menu, statusLine, rail); parent.appendChild(root);

  const snapshot = (): WindControlState => Object.freeze({ ...state });
  const notify = (commit: boolean): void => { if (commit) persist(state, fixedHeight); options.onChange(snapshot()); };

  function renderStatus(): void {
    attr(root, { 'data-status': status, 'data-quality': overview ? 'overview' : 'detail' });
    trigger.setAttribute('aria-busy', String(state.visible && status === 'loading'));
    const text = status !== 'ready' ? STATUS_LABELS[status] : overview ? 'Overview wind' : '';
    statusLine.textContent = text; statusLine.hidden = !state.visible || !text;
  }

  function renderHeight(): void {
    const numeric = typeof state.height === 'number', index = STOPS.indexOf(fixedHeight), unit = units === 'imperial' ? 'ft AGL' : 'm AGL';
    range.value = String(index);
    range.setAttribute('aria-valuetext', `${stopLabel(fixedHeight, units)} ${unit}`);
    unitLine.textContent = unit;
    for (const { tick, height, labelled } of ticks) {
      const v = stopValue(height, units);
      tick.textContent = labelled ? v >= 1000 ? `${Number((v / 1000).toFixed(1))}k` : String(v) : '';
    }
    readout.textContent = stopLabel(fixedHeight, units);
    readout.hidden = !numeric;
    readout.style.setProperty('--wind-controls-position', String(index / (STOPS.length - 1)));
    scale.setAttribute('data-height', numeric ? 'fixed' : String(state.height));
    for (const [b, cls, sel] of [[lift, 'wind-controls-lift', state.height === 'lift'], [surface, 'wind-controls-surface', state.height === 'surface']] as const) {
      b.setAttribute('aria-pressed', String(sel)); b.className = sel ? `${cls} is-selected` : cls;
    }
  }

  function render(): void {
    attr(root, { 'data-style': state.style, 'data-visible': state.visible, 'data-paused': state.paused });
    const pausedActive = state.visible && state.paused && state.style !== 'barbs';
    triggerGlyph.innerHTML = ICONS[state.style];
    triggerState.innerHTML = !state.visible ? ICONS['eye-off'] : pausedActive ? ICONS.pause : '';
    triggerState.hidden = !(!state.visible || pausedActive);
    attr(trigger, { 'aria-label': `Wind controls, ${STYLE_LABELS[state.style]}, ${!state.visible ? 'off' : pausedActive ? 'paused' : 'visible'}`, 'aria-expanded': !popup.hidden });
    for (const style of STYLES) {
      const choice = styleButtons.get(style)!, selected = style === state.style;
      choice.className = selected ? 'wind-controls-style is-selected' : 'wind-controls-style';
      choice.setAttribute('aria-checked', String(selected)); choice.tabIndex = selected ? 0 : -1;
    }
    visibilityIcon.innerHTML = state.visible ? ICONS.eye : ICONS['eye-off'];
    visibilityLabel.textContent = state.visible ? 'On' : 'Off';
    attr(visibility, { 'aria-label': state.visible ? 'Hide wind' : 'Show wind', 'aria-pressed': state.visible });
    pause.disabled = !(state.visible && state.style !== 'barbs');
    pauseIcon.innerHTML = state.paused ? ICONS.play : ICONS.pause;
    pauseLabel.textContent = state.paused ? 'Play' : 'Pause';
    attr(pause, { 'aria-label': state.paused ? 'Resume wind' : 'Pause wind', 'aria-pressed': state.paused });
    renderStatus(); renderHeight();
  }

  const selectStyle = (style: WindStyle) => { if (!destroyed) { state = { ...state, style, visible: true }; render(); notify(true); } };
  const selectHeight = (height: WindHeight) => { if (!destroyed && state.height !== height) { state = { ...state, height }; renderHeight(); notify(true); } };
  const setMenu = (open: boolean, focusTarget: boolean) => {
    if (destroyed || popup.hidden === !open) return;
    popup.hidden = !open; trigger.setAttribute('aria-expanded', String(open));
    if (focusTarget) (open ? styleButtons.get(state.style) : trigger)?.focus({ preventScroll: true });
  };
  const closeMenu = (restoreFocus: boolean) => setMenu(false, restoreFocus);

  trigger.addEventListener('click', event => { const kb = 'detail' in event && event.detail === 0; setMenu(popup.hidden, kb); });
  styleGroup.addEventListener('keydown', event => {
    const k = event.key, off = k === 'ArrowRight' || k === 'ArrowDown' ? 1 : k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 0;
    if (!off && k !== 'Home' && k !== 'End') return;
    event.preventDefault();
    const next = k === 'Home' ? 0 : k === 'End' ? STYLES.length - 1 : (STYLES.indexOf(state.style) + off + STYLES.length) % STYLES.length;
    selectStyle(STYLES[next]); styleButtons.get(STYLES[next])?.focus({ preventScroll: true });
  });
  visibility.addEventListener('click', () => { if (!destroyed) { state = { ...state, visible: !state.visible }; render(); notify(true); } });
  pause.addEventListener('click', () => { if (!destroyed && !pause.disabled) { state = { ...state, paused: !state.paused }; render(); notify(true); } });
  lift.addEventListener('click', () => selectHeight('lift'));
  surface.addEventListener('click', () => selectHeight('surface'));
  range.addEventListener('input', () => {
    const index = Number(range.value);
    if (!Number.isInteger(index) || index < 0 || index >= STOPS.length) return;
    fixedHeight = STOPS[index]; state = { ...state, height: fixedHeight }; renderHeight(); notify(false);
  });
  range.addEventListener('change', () => persist(state, fixedHeight));
  range.addEventListener('pointerup', () => selectHeight(fixedHeight));

  let focusPending = false, focusAtDismiss: Element | null = null;
  const onPointerUp = (): void => {
    if (!focusPending) return;
    focusPending = false;
    doc.removeEventListener('pointerup', onPointerUp, true); doc.removeEventListener('pointercancel', onPointerUp, true);
    if (!destroyed && (doc.activeElement === focusAtDismiss || doc.activeElement === doc.body || !doc.activeElement)) trigger.focus({ preventScroll: true });
  };
  const onOutside = (event: PointerEvent): void => {
    if (popup.hidden) return;
    const target = event.target as Element | null;
    if (target && menu.contains(target)) return;
    closeMenu(false);
    if (!target?.closest?.('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex],[contenteditable]:not([contenteditable="false"])') && !focusPending) {
      focusPending = true; focusAtDismiss = doc.activeElement;
      doc.addEventListener('pointerup', onPointerUp, true); doc.addEventListener('pointercancel', onPointerUp, true);
    }
  };
  const onKeydown = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !popup.hidden) { event.preventDefault(); closeMenu(true); } };
  doc.addEventListener('pointerdown', onOutside, true); doc.addEventListener('keydown', onKeydown);
  render();

  return {
    get state() { return snapshot(); },
    setStatus(next: WindStatus) { if (!destroyed && next in STATUS_LABELS) { status = next; renderStatus(); } },
    setQuality(next: boolean) { if (!destroyed && overview !== next) { overview = next; renderStatus(); } },
    setState(next) {
      if (destroyed) return;
      const height = next.height !== undefined ? (typeof next.height === 'number' ? storedStop(next.height) ?? fixedHeight : next.height) : state.height;
      if (typeof height === 'number') fixedHeight = height;
      state = { ...state, ...(next.style ? { style: next.style } : {}), ...(next.visible !== undefined ? { visible: next.visible } : {}), height };
      render();
    },
    setUnits(next: WindUnits) { units = next === 'imperial' ? 'imperial' : 'metric'; renderHeight(); },
    destroy() {
      if (destroyed) return;
      destroyed = true; focusPending = false;
      doc.removeEventListener('pointerdown', onOutside, true); doc.removeEventListener('pointerup', onPointerUp, true);
      doc.removeEventListener('pointercancel', onPointerUp, true); doc.removeEventListener('keydown', onKeydown);
      root.remove();
    }
  };
}
