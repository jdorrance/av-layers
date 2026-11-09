import { formatMapLiftCell, pointLiftExpectation, pointMapLift, samePoint, type GeoPoint, type PinnedBuild, type PointFrame, type PointSeries, type UnitSystem } from '@av/contracts/client';
import { mountWindgram, type WindgramMount } from './dom.ts';
import { pointSeriesToSiteForecast } from './from-av-profile.ts';
import { panelStyles } from './panel-styles.ts';
import { renderPointSeries } from './scalar-point.ts';
import { localDateKey, type SiteForecast } from './internal-meteo.ts';
import { buildWindgramView, type WindgramView } from './scene.ts';
import { renderWindgramKey } from './svg.ts';

const STYLE_ID = 'av-windgram-document-style';

function ensureDocumentStyles(): void {
  if (typeof document === 'undefined' || !document.head) return;
  if (typeof document.getElementById === 'function' && document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = panelStyles;
  document.head.append(style);
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
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
type PointWindgramInput = Pick<PointSeries, 'frames'>;

interface PointWindgramState {
  readonly section: HTMLElement;
  readonly build: PinnedBuild;
  readonly point: GeoPoint;
  readonly update: Update;
  refresh(input: PointWindgramInput, options: PointWindgramOptions): void;
  dispose(): void;
}

interface Data {
  frames: readonly FrameRef[];
  loaded: ReadonlyMap<string, PointFrame>;
  forecast: SiteForecast;
  frameIdByValidTime: Map<string, string>;
  days: Map<string, { validAt: string }[]>;
  hasSounding: boolean;
  hasValues: boolean;
  partial: boolean;
}

const states = new WeakMap<HTMLElement, PointWindgramState>();
let nextPanelId = 0;

function createPointWindgram(
  container: HTMLElement,
  input: PointWindgramInput,
  build: PinnedBuild,
  options: PointWindgramOptions
): PointWindgramState {
  ensureDocumentStyles();
  const { layers: liftLayers, frames: mapFrames } = pointLiftExpectation(build);
  const derive = (nextInput: PointWindgramInput, nextOptions: PointWindgramOptions): Data => {
    const frames = nextOptions.totalFrames === undefined ? nextInput.frames : build.manifest.frames.slice(0, nextOptions.totalFrames);
    const forecast = pointSeriesToSiteForecast(nextInput, build, { point: nextOptions.point, expectedFrames: frames.map(frame => frame.id) });
    const loaded = new Map(nextInput.frames.map(frame => [frame.id, frame]));
    const frameIdByValidTime = new Map<string, string>(), days = new Map<string, { validAt: string }[]>();
    for (const frame of frames) {
      frameIdByValidTime.set(frame.validTime, frame.id);
      const key = localDateKey(frame.validTime, forecast.site.timeZone);
      const hours = days.get(key);
      if (hours) hours.push({ validAt: frame.validTime });
      else days.set(key, [{ validAt: frame.validTime }]);
    }
    return {
      frames, loaded, forecast, frameIdByValidTime, days,
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
  let observer: ResizeObserver | null = null;
  let disposed = false;
  const dayButtons = new Map<string, HTMLButtonElement>();

  const dayLabel = new Intl.DateTimeFormat('en-US', { timeZone: data.forecast.site.timeZone, weekday: 'short', day: 'numeric' });
  const chartHeight = () => {
    const cap = typeof getComputedStyle === 'function' ? parseFloat(getComputedStyle(chartHost).maxHeight) : NaN;
    return Number.isFinite(cap) ? Math.floor(cap) : undefined;
  };

  const dayViews = (dayKey: string, widthPx: number, heightPx: number | undefined) => {
    const hours = data.days.get(dayKey)!;
    const frames = hours.map(hour => data.loaded.get(data.frameIdByValidTime.get(hour.validAt)!));
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
    const ids = (data.days.get(dayKey) ?? []).map(hour => data.frameIdByValidTime.get(hour.validAt)!);
    const view = mounted ? dayViews(dayKey, activeWidth, activeHeight).daylight : null;
    const visible = view?.hours.find(hour => hour.x >= view.left && hour.x <= view.left + view.plotWidth && data.loaded.has(data.frameIdByValidTime.get(hour.validAt)!));
    const id = (visible && data.frameIdByValidTime.get(visible.validAt)) ?? ids.find(candidate => data.loaded.has(candidate)) ?? ids[0];
    if (id) onFrame(id);
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
    const showChart = targetDayKey !== undefined && (data.hasSounding || (!loading && data.hasValues));
    chartHost.hidden = details.hidden = !showChart;
    controls.hidden = data.frames.length <= 1;
    liftSummary.hidden = liftLayers.length === 0 || (showChart && lift.mslM !== null);
    if (!showChart) return;

    const widthPx = chartHost.clientWidth > 0 ? chartHost.clientWidth : 420;
    const compact = widthPx < 520;
    const heightPx = chartHeight();
    activeWidth = widthPx;
    activeHeight = heightPx;
    const dayHours = data.days.get(targetDayKey)!;
    const views = dayViews(targetDayKey, widthPx, heightPx), daylightView = views.daylight;
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
  const window = chartHost.ownerDocument?.defaultView;
  window?.addEventListener('resize', resize);
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(resize);
    observer.observe(chartHost);
  }

  const state: PointWindgramState = {
    section,
    build,
    point: options.point,
    update,
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      window?.removeEventListener('resize', resize);
      observer?.disconnect();
      observer = null;
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
  if (build.manifest.version !== 5 || !build.manifest.surfaces.some(surface => surface.profiles)) {
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
