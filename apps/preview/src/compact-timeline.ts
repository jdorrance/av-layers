import './compact-timeline.css';

export interface TimelineFrame { readonly id: string; readonly validTime: string }
export interface CompactTimelineOptions { onSelect(index: number): void; timeZone?: string; zoneLabel?: string; onToggleTimeZone?: () => void }
export interface CompactTimeline { update(frames: readonly TimelineFrame[], selectedFrame: string | null, disabled?: boolean): void; setTimeZone?(timeZone: string, zoneLabel?: string): void; destroy(): void }

interface LocalTime { day: string; hour: number; minute: number }
interface DayGroup { day: string; indices: number[] }

const PLAYBACK_INTERVAL_MS = 700, DEFAULT_TIME_ZONE = 'UTC';
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function localTimeFromMs(ms: number, timeZone: string): LocalTime | null {
  if (!Number.isFinite(ms)) return null;
  let fmt = partsFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    partsFormatters.set(timeZone, fmt);
  }
  const v: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) if (p.type !== 'literal') v[p.type] = p.value;
  const hour = Number(v.hour) % 24, minute = Number(v.minute);
  return v.year && v.month && v.day && Number.isFinite(hour) && Number.isFinite(minute) ? { day: `${v.year}-${v.month}-${v.day}`, hour, minute } : null;
}

export const localDayKey = (validTime: string, timeZone: string): string | null => localTimeFromMs(Date.parse(validTime), timeZone)?.day ?? null;
export const localTimeParts = (validTime: string, timeZone: string): LocalTime | null => localTimeFromMs(Date.parse(validTime), timeZone);

export function nearestFrameIndexForDay(frames: readonly TimelineFrame[], indices: readonly number[], timeZone: string, hour: number, minute: number): number {
  if (!indices.length) return -1;
  const target = hour * 60 + minute;
  let best = indices[0]!, bestDist = Infinity, bestMs = Infinity;
  for (const index of indices) {
    const f = frames[index];
    if (!f) continue;
    const ms = Date.parse(f.validTime), local = localTimeFromMs(ms, timeZone);
    if (!local) continue;
    const dist = Math.abs(local.hour * 60 + local.minute - target);
    if (dist < bestDist || (dist === bestDist && ms < bestMs)) { best = index; bestDist = dist; bestMs = ms; }
  }
  return best;
}

export function scrollLeftForCell(cellLeft: number, cellWidth: number, scrollLeft: number, viewportWidth: number): number {
  if (viewportWidth <= 0 || cellWidth <= 0) return scrollLeft;
  return cellLeft < scrollLeft ? cellLeft : cellLeft + cellWidth > scrollLeft + viewportWidth ? cellLeft + cellWidth - viewportWidth : scrollLeft;
}

function groupDays(frames: readonly TimelineFrame[], timeZone: string): DayGroup[] {
  const groups = new Map<string, number[]>();
  frames.forEach((f, i) => { const d = localDayKey(f.validTime, timeZone); if (d) groups.set(d, [...(groups.get(d) ?? []), i]); });
  return [...groups.entries()].map(([day, indices]) => ({ day, indices }));
}

export function createCompactTimeline(host: HTMLElement, options: CompactTimelineOptions): CompactTimeline {
  const doc = host.ownerDocument;
  let timeZone = options.timeZone || DEFAULT_TIME_ZONE, zoneText = options.zoneLabel ?? timeZone;
  const makeFmt = (tz: string) => ({
    date: new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }),
    clock: new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    cell: new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  });
  let fmt = makeFmt(timeZone);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
    const n = doc.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n;
  };
  const btn = (cls: string, label: string, text?: string) => { const b = el('button', cls, text); b.type = 'button'; b.setAttribute('aria-label', label); return b; };

  const root = el('div', 'compact-timeline'), dateBlock = el('div', 'ct-date');
  root.setAttribute('role', 'group'); root.setAttribute('aria-label', 'Forecast timeline');
  const previousDay = btn('ct-day ct-prev', 'Previous available day', '‹'), nextDay = btn('ct-day ct-next', 'Next available day', '›');
  const dateText = el('div', 'ct-date-text'), dateLine = el('span', 'ct-date-line', 'No forecast time');
  const timeLine = el('span', 'ct-time-line'), timeLabel = el('time', 'ct-time', '--:--');
  const zoneLabel = options.onToggleTimeZone ? btn('ct-zone ct-zone-toggle', 'Toggle UTC and local time', zoneText) : el('span', 'ct-zone', zoneText);
  if (options.onToggleTimeZone) zoneLabel.addEventListener('click', () => options.onToggleTimeZone!());
  timeLine.append(timeLabel, el('span', 'ct-sep', ' · '), zoneLabel); dateText.append(dateLine, timeLine);
  dateBlock.append(previousDay, dateText, nextDay);

  const play = btn('ct-play', 'Play forecast'), playGlyph = el('span', 'ct-play-glyph');
  play.setAttribute('aria-pressed', 'false'); playGlyph.setAttribute('aria-hidden', 'true'); play.append(playGlyph);

  const hours = el('div', 'ct-hours');
  for (const [k, v] of [['role', 'radiogroup'], ['aria-label', 'Available forecast frames'], ['aria-orientation', 'horizontal']] as const) hours.setAttribute(k, v);
  root.append(dateBlock, play, hours); host.append(root);

  let frames: readonly TimelineFrame[] = [], days: DayGroup[] = [], cells: HTMLButtonElement[] = [];
  let selectedIndex = -1, disabled = false, timer: ReturnType<typeof setInterval> | null = null, destroyed = false;

  const controlsDisabled = () => disabled || !frames.length;
  const dayPosition = () => selectedIndex < 0 ? -1 : days.findIndex(g => g.day === localDayKey(frames[selectedIndex]!.validTime, timeZone));

  function rebuild(): void {
    const hadFocus = cells.includes(doc.activeElement as HTMLButtonElement), prevScroll = hours.scrollLeft;
    cells = frames.map((frame, index) => {
      const ms = Date.parse(frame.validTime), local = localTimeFromMs(ms, timeZone), ok = Number.isFinite(ms);
      const cell = btn('ct-hour', `${ok ? fmt.cell.format(new Date(ms)) : 'Unknown date'} at ${ok ? fmt.clock.format(new Date(ms)) : '--:--'} ${zoneText}`);
      cell.setAttribute('role', 'radio'); cell.dataset.index = String(index);
      cell.append(el('span', 'ct-hour-label', local ? String(local.hour).padStart(2, '0') : '--'));
      cell.addEventListener('click', () => select(index, true, false));
      return cell;
    });
    hours.replaceChildren(...cells); hours.scrollLeft = prevScroll;
    if (hadFocus) (cells[selectedIndex] ?? cells[0])?.focus({ preventScroll: true });
  }

  function render(): void {
    cells.forEach((cell, i) => {
      const sel = i === selectedIndex;
      cell.classList.toggle('is-selected', sel);
      cell.setAttribute('aria-checked', String(sel));
      cell.tabIndex = sel || (selectedIndex < 0 && i === 0) ? 0 : -1;
    });
    const activeCell = cells[selectedIndex];
    if (activeCell) {
      const left = activeCell.getBoundingClientRect().left - hours.getBoundingClientRect().left + hours.scrollLeft;
      hours.scrollLeft = scrollLeftForCell(left, activeCell.offsetWidth, hours.scrollLeft, hours.clientWidth);
    }
    const frame = selectedIndex >= 0 ? frames[selectedIndex] : undefined, ms = frame ? Date.parse(frame.validTime) : NaN;
    if (!frame || !Number.isFinite(ms)) {
      dateLine.textContent = 'No forecast time'; timeLabel.textContent = '--:--'; timeLabel.removeAttribute('dateTime');
    } else {
      dateLine.textContent = fmt.date.format(new Date(ms)); timeLabel.textContent = fmt.clock.format(new Date(ms)); timeLabel.setAttribute('dateTime', frame.validTime);
    }
    zoneLabel.textContent = zoneText; zoneLabel.setAttribute('title', timeZone);
    const off = controlsDisabled(), pos = dayPosition(), playing = timer !== null;
    play.disabled = off; hours.setAttribute('aria-disabled', String(off));
    for (const c of cells) c.disabled = off;
    previousDay.disabled = off || pos <= 0; nextDay.disabled = off || pos < 0 || pos >= days.length - 1;
    play.classList.toggle('is-playing', playing);
    play.setAttribute('aria-pressed', String(playing));
    play.setAttribute('aria-label', playing ? 'Pause forecast playback' : 'Play forecast');
  }

  function select(index: number, notify: boolean, moveFocus: boolean): void {
    if (destroyed || controlsDisabled() || index < 0 || index >= frames.length) return;
    selectedIndex = index; render();
    if (moveFocus) cells[index]?.focus({ preventScroll: true });
    if (notify) options.onSelect(index);
  }

  const stopPlayback = () => { if (timer !== null) { clearInterval(timer); timer = null; } if (!destroyed) render(); };
  const moveDay = (dir: number) => {
    const pos = dayPosition(), target = pos >= 0 ? days[pos + dir] : undefined, cur = frames[selectedIndex];
    const local = cur ? localTimeFromMs(Date.parse(cur.validTime), timeZone) : null;
    if (target && local) select(nearestFrameIndexForDay(frames, target.indices, timeZone, local.hour, local.minute), true, false);
  };
  previousDay.addEventListener('click', () => moveDay(-1));
  nextDay.addEventListener('click', () => moveDay(1));

  play.addEventListener('click', () => {
    if (timer !== null) { stopPlayback(); return; }
    if (controlsDisabled()) return;
    if (frames.length <= 1) { if (selectedIndex < 0) select(0, true, false); render(); return; }
    if (selectedIndex < 0 || selectedIndex >= frames.length - 1) select(0, true, false);
    timer = setInterval(() => {
      if (selectedIndex >= frames.length - 1) { stopPlayback(); return; }
      select(selectedIndex + 1, true, false);
      if (selectedIndex >= frames.length - 1) stopPlayback();
    }, PLAYBACK_INTERVAL_MS);
    render();
  });

  hours.addEventListener('keydown', event => {
    const k = (event as KeyboardEvent).key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(k)) return;
    event.preventDefault();
    if (controlsDisabled()) return;
    const s = selectedIndex < 0 ? 0 : selectedIndex;
    select(k === 'Home' ? 0 : k === 'End' ? frames.length - 1 : k === 'ArrowLeft' || k === 'ArrowUp' ? Math.max(0, s - 1) : Math.min(frames.length - 1, s + 1), true, true);
  });

  const onVisibility = () => { if (doc.visibilityState === 'hidden') stopPlayback(); };
  doc.addEventListener('visibilitychange', onVisibility);
  doc.defaultView?.addEventListener('pagehide', stopPlayback);

  return {
    update(nextFrames, selectedFrame, nextDisabled = false) {
      if (destroyed) return;
      const changed = frames.length !== nextFrames.length || frames.some((f, i) => f.id !== nextFrames[i]!.id || f.validTime !== nextFrames[i]!.validTime);
      frames = nextFrames.slice(); days = groupDays(frames, timeZone);
      selectedIndex = frames.findIndex(f => f.id === selectedFrame); disabled = nextDisabled;
      if (changed) rebuild();
      render();
      if (controlsDisabled()) stopPlayback();
    },
    setTimeZone(nextZone: string, nextLabel?: string) {
      if (destroyed) return;
      const resolved = nextZone || DEFAULT_TIME_ZONE, label = nextLabel ?? resolved;
      if (resolved === timeZone && label === zoneText) return;
      timeZone = resolved; zoneText = label; fmt = makeFmt(timeZone); days = groupDays(frames, timeZone);
      rebuild(); render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true; stopPlayback();
      doc.removeEventListener('visibilitychange', onVisibility);
      doc.defaultView?.removeEventListener('pagehide', stopPlayback);
      root.remove();
    }
  };
}
