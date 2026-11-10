import { formatMapLiftCell, hasNativeProfiles, pointLiftExpectation, pointMapLift, samePoint, type GeoPoint, type PinnedBuild, type PointFrame, type PointSeries, type UnitSystem } from '@av/contracts/client';
import { mountWindgram, type WindgramMount } from './dom.ts';
import { createPointForecast } from './from-av-profile.ts';
import { panelStyles } from './panel-styles.ts';
import { renderPointSeries } from './scalar-point.ts';
import { localDateKey, type SiteForecast } from './internal-meteo.ts';
import { buildWindgramView, type WindgramView } from './scene.ts';
import { renderWindgramKey } from './svg.ts';
import { daylightForDate } from './windgram-time-axis.ts';

const STYLE_ID = 'av-windgram-document-style';

function ensureDocumentStyles(owner: Document): void {
  if (!owner.head || owner.getElementById?.(STYLE_ID)) return;
  const style = owner.createElement('style');
  style.id = STYLE_ID;
  style.textContent = panelStyles;
  owner.head.append(style);
}

export interface PointWindgramOptions {
  readonly point: GeoPoint;
  readonly frameId: string | null;
  readonly mapFrameId?: string | null;
  readonly unitSystem: UnitSystem;
  readonly totalFrames?: number;
  readonly loading?: boolean;
  onFrame(id: string): void;
}

type Update = (frameId: string | null, units?: UnitSystem, mapFrameId?: string | null, loading?: boolean) => void;
type FrameRef = { readonly id: string; readonly validTime: string };
type DayHour = { readonly id: string; readonly validAt: string };
type PointWindgramInput = Pick<PointSeries, 'frames'>;

interface PointWindgramState {
  readonly section: HTMLElement;
  readonly build: PinnedBuild;
  readonly point: GeoPoint;
  readonly update: Update;
  refresh(input: PointWindgramInput, options: PointWindgramOptions): void;
  dispose(): void;
}

interface Calendar {
  frames: readonly FrameRef[];
  frameIdByValidTime: ReadonlyMap<string, string>;
  days: ReadonlyMap<string, readonly DayHour[]>;
}

interface Data extends Calendar {
  loaded: ReadonlyMap<string, PointFrame>;
  forecast: SiteForecast;
  hasSounding: boolean;
  hasValues: boolean;
  partial: boolean;
}

function groupFrames(frames: readonly FrameRef[], timeZone: string): Calendar {
  const frameIdByValidTime = new Map<string, string>();
  const days = new Map<string, DayHour[]>();
  const references = frames.map(({ id, validTime }) => {
    frameIdByValidTime.set(validTime, id);
    const key = localDateKey(validTime, timeZone);
    const hour = { id, validAt: validTime };
    const hours = days.get(key);
    if (hours) hours.push(hour);
    else days.set(key, [hour]);
    return { id, validTime };
  });
  return { frames: references, frameIdByValidTime, days };
}

const states = new WeakMap<HTMLElement, PointWindgramState>();
let nextPanelId = 0;

function createPointWindgram(
  container: HTMLElement,
  input: PointWindgramInput,
  build: PinnedBuild,
  options: PointWindgramOptions
): PointWindgramState {
  const owner = container.ownerDocument;
  const browser = owner.defaultView;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
    const el = owner.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  ensureDocumentStyles(owner);
  const { layers: liftLayers, frames: mapFrames } = pointLiftExpectation(build);
  const toForecast = createPointForecast(build, options.point);
  let grouped: Calendar | undefined;
  const derive = (nextInput: PointWindgramInput, nextOptions: PointWindgramOptions): Data => {
    const loaded = new Map(nextInput.frames.map(frame => [frame.id, frame]));
    const frames = nextOptions.totalFrames === undefined
      ? build.manifest.frames.filter(frame => loaded.has(frame.id))
      : build.manifest.frames.slice(0, nextOptions.totalFrames);
    const forecast = toForecast(frames, loaded);
    const previous = grouped;
    const calendar = previous && previous.frames.length === frames.length && frames.every(({ id, validTime }, i) => {
      const old = previous.frames[i];
      return old.id === id && old.validTime === validTime;
    }) ? previous : groupFrames(frames, forecast.site.timeZone);
    grouped = calendar;
    return {
      ...calendar, loaded, forecast,
      hasSounding: forecast.hours.some(hour => hour.levels.length > 0),
      hasValues: nextInput.frames.some(frame => Object.values(frame.layers).some(cell => cell.status === 'valid')),
      partial: frames.some(({ id }) => {
        const frame = loaded.get(id);
        return !frame?.profile || (mapFrames.has(id) && liftLayers.some(layer => !frame.layers[layer]));
      })
    };
  };
  let data = derive(input, options);

  const section = node('section', 'av-point-series av-windgram-panel');
  const idPrefix = `av-point-windgram-${++nextPanelId}`;
  const time = node('p', 'av-point-time');
  const liftSummary = node('p', 'av-windgram-lift-summary');
  const profileStatus = node('p', 'av-windgram-profile-status');
  profileStatus.role = 'status';
  const incomplete = node('p', 'av-point-incomplete', 'Forecast incomplete. Some hours could not be loaded.');
  incomplete.role = 'status';
  const controls = node('div', 'av-windgram-controls');
  const hourSteps = node('div', 'av-windgram-hours');
  const hourBack = node('button', 'av-windgram-step', '‹');
  const hourForward = node('button', 'av-windgram-step', '›');
  hourBack.type = 'button'; hourForward.type = 'button';
  hourBack.ariaLabel = 'Previous point hour'; hourForward.ariaLabel = 'Next point hour';
  hourSteps.append(hourBack, hourForward);
  const dayTabs = node('div', 'av-windgram-days');
  controls.append(hourSteps, dayTabs);
  const chartHost = node('div', 'av-windgram-host');
  const details = node('details', 'av-windgram-details');
  details.append(node('summary', undefined, 'Chart details'));
  const inspection = node('div', 'windgram-inspection');
  const inspectLabel = node('label');
  const inspectCheckbox = node('input');
  inspectCheckbox.type = 'checkbox';
  const inspectText = node('span', undefined, ' Inspect any height');
  inspectLabel.append(inspectCheckbox, inspectText);
  const readout = node('p', 'windgram-readout');
  readout.id = `${idPrefix}-readout`;
  inspection.append(inspectLabel, readout);
  const keyHost = node('div', 'av-windgram-key');
  details.append(inspection, keyHost);
  section.append(controls, chartHost, liftSummary, time, profileStatus, incomplete, details);
  container.replaceChildren(section);

  let units: UnitSystem = options.unitSystem;
  let loading = options.loading ?? false;
  let selectedFrameId = options.frameId;
  let mapFrameId = options.mapFrameId === undefined ? options.frameId : options.mapFrameId;
  let onFrame = options.onFrame;
  let inspectionMode: 'lift' | 'height' = 'lift';
  let keyUnits: UnitSystem | null = null;
  let activeWidth = 0;
  let activeHeight: number | undefined;
  let daySignature: string | null = null;
  let viewCache: { key: string; frames: readonly (PointFrame | undefined)[]; daylight: WindgramView; full?: WindgramView } | null = null;
  let mountedView: WindgramView | null = null;
  let mounted: WindgramMount | null = null;
  let disposed = false;
  const dayButtons = new Map<string, HTMLButtonElement>();

  const dayLabel = new Intl.DateTimeFormat('en-US', { timeZone: data.forecast.site.timeZone, weekday: 'short', day: 'numeric' });
  const chartHeight = () => {
    const cap = browser?.getComputedStyle(chartHost).maxHeight;
    const pixels = cap?.endsWith('px') ? Number(cap.slice(0, -2)) : NaN;
    return Number.isFinite(pixels) ? Math.floor(pixels) : undefined;
  };

  const dayViews = (dayKey: string, hours: readonly DayHour[], widthPx: number, heightPx: number | undefined) => {
    const frames = hours.map(hour => data.loaded.get(hour.id));
    const key = `${dayKey}|${units}|${widthPx}|${heightPx}|${hours.length}`;
    if (viewCache?.key !== key || viewCache.frames.some((frame, i) => frame !== frames[i])) {
      const timeZone = data.forecast.site.timeZone;
      const daylight = buildWindgramView(data.forecast, {
        unitSystem: units, timeZone, widthPx, heightPx, compact: widthPx < 520, heightRange: 'soaring', hours: { timeZone, dateKey: dayKey }
      });
      viewCache = { key, frames, daylight };
    }
    return viewCache;
  };

  const selectDay = (dayKey: string) => {
    if (disposed) return;
    const hours = data.days.get(dayKey);
    if (!hours?.length) return;
    const daylight = mounted ? daylightForDate(data.forecast, dayKey, data.forecast.site.timeZone) : null;
    const visible = daylight && hours.find(hour => {
      const time = Date.parse(hour.validAt);
      return time >= daylight.sunrise && time <= daylight.sunset && data.loaded.has(hour.id);
    });
    onFrame((visible || hours.find(hour => data.loaded.has(hour.id)) || hours[0]).id);
  };

  const syncDayButtons = () => {
    const keys = [...data.days.keys()];
    const signature = keys.join('|');
    if (signature === daySignature) return;
    daySignature = signature;
    dayButtons.clear();
    dayTabs.replaceChildren(...keys.map(dayKey => {
      const date = new Date(data.days.get(dayKey)![0].validAt);
      const parts = dayLabel.formatToParts(date);
      const shortDay = `${parts.find(part => part.type === 'weekday')!.value} ${parts.find(part => part.type === 'day')!.value}`;
      const button = node('button', 'av-windgram-day', shortDay);
      button.type = 'button';
      button.value = dayKey;
      button.ariaLabel = dayKey;
      button.addEventListener('click', () => selectDay(dayKey));
      dayButtons.set(dayKey, button);
      return button;
    }));
    dayTabs.hidden = keys.length <= 1;
  };

  const step = (delta: -1 | 1) => {
    if (disposed || !data.frames.length) return;
    const index = data.frames.findIndex(frame => frame.id === selectedFrameId);
    const target = data.frames[Math.max(0, Math.min(data.frames.length - 1, index + delta))];
    if (target.id !== selectedFrameId) onFrame(target.id);
  };
  hourBack.addEventListener('click', () => step(-1));
  hourForward.addEventListener('click', () => step(1));

  inspectCheckbox.addEventListener('change', () => {
    if (disposed) return;
    inspectionMode = inspectCheckbox.checked ? 'height' : 'lift';
    mounted?.setMode(inspectionMode);
  });

  const update: Update = (frameId, nextUnits = units, nextMapFrameId = mapFrameId, nextLoading = loading) => {
    if (disposed) return;
    const timeZone = data.forecast.site.timeZone;
    units = nextUnits;
    loading = nextLoading;
    selectedFrameId = frameId;
    mapFrameId = nextMapFrameId;
    incomplete.hidden = !data.partial || loading;

    const loadedFrame = frameId === null ? undefined : data.loaded.get(frameId);
    const pointFrame = loadedFrame ?? build.manifest.frames.find(frame => frame.id === frameId);
    const mapFrame = build.manifest.frames.find(frame => frame.id === mapFrameId);
    const utc = (value: string) => `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;
    time.textContent = pointFrame && pointFrame.id !== mapFrameId
      ? `Point: ${utc(pointFrame.validTime)} · Map: ${mapFrame ? utc(mapFrame.validTime) : 'unavailable'}`
      : pointFrame ? `Point and map: ${utc(pointFrame.validTime)}` : 'Point time unavailable';
    time.hidden = !pointFrame || pointFrame.id === mapFrameId;

    const index = data.frames.findIndex(frame => frame.id === selectedFrameId);
    hourBack.disabled = index <= 0;
    hourForward.disabled = index < 0 || index >= data.frames.length - 1;

    const pendingLift = loading && frameId !== null && mapFrames.has(frameId) && liftLayers.some(layer => !loadedFrame?.layers[layer]);
    const lift = pointMapLift(loadedFrame, build);
    liftSummary.textContent = pendingLift ? 'Loading map lift…' : `MSL ${formatMapLiftCell(lift.msl, units)} · AGL ${formatMapLiftCell(lift.agl, units)}`;
    const hasProfile = loadedFrame?.profile?.status === 'valid' && loadedFrame.profile.levels.length > 0;
    profileStatus.hidden = hasProfile;
    profileStatus.textContent = loading && !loadedFrame?.profile ? 'Loading native profile…' : 'Native profile unavailable.';

    const selectedValidAt = pointFrame?.validTime ?? null;
    const selectedDay = selectedValidAt && localDateKey(selectedValidAt, timeZone);
    const targetDayKey = selectedDay && data.days.has(selectedDay) ? selectedDay : data.days.keys().next().value;
    for (const [dayKey, button] of dayButtons) {
      const isSelected = dayKey === targetDayKey;
      button.ariaPressed = String(isSelected);
      button.className = isSelected ? 'av-windgram-day is-selected' : 'av-windgram-day';
    }
    const dayHours = targetDayKey === undefined ? undefined : data.days.get(targetDayKey);
    const showChart = dayHours !== undefined && (data.hasSounding || (!loading && data.hasValues));
    chartHost.hidden = details.hidden = !showChart;
    controls.hidden = data.frames.length <= 1;
    liftSummary.hidden = liftLayers.length === 0 || (showChart && lift.mslM !== null);
    if (!showChart || targetDayKey === undefined) return;

    const widthPx = chartHost.clientWidth > 0 ? chartHost.clientWidth : 420;
    const compact = widthPx < 520;
    const heightPx = chartHeight();
    activeWidth = widthPx;
    activeHeight = heightPx;
    const views = dayViews(targetDayKey, dayHours, widthPx, heightPx), daylightView = views.daylight;
    const visibleDayHours = daylightView.hours.filter(hour => hour.x >= daylightView.left && hour.x <= daylightView.left + daylightView.plotWidth);
    const selectedInDaylight = selectedValidAt === null || visibleDayHours.some(hour => hour.validAt === selectedValidAt);
    const useDaylightCrop = selectedInDaylight && visibleDayHours.length >= Math.min(2, dayHours.length) && visibleDayHours.length > 0;
    const view = useDaylightCrop ? daylightView : (views.full ??= buildWindgramView(data.forecast, {
      unitSystem: units, timeZone, widthPx, heightPx, compact, heightRange: 'soaring', hours: dayHours
    }));

    if (!mounted) {
      mounted = mountWindgram(chartHost, {
        view, idPrefix, readout, selectedValidAt, inspectionMode,
        onStepHour: step,
        onSelectHour: validAt => {
          const id = data.frameIdByValidTime.get(validAt);
          if (id) onFrame(id);
        }
      });
    } else {
      if (mountedView !== view) mounted.update(view);
      mounted.select(selectedValidAt);
    }
    mountedView = view;
    if (keyUnits !== units) keyHost.innerHTML = renderWindgramKey(units);
    keyUnits = units;
  };

  const refresh = (nextInput: PointWindgramInput, nextOptions: PointWindgramOptions) => {
    data = derive(nextInput, nextOptions);
    onFrame = nextOptions.onFrame;
    syncDayButtons();
    update(nextOptions.frameId, nextOptions.unitSystem, nextOptions.mapFrameId, nextOptions.loading);
  };

  syncDayButtons();
  update(selectedFrameId, units, mapFrameId, loading);

  const resize = () => {
    if (disposed || container.children[0] !== section || chartHost.clientWidth <= 0) return;
    if (chartHost.clientWidth !== activeWidth || chartHeight() !== activeHeight) update(selectedFrameId, units, mapFrameId, loading);
  };
  browser?.addEventListener('resize', resize);
  const observer = browser?.ResizeObserver ? new browser.ResizeObserver(resize) : null;
  observer?.observe(chartHost);

  const state: PointWindgramState = {
    section,
    build,
    point: options.point,
    update,
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      browser?.removeEventListener('resize', resize);
      observer?.disconnect();
      mounted?.dispose();
      mounted = null;
    }
  };
  return state;
}

export function renderPointWindgram(
  container: HTMLElement,
  input: PointWindgramInput,
  build: PinnedBuild,
  options: PointWindgramOptions
): Update {
  if (!hasNativeProfiles(build)) {
    disposePointWindgram(container);
    return renderPointSeries(container, { frames: input.frames }, build, options);
  }
  const existing = states.get(container);
  if (existing && existing.build === build && samePoint(existing.point, options.point) && container.children[0] === existing.section) {
    existing.refresh(input, options);
    return existing.update;
  }
  disposePointWindgram(container);
  const state = createPointWindgram(container, input, build, options);
  states.set(container, state);
  return state.update;
}

export function disposePointWindgram(container: HTMLElement): void {
  states.get(container)?.dispose();
  states.delete(container);
}
