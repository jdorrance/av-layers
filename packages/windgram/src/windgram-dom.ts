import { formatMapLiftCell, formatPointMapLift } from '@av/client';
import { renderWindgramSvg } from './windgram-chart.ts';
import { clamp, formatQuantity, svgNumber as fmt } from './windgram-format.ts';
import { formatWindgramReading } from './windgram-readout.ts';
import { heightToY, yToHeight } from './windgram-scale.ts';
import { readWindgram } from './windgram-inspector.ts';
import { hourX, visibleWindgramHourIndices } from './windgram-time-axis.ts';
import type { WindgramView } from './windgram-view.ts';

export interface WindgramMountOptions {
  /** Unique among charts in the host document. */
  idPrefix: string;
  readout?: HTMLElement | null;
  onSelectHour?: (validAt: string) => void;
  onStepHour?: (delta: -1 | 1) => void;
  selectedValidAt?: string | null;
  /** Defaults to the published lift ceiling; height mode follows pointer altitude. */
  inspectionMode?: 'lift' | 'height';
}

type WindgramInspector = (() => void) & {
  /** Show an hour, or clear inspection with null. */
  select(hourIndex: number | null): void;
};
/** Inspect the published lift ceiling, or opt into physical height inspection. */
function mountWindgramInspector(
  host: HTMLElement,
  readout: HTMLElement | null,
  view: WindgramView,
  onSelectHour?: (validAt: string) => void,
  selectedHourIndex?: () => number,
  options: { mode?: 'lift' | 'height'; onStepHour?: (delta: -1 | 1) => void } = {},
): WindgramInspector {
  const system = view.unitSystem;
  const svg = host.querySelector?.<SVGSVGElement>('svg.windgram') ?? null;
  const visibleHours = visibleWindgramHourIndices(view, 0);
  if (!visibleHours.length) return Object.assign(() => {}, { select: (_index: number | null) => {} });
  const heightMode = options.mode === 'height';
  const ownerDocument = host.ownerDocument ?? (typeof document !== 'undefined' ? document : undefined);
  const cursor = svg?.querySelector<SVGGElement>('[data-windgram-cursor]') ?? null;
  const vertical = svg?.querySelector<SVGLineElement>('[data-cursor-vertical]') ?? null;
  const horizontal = svg?.querySelector<SVGLineElement>('[data-cursor-horizontal]') ?? null;
  const point = svg?.querySelector<SVGCircleElement>('[data-cursor-point]') ?? null;
  const callout = svg?.querySelector<SVGGElement>('[data-cursor-readout]') ?? null;
  const calloutBack = svg?.querySelector<SVGRectElement>('[data-cursor-back]') ?? null;
  const aglLabel = svg?.querySelector<SVGTextElement>('[data-cursor-agl]') ?? null;
  const mslLabel = svg?.querySelector<SVGTextElement>('[data-cursor-msl]') ?? null;
  const originalAttributes = new Map(['tabindex', 'role', 'aria-label', 'aria-describedby'].map((key) => [key, host.getAttribute?.(key) ?? null]));
  const readoutAttributes = new Map(['role', 'aria-live', 'aria-atomic'].map((key) => [key, readout?.getAttribute?.(key) ?? null]));
  const interactionLabel =
    heightMode ? 'Interactive windgram. Hover or tap to inspect height. Left and right arrows change hour; up and down change height. Escape clears the selection.'
      : 'Interactive windgram. Hover or tap an hour for lift top AGL. Left and right arrows change hour. Escape clears the selection.';
  host.tabIndex = 0;
  host.setAttribute?.('role', 'group');
  host.setAttribute?.('aria-label', interactionLabel);
  if (readout?.id) host.setAttribute?.('aria-describedby', readout.id);
  readout?.setAttribute?.('role', 'status');
  readout?.setAttribute?.('aria-live', 'polite');
  readout?.setAttribute?.('aria-atomic', 'true');
  const instructions = `${heightMode ? 'Hover to inspect height' : 'Hover for lift top'} · click or tap to pin · left/right arrows change hour${heightMode ? ' · up/down changes height' : ''} · Escape clears`;
  const timeFormat = new Intl.DateTimeFormat('en-US', {
    timeZone: view.timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  let activeHour: number | null = null;
  let activeHeightM: number | null = null;
  let pinned = false;
  let pointerStart: { x: number; y: number; id: number; moved: boolean } | null = null;
  let lastText = readout?.textContent ?? '';
  let disposed = false;
  const writeReadout = (text: string, title?: string) => {
    if (text === lastText) return;
    if (readout && title && ownerDocument && typeof ownerDocument.createTextNode === 'function') {
      const strong = ownerDocument.createElement('strong');
      strong.textContent = title;
      readout.replaceChildren(strong, ownerDocument.createTextNode(text.slice(title.length)));
    } else if (readout) {
      readout.textContent = text;
    } else {
      host.setAttribute?.('aria-label', text === instructions ? interactionLabel : `${interactionLabel} ${text}`);
    }
    lastText = text;
  };
  const clear = () => {
    pinned = false;
    activeHour = null;
    cursor?.setAttribute('visibility', 'hidden');
    writeReadout(instructions);
  };

  const update = (hourIndex: number, keyboard = false, inspectedHeightM?: number) => {
    const hour = view.hours[hourIndex];
    const lift = view.sourceHours[hourIndex].mapLift;
    activeHour = hourIndex;
    const x = hour.x;
    if (keyboard) {
      onSelectHour?.(hour.validAt);
      if (disposed) return;
      // Reveal the selected hour even when its lift ceiling is unavailable.
      const matrix = svg?.getScreenCTM?.() ?? null;
      if (matrix) {
        const screen = new DOMPoint(x, view.top).matrixTransform(matrix);
        const rect = host.getBoundingClientRect();
        const clearance = view.compact ? view.left + 16 : 32;
        if (screen.x < rect.left + clearance) host.scrollLeft -= rect.left + clearance - screen.x;
        else if (screen.x > rect.right - 32) host.scrollLeft += screen.x - rect.right + 32;
      }
    }
    const when = timeFormat.format(new Date(hour.validAt));
    const heightM = heightMode ? clamp(inspectedHeightM ?? activeHeightM ?? hour.usableLiftTopM ?? view.floorM + 100, view.floorM, view.topM) : hour.usableLiftTopM;
    if (heightMode) activeHeightM = heightM;
    if (heightM === null || heightM < view.floorM || heightM > view.topM) {
      cursor?.setAttribute('visibility', 'hidden');
      const reading = readWindgram(view, hourIndex, view.floorM);
      writeReadout(`${when} · ${formatPointMapLift(lift, system)} · ${formatWindgramReading(view, reading, 'surface').join(' · ')}`);
      return;
    }
    const reading = readWindgram(view, hourIndex, heightM);
    const y = heightToY(view, heightM);
    const attr = (element: Element | null, values: Record<string, number>) => {
      for (const [key, value] of Object.entries(values)) element?.setAttribute(key, String(fmt(value)));
    };
    attr(vertical, { x1: x, x2: x, y1: view.top, y2: view.bottom });
    attr(horizontal, { x1: view.left, x2: view.left + view.plotWidth, y1: y, y2: y });
    attr(point, { cx: x, cy: y });
    cursor?.setAttribute('visibility', 'visible');
    const aglText = heightMode
      ? `${formatQuantity(reading.heightAglM, 'elevation', undefined, system)} ${reading.heightAglReference === 'model' ? 'model AGL' : reading.heightAglReference === 'terrain' ? 'surface AGL' : 'AGL'}`
      : `${formatMapLiftCell(lift.agl, system)} AGL`;
    const mslText = `${heightMode ? formatQuantity(reading.heightM, 'elevation', undefined, system) : formatMapLiftCell(lift.msl, system)} MSL`;
    if (aglLabel) aglLabel.textContent = aglText;
    if (mslLabel) mslLabel.textContent = mslText;
    // Keep the card visible while the page or the wide desktop chart is scrolled.
    let visibleLeft = view.left, visibleRight = view.left + view.plotWidth;
    let visibleTop = view.top, visibleBottom = view.bottom;
    const matrix = svg?.getScreenCTM?.() ?? null;
    if (matrix) {
      const bounds = host.getBoundingClientRect(), inverse = matrix.inverse();
      const viewport = ownerDocument?.defaultView;
      const topLeft = new DOMPoint(Math.max(0, bounds.left), Math.max(0, bounds.top)).matrixTransform(inverse);
      const bottomRight = new DOMPoint(
        Math.min(viewport?.innerWidth ?? Infinity, bounds.right),
        Math.min(viewport?.innerHeight ?? Infinity, bounds.bottom),
      ).matrixTransform(inverse);
      visibleLeft = Math.max(visibleLeft, topLeft.x);
      visibleRight = Math.min(visibleRight, bottomRight.x);
      visibleTop = Math.max(visibleTop, topLeft.y);
      visibleBottom = Math.min(visibleBottom, bottomRight.y);
    }
    const padding = 4, calloutHeight = 47;
    const labelWidth =
      Math.max(aglLabel?.getComputedTextLength?.() ?? aglText.length * 9, mslLabel?.getComputedTextLength?.() ?? mslText.length * 5.5) + 20;
    const calloutWidth = Math.min(labelWidth, Math.max(0, visibleRight - visibleLeft - padding * 2));
    const calloutX = Math.max(
      visibleLeft + padding,
      Math.min(
        x + 12 + calloutWidth <= visibleRight - padding ? x + 12 : x - 12 - calloutWidth,
        visibleRight - calloutWidth - padding,
      ),
    );
    const calloutY = Math.max(
      visibleTop + padding,
      Math.min(
        y - calloutHeight - 12 >= visibleTop + padding ? y - calloutHeight - 12 : y + 12,
        visibleBottom - calloutHeight - padding,
      ),
    );
    callout?.setAttribute('transform', `translate(${fmt(calloutX)} ${fmt(calloutY)})`);
    attr(calloutBack, { width: calloutWidth });
    const title = `${when} · ${heightMode ? 'Inspected height' : 'Map usable lift'} · ${aglText} · ${mslText}`;
    const values = formatWindgramReading(view, reading, 'height');
    writeReadout(`${title} · ${values.join(' · ')}`, title);
  };
  const location = (event: PointerEvent) => {
    const matrix = svg?.getScreenCTM?.() ?? null;
    if (!matrix) return null;
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    if (position.x < view.left || position.x > view.left + view.plotWidth || position.y < view.top || position.y > view.bottom) return null;
    const dataLeft = view.hours[0].x - view.columnWidth / 2;
    const dataRight = view.hours.at(-1)!.x + view.columnWidth / 2;
    if (position.x < dataLeft || position.x > dataRight) return null;
    const hourIndex = visibleHours.reduce((best, index) =>
      Math.abs(view.hours[index].x - position.x) < Math.abs(view.hours[best].x - position.x) ? index : best);
    return { hourIndex, heightM: yToHeight(view, position.y) };
  };
  const endHover = () => {
    if (heightMode) cursor?.setAttribute('visibility', 'hidden');
    else if (activeHour !== null) {
      const selected = selectedHourIndex?.() ?? view.selectedHourIndex;
      if (!visibleHours.includes(selected)) clear();
      else if (selected !== activeHour) update(selected);
    }
  };
  const onMove = (event: PointerEvent) => {
    if (pointerStart?.id === event.pointerId && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 10) pointerStart.moved = true;
    if (event.pointerType !== 'mouse' || pinned) return;
    const p = location(event);
    if (p) update(p.hourIndex, false, p.heightM);
    else endHover();
  };
  const onDown = (event: PointerEvent) => {
    if (event.isPrimary !== false) pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false };
  };
  const onUp = (event: PointerEvent) => {
    const start = pointerStart;
    pointerStart = null;
    if (!start || start.moved || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) return;
    const p = location(event);
    if (!p) return;
    pinned = true;
    update(p.hourIndex, false, p.heightM);
    onSelectHour?.(view.hours[p.hourIndex].validAt);
  };
  const onCancel = () => {
    pointerStart = null;
  };
  const onLeave = () => {
    if (!pinned) endHover();
  };
  const onBlur = () => {
    if (!pinned) return;
    pinned = false;
    if (heightMode) clear();
    else endHover();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      clear();
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', ...(heightMode ? ['ArrowUp', 'ArrowDown'] : [])].includes(event.key)) return;
    event.preventDefault();
    pinned = true;
    let hourIndex = Math.max(0, selectedHourIndex?.() ?? activeHour ?? view.selectedHourIndex);
    if (event.key === 'ArrowLeft') {
      let previous = visibleHours.length - 1;
      while (previous >= 0 && visibleHours[previous] >= hourIndex) previous--;
      if (previous < 0 && options.onStepHour) { options.onStepHour(-1); return; }
      hourIndex = visibleHours[Math.max(0, previous)];
    }
    if (event.key === 'ArrowRight') {
      const next = visibleHours.find(index => index > hourIndex);
      if (next === undefined && options.onStepHour) { options.onStepHour(1); return; }
      hourIndex = next ?? visibleHours.at(-1)!;
    }
    if (event.key === 'Home') hourIndex = visibleHours[0];
    if (event.key === 'End') hourIndex = visibleHours.at(-1)!;
    if (heightMode && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      hourIndex = visibleHours.find(index => index >= hourIndex) ?? visibleHours.at(-1)!;
      activeHeightM = clamp((activeHeightM ?? view.hours[hourIndex].usableLiftTopM ?? view.floorM + 100) + (event.key === 'ArrowUp' ? 100 : -100), view.floorM, view.topM);
    }
    update(hourIndex, true);
  };
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerdown', onDown);
  host.addEventListener('pointerup', onUp);
  host.addEventListener('pointercancel', onCancel);
  host.addEventListener('pointerleave', onLeave);
  host.addEventListener('keydown', onKey);
  host.addEventListener('blur', onBlur);
  return Object.assign(() => {
    if (disposed) return;
    disposed = true;
    host.removeEventListener?.('pointermove', onMove);
    host.removeEventListener?.('pointerdown', onDown);
    host.removeEventListener?.('pointerup', onUp);
    host.removeEventListener?.('pointercancel', onCancel);
    host.removeEventListener?.('pointerleave', onLeave);
    host.removeEventListener?.('keydown', onKey);
    host.removeEventListener?.('blur', onBlur);
    for (const [name, value] of originalAttributes) {
      if (value === null) host.removeAttribute?.(name);
      else host.setAttribute?.(name, value);
    }
    for (const [name, value] of readoutAttributes) {
      if (value === null) readout?.removeAttribute?.(name);
      else readout?.setAttribute?.(name, value);
    }
    cursor?.setAttribute('visibility', 'hidden');
  }, { select: (index: number | null) => {
    if (disposed) return;
    if (index === null || !visibleHours.includes(index)) clear();
    else update(index);
  } });
}


/** Owns one SVG host; callers own profiles, layout, routing and persisted state. */
export function mountWindgram(host: HTMLElement, options: WindgramMountOptions & { view: WindgramView }) {
  let clearInspector: WindgramInspector | null = null;
  let disposed = false;
  let view = options.view;
  let mode: 'lift' | 'height' | undefined = options.inspectionMode;
  let selectedValidAt = options.selectedValidAt === undefined ? view.hours[view.selectedHourIndex]?.validAt ?? null : options.selectedValidAt;
  const select = (validAt: string | null) => {
    if (disposed) return;
    selectedValidAt = validAt;
    const index = validAt ? view.hours.findIndex(hour => hour.validAt === validAt && hour.x >= view.left && hour.x <= view.left + view.plotWidth) : -1;
    clearInspector?.select(index >= 0 ? index : null);
    const cursor = host.querySelector?.<SVGRectElement>('[data-selected-hour]') ?? null;
    if (cursor) {
      cursor.setAttribute('visibility', index >= 0 ? 'visible' : 'hidden');
      if (index >= 0) {
        const left = Math.max(view.left, hourX(view.hours, index - 0.5, view.columnWidth));
        const right = Math.min(view.left + view.plotWidth, hourX(view.hours, index + 0.5, view.columnWidth));
        cursor.setAttribute('x', String(left));
        cursor.setAttribute('width', String(right - left));
      }
    }
  };
  const bindInspector = () => {
    clearInspector?.();
    clearInspector = mountWindgramInspector(host, options.readout ?? null, view, validAt => {
      select(validAt);
      options.onSelectHour?.(validAt);
    }, () => view.hours.findIndex(hour => hour.validAt === selectedValidAt), { mode, onStepHour: options.onStepHour });
    select(selectedValidAt);
  };
  const update = (next: WindgramView) => {
    if (disposed) return;
    clearInspector?.();
    clearInspector = null;
    view = next;
    host.innerHTML = renderWindgramSvg(view, { idPrefix: options.idPrefix });
    const svg = host.querySelector?.<SVGSVGElement>('svg.windgram') ?? null;
    const ownerDocument = host.ownerDocument ?? (typeof document !== 'undefined' ? document : undefined);
    if (svg && ownerDocument && typeof ownerDocument.createElementNS === 'function') {
      const selected = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect');
      for (const [key, value] of Object.entries({
        y: view.top, height: view.plotHeight, width: view.columnWidth,
        fill: '#237e81', 'fill-opacity': 0.04, stroke: '#237e81', 'stroke-width': 1,
        'pointer-events': 'none', 'data-selected-hour': '',
      })) selected.setAttribute(key, String(value));
      svg.insertBefore?.(selected, svg.querySelector?.('[data-windgram-cursor]') ?? null);
    }
    bindInspector();
  };
  update(view);
  return {
    update, select,
    setMode(nextMode: 'lift' | 'height') {
      if (disposed || mode === nextMode) return;
      mode = nextMode;
      bindInspector();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInspector?.();
      clearInspector = null;
      host.replaceChildren();
    },
  };
}
