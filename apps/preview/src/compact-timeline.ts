import './compact-timeline.css';

export interface TimelineFrame {
  readonly id: string;
  readonly validTime: string;
}

export interface CompactTimelineOptions {
  onSelect(index: number): void;
  timeZone?: string;
}

export interface CompactTimeline {
  update(frames: readonly TimelineFrame[], selectedFrame: string | null, disabled?: boolean): void;
  destroy(): void;
}

interface LocalTime {
  day: string;
  hour: number;
  minute: number;
}

interface DayGroup {
  day: string;
  indices: number[];
}

const PLAYBACK_INTERVAL_MS = 700;
const DEFAULT_TIME_ZONE = 'UTC';

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function localTimeFromMs(ms: number, timeZone: string): LocalTime | null {
  if (!Number.isFinite(ms)) return null;
  const values: Record<string, string> = {};
  for (const part of partsFormatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  const hour = Number(values.hour) % 24;
  const minute = Number(values.minute);
  if (!values.year || !values.month || !values.day || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { day: `${values.year}-${values.month}-${values.day}`, hour, minute };
}

export function localDayKey(validTime: string, timeZone: string): string | null {
  return localTimeFromMs(Date.parse(validTime), timeZone)?.day ?? null;
}

export function localTimeParts(validTime: string, timeZone: string): LocalTime | null {
  return localTimeFromMs(Date.parse(validTime), timeZone);
}

export function nearestFrameIndexForDay(
  frames: readonly TimelineFrame[],
  indices: readonly number[],
  timeZone: string,
  hour: number,
  minute: number
): number {
  if (indices.length === 0) return -1;
  const target = hour * 60 + minute;
  let best = indices[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const index of indices) {
    const frame = frames[index];
    if (!frame) continue;
    const ms = Date.parse(frame.validTime);
    const local = localTimeFromMs(ms, timeZone);
    if (!local) continue;
    const distance = Math.abs(local.hour * 60 + local.minute - target);
    if (distance < bestDistance || (distance === bestDistance && ms < bestMs)) {
      best = index;
      bestDistance = distance;
      bestMs = ms;
    }
  }
  return best;
}

export function scrollLeftForCell(cellLeft: number, cellWidth: number, scrollLeft: number, viewportWidth: number): number {
  if (viewportWidth <= 0 || cellWidth <= 0) return scrollLeft;
  if (cellLeft < scrollLeft) return cellLeft;
  const right = cellLeft + cellWidth;
  if (right > scrollLeft + viewportWidth) return right - viewportWidth;
  return scrollLeft;
}

function groupDays(frames: readonly TimelineFrame[], timeZone: string): DayGroup[] {
  const groups = new Map<string, number[]>();
  frames.forEach((frame, index) => {
    const day = localDayKey(frame.validTime, timeZone);
    if (!day) return;
    const indices = groups.get(day);
    if (indices) indices.push(index);
    else groups.set(day, [index]);
  });
  return [...groups.entries()].map(([day, indices]) => ({ day, indices }));
}

function sameFrames(a: readonly TimelineFrame[], b: readonly TimelineFrame[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((frame, index) => frame.id === b[index]!.id && frame.validTime === b[index]!.validTime);
}

export function createCompactTimeline(host: HTMLElement, options: CompactTimelineOptions): CompactTimeline {
  const doc = host.ownerDocument;
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const dateFormatter = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' });
  const clockFormatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const cellLabelFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const root = doc.createElement('div');
  root.className = 'compact-timeline';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Forecast timeline');

  const dateBlock = doc.createElement('div');
  dateBlock.className = 'ct-date';

  const previousDay = doc.createElement('button');
  previousDay.type = 'button';
  previousDay.className = 'ct-day ct-prev';
  previousDay.setAttribute('aria-label', 'Previous available day');
  previousDay.textContent = '‹';

  const dateText = doc.createElement('div');
  dateText.className = 'ct-date-text';
  const dateLine = doc.createElement('span');
  dateLine.className = 'ct-date-line';
  dateLine.textContent = 'No forecast time';
  const timeLine = doc.createElement('span');
  timeLine.className = 'ct-time-line';
  const timeLabel = doc.createElement('time');
  timeLabel.className = 'ct-time';
  timeLabel.textContent = '--:--';
  const separator = doc.createElement('span');
  separator.className = 'ct-sep';
  separator.textContent = ' · ';
  const zoneLabel = doc.createElement('span');
  zoneLabel.className = 'ct-zone';
  zoneLabel.textContent = timeZone;
  timeLine.append(timeLabel, separator, zoneLabel);
  dateText.append(dateLine, timeLine);

  const nextDay = doc.createElement('button');
  nextDay.type = 'button';
  nextDay.className = 'ct-day ct-next';
  nextDay.setAttribute('aria-label', 'Next available day');
  nextDay.textContent = '›';
  dateBlock.append(previousDay, dateText, nextDay);

  const play = doc.createElement('button');
  play.type = 'button';
  play.className = 'ct-play';
  play.setAttribute('aria-label', 'Play forecast');
  play.setAttribute('aria-pressed', 'false');
  const playGlyph = doc.createElement('span');
  playGlyph.className = 'ct-play-glyph';
  playGlyph.setAttribute('aria-hidden', 'true');
  play.append(playGlyph);

  const hours = doc.createElement('div');
  hours.className = 'ct-hours';
  hours.setAttribute('role', 'radiogroup');
  hours.setAttribute('aria-label', 'Available forecast frames');
  hours.setAttribute('aria-orientation', 'horizontal');

  root.append(dateBlock, play, hours);
  host.append(root);

  let frames: readonly TimelineFrame[] = [];
  let days: DayGroup[] = [];
  let cells: HTMLButtonElement[] = [];
  let selectedIndex = -1;
  let disabled = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;

  function controlsDisabled(): boolean {
    return disabled || frames.length === 0;
  }

  function resolveSelected(selectedFrame: string | null): number {
    return frames.findIndex(frame => frame.id === selectedFrame);
  }

  function dayPosition(): number {
    if (selectedIndex < 0) return -1;
    const day = localDayKey(frames[selectedIndex]!.validTime, timeZone);
    if (!day) return -1;
    return days.findIndex(group => group.day === day);
  }

  function buildCell(frame: TimelineFrame, index: number): HTMLButtonElement {
    const cell = doc.createElement('button');
    cell.type = 'button';
    cell.className = 'ct-hour';
    cell.setAttribute('role', 'radio');
    cell.dataset.index = String(index);
    const ms = Date.parse(frame.validTime);
    const local = localTimeFromMs(ms, timeZone);
    const label = doc.createElement('span');
    label.className = 'ct-hour-label';
    label.textContent = local ? String(local.hour).padStart(2, '0') : '--';
    cell.append(label);
    const clock = Number.isFinite(ms) ? clockFormatter.format(new Date(ms)) : '--:--';
    const date = Number.isFinite(ms) ? cellLabelFormatter.format(new Date(ms)) : 'Unknown date';
    cell.setAttribute('aria-label', `${date} at ${clock} ${timeZone}`);
    cell.addEventListener('click', () => select(index, true, false));
    return cell;
  }

  function rebuild(): void {
    const hadFocus = cells.includes(doc.activeElement as HTMLButtonElement);
    const previousScroll = hours.scrollLeft;
    cells = frames.map(buildCell);
    hours.replaceChildren(...cells);
    hours.scrollLeft = previousScroll;
    if (hadFocus) (cells[selectedIndex] ?? cells[0])?.focus({ preventScroll: true });
  }

  function reveal(index: number): void {
    const cell = cells[index];
    if (!cell) return;
    const left = cell.getBoundingClientRect().left - hours.getBoundingClientRect().left + hours.scrollLeft;
    hours.scrollLeft = scrollLeftForCell(left, cell.offsetWidth, hours.scrollLeft, hours.clientWidth);
  }

  function renderCells(): void {
    cells.forEach((cell, index) => {
      const isSelected = index === selectedIndex;
      cell.classList.toggle('is-selected', isSelected);
      cell.setAttribute('aria-checked', String(isSelected));
      cell.tabIndex = isSelected || (selectedIndex < 0 && index === 0) ? 0 : -1;
    });
    if (selectedIndex >= 0) reveal(selectedIndex);
  }

  function renderDate(): void {
    if (selectedIndex < 0) {
      dateLine.textContent = 'No forecast time';
      timeLabel.textContent = '--:--';
      timeLabel.removeAttribute('dateTime');
      return;
    }
    const frame = frames[selectedIndex]!;
    const ms = Date.parse(frame.validTime);
    if (!Number.isFinite(ms)) {
      dateLine.textContent = 'No forecast time';
      timeLabel.textContent = '--:--';
      timeLabel.removeAttribute('dateTime');
      return;
    }
    dateLine.textContent = dateFormatter.format(new Date(ms));
    timeLabel.textContent = clockFormatter.format(new Date(ms));
    timeLabel.setAttribute('dateTime', frame.validTime);
  }

  function renderDays(): void {
    const position = dayPosition();
    previousDay.disabled = controlsDisabled() || position <= 0;
    nextDay.disabled = controlsDisabled() || position < 0 || position >= days.length - 1;
  }

  function renderDisabled(): void {
    const off = controlsDisabled();
    play.disabled = off;
    for (const cell of cells) cell.disabled = off;
    hours.setAttribute('aria-disabled', String(off));
    renderDays();
  }

  function renderPlay(): void {
    const active = timer !== null;
    play.classList.toggle('is-playing', active);
    play.setAttribute('aria-pressed', String(active));
    play.setAttribute('aria-label', active ? 'Pause forecast playback' : 'Play forecast');
  }

  function render(): void {
    renderCells();
    renderDate();
    renderDisabled();
    renderPlay();
  }

  function select(index: number, notify: boolean, moveFocus: boolean): void {
    if (destroyed || controlsDisabled() || index < 0 || index >= frames.length) return;
    selectedIndex = index;
    render();
    if (moveFocus) cells[index]?.focus({ preventScroll: true });
    if (notify) options.onSelect(index);
  }

  function stopPlayback(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (!destroyed) renderPlay();
  }

  function stepPlayback(): void {
    if (selectedIndex >= frames.length - 1) {
      stopPlayback();
      return;
    }
    select(selectedIndex + 1, true, false);
    if (selectedIndex >= frames.length - 1) stopPlayback();
  }

  function startPlayback(): void {
    if (controlsDisabled()) return;
    if (frames.length <= 1) {
      if (selectedIndex < 0) select(0, true, false);
      renderPlay();
      return;
    }
    if (selectedIndex < 0 || selectedIndex >= frames.length - 1) select(0, true, false);
    timer = setInterval(stepPlayback, PLAYBACK_INTERVAL_MS);
    renderPlay();
  }

  function moveDay(direction: number): void {
    const position = dayPosition();
    if (position < 0) return;
    const target = days[position + direction];
    const current = frames[selectedIndex];
    if (!target || !current) return;
    const local = localTimeFromMs(Date.parse(current.validTime), timeZone);
    if (!local) return;
    select(nearestFrameIndexForDay(frames, target.indices, timeZone, local.hour, local.minute), true, false);
  }

  previousDay.addEventListener('click', () => moveDay(-1));
  nextDay.addEventListener('click', () => moveDay(1));
  play.addEventListener('click', () => {
    if (timer !== null) stopPlayback();
    else startPlayback();
  });

  hours.addEventListener('keydown', event => {
    const key = (event as KeyboardEvent).key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return;
    event.preventDefault();
    if (controlsDisabled() || frames.length === 0) return;
    const start = selectedIndex < 0 ? 0 : selectedIndex;
    const target = key === 'Home' ? 0
      : key === 'End' ? frames.length - 1
        : key === 'ArrowLeft' || key === 'ArrowUp' ? Math.max(0, start - 1)
          : Math.min(frames.length - 1, start + 1);
    select(target, true, true);
  });

  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') stopPlayback();
  };
  const onPageHide = (): void => stopPlayback();
  doc.addEventListener('visibilitychange', onVisibility);
  const view = doc.defaultView;
  view?.addEventListener('pagehide', onPageHide);

  return {
    update(nextFrames, selectedFrame, nextDisabled = false) {
      if (destroyed) return;
      const changed = !sameFrames(frames, nextFrames);
      frames = nextFrames.slice();
      days = groupDays(frames, timeZone);
      selectedIndex = resolveSelected(selectedFrame);
      disabled = nextDisabled;
      if (changed) rebuild();
      render();
      if (controlsDisabled()) stopPlayback();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopPlayback();
      doc.removeEventListener('visibilitychange', onVisibility);
      view?.removeEventListener('pagehide', onPageHide);
      root.remove();
    }
  };
}
