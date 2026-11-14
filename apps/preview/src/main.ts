import { renderBuildDiagnostics } from '@av/client/dom';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { LIFT_RENDER_STYLE, LIFT_STEP_RENDER_STYLE, renderedLayers, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, type LayerId } from '@av/contracts/layers';
import { normalizeLon } from '@av/contracts/geometry';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import { renderedFrames, type ModelId } from '@av/contracts/publication';
import { displayedWindSpeed, windSpeedUnitLabel } from '@av/contracts/units';
import {
  ApiClient, createForecastRequestScheduler, AUTO_MODEL_ID, activePalettes, assertNotExpired,
  pointSeriesSelection, mapForecastHorizonNotice, formatBuildFreshness, longitudeOffsetHours,
  normalizePoint, PointSeriesController, resolveAutoBuild, watchBuildExpiry,
  type AutoForecastSelection, type GeoPoint, type PinnedBuild, type PointSeries, type PointSeriesContext, type PointHorizon, type UnitSystem
} from '@av/client';
import { WindDataCache, WindDataSource } from '@av/client/wind';
import './style.css';
import { RasterOverlay, type OverlayState } from './raster-overlay';
import { RASTER_CACHE_TILES } from './raster-budget';
import { previewQuery, previewUrl, type AltitudeReference, type TimeZoneMode } from './url-state';
import { clockLabel, frameIndexFor } from './timeline';
import { WindOverlay } from './wind-overlay';
import { createWindControls, type WindStatus } from './wind-controls';
import { createCompactTimeline } from './compact-timeline';
import { googleTerrainStyle, type TerrainBasemap } from './basemap';

type PointWindgram = typeof import('@av/windgram');

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const modelBar = element<HTMLDivElement>('models'), modelPicker = element<HTMLDetailsElement>('model-picker'), modelSelected = element<HTMLElement>('model-selected');
const layerPicker = element<HTMLDivElement>('layer-picker'), metricButton = element<HTMLButtonElement>('units-metric'), imperialButton = element<HTMLButtonElement>('units-imperial');
const locateButton = element<HTMLButtonElement>('locate'), locationStatus = element<HTMLParagraphElement>('location-status'), distanceScale = element<HTMLParagraphElement>('distance-scale');
const referenceGroup = element<HTMLDivElement>('reference'), refAgl = element<HTMLButtonElement>('ref-agl'), refMsl = element<HTMLButtonElement>('ref-msl');
const opacityInput = element<HTMLInputElement>('opacity'), opacityReadout = element<HTMLSpanElement>('opacity-readout'), timeInput = element<HTMLInputElement>('time');
const timestamp = element<HTMLParagraphElement>('timestamp'), frameStatus = element<HTMLParagraphElement>('frame-status'), timelineStatus = element<HTMLParagraphElement>('timeline-status');
const legend = element<HTMLElement>('legend'), legendBody = element<HTMLDivElement>('legend-body'), horizonNotice = element<HTMLParagraphElement>('horizon-notice');
const tileErrorBox = element<HTMLParagraphElement>('tile-error'), errorBox = element<HTMLParagraphElement>('error'), freshness = element<HTMLParagraphElement>('freshness');
const pointCard = element<HTMLElement>('point-card'), pointClose = element<HTMLButtonElement>('point-close'), pointSettings = element<HTMLDetailsElement>('point-settings');
const pointBuildDetails = element<HTMLDetailsElement>('point-build-details'), pointLocation = element<HTMLParagraphElement>('point-location'), pointWind = element<HTMLParagraphElement>('point-wind');
const pointStatus = element<HTMLParagraphElement>('point-status'), pointBody = element<HTMLDivElement>('point-body'), pointUnits = element<HTMLSelectElement>('point-units');
const windControlsHost = element<HTMLElement>('wind-controls');
const pointHorizonSelect = element<HTMLSelectElement>('point-horizon'), pointHorizonLabel = element<HTMLLabelElement>('point-horizon-label'), meta = element<HTMLDListElement>('meta');

const LIFT: readonly LayerId[] = ['usable-lift-agl', 'usable-lift-msl'];
const HIDDEN_PREVIEW_LAYERS: ReadonlySet<LayerId> = new Set(['precip-rate']);
const isLiftLayer = (layer: LayerId): boolean => layer === 'usable-lift-agl' || layer === 'usable-lift-msl';
const visibleCustomLayer = (layer: LayerId | null): LayerId | null => layer && !HIDDEN_PREVIEW_LAYERS.has(layer) ? layer : null;
const shortLayerName = (layer: LayerId, d?: { label: string }): string =>
  layer.startsWith('cloud') ? 'Cloud' : (d?.label ?? layer).replace(/\s*\(.*\)$/, '');

const offlineFixture = import.meta.env.VITE_OFFLINE_FIXTURE === 'true';
const apiBaseUrl = import.meta.env.AV_API_BASE ?? 'http://localhost:8787';
const api = new ApiClient({ baseUrl: apiBaseUrl });
const startup = previewQuery(window.location.search, offlineFixture);

const stored = (key: string): string | null => { try { return window.localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: string): void => { try { window.localStorage.setItem(key, value); } catch { /* ignore */ } };
const browserLocalZone = (): string => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

const initialModel = startup.model ?? (offlineFixture ? import.meta.env.VITE_MODEL ?? 'gfs' : AUTO_MODEL_ID);
const savedOpacity = stored('preview-lift-opacity'), savedOpacityNum = savedOpacity?.trim() ? Number(savedOpacity) : NaN;
const initialOpacity = startup.opacity ?? (savedOpacityNum >= 0 && savedOpacityNum <= 1 ? savedOpacityNum : 0.5);

if (offlineFixture) {
  const warning = Object.assign(document.createElement('p'), { className: 'toast', textContent: 'SYNTHETIC FIXTURE — development data, not a forecast' });
  document.getElementById('app')?.prepend(warning);
}

maplibregl.setWorkerUrl(workerUrl);
opacityInput.value = String(initialOpacity);
opacityReadout.textContent = `${Math.round(initialOpacity * 100)}%`;

const modelButtons: HTMLButtonElement[] = [];

const basemapStyle = (): maplibregl.StyleSpecification => ({
  version: 8,
  sources: { basemap: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' } },
  layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }]
});

interface InitialDiscovery { controller: AbortController; model?: ModelId; build?: Promise<PinnedBuild>; auto?: Promise<AutoForecastSelection | null> }
interface WindView { zoom: number; build: PinnedBuild; frame: string; bounds: [number, number, number, number]; source: WindDataSource }
interface WindRequest extends WindView { controller: AbortController; key: string }

function startPreview(lifecycle: AbortController, terrain: TerrainBasemap | null, initialDiscovery: InitialDiscovery | null): void {
  modelBar.replaceChildren(); modelButtons.length = 0;
  for (const choice of offlineFixture ? [{ modelId: initialModel, label: 'Synthetic fixture' }] : [...MODEL_OPTIONS, { modelId: AUTO_MODEL_ID, label: 'Auto' }]) {
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'model-button', value: choice.modelId, textContent: choice.label });
    modelButtons.push(button); modelBar.append(button);
  }

  const map = new maplibregl.Map({
    container: 'map', center: startup.camera?.center ?? [0, 20], zoom: startup.camera?.zoom ?? 2, maxTileCacheSize: RASTER_CACHE_TILES,
    style: offlineFixture ? { version: 8, sources: {}, layers: [{ id: 'neutral-background', type: 'background', paint: { 'background-color': '#d5dde3' } }] } : terrain?.style ?? basemapStyle()
  });
  terrain?.attach(map);
  const globalListener = { signal: lifecycle.signal };

  let build: PinnedBuild | null = null, currentModel: ModelId = initialModel, reference: AltitudeReference = startup.reference;
  let customLayer: LayerId | null = visibleCustomLayer(startup.layer), requestedTime = startup.validTime, selectedFrame: string | null = null, opacity = initialOpacity;
  let expired = false, mapFailed = false, mapReady = false, selectingOverlay = false;
  let overlayState: OverlayState = { displayed: null, requested: null, quality: null, viewLoading: false, overviewReady: 0, overviewTotal: 0, overviewFailed: 0, incomplete: false, replacementFailed: false };
  const scheduler = createForecastRequestScheduler(), windCache = new WindDataCache();
  const overlay = new RasterOverlay(map, apiBaseUrl, opacity, state => { overlayState = state; reconcileWind(); updateOverlayStatus(); }, scheduler.fetch);

  let ribbon: { build: PinnedBuild; layer: LayerId } | null = null, layerButtons: HTMLButtonElement[] = [], layerMenuSignature = '';
  let pendingModel: ModelId | null = null, resumeModel: ModelId | null = null;
  let loadAbort: AbortController | null = null, autoAbort: AbortController | null = null;
  const pointSeries = new PointSeriesController(api);
  const savedUnits = startup.units ?? stored('preview-units');
  let pointUnitSystem: UnitSystem = savedUnits === 'imperial' ? 'imperial' : 'metric';
  let timeZoneMode: TimeZoneMode = startup.timeZoneMode ?? (stored('preview-tz') === 'local' ? 'local' : 'utc');
  let pointHorizon: PointHorizon = 'day', windgram: PointWindgram | null = null;
  let updatePointSeries: ReturnType<PointWindgram['renderPointWindgram']> | null = null;
  let pointSelection: { update: ReturnType<PointWindgram['renderPointWindgram']>; frame: string | null; units: UnitSystem; mapFrame: string | null } | null = null;
  let expiryTimer: number | null = null, disposeExpiry = () => {};
  let urlReady = false, historyRevision = 0, applyingHistory: number | null = null, opacityCommitted = false;
  let windVisibleOverride: boolean | null = startup.windVisible;
  let windView: WindView | null = null, windRequest: WindRequest | null = null;
  let windLoadStatus: WindStatus = 'unavailable', windDisplayed = false, windLoading = false, windHeight: 'surface' | number | 'lift' = 'surface';
  let queuedWindLoad: (() => void) | null = null;
  let locationRevision = 0, locationMarker: HTMLElement | null = null, locationPoint: [number, number] | null = null, locationTimer: ReturnType<typeof setTimeout> | null = null;

  const activeZone = () => timeZoneMode === 'local' ? browserLocalZone() : 'UTC';
  const activeZoneLabel = () => timeZoneMode === 'local' ? 'Local' : 'UTC';
  const makeClock = () => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: activeZone() });
  const makePointClock = () => {
    const fmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: activeZone() });
    return (ms: number): string => {
      const p = Object.fromEntries(fmt.formatToParts(ms).map(part => [part.type, part.value]));
      return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${activeZoneLabel()}`;
    };
  };
  let displayedClock = makeClock(), pointClock = makePointClock();
  const hasWindData = (): boolean => Boolean(build?.manifest.mapData);

  const windOverlay = new WindOverlay(map);
  let lastControlVisible = true;
  const windControls = createWindControls(windControlsHost, {
    initial: {
      ...(startup.windStyle ? { style: startup.windStyle } : {}),
      ...(startup.windVisible !== null ? { visible: startup.windVisible } : {}),
      ...(startup.windHeight !== null ? { height: startup.windHeight } : {})
    },
    onChange(state) {
      if (state.visible !== lastControlVisible) { lastControlVisible = state.visible; windVisibleOverride = state.visible; }
      syncWindReservation();
      windOverlay.setOptions({ ...state, units: pointUnitSystem });
      if (windDisplayed && windHeight !== state.height) setWindField();
      updateWind(); updatePointWind(); writeUrl('replace');
    }
  });
  lastControlVisible = windControls.state.visible;
  const syncWindReservation = (): void => {
    const active = hasWindData() && windControls.state.visible;
    overlay.setWindActive(active, active || Boolean(windView) || windCache.allocatedBytes > 0);
  };
  const syncWindSupport = (): void => {
    windControlsHost.hidden = !hasWindData();
    if (!hasWindData()) clearWind();
    syncWindReservation();
  };
  const compactTimeline = createCompactTimeline(element('compact-timeline'), {
    timeZone: activeZone(), zoneLabel: activeZoneLabel(),
    onToggleTimeZone: () => setTimeZoneMode(timeZoneMode === 'utc' ? 'local' : 'utc'),
    onSelect: index => selectIndex(index, 'push')
  });
  syncWindSupport();
  windControls.setUnits(pointUnitSystem);
  windOverlay.setOptions({ ...windControls.state, units: pointUnitSystem });

  function setTimeZoneMode(mode: TimeZoneMode, commit = true): void {
    timeZoneMode = mode; store('preview-tz', mode); displayedClock = makeClock(); pointClock = makePointClock();
    compactTimeline.setTimeZone?.(activeZone(), activeZoneLabel());
    updateOverlayStatus(); updatePointWind();
    if (commit) writeUrl('replace');
  }

  function setWindField(): void {
    const view = windView;
    if (!view) return;
    const height = windControls.state.height;
    windHeight = height;
    windOverlay.setField(typeof view.source.field === 'function' ? view.source.field(height) : {
      sample: (lat, lon) => {
        const s = view.source.sample(lat, normalizeLon(lon), height);
        const status = s.status === 'valid' ? STATUS_VALID : s.status === 'no-lift' ? STATUS_NO_LIFT : s.status === 'outside' ? STATUS_OUTSIDE : STATUS_UNAVAILABLE;
        return { ...s, status };
      }
    });
  }

  function reconcileWind(): void {
    const displayed = overlayState.displayed;
    const matches = windView && windLoadStatus !== 'unavailable'
      && windView.build === build && windView.frame === selectedFrame
      && (!displayed || displayed.build === windView.build && displayed.frame === windView.frame);
    if (matches && !windDisplayed) { setWindField(); windDisplayed = true; }
    else if (!matches && windDisplayed) { windOverlay.clear(); windDisplayed = false; }
    windControls.setQuality?.(!!(matches && windView?.source.isOverview));
    if (windLoadStatus === 'ready') windControls.setStatus(matches ? 'ready' : overlayState.replacementFailed ? 'unavailable' : 'loading');
    syncWindReservation();
    updatePointWind();
  }

  function setWindStatus(status: WindStatus): void { windLoadStatus = status; windControls.setStatus(status); }
  function cancelWindRequest(): void { windRequest?.controller.abort(); windRequest?.source.dispose(); windRequest = null; queuedWindLoad = null; }

  function clearWind(): void {
    cancelWindRequest(); windView?.source.dispose(); windView = null; windDisplayed = false;
    windOverlay.clear(); windControls.setQuality?.(false); setWindStatus('unavailable'); syncWindReservation(); updatePointWind();
  }

  function updatePointWind(): void {
    const context = pointSeries.current, identity = windView;
    if (!context || !windDisplayed || !identity || context.build !== identity.build || pointSeries.frameId !== identity.frame) { pointWind.textContent = ''; return; }
    const validTime = identity.build.manifest.frames.find(f => f.id === identity.frame)?.validTime;
    if (!validTime) { pointWind.textContent = ''; return; }
    const sample = identity.source.sample(context.point.lat, context.point.lon, windControls.state.height);
    const speed = sample.status === 'valid' && sample.u !== null && sample.v !== null ? displayedWindSpeed(Math.hypot(sample.u, sample.v), pointUnitSystem) : null;
    const value = speed !== null ? `${speed} ${windSpeedUnitLabel(pointUnitSystem)}`
      : sample.status === 'outside' ? 'Outside forecast area' : sample.status === 'no-lift' ? 'No usable lift' : 'Wind unavailable';
    pointWind.textContent = `Map wind · ${pointClock(Date.parse(validTime))} · ${value}`;
  }

  function coversBounds(outer: readonly [number, number, number, number], inner: readonly [number, number, number, number]): boolean {
    const span = (w: number, e: number) => (e - w + 360) % 360 || (e === w ? 0 : 360);
    return inner[1] >= outer[1] && inner[3] <= outer[3] && span(outer[0], inner[0]) + span(inner[0], inner[2]) <= span(outer[0], outer[2]);
  }

  function updateWind(): void {
    if (!windControls.state.visible || !hasWindData()) { cancelWindRequest(); syncWindReservation(); return; }
    if (!mapReady || !build || !selectedFrame || expired || mapFailed || lifecycle.signal.aborted) return;
    if (windCache.isBuildUnavailable(build.manifest.buildId)) { clearWind(); return; }
    const bounds = map.getBounds(), west = bounds.getWest(), east = bounds.getEast();
    const view: [number, number, number, number] = [east - west >= 360 ? -180 : normalizeLon(west), Math.max(-90, bounds.getSouth()), east - west >= 360 ? 180 : normalizeLon(east), Math.min(90, bounds.getNorth())];
    const identity = windView;
    if (identity && identity.build === build && identity.frame === selectedFrame
      && (identity.source.isOverview === false || map.getZoom() <= identity.zoom)
      && coversBounds(identity.bounds, view)) {
      cancelWindRequest(); setWindStatus('ready'); reconcileWind(); return;
    }
    const key = JSON.stringify([build.manifest.model, build.manifest.buildId, selectedFrame, view, map.getZoom()]);
    if (key === windRequest?.key) return;
    if (!identity || identity.build !== build || identity.frame !== selectedFrame) clearWind();
    else cancelWindRequest();
    setWindStatus('loading');
    const request: WindRequest = {
      zoom: map.getZoom(), build, frame: selectedFrame, bounds: view, key, controller: new AbortController(),
      source: new WindDataSource(apiBaseUrl, { fetchImpl: scheduler.fetch, cache: windCache, coalesceSpans: true })
    };
    windRequest = request;
    if (windLoading) queuedWindLoad = () => { void loadWind(request); };
    else void loadWind(request);
  }

  async function loadWind(request: WindRequest): Promise<void> {
    windLoading = true;
    const retainFallback = () => Boolean(windView && windView.build === request.build && windView.frame === request.frame && coversBounds(windView.bounds, request.bounds));
    try {
      let status: 'ready' | 'unavailable';
      try {
        status = await request.source.load({ ...request, signal: request.controller.signal });
      } catch (error) {
        if (!(error instanceof RangeError) || !windView || retainFallback() || request.controller.signal.aborted) throw error;
        windView.source.dispose(); windView = null; windDisplayed = false; windOverlay.clear();
        status = await request.source.load({ ...request, signal: request.controller.signal });
      }
      if (windRequest !== request || request.controller.signal.aborted || !ensureLive()) return;
      if (status === 'ready') { windView?.source.dispose(); windView = request; if (windDisplayed) setWindField(); setWindStatus('ready'); }
      else setWindStatus(retainFallback() ? 'ready' : status);
      reconcileWind();
    } catch {
      if (windRequest === request && !request.controller.signal.aborted) { setWindStatus(retainFallback() ? 'ready' : 'unavailable'); reconcileWind(); }
    } finally {
      if (windRequest === request) windRequest = null;
      if (windView !== request) request.source.dispose();
      windLoading = false;
      const next = queuedWindLoad; queuedWindLoad = null; next?.();
    }
  }

  function updateScale(): void {
    const metres = 80 * 2 * Math.PI * 6371000 * Math.cos(Math.min(85, Math.abs(map.getCenter().lat)) * Math.PI / 180) / (512 * 2 ** map.getZoom());
    const distance = metres / (pointUnitSystem === 'metric' ? 1000 : 1609.344);
    const magnitude = 10 ** Math.floor(Math.log10(distance)), value = ([10, 5, 2, 1].find(v => v * magnitude <= distance) ?? 1) * magnitude;
    distanceScale.style.width = `${Math.max(1, 80 * value / distance)}px`;
    distanceScale.textContent = `${Number(value.toPrecision(2))} ${pointUnitSystem === 'metric' ? 'km' : 'mi'}`;
  }

  function setUnits(choice: UnitSystem, updateHistory = false): void {
    pointUnitSystem = choice;
    store('preview-units', choice);
    for (const [b, key] of [[metricButton, 'metric'], [imperialButton, 'imperial']] as const) b.ariaPressed = String(choice === key);
    pointUnits.value = choice;
    if (!overlayState.displayed || isLiftLayer(overlayState.displayed.layer)) element('lift-units').textContent = pointUnitSystem === 'metric' ? 'Lift m' : 'Lift ft';
    windControls.setUnits(pointUnitSystem); windOverlay.setOptions({ units: pointUnitSystem });
    ribbon = null;
    if (overlayState.displayed) renderRibbon(overlayState.displayed.layer, overlayState.displayed.build);
    updateScale(); updatePointSelection(); updatePointWind();
    if (updateHistory) writeUrl('replace');
  }

  const liftLayers = (v: PinnedBuild): LayerId[] => LIFT.filter(l => v.templates[l]);
  const nonLiftLayers = (v: PinnedBuild): LayerId[] => renderedLayers(v.manifest.layers, v.manifest.descriptors.layers).filter(l => v.templates[l] && !isLiftLayer(l) && !HIDDEN_PREVIEW_LAYERS.has(l));

  function activeLayer(): LayerId | null {
    if (!build) return null;
    if (customLayer && build.templates[customLayer]) return customLayer;
    const preferred: LayerId = reference === 'agl' ? 'usable-lift-agl' : 'usable-lift-msl';
    return build.templates[preferred] ? preferred : liftLayers(build)[0] ?? nonLiftLayers(build)[0] ?? null;
  }

  function syncLayerPicker(): void {
    if (!build) { layerPicker.hidden = true; return; }
    if (customLayer && !build.templates[customLayer]) customLayer = null;
    const items = [...(liftLayers(build).length ? [{ id: 'lift', label: 'Lift' }] : []), ...nonLiftLayers(build).map(id => ({ id, label: shortLayerName(id, build!.manifest.descriptors.layers[id]) }))];
    const sig = items.map(i => i.id).join('|');
    if (sig !== layerMenuSignature) {
      layerMenuSignature = sig;
      layerButtons = items.map(item => {
        const b = Object.assign(document.createElement('button'), { type: 'button', value: item.id, textContent: item.label });
        const prepare = () => {
          if (b.disabled || !selectedFrame || !build) return;
          const target = item.id === 'lift' ? (reference === 'agl' ? 'usable-lift-agl' : 'usable-lift-msl') : item.id as LayerId;
          if (build.templates[target]) overlay.prepare(target, selectedFrame);
        };
        for (const ev of ['pointerenter', 'focus', 'pointerdown']) b.addEventListener(ev, prepare);
        b.addEventListener('click', () => {
          if (b.disabled) return;
          customLayer = item.id === 'lift' ? null : item.id as LayerId;
          syncLayerPicker(); syncReference(); updateOverlay(); writeUrl('push');
          if (currentModel === AUTO_MODEL_ID) void loadAuto();
        });
        return b;
      });
      layerPicker.replaceChildren(...layerButtons);
    }
    layerPicker.hidden = items.length <= 1;
    const selectedId = customLayer ?? 'lift';
    for (const b of layerButtons) {
      b.className = b.value === selectedId ? 'layer-button is-selected' : 'layer-button';
      b.ariaPressed = String(b.value === selectedId); b.disabled = !build || expired || mapFailed;
    }
  }

  function syncReference(): void {
    for (const [b, r] of [[refAgl, 'agl'], [refMsl, 'msl']] as const) { b.className = reference === r ? 'ref is-selected' : 'ref'; b.ariaPressed = String(reference === r); }
    referenceGroup.hidden = customLayer !== null;
  }

  function syncModels(): void {
    for (const b of modelButtons) b.className = b.value === currentModel ? 'model-button is-selected' : 'model-button';
    const label = modelButtons.find(b => b.value === currentModel)?.textContent ?? currentModel;
    element('model-name').textContent = currentModel === AUTO_MODEL_ID && build ? `${label} · ${build.manifest.model}` : label;
    modelSelected.dataset.model = currentModel === AUTO_MODEL_ID ? build?.manifest.model ?? 'auto' : currentModel;
  }

  function writeUrl(mode: 'push' | 'replace'): void {
    if (applyingHistory || !mapReady || !urlReady || pendingModel) return;
    const camera = map.getCenter(), wState = windControls.state;
    const validTime = currentModel === AUTO_MODEL_ID ? requestedTime ?? undefined : build?.manifest.frames.find(f => f.id === selectedFrame)?.validTime;
    const next = previewUrl(window.location.pathname, {
      model: currentModel, reference, layer: customLayer, opacity, lat: camera.lat, lon: camera.lng, zoom: map.getZoom(),
      validTime, ...(windVisibleOverride !== null ? { windVisible: wState.visible } : {}), windStyle: wState.style, windHeight: wState.height, units: pointUnitSystem, timeZoneMode
    });
    if (next !== `${window.location.pathname}${window.location.search}`) window.history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', next);
  }

  const showError = (msg: string): void => { errorBox.hidden = false; errorBox.textContent = msg; };
  const clearError = (): void => { errorBox.hidden = true; errorBox.textContent = ''; };
  const setPointStatus = (msg = ''): void => { pointStatus.textContent = msg; pointStatus.hidden = !msg; };

  function closePoint(): void {
    pointSeries.close(); pointCard.hidden = true; pointCard.ariaBusy = 'false';
    pointSettings.open = pointBuildDetails.open = false; setPointStatus();
    windgram?.disposePointWindgram(pointBody); pointBody.replaceChildren();
    updatePointSeries = pointSelection = null; pointWind.textContent = ''; pointBody.tabIndex = -1; meta.replaceChildren();
  }

  function setControlsEnabled(enabled: boolean): void {
    for (const b of modelButtons) b.disabled = mapFailed || pendingModel !== null;
    for (const b of layerButtons) b.disabled = !enabled;
    refAgl.disabled = refMsl.disabled = opacityInput.disabled = timeInput.disabled = !enabled;
    compactTimeline.update(build ? renderedFrames(build.manifest) : [], selectedFrame, !enabled);
  }

  function updateFreshness(): void {
    overlay.refresh();
    if (!build || expired) return;
    const now = Date.now();
    if (build.expiresAtMs <= now) { expireView(); return; }
    const notice = mapForecastHorizonNotice(build.manifest, now);
    horizonNotice.textContent = notice ?? ''; horizonNotice.hidden = notice === null;
    freshness.textContent = (currentModel === AUTO_MODEL_ID ? `${build.manifest.model} · ` : '') + formatBuildFreshness(build.manifest, build.expiresAtMs, now);
  }

  function renderRibbon(layer: LayerId, displayedBuild = build): void {
    if (!legend.hidden && ribbon?.build === displayedBuild && ribbon.layer === layer) return;
    const palette = displayedBuild ? activePalettes(displayedBuild.manifest.descriptors.palettes, layer, displayedBuild.manifest.descriptors.layers)[0] : undefined;
    if (!displayedBuild || !palette) { legend.hidden = true; legendBody.replaceChildren(); return; }
    legend.hidden = false; ribbon = { build: displayedBuild, layer };
    const descriptor = displayedBuild.manifest.descriptors.layers[layer], liftLayer = isLiftLayer(layer);
    referenceGroup.hidden = !liftLayer;
    const altitudeUnit = pointUnitSystem === 'imperial' ? 'ft' : 'm';
    element('lift-units').textContent = liftLayer ? `Lift ${altitudeUnit}` : `${shortLayerName(layer, descriptor)} ${palette.units}`;

    const title = Object.assign(document.createElement('p'), {
      className: 'ribbon-title',
      textContent: layer === 'usable-lift-agl' ? `Lift above ground (${altitudeUnit} AGL)` : layer === 'usable-lift-msl' ? `Top of usable lift (${altitudeUnit} MSL)` : `${descriptor.label} (${palette.units})`
    });
    const scale = Object.assign(document.createElement('div'), { className: 'ribbon-scale' }), colorCount = palette.colors.length;
    palette.colors.forEach((color, index) => {
      const edge = index === colorCount - 1 && palette.edges.length > colorCount ? palette.edges[colorCount] : palette.edges[index];
      const showTick = edge !== undefined && (index === 0 || index === colorCount - 1 || index === Math.floor(colorCount / 3) || index === Math.floor(colorCount * 2 / 3));
      const val = edge === undefined ? 0 : liftLayer ? Math.round(edge * (pointUnitSystem === 'imperial' ? 3.280839895 : 1)) : edge;
      const label = !showTick ? '' : !liftLayer ? (val >= 100 ? String(Math.round(val)) : String(Number(val.toFixed(1)))) : val >= 1000 ? `${Number((val / 1000).toFixed(1))}k` : String(val);
      const row = Object.assign(document.createElement('div'), { className: 'ribbon-stop' }), swatch = document.createElement('span'), tick = Object.assign(document.createElement('span'), { textContent: label });
      swatch.style.background = color; row.append(swatch, tick); scale.append(row);
    });
    const body = Object.assign(document.createElement('div'), { className: 'ribbon-main' });
    body.append(title, scale);
    if (liftLayer) {
      element('legend-reference').textContent = layer === 'usable-lift-agl' ? 'AGL shows usable lift height above ground.' : 'MSL includes ground elevation. Choose AGL to see usable lift height above ground.';
      const renderStyle = displayedBuild.manifest.tool.liftRenderStyle;
      element('legend-no-lift').textContent = layer === 'usable-lift-msl' && (renderStyle === LIFT_STEP_RENDER_STYLE || renderStyle === LIFT_RENDER_STYLE)
        ? 'No usable lift: the map shows ground elevation, including at night.' : 'No usable lift: clear areas on the map.';
      const sink = displayedBuild.manifest.descriptors.methods[descriptor.methodId]?.parameters.sinkRateMps;
      element('legend-cutoff').textContent = Number.isFinite(sink) && sink > 0 ? `Usable lift requires predicted updrafts above ${sink} m/s. Nearby terrain can cross this cutoff.` : 'Usable lift depends on the predicted updraft and terrain.';
    } else {
      element('legend-reference').textContent = `${descriptor.label} in ${palette.units}.`;
      element('legend-no-lift').textContent = descriptor.hideNonPositiveValues ? 'Zero or trace values are clear on the map.' : 'Shaded across all covered cells.';
      element('legend-cutoff').textContent = descriptor.timeSupport.startsWith('interval') ? 'Aggregated over the forecast interval ending at the selected time.' : 'Instantaneous value at the selected valid time.';
    }
    legendBody.replaceChildren(body);
  }

  function updateTimeUi(): void {
    const frames = build ? renderedFrames(build.manifest) : [];
    compactTimeline.update(frames, selectedFrame, !build || expired || mapFailed);
    if (!build || !selectedFrame) { timestamp.textContent = expired ? 'Build expired — overlay removed' : 'No frame selected'; return; }
    const selected = frames.find(f => f.id === selectedFrame) ?? frames[0];
    timeInput.max = String(Math.max(0, frames.length - 1));
    if (document.activeElement !== timeInput) timeInput.value = String(Math.max(0, frames.findIndex(f => f.id === selectedFrame)));
    timestamp.textContent = selected ? `Selected · ${clockLabel(Date.parse(selected.validTime), longitudeOffsetHours(map.getCenter().lng) * 60)}` : 'No frame selected';
  }

  function updateOverlayStatus(): void {
    const { displayed, requested, quality, viewLoading, overviewReady, overviewTotal, overviewFailed, incomplete, replacementFailed } = overlayState;
    const showing = displayed ? `Showing ${displayed.build.manifest.model} ${displayed.frame} ${displayed.layer}.` : 'No forecast displayed.';
    const pending = requested && (!displayed || displayed.build !== requested.build || displayed.layer !== requested.layer || displayed.frame !== requested.frame);
    const olderBuild = displayed && displayed.build !== build;
    const displayedTime = displayed?.build.manifest.frames.find(f => f.id === displayed.frame)?.validTime;
    const displayedLabel = displayedTime ? `${displayedClock.format(Date.parse(displayedTime))} ${activeZoneLabel()}` : '';
    frameStatus.dataset.quality = quality ?? 'none';
    const status = !displayed ? requested ? replacementFailed ? 'Forecast unavailable · No forecast shown' : 'Loading selected time · No forecast shown' : expired ? 'Forecast expired' : pendingModel ? 'Loading forecast…' : 'No forecast shown'
      : pending ? `Showing ${displayedLabel} · ${replacementFailed ? 'Selected time unavailable' : 'Loading selected time…'}`
      : quality === 'overview' ? `${displayedLabel} · Overview · ${replacementFailed ? 'Detail unavailable' : 'Loading detail…'}`
      : viewLoading ? `${displayedLabel} · Loading this view…` : `${displayedLabel} · ${incomplete ? 'Detail incomplete' : 'Full detail'}`;
    if (frameStatus.textContent !== status) frameStatus.textContent = status;
    timelineStatus.dataset.ready = String(overviewReady); timelineStatus.dataset.total = String(overviewTotal); timelineStatus.hidden = !overviewTotal;
    timelineStatus.textContent = overviewReady === overviewTotal ? 'Timeline ready' : `${overviewReady + overviewFailed === overviewTotal ? 'Timeline partly ready' : 'Preparing timeline'} · ${overviewReady} / ${overviewTotal} times ready`;
    const alert = replacementFailed || incomplete;
    tileErrorBox.className = alert ? 'toast error' : 'toast status'; tileErrorBox.role = alert ? 'alert' : 'status';
    tileErrorBox.hidden = !alert && !pendingModel && !olderBuild;
    tileErrorBox.textContent = replacementFailed ? `Forecast replacement failed. ${showing}` : incomplete ? `Overlay tile failed to load — forecast display may be incomplete. ${showing}` : pendingModel ? `Loading ${pendingModel}. ${showing}` : olderBuild ? showing : '';
    if (displayed) renderRibbon(displayed.layer, displayed.build); else { legend.hidden = true; legendBody.replaceChildren(); }
    if (!selectingOverlay) updatePointSelection();
  }

  const displayedPointFrame = (): string | null => overlayState.displayed?.build === build ? overlayState.displayed.frame : null;

  function updatePointSelection(): void {
    updatePointWind();
    if (!updatePointSeries) return;
    const frame = pointSeries.frameId, mapFrame = displayedPointFrame();
    if (pointSelection?.update === updatePointSeries && pointSelection.frame === frame && pointSelection.units === pointUnitSystem && pointSelection.mapFrame === mapFrame) return;
    pointSelection = { update: updatePointSeries, frame, units: pointUnitSystem, mapFrame };
    updatePointSeries(frame, pointUnitSystem, mapFrame);
  }

  function expireView(): void {
    if (expired) return;
    expired = true;
    tileErrorBox.hidden = horizonNotice.hidden = true; tileErrorBox.textContent = horizonNotice.textContent = '';
    if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; }
    loadAbort?.abort(); windCache.clear(); clearWind(); closePoint(); disposeExpiry(); overlay.clear();
    setControlsEnabled(false);
    timestamp.textContent = 'Build expired — overlay removed'; freshness.textContent = 'Expired immutable build';
    showError('This build has expired. Reload to discover the latest retained build.');
    if (currentModel === AUTO_MODEL_ID) void loadAuto();
  }

  function ensureLive(): boolean {
    if (!build || mapFailed) return false;
    try { assertNotExpired(build.manifest.expiresAt, Date.now()); return true; } catch { expireView(); return false; }
  }

  function updateOverlay(): void {
    const layer = activeLayer();
    if (!mapReady || !build || !selectedFrame || !layer || !ensureLive()) return;
    clearError(); selectingOverlay = true;
    try { overlay.select(build, layer, selectedFrame); }
    catch (error) { showError(`Overlay display failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { selectingOverlay = false; updatePointSelection(); }
    updateWind();
  }

  function selectIndex(index: number, history: 'none' | 'push' | 'replace'): void {
    const frame = build ? renderedFrames(build.manifest)[index] : undefined;
    if (!frame) return;
    if (selectedFrame !== frame.id && windControls.state.visible) clearWind();
    if (currentModel === AUTO_MODEL_ID && requestedTime !== frame.validTime) autoAbort?.abort();
    selectedFrame = frame.id; requestedTime = frame.validTime;
    updateTimeUi(); pointSeries.followMapFrame(selectedFrame); updateOverlay(); updatePointSelection();
    if (history !== 'none') { writeUrl(history); if (currentModel === AUTO_MODEL_ID) void loadAuto(); }
  }

  const followMapFrame = (): void => { pointSeries.followMapFrame(selectedFrame); updatePointSelection(); };
  function chooseFrame(value: PinnedBuild): void {
    const frames = renderedFrames(value.manifest);
    selectedFrame = frames[frameIndexFor(frames, requestedTime, Date.now())]?.id ?? null;
    const frame = value.manifest.frames.find(f => f.id === selectedFrame);
    if (frame) requestedTime = frame.validTime;
  }

  async function loadAuto(): Promise<void> {
    if (currentModel !== AUTO_MODEL_ID || mapFailed || lifecycle.signal.aborted) return;
    autoAbort?.abort();
    const request = new AbortController(); autoAbort = request;
    const { lat, lng } = map.getCenter(), time = Date.parse(requestedTime ?? '');
    const layers = customLayer ? [customLayer, ...LIFT] : reference === 'agl' ? LIFT : [...LIFT].reverse();
    if (!build) freshness.textContent = 'Finding a forecast for this location…';
    try {
      const pending = initialDiscovery?.auto;
      if (pending) { initialDiscovery!.auto = undefined; request.signal.addEventListener('abort', () => initialDiscovery?.controller.abort(), { once: true }); }
      const next = await (pending ?? resolveAutoBuild(api, { ...normalizePoint(lat, lng), layers, signal: request.signal, ...(Number.isFinite(time) ? { validTimeMs: time } : {}) }));
      if (request.signal.aborted || autoAbort !== request || currentModel !== AUTO_MODEL_ID) return;
      if (next) {
        if (build?.manifest.model === next.build.manifest.model && build.manifest.buildId === next.build.manifest.buildId) {
          selectedFrame = next.frame.id; followMapFrame(); updateTimeUi(); updateOverlay(); updateFreshness();
          if (expiryTimer === null) expiryTimer = window.setInterval(updateFreshness, 5000);
          writeUrl('replace');
        } else await loadModel(AUTO_MODEL_ID, next);
        return;
      }
      disposeExpiry();
      if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; }
      build = selectedFrame = null; syncModels(); syncWindSupport();
      clearWind(); closePoint(); overlay.clear(); updateTimeUi(); setControlsEnabled(false);
      showError('No forecast covers this location and time.'); freshness.textContent = 'No viewable build';
      urlReady = true; writeUrl('replace');
    } catch (error) {
      if (!request.signal.aborted) showError(error instanceof Error ? error.message : String(error));
    } finally { if (autoAbort === request) autoAbort = null; }
  }

  async function loadModel(model: ModelId, resolved?: AutoForecastSelection): Promise<void> {
    if (mapFailed) return;
    clearWind();
    if (model === AUTO_MODEL_ID && !resolved) {
      loadAbort?.abort(); loadAbort = pendingModel = null; currentModel = model;
      syncModels(); setControlsEnabled(build !== null && !expired);
      await loadAuto(); return;
    }
    if (model !== AUTO_MODEL_ID) autoAbort?.abort();
    const replaceUrl = applyingHistory === null, revision = historyRevision;
    disposeExpiry();
    if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; }
    loadAbort?.abort();
    const requestAbort = new AbortController(); loadAbort = requestAbort;
    pendingModel = model; resumeModel = null; currentModel = model; expired = false;
    syncModels();
    tileErrorBox.hidden = horizonNotice.hidden = legend.hidden = true; tileErrorBox.textContent = horizonNotice.textContent = '';
    build = selectedFrame = null; syncWindSupport(); syncLayerPicker(); updateTimeUi(); legendBody.replaceChildren();
    closePoint(); setControlsEnabled(false); clearError();
    freshness.textContent = `Loading ${model} latest immutable build…`; timestamp.textContent = 'No frame selected';
    updateOverlayStatus();
    try {
      const pending = initialDiscovery?.model === model ? initialDiscovery.build : undefined;
      if (pending) { initialDiscovery!.build = undefined; requestAbort.signal.addEventListener('abort', () => initialDiscovery?.controller.abort(), { once: true }); }
      const next = resolved?.build ?? await (pending ?? api.latest(model, { signal: requestAbort.signal }));
      if (requestAbort.signal.aborted || loadAbort !== requestAbort) return;
      build = next; syncModels(); syncWindSupport(); syncLayerPicker();
      pointHorizonLabel.hidden = pointSeriesSelection(next).frames.length === next.manifest.frames.length;
      pointHorizonSelect.children[0].textContent = next.manifest.mapFrameCount !== undefined ? 'Map forecast' : '24 hours';
      if (resolved) selectedFrame = resolved.frame.id; else chooseFrame(next);
      updateTimeUi(); updateOverlay(); updateFreshness(); setControlsEnabled(true); syncReference();
      disposeExpiry = watchBuildExpiry(next.expiresAtMs, expireView, [document, window]);
      if (expiryTimer === null) expiryTimer = window.setInterval(updateFreshness, 5000);
      if (loadAbort === requestAbort) pendingModel = null;
      urlReady = true;
      if (replaceUrl && revision === historyRevision) writeUrl('replace');
    } catch (error) {
      if (requestAbort.signal.aborted || loadAbort !== requestAbort || (error instanceof DOMException && error.name === 'AbortError')) return;
      showError(error instanceof Error ? error.message : String(error)); freshness.textContent = 'No viewable build'; setControlsEnabled(false);
    } finally {
      if (loadAbort === requestAbort) {
        loadAbort = pendingModel = null;
        for (const b of modelButtons) b.disabled = mapFailed;
        updateOverlayStatus();
      }
    }
  }

  function focusRegion(model: ModelId): void {
    const bounds = MODEL_OPTIONS.find(c => c.modelId === model)?.bounds;
    if (bounds && bounds[2] - bounds[0] < 360) map.fitBounds([[bounds[0], bounds[1]], [bounds[0] <= bounds[2] ? bounds[2] : bounds[2] + 360, bounds[3]]], { padding: 32, duration: 0 });
  }

  function showPoint(context: PointSeriesContext, payload: PointSeries, totalFrames: number, loading: boolean): void {
    if (!windgram) return;
    updatePointSeries = windgram.renderPointWindgram(pointBody, payload, context.build, {
      point: context.point, frameId: pointSeries.frameId, mapFrameId: displayedPointFrame(), unitSystem: pointUnitSystem, totalFrames, loading,
      onFrame(id) {
        if (build !== context.build || !ensureLive() || !pointSeries.selectFrame(context, id)) return;
        const index = renderedFrames(context.build.manifest).findIndex(f => f.id === id);
        if (index >= 0) selectIndex(index, 'push'); else updatePointSelection();
      }
    });
    pointBody.tabIndex = 0; pointCard.ariaBusy = String(loading);
    if (!loading) setPointStatus();
  }

  async function openPoint(point: GeoPoint): Promise<void> {
    if (!build || expired || mapFailed || !ensureLive()) return;
    pointSeries.open(build, point);
    pointCard.hidden = false; pointSettings.open = pointBuildDetails.open = false;
    pointLocation.textContent = `${point.lat.toFixed(3)}°, ${point.lon.toFixed(3)}°`;
    updatePointWind(); meta.replaceChildren(); windgram?.disposePointWindgram(pointBody);
    pointBody.replaceChildren(); updatePointSeries = pointSelection = null; pointBody.tabIndex = -1;
    await loadPointRange();
  }

  async function loadPointRange(): Promise<void> {
    const context = pointSeries.current;
    if (!context || build !== context.build || !ensureLive()) return;
    await pointSeries.load(pointHorizon, selectedFrame, {
      canRender: () => build === context.build && ensureLive(),
      prepare: windgram ? undefined : async () => { windgram = await import('@av/windgram'); },
      onLoading() { pointCard.ariaBusy = 'true'; setPointStatus('Loading forecast…'); updatePointWind(); },
      onProgress(payload, totalFrames, loading) { showPoint(context, payload, totalFrames, loading); },
      onError(detail) {
        updatePointSeries?.(pointSeries.frameId, pointUnitSystem, displayedPointFrame(), false);
        pointCard.ariaBusy = 'false'; setPointStatus(pointBody.children.length ? detail : `Forecast unavailable. ${detail}`);
      }
    });
  }

  async function applyHistory(): Promise<void> {
    if (lifecycle.signal.aborted) return;
    const state = previewQuery(window.location.search, offlineFixture), change = ++historyRevision;
    applyingHistory = change;
    try {
      reference = state.reference; customLayer = visibleCustomLayer(state.layer);
      syncLayerPicker(); syncReference();
      const nextUnits: UnitSystem = state.units ?? 'metric';
      if (nextUnits !== pointUnitSystem) setUnits(nextUnits);
      const nextTz: TimeZoneMode = state.timeZoneMode ?? 'utc';
      if (nextTz !== timeZoneMode) setTimeZoneMode(nextTz, false);
      windVisibleOverride = state.windVisible;
      const nextVisible = state.windVisible ?? (windControls.preferredVisible?.() ?? true), nextStyle = state.windStyle ?? 'trails', nextHeight = state.windHeight ?? 'surface';
      lastControlVisible = nextVisible;
      if (nextVisible !== windControls.state.visible || nextStyle !== windControls.state.style || nextHeight !== windControls.state.height) {
        windControls.setState?.({ visible: nextVisible, style: nextStyle, height: nextHeight });
        syncWindReservation();
        windOverlay.setOptions({ ...windControls.state, units: pointUnitSystem });
        if (windDisplayed && windHeight !== windControls.state.height) setWindField();
      }
      if (state.opacity !== null) {
        opacity = state.opacity; opacityInput.value = String(opacity);
        opacityReadout.textContent = `${Math.round(opacity * 100)}%`; overlay.setOpacity(opacity);
      }
      if (state.camera) map.jumpTo(state.camera, { previewHistory: true });
      requestedTime = state.validTime;
      if (state.model && state.model !== currentModel) { await loadModel(state.model); return; }
      if (currentModel === AUTO_MODEL_ID) { await loadAuto(); return; }
      if (build) {
        const previousFrame = selectedFrame;
        chooseFrame(build);
        if (selectedFrame !== previousFrame) followMapFrame();
        updateTimeUi(); updateOverlay();
      }
    } finally { if (applyingHistory === change) applyingHistory = null; }
  }

  for (const button of modelButtons) {
    button.addEventListener('click', () => {
      if (button.disabled || mapFailed) return;
      if (currentModel === AUTO_MODEL_ID) applyingHistory = null;
      modelPicker.open = false; void loadModel(button.value as ModelId); focusRegion(button.value as ModelId);
    });
  }
  for (const [control, layer, nextRef] of [[refAgl, 'usable-lift-agl', 'agl'], [refMsl, 'usable-lift-msl', 'msl']] as const) {
    const prepare = () => { if (!control.disabled && selectedFrame) overlay.prepare(layer, selectedFrame); };
    for (const ev of ['pointerenter', 'focus', 'pointerdown']) control.addEventListener(ev, prepare);
    control.addEventListener('click', () => {
      reference = nextRef; customLayer = null;
      syncLayerPicker(); syncReference(); updateOverlay(); writeUrl('push');
      if (currentModel === AUTO_MODEL_ID) void loadAuto();
    });
  }
  opacityInput.addEventListener('pointerdown', () => { opacityCommitted = false; });
  opacityInput.addEventListener('input', () => {
    opacity = Math.min(1, Math.max(0, Number(opacityInput.value)));
    store('preview-lift-opacity', String(opacity));
    opacityReadout.textContent = `${Math.round(opacity * 100)}%`; overlay.setOpacity(opacity);
    writeUrl(opacityCommitted ? 'replace' : 'push'); opacityCommitted = true;
  });
  opacityInput.addEventListener('change', () => { opacityCommitted = false; });
  timeInput.addEventListener('input', () => selectIndex(Number(timeInput.value), 'none'));
  timeInput.addEventListener('change', () => { writeUrl('replace'); if (currentModel === AUTO_MODEL_ID) void loadAuto(); });
  setUnits(pointUnitSystem);
  metricButton.addEventListener('click', () => setUnits('metric', true));
  imperialButton.addEventListener('click', () => setUnits('imperial', true));
  pointUnits.addEventListener('change', () => setUnits(pointUnits.value === 'imperial' ? 'imperial' : 'metric', true));

  const positionLocationMarker = (): void => {
    if (!locationMarker || !locationPoint) return;
    const p = map.project(locationPoint); locationMarker.style.left = `${p.x}px`; locationMarker.style.top = `${p.y}px`;
  };
  const clearLocationMarker = (): void => {
    if (locationTimer !== null) clearTimeout(locationTimer);
    locationTimer = null; map.off('move', positionLocationMarker);
    locationMarker?.remove(); locationMarker = locationPoint = null;
  };

  locateButton.addEventListener('click', () => {
    if (locateButton.disabled || mapFailed) return;
    const revision = ++locationRevision;
    if (!navigator.geolocation) { locationStatus.textContent = 'Location unavailable'; return; }
    locateButton.disabled = true; locateButton.ariaBusy = 'true'; locationStatus.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(position => {
      if (revision !== locationRevision || lifecycle.signal.aborted) return;
      locateButton.disabled = false; locateButton.ariaBusy = 'false'; locationStatus.textContent = '';
      clearLocationMarker();
      const point: [number, number] = [position.coords.longitude, position.coords.latitude];
      map.jumpTo({ center: point, zoom: Math.max(map.getZoom(), 10) });
      const dot = Object.assign(document.createElement('div'), { className: 'location-pulse' });
      dot.setAttribute('aria-hidden', 'true'); locationMarker = dot; locationPoint = point;
      element('map').append(dot); positionLocationMarker(); map.on('move', positionLocationMarker);
      locationTimer = setTimeout(clearLocationMarker, 2000);
    }, error => {
      if (revision !== locationRevision || lifecycle.signal.aborted) return;
      locateButton.disabled = false; locateButton.ariaBusy = 'false';
      locationStatus.textContent = error.code === 1 ? 'Location permission denied' : error.code === 3 ? 'Location timed out' : 'Location unavailable';
    }, { timeout: 10_000 });
  });

  pointHorizonSelect.value = pointHorizon;
  pointHorizonSelect.addEventListener('change', () => { pointHorizon = pointHorizonSelect.value === 'forecast' ? 'forecast' : 'day'; void loadPointRange(); });
  pointClose.addEventListener('click', closePoint);
  pointBuildDetails.addEventListener('toggle', () => {
    if (pointBuildDetails.open && build && pointSeries.current && !meta.children.length) renderBuildDiagnostics(meta, build);
  });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement | null)?.matches?.('input,select,textarea,button')) return;
    if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || !build || !ensureLive()) return;
    event.preventDefault();
    const frames = renderedFrames(build.manifest), index = frames.findIndex(f => f.id === selectedFrame);
    selectIndex(Math.max(0, Math.min(frames.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1))), 'replace');
  }, globalListener);

  const pointControls = [pointCard, refAgl, refMsl, layerPicker, timeInput, element('wind-controls'), element('compact-timeline'), element('display-units')];
  document.addEventListener('pointerdown', event => {
    if (!pointSeries.current) return;
    const target = event.target;
    if (!(target instanceof Node) || map.getContainer().contains(target) || pointControls.some(c => c.contains(target))) return;
    closePoint();
  }, globalListener);

  map.on('click', event => { if (!mapFailed) void openPoint(normalizePoint(event.lngLat.lat, event.lngLat.lng)); });
  map.on('movestart', event => { if (currentModel === AUTO_MODEL_ID && !('previewHistory' in event)) { applyingHistory = null; autoAbort?.abort(); } });
  map.on('moveend', () => {
    updateScale();
    if (currentModel !== AUTO_MODEL_ID) updateWind();
    if (build && !expired) updateTimeUi();
    if (currentModel === AUTO_MODEL_ID && !applyingHistory) void loadAuto();
    if (urlReady && !applyingHistory) writeUrl('push');
  });

  const teardownAll = () => {
    windOverlay.destroy(); windControls.destroy(); compactTimeline.destroy(); terrain?.dispose();
    overlay.destroy(); scheduler.dispose(); map.remove();
  };

  map.on('error', (event: { error?: unknown }) => {
    if (mapFailed || !(event.error instanceof maplibregl.GPUInitializationError)) return;
    mapFailed = true; lifecycle.abort(); autoAbort?.abort(); loadAbort?.abort(); loadAbort = pendingModel = resumeModel = null;
    closePoint(); disposeExpiry(); windCache.clear(); clearWind(); locationRevision++; clearLocationMarker();
    if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; }
    teardownAll(); showMapFailure(event.error);
  });

  window.addEventListener('popstate', applyHistory, globalListener);
  window.addEventListener('pagehide', (event: PageTransitionEvent) => {
    windCache.clear(); clearWind(); locationRevision++; clearLocationMarker();
    locateButton.disabled = false; locateButton.ariaBusy = 'false';
    resumeModel = event.persisted ? (pendingModel ?? (currentModel === AUTO_MODEL_ID ? AUTO_MODEL_ID : null)) : null;
    loadAbort?.abort(); autoAbort?.abort();
    const pointInterrupted = event.persisted && pointSeries.pending;
    if (pointInterrupted) {
      pointCard.hidden = false; pointCard.ariaBusy = 'false';
      setPointStatus('Point request interrupted. Click the map again.');
      windgram?.disposePointWindgram(pointBody); updatePointSeries = pointSelection = null;
    }
    if (!event.persisted || pointInterrupted) pointSeries.close();
    if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; }
    overlay.clear(true);
    if (event.persisted) return;
    lifecycle.abort(); windgram?.disposePointWindgram(pointBody); updatePointSeries = pointSelection = null;
    disposeExpiry(); teardownAll();
  }, globalListener);

  window.addEventListener('pageshow', (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    if (resumeModel !== null) { const m = resumeModel; resumeModel = null; void loadModel(m); return; }
    if (build && ensureLive()) {
      updateTimeUi(); updateOverlay(); setControlsEnabled(true); updateFreshness();
      if (expiryTimer === null) expiryTimer = window.setInterval(updateFreshness, 5000);
    }
  }, globalListener);

  document.addEventListener('visibilitychange', updateFreshness, globalListener);
  window.addEventListener('focus', updateFreshness, globalListener);
  syncReference(); syncModels();

  map.once('style.load', () => {
    if (lifecycle.signal.aborted || mapFailed) return;
    if (!startup.camera) focusRegion(currentModel);
    mapReady = true; updateOverlay(); writeUrl('replace');
  });
  void loadModel(initialModel);
}

function showMapFailure(error: unknown): void {
  for (const b of modelButtons) b.disabled = true;
  for (const c of [refAgl, refMsl, opacityInput, timeInput]) c.disabled = true;
  errorBox.hidden = false;
  errorBox.textContent = error instanceof maplibregl.GPUInitializationError
    ? 'Map unavailable: this browser needs WebGL2. Enable graphics acceleration or try another browser.'
    : `Map initialization failed: ${error instanceof Error ? error.message : String(error)}`;
  timestamp.textContent = 'Map unavailable'; freshness.textContent = '';
}

function bootstrap(): void {
  const lifecycle = new AbortController();
  const key = offlineFixture ? '' : import.meta.env.VITE_GOOGLE_MAPS_API_KEY?.trim() ?? '';
  if (!key) {
    try { startPreview(lifecycle, null, null); } catch (error) { lifecycle.abort(); showMapFailure(error); }
    return;
  }
  const controller = new AbortController();
  lifecycle.signal.addEventListener('abort', () => controller.abort(), { once: true });
  const discovery: InitialDiscovery = { controller };
  if (initialModel === AUTO_MODEL_ID) {
    const [lng, lat] = startup.camera?.center ?? [0, 20], time = Date.parse(startup.validTime ?? ''), startLayer = visibleCustomLayer(startup.layer);
    const layers = startLayer ? [startLayer, ...LIFT] : startup.reference === 'agl' ? LIFT : [...LIFT].reverse();
    discovery.auto = resolveAutoBuild(api, { ...normalizePoint(lat, lng), layers, signal: controller.signal, ...(Number.isFinite(time) ? { validTimeMs: time } : {}) });
    void discovery.auto.catch(() => {});
  } else {
    discovery.model = initialModel; discovery.build = api.latest(initialModel, { signal: controller.signal });
    void discovery.build.catch(() => {});
  }
  const onPagehide = (event: PageTransitionEvent): void => {
    lifecycle.abort();
    if (event.persisted) window.addEventListener('pageshow', bootstrap, { once: true });
  };
  window.addEventListener('pagehide', onPagehide);
  const session = new AbortController();
  lifecycle.signal.addEventListener('abort', () => session.abort(), { once: true });
  const timeout = setTimeout(() => session.abort(), 2_500);
  void googleTerrainStyle(key, session.signal).catch(() => {
    if (!lifecycle.signal.aborted) {
      const warning = Object.assign(document.createElement('p'), { className: 'toast basemap-warning', textContent: 'Google terrain unavailable. Using OpenStreetMap.' });
      warning.setAttribute('role', 'status'); document.getElementById('app')?.append(warning);
    }
    return null;
  }).finally(() => clearTimeout(timeout)).then(terrain => {
    window.removeEventListener('pagehide', onPagehide);
    if (lifecycle.signal.aborted) { terrain?.dispose(); return; }
    try { startPreview(lifecycle, terrain, discovery); }
    catch (error) { terrain?.dispose(); lifecycle.abort(); showMapFailure(error); }
  });
}

bootstrap();
