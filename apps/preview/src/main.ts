import { renderBuildDiagnostics } from '@av/client/dom';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { LIFT_RENDER_STYLE, LIFT_STEP_RENDER_STYLE, STATUS_VALID, type LayerId } from '@av/contracts/layers';
import { normalizeLon } from '@av/contracts/geometry';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import { renderedFrames, type ModelId } from '@av/contracts/publication';
import {
  ApiClient,
  createForecastRequestScheduler,
  AUTO_MODEL_ID,
  activePalettes,
  assertNotExpired,
  pointSeriesSelection,
  mapForecastHorizonNotice,
  formatBuildFreshness,
  longitudeOffsetHours,
  normalizePoint,
  PointSeriesController,
  resolveAutoBuild,
  watchBuildExpiry,
  type AutoForecastSelection,
  type GeoPoint,
  type PinnedBuild,
  type PointSeries,
  type PointSeriesContext,
  type PointHorizon,
  type UnitSystem
} from '@av/client';
import './style.css';
import { RasterOverlay, type OverlayState } from './raster-overlay';
import { RASTER_CACHE_TILES } from './raster-budget';
import { previewQuery, previewUrl, type AltitudeReference } from './url-state';
import { clockLabel, frameIndexFor } from './timeline';
import { WindOverlay } from './wind-overlay';
import { createWindControls, type WindStatus } from './wind-controls';
import { createCompactTimeline } from './compact-timeline';
import { WindDataSource } from '@av/client/wind';
import { displayedWindSpeed } from '@av/contracts/units';
import { googleTerrainStyle, type TerrainBasemap } from './basemap';

type PointWindgram = typeof import('@av/windgram');

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const modelBar = element<HTMLDivElement>('models');
const modelPicker = element<HTMLDetailsElement>('model-picker');
const modelSelected = element<HTMLElement>('model-selected');
const metricButton = element<HTMLButtonElement>('units-metric');
const imperialButton = element<HTMLButtonElement>('units-imperial');
const locateButton = element<HTMLButtonElement>('locate');
const locationStatus = element<HTMLParagraphElement>('location-status');
const distanceScale = element<HTMLParagraphElement>('distance-scale');
const refAgl = element<HTMLButtonElement>('ref-agl');
const refMsl = element<HTMLButtonElement>('ref-msl');
const opacityInput = element<HTMLInputElement>('opacity');
const opacityReadout = element<HTMLSpanElement>('opacity-readout');
const timeInput = element<HTMLInputElement>('time');
const timestamp = element<HTMLParagraphElement>('timestamp');
const frameStatus = element<HTMLParagraphElement>('frame-status');
const timelineStatus = element<HTMLParagraphElement>('timeline-status');
const legend = element<HTMLElement>('legend');
const legendBody = element<HTMLDivElement>('legend-body');
const legendToggle = element<HTMLButtonElement>('legend-toggle');
const horizonNotice = element<HTMLParagraphElement>('horizon-notice');
const tileErrorBox = element<HTMLParagraphElement>('tile-error');
const errorBox = element<HTMLParagraphElement>('error');
const freshness = element<HTMLParagraphElement>('freshness');
const pointCard = element<HTMLElement>('point-card');
const pointClose = element<HTMLButtonElement>('point-close');
const pointSettings = element<HTMLDetailsElement>('point-settings');
const pointBuildDetails = element<HTMLDetailsElement>('point-build-details');
const pointLocation = element<HTMLParagraphElement>('point-location');
const pointWind = element<HTMLParagraphElement>('point-wind');
const pointStatus = element<HTMLParagraphElement>('point-status');
const pointBody = element<HTMLDivElement>('point-body');
const pointUnits = element<HTMLSelectElement>('point-units');
const pointHorizonSelect = element<HTMLSelectElement>('point-horizon');
const pointHorizonLabel = element<HTMLLabelElement>('point-horizon-label');
const meta = element<HTMLDListElement>('meta');

const LIFT: readonly LayerId[] = ['usable-lift-agl', 'usable-lift-msl'];
const displayedClock = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

const offlineFixture = import.meta.env.VITE_OFFLINE_FIXTURE === 'true';
const apiBaseUrl = import.meta.env.AV_API_BASE ?? 'http://localhost:8787';
const api = new ApiClient({ baseUrl: apiBaseUrl });

const startup = previewQuery(window.location.search, offlineFixture);
function stored(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function store(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* Storage can be unavailable. */ }
}

const initialModel = startup.model ?? (offlineFixture ? import.meta.env.VITE_MODEL ?? 'gfs' : AUTO_MODEL_ID);
const savedOpacity = stored('preview-lift-opacity');
const savedOpacityNumber = savedOpacity === null || savedOpacity.trim() === '' ? NaN : Number(savedOpacity);
const initialOpacity = startup.opacity ?? (Number.isFinite(savedOpacityNumber) && savedOpacityNumber >= 0 && savedOpacityNumber <= 1 ? savedOpacityNumber : 0.5);

if (offlineFixture) {
  const warning = document.createElement('p');
  warning.className = 'toast';
  warning.textContent = 'SYNTHETIC FIXTURE — development data, not a forecast';
  document.getElementById('app')?.prepend(warning);
}

maplibregl.setWorkerUrl(workerUrl);
opacityInput.value = String(initialOpacity);
opacityReadout.textContent = `${Math.round(initialOpacity * 100)}%`;

const modelButtons: HTMLButtonElement[] = [];

function basemapStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }
    },
    layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }]
  };
}

interface InitialDiscovery {
  controller: AbortController;
  model?: ModelId;
  build?: Promise<PinnedBuild>;
  auto?: Promise<AutoForecastSelection | null>;
}

interface WindView {
  build: PinnedBuild;
  frame: string;
  bounds: [number, number, number, number];
  source: WindDataSource;
}

interface WindRequest extends WindView {
  controller: AbortController;
  key: string;
}

function startPreview(lifecycle: AbortController, terrain: TerrainBasemap | null, initialDiscovery: InitialDiscovery | null): void {
  modelBar.replaceChildren();
  modelButtons.length = 0;
  const choices = offlineFixture
    ? [{ modelId: initialModel, label: 'Synthetic fixture' }]
    : [...MODEL_OPTIONS, { modelId: AUTO_MODEL_ID, label: 'Auto' }];
  for (const choice of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'model-button';
    button.value = choice.modelId;
    button.textContent = choice.label;
    modelButtons.push(button);
    modelBar.append(button);
  }

  const map = new maplibregl.Map({
    container: 'map',
    center: startup.camera?.center ?? [0, 20],
    zoom: startup.camera?.zoom ?? 2,
    maxTileCacheSize: RASTER_CACHE_TILES,
    style: offlineFixture
      ? { version: 8, sources: {}, layers: [{ id: 'neutral-background', type: 'background', paint: { 'background-color': '#d5dde3' } }] }
      : terrain?.style ?? basemapStyle()
  });
  terrain?.attach(map);
  const globalListener = { signal: lifecycle.signal };

  let build: PinnedBuild | null = null;
  let currentModel: ModelId = initialModel;
  let reference: AltitudeReference = startup.reference;
  let requestedTime = startup.validTime;
  let selectedFrame: string | null = null;
  let opacity = initialOpacity;
  let expired = false;
  let mapFailed = false;
  let mapReady = false;
  let selectingOverlay = false;
  let overlayState: OverlayState = { displayed: null, requested: null, quality: null, viewLoading: false, overviewReady: 0, overviewTotal: 0, overviewFailed: 0, incomplete: false, replacementFailed: false };
  const scheduler = createForecastRequestScheduler();
  const overlay = new RasterOverlay(map, apiBaseUrl, opacity, state => {
    overlayState = state;
    reconcileWind();
    updateOverlayStatus();
  }, scheduler.fetch);
  let ribbon: { build: PinnedBuild; layer: LayerId } | null = null;
  let pendingModel: ModelId | null = null;
  let resumeModel: ModelId | null = null;
  let loadAbort: AbortController | null = null;
  let autoAbort: AbortController | null = null;
  const pointSeries = new PointSeriesController(api);
  let pointUnitSystem: UnitSystem = stored('preview-units') === 'imperial' ? 'imperial' : 'metric';
  let pointHorizon: PointHorizon = 'day';
  let windgram: PointWindgram | null = null;
  let updatePointSeries: ReturnType<PointWindgram['renderPointWindgram']> | null = null;
  let pointSelection: { update: ReturnType<PointWindgram['renderPointWindgram']>; frame: string | null; units: UnitSystem; mapFrame: string | null } | null = null;
  let expiryTimer: number | null = null;
  let disposeExpiry = () => {};
  let urlReady = false;
  let historyRevision = 0;
  let applyingHistory: number | null = null;
  let opacityCommitted = false;
  let legendOpen = true;
  let windView: WindView | null = null;
  let windRequest: WindRequest | null = null;
  let windLoadStatus: WindStatus = 'unavailable';
  let windDisplayed = false;
  let windHeight: 'surface' | number | 'lift' = 'surface';
  let locationRevision = 0;
  let windLoading = false;
  let queuedWindLoad: (() => void) | null = null;
  const windOverlay = new WindOverlay(map);
  const windControls = createWindControls(element('wind-controls'), {
    onChange(state) {
      windOverlay.setOptions({ ...state, units: pointUnitSystem });
      if (windDisplayed && windHeight !== state.height) setWindField();
      updateWind();
      updatePointWind();
    }
  });
  const compactTimeline = createCompactTimeline(element('compact-timeline'), {
    timeZone: 'UTC',
    onSelect(index) { selectIndex(index, 'push'); }
  });
  windControls.setUnits(pointUnitSystem);
  windOverlay.setOptions({ ...windControls.state, units: pointUnitSystem });

  function setWindField(): void {
    const view = windView;
    if (!view) return;
    const height = windControls.state.height;
    windHeight = height;
    windOverlay.setField({ sample(lat, lon) {
      const sample = view.source.sample(lat, normalizeLon(lon), height);
      return { ...sample, status: sample.status === 'valid' ? STATUS_VALID : 1 };
    } });
  }

  function reconcileWind(): void {
    const displayed = overlayState.displayed;
    const matches = windView && windLoadStatus !== 'unavailable' && windLoadStatus !== 'zoom-in'
      && displayed?.build === windView.build && displayed.frame === windView.frame;
    if (matches && !windDisplayed) {
      setWindField();
      windDisplayed = true;
    } else if (!matches && windDisplayed) {
      windOverlay.clear();
      windDisplayed = false;
    }
    if (windLoadStatus === 'ready') windControls.setStatus(matches ? 'ready' : overlayState.replacementFailed ? 'unavailable' : 'loading');
    updatePointWind();
  }

  function setWindStatus(status: WindStatus): void {
    windLoadStatus = status;
    windControls.setStatus(status);
  }

  function cancelWindRequest(): void {
    windRequest?.controller.abort();
    windRequest?.source.dispose();
    windRequest = null;
    queuedWindLoad = null;
  }

  function clearWind(): void {
    cancelWindRequest();
    windView?.source.dispose();
    windView = null;
    windDisplayed = false;
    windOverlay.clear();
    setWindStatus('unavailable');
    updatePointWind();
  }

  function updatePointWind(): void {
    const context = pointSeries.current, identity = windView;
    if (!context || !windDisplayed || !identity || context.build !== identity.build || pointSeries.frameId !== identity.frame) {
      pointWind.textContent = '';
      return;
    }
    const point = context.point;
    const validTime = identity.build.manifest.frames.find(frame => frame.id === identity.frame)?.validTime;
    if (!validTime) { pointWind.textContent = ''; return; }
    const sample = identity.source.sample(point.lat, point.lon, windControls.state.height);
    const speed = sample.status === 'valid' && sample.u !== null && sample.v !== null ? displayedWindSpeed(Math.hypot(sample.u, sample.v), pointUnitSystem) : null;
    const value = speed !== null
      ? `${speed} ${pointUnitSystem === 'metric' ? 'km/h' : 'mph'}`
      : sample.status === 'outside' ? 'Outside forecast area' : sample.status === 'no-lift' ? 'No usable lift' : 'Wind unavailable';
    pointWind.textContent = `Map wind · ${validTime.slice(0, 16).replace('T', ' ')} UTC · ${value}`;
  }

  function updateWind(): void {
    if (!windControls.state.visible) {
      cancelWindRequest();
      return;
    }
    if (!mapReady || !build || !selectedFrame || expired || mapFailed || lifecycle.signal.aborted) return;
    const bounds = map.getBounds();
    const west = bounds.getWest(), east = bounds.getEast();
    const wrap = (lon: number) => ((lon + 180) % 360 + 360) % 360 - 180;
    const view: [number, number, number, number] = [east - west >= 360 ? -180 : wrap(west), Math.max(-90, bounds.getSouth()), east - west >= 360 ? 180 : wrap(east), Math.min(90, bounds.getNorth())];
    const identity = windView;
    const span = (west: number, east: number) => (east - west + 360) % 360 || (east === west ? 0 : 360);
    const covered = identity && identity.build === build && identity.frame === selectedFrame
      && view[1] >= identity.bounds[1] && view[3] <= identity.bounds[3]
      && span(identity.bounds[0], view[0]) + span(view[0], view[2]) <= span(identity.bounds[0], identity.bounds[2]);
    if (covered) {
      cancelWindRequest();
      setWindStatus('ready');
      reconcileWind();
      return;
    }
    const key = JSON.stringify([build.manifest.model, build.manifest.buildId, selectedFrame, view]);
    if (key === windRequest?.key) return;
    if (!identity || identity.build !== build || identity.frame !== selectedFrame) clearWind();
    else cancelWindRequest();
    setWindStatus('loading');
    const request: WindRequest = { build, frame: selectedFrame, bounds: view, key,
      controller: new AbortController(), source: new WindDataSource(apiBaseUrl, { fetchImpl: scheduler.fetch }) };
    windRequest = request;
    // A retired load releases its decoded maps before the latest viewport can allocate.
    if (windLoading) queuedWindLoad = () => { void loadWind(request); };
    else void loadWind(request);
  }

  async function loadWind(request: WindRequest): Promise<void> {
    windLoading = true;
    try {
      const status = await request.source.load({ ...request, signal: request.controller.signal });
      if (windRequest !== request || request.controller.signal.aborted || !ensureLive()) return;
      if (status === 'ready') {
        windView?.source.dispose();
        windView = request;
        if (windDisplayed) setWindField();
      }
      setWindStatus(status);
      reconcileWind();
    } catch {
      if (windRequest === request && !request.controller.signal.aborted) {
        setWindStatus('unavailable');
        reconcileWind();
      }
    } finally {
      if (windRequest === request) windRequest = null;
      if (windView !== request) request.source.dispose();
      windLoading = false;
      const next = queuedWindLoad;
      queuedWindLoad = null;
      next?.();
    }
  }

  function updateScale(): void {
    const metres = 80 * 2 * Math.PI * 6371000 * Math.cos(Math.min(85, Math.abs(map.getCenter().lat)) * Math.PI / 180) / (512 * 2 ** map.getZoom());
    const distance = metres / (pointUnitSystem === 'metric' ? 1000 : 1609.344);
    const magnitude = 10 ** Math.floor(Math.log10(distance));
    const rounded = [10, 5, 2, 1].find(value => value * magnitude <= distance) ?? 1;
    const value = rounded * magnitude;
    distanceScale.style.width = `${Math.max(1, 80 * value / distance)}px`;
    distanceScale.textContent = `${Number(value.toPrecision(2))} ${pointUnitSystem === 'metric' ? 'km' : 'mi'}`;
  }

  function setUnits(units: UnitSystem): void {
    pointUnitSystem = units;
    store('preview-units', units);
    metricButton.ariaPressed = String(units === 'metric');
    imperialButton.ariaPressed = String(units === 'imperial');
    pointUnits.value = units;
    element<HTMLElement>('lift-units').textContent = units === 'metric' ? 'Lift m' : 'Lift ft';
    windControls.setUnits(units);
    windOverlay.setOptions({ units });
    ribbon = null;
    if (overlayState.displayed) renderRibbon(overlayState.displayed.layer, overlayState.displayed.build);
    updateScale();
    updatePointSelection();
    updatePointWind();
  }

  function mapLon(): number {
    return map.getCenter().lng;
  }

  function liftLayers(value: PinnedBuild): LayerId[] {
    return LIFT.filter(layer => value.templates[layer]);
  }

  function activeLayer(): LayerId | null {
    if (!build) return null;
    const preferred: LayerId = reference === 'agl' ? 'usable-lift-agl' : 'usable-lift-msl';
    if (build.templates[preferred]) return preferred;
    return liftLayers(build)[0] ?? null;
  }

  function syncReference(): void {
    refAgl.className = reference === 'agl' ? 'ref is-selected' : 'ref';
    refMsl.className = reference === 'msl' ? 'ref is-selected' : 'ref';
    refAgl.ariaPressed = String(reference === 'agl');
    refMsl.ariaPressed = String(reference === 'msl');
  }

  function syncModels(): void {
    for (const button of modelButtons) button.className = button.value === currentModel ? 'model-button is-selected' : 'model-button';
    modelSelected.textContent = modelButtons.find(button => button.value === currentModel)?.textContent ?? currentModel;
  }

  function writeUrl(mode: 'push' | 'replace'): void {
    if (applyingHistory || !mapReady || !urlReady || pendingModel) return;
    const camera = map.getCenter();
    const validTime = currentModel === AUTO_MODEL_ID ? requestedTime ?? undefined : build?.manifest.frames.find(item => item.id === selectedFrame)?.validTime;
    const next = previewUrl(window.location.pathname, {
      model: currentModel, reference, opacity, lat: camera.lat, lon: camera.lng, zoom: map.getZoom(), validTime
    });
    if (next === `${window.location.pathname}${window.location.search}`) return;
    const method = mode === 'push' ? 'pushState' : 'replaceState';
    window.history[method](null, '', next);
  }

  function showError(message: string): void {
    errorBox.hidden = false;
    errorBox.textContent = message;
  }

  function clearError(): void {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }

  function setPointStatus(message = ''): void {
    pointStatus.textContent = message;
    pointStatus.hidden = !message;
  }

  function closePoint(): void {
    pointSeries.close();
    pointCard.hidden = true;
    pointCard.ariaBusy = 'false';
    pointSettings.open = pointBuildDetails.open = false;
    setPointStatus();
    windgram?.disposePointWindgram(pointBody);
    pointBody.replaceChildren();
    updatePointSeries = null;
    pointSelection = null;
    pointWind.textContent = '';
    pointBody.tabIndex = -1;
    meta.replaceChildren();
  }

  function setControlsEnabled(enabled: boolean): void {
    for (const button of modelButtons) button.disabled = mapFailed || pendingModel !== null;
    refAgl.disabled = !enabled;
    refMsl.disabled = !enabled;
    opacityInput.disabled = !enabled;
    timeInput.disabled = !enabled;
    compactTimeline.update(build ? renderedFrames(build.manifest) : [], selectedFrame, !enabled);
  }

  function updateFreshness(): void {
    overlay.refresh();
    if (!build || expired) return;
    const now = Date.now();
    if (build.expiresAtMs <= now) {
      expireView();
      return;
    }
    const notice = mapForecastHorizonNotice(build.manifest, now);
    horizonNotice.textContent = notice ?? '';
    horizonNotice.hidden = notice === null;
    const actual = currentModel === AUTO_MODEL_ID ? `${build.manifest.model} · ` : '';
    freshness.textContent = actual + formatBuildFreshness(build.manifest, build.expiresAtMs, now);
  }

  function renderRibbon(layer: LayerId, displayedBuild = build): void {
    if (!legend.hidden && ribbon?.build === displayedBuild && ribbon.layer === layer) return;
    const palette = displayedBuild ? activePalettes(displayedBuild.manifest.descriptors.palettes, layer, displayedBuild.manifest.descriptors.layers)[0] : undefined;
    if (!displayedBuild || !palette) {
      legend.hidden = true;
      legendBody.replaceChildren();
      return;
    }
    legend.hidden = false;
    ribbon = { build: displayedBuild, layer };
    const title = document.createElement('p');
    title.className = 'ribbon-title';
    const descriptor = displayedBuild.manifest.descriptors.layers[layer];
    const altitudeUnit = pointUnitSystem === 'imperial' ? 'ft' : 'm';
    title.textContent = layer === 'usable-lift-agl' ? `Lift above ground (${altitudeUnit} AGL)` : `Top of usable lift (${altitudeUnit} MSL)`;
    const scale = document.createElement('div');
    scale.className = 'ribbon-scale';
    const colorCount = palette.colors.length;
    const colors = [...palette.colors];
    const labels = palette.colors.map((_, index) => {
      const edge = index === colorCount - 1 && palette.edges.length > colorCount ? palette.edges[colorCount] : palette.edges[index];
      const value = edge === undefined ? null : Math.round(edge * (pointUnitSystem === 'imperial' ? 3.280839895 : 1));
      return value === null ? '' : value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value);
    });
    colors.forEach((color, index) => {
      const row = document.createElement('div');
      row.className = 'ribbon-stop';
      const swatch = document.createElement('span');
      swatch.style.background = color;
      const tick = document.createElement('span');
      tick.textContent = index === 0 || index === colorCount - 1 || index === Math.floor(colorCount / 3) || index === Math.floor(colorCount * 2 / 3) ? labels[index] ?? '' : '';
      row.append(swatch, tick);
      scale.append(row);
    });
    const body = document.createElement('div');
    body.className = 'ribbon-main';
    body.append(title, scale);
    element<HTMLParagraphElement>('legend-reference').textContent = layer === 'usable-lift-agl'
      ? 'AGL shows usable lift height above ground.'
      : 'MSL includes ground elevation. Choose AGL to see usable lift height above ground.';
    const renderStyle = displayedBuild.manifest.tool.liftRenderStyle;
    const terrainNoLift = layer === 'usable-lift-msl'
      && (renderStyle === LIFT_STEP_RENDER_STYLE || renderStyle === LIFT_RENDER_STYLE);
    element<HTMLParagraphElement>('legend-no-lift').textContent = terrainNoLift
      ? 'No usable lift: the map shows ground elevation, including at night.'
      : 'No usable lift: clear areas on the map.';
    const sink = displayedBuild.manifest.descriptors.methods[descriptor.methodId]?.parameters.sinkRateMps;
    element<HTMLParagraphElement>('legend-cutoff').textContent = Number.isFinite(sink) && sink > 0
      ? `Usable lift requires predicted updrafts above ${sink} m/s. Nearby terrain can cross this cutoff.`
      : 'Usable lift depends on the predicted updraft and terrain.';
    legendBody.replaceChildren(body);
  }

  function updateTimeUi(): void {
    const frames = build ? renderedFrames(build.manifest) : [];
    compactTimeline.update(frames, selectedFrame, !build || expired || mapFailed);
    if (!build || !selectedFrame) {
      timestamp.textContent = expired ? 'Build expired — overlay removed' : 'No frame selected';
      return;
    }
    const offset = longitudeOffsetHours(mapLon()) * 60;
    const selected = frames.find(frame => frame.id === selectedFrame) ?? frames[0];
    timeInput.max = String(Math.max(0, frames.length - 1));
    const index = Math.max(0, frames.findIndex(frame => frame.id === selectedFrame));
    if (document.activeElement !== timeInput) timeInput.value = String(index);
    timestamp.textContent = selected ? `Selected · ${clockLabel(Date.parse(selected.validTime), offset)}` : 'No frame selected';
  }

  function resetTileErrors(): void {
    tileErrorBox.hidden = true;
    tileErrorBox.textContent = '';
  }

  function updateOverlayStatus(): void {
    const { displayed, requested, quality, viewLoading, overviewReady, overviewTotal, overviewFailed, incomplete, replacementFailed } = overlayState;
    const showing = displayed ? `Showing ${displayed.build.manifest.model} ${displayed.frame} ${displayed.layer}.` : 'No forecast displayed.';
    const pending = requested && (!displayed || displayed.build !== requested.build || displayed.layer !== requested.layer || displayed.frame !== requested.frame);
    const olderBuild = displayed && displayed.build !== build;
    const displayedTime = displayed?.build.manifest.frames.find(frame => frame.id === displayed.frame)?.validTime;
    const displayedLabel = displayedTime ? `${displayedClock.format(Date.parse(displayedTime))} UTC` : '';
    frameStatus.dataset.quality = quality ?? 'none';
    const status = !displayed ? requested ? replacementFailed ? 'Forecast unavailable · No forecast shown' : 'Loading selected time · No forecast shown' : expired ? 'Forecast expired' : pendingModel ? 'Loading forecast…' : 'No forecast shown'
      : pending ? `Showing ${displayedLabel} · ${replacementFailed ? 'Selected time unavailable' : 'Loading selected time…'}`
      : quality === 'overview' ? `${displayedLabel} · Overview · ${replacementFailed ? 'Detail unavailable' : 'Loading detail…'}`
      : viewLoading ? `${displayedLabel} · Loading this view…`
      : `${displayedLabel} · ${incomplete ? 'Detail incomplete' : 'Full detail'}`;
    if (frameStatus.textContent !== status) frameStatus.textContent = status;
    timelineStatus.dataset.ready = String(overviewReady); timelineStatus.dataset.total = String(overviewTotal);
    timelineStatus.hidden = overviewTotal === 0;
    timelineStatus.textContent = overviewReady === overviewTotal ? 'Timeline ready'
      : `${overviewReady + overviewFailed === overviewTotal ? 'Timeline partly ready' : 'Preparing timeline'} · ${overviewReady} / ${overviewTotal} times ready`;
    const alert = replacementFailed || incomplete;
    tileErrorBox.className = alert ? 'toast error' : 'toast status';
    tileErrorBox.role = alert ? 'alert' : 'status';
    tileErrorBox.hidden = !alert && !pendingModel && !olderBuild;
    tileErrorBox.textContent = replacementFailed ? `Forecast replacement failed. ${showing}` : incomplete ? `Overlay tile failed to load — forecast display may be incomplete. ${showing}` : pendingModel ? `Loading ${pendingModel}. ${showing}` : olderBuild ? showing : '';
    if (displayed) renderRibbon(displayed.layer, displayed.build);
    else { legend.hidden = true; legendBody.replaceChildren(); }
    if (!selectingOverlay) updatePointSelection();
  }

  function displayedPointFrame(): string | null {
    return overlayState.displayed?.build === build ? overlayState.displayed.frame : null;
  }

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
    resetTileErrors();
    horizonNotice.hidden = true;
    horizonNotice.textContent = '';
    if (expiryTimer !== null) {
      window.clearInterval(expiryTimer);
      expiryTimer = null;
    }
    loadAbort?.abort();
    clearWind();
    closePoint();
    disposeExpiry();
    overlay.clear();
    setControlsEnabled(false);
    for (const button of modelButtons) button.disabled = mapFailed || pendingModel !== null;
    timestamp.textContent = 'Build expired — overlay removed';
    freshness.textContent = 'Expired immutable build';
    showError('This build has expired. Reload to discover the latest retained build.');
    if (currentModel === AUTO_MODEL_ID) void loadAuto();
  }

  function ensureLive(): boolean {
    if (!build || mapFailed) return false;
    try {
      assertNotExpired(build.manifest.expiresAt, Date.now());
      return true;
    } catch {
      expireView();
      return false;
    }
  }

  function updateOverlay(): void {
    const layer = activeLayer();
    if (!mapReady || !build || !selectedFrame || !layer || !ensureLive()) return;
    updateWind();
    clearError();
    selectingOverlay = true;
    try {
      overlay.select(build, layer, selectedFrame);
    } catch (error) {
      showError(`Overlay display failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      selectingOverlay = false;
      updatePointSelection();
    }
  }

  function selectIndex(index: number, history: 'none' | 'push' | 'replace'): void {
    const frame = build ? renderedFrames(build.manifest)[index] : undefined;
    if (!frame) return;
    if (selectedFrame !== frame.id && windControls.state.visible) clearWind();
    if (currentModel === AUTO_MODEL_ID && requestedTime !== frame.validTime) autoAbort?.abort();
    selectedFrame = frame.id;
    requestedTime = frame.validTime;
    updateTimeUi();
    pointSeries.followMapFrame(selectedFrame);
    updateOverlay();
    updatePointSelection();
    if (history !== 'none') {
      writeUrl(history);
      if (currentModel === AUTO_MODEL_ID) void loadAuto();
    }
  }

  function followMapFrame(): void {
    pointSeries.followMapFrame(selectedFrame);
    updatePointSelection();
  }

  function chooseFrame(value: PinnedBuild): void {
    const frames = renderedFrames(value.manifest);
    const index = frameIndexFor(frames, requestedTime, Date.now());
    selectedFrame = frames[index]?.id ?? null;
    const frame = value.manifest.frames.find(item => item.id === selectedFrame);
    if (frame) requestedTime = frame.validTime;
  }

  async function loadAuto(): Promise<void> {
    if (currentModel !== AUTO_MODEL_ID || mapFailed || lifecycle.signal.aborted) return;
    autoAbort?.abort();
    const request = new AbortController();
    autoAbort = request;
    const { lat, lng } = map.getCenter();
    const time = Date.parse(requestedTime ?? '');
    const layers = reference === 'agl' ? LIFT : [...LIFT].reverse();
    if (!build) freshness.textContent = 'Finding a forecast for this location…';
    try {
      const pending = initialDiscovery?.auto;
      if (pending) {
        initialDiscovery!.auto = undefined;
        request.signal.addEventListener('abort', () => initialDiscovery?.controller.abort(), { once: true });
      }
      const next = await (pending ?? resolveAutoBuild(api, { ...normalizePoint(lat, lng), layers, signal: request.signal,
        ...(Number.isFinite(time) ? { validTimeMs: time } : {}) }));
      if (request.signal.aborted || autoAbort !== request || currentModel !== AUTO_MODEL_ID) return;
      if (next) {
        if (build?.manifest.model === next.build.manifest.model && build.manifest.buildId === next.build.manifest.buildId) {
          selectedFrame = next.frame.id;
          followMapFrame();
          updateTimeUi();
          updateOverlay();
          updateFreshness();
          if (expiryTimer === null) expiryTimer = window.setInterval(updateFreshness, 5000);
          writeUrl('replace');
        } else await loadModel(AUTO_MODEL_ID, next);
        return;
      }
      disposeExpiry();
      if (expiryTimer !== null) window.clearInterval(expiryTimer);
      expiryTimer = null;
      build = null;
      selectedFrame = null;
      clearWind();
      closePoint();
      overlay.clear();
      updateTimeUi();
      setControlsEnabled(false);
      showError('No forecast covers this location and time.');
      freshness.textContent = 'No viewable build';
      urlReady = true;
      writeUrl('replace');
    } catch (error) {
      if (!request.signal.aborted) showError(error instanceof Error ? error.message : String(error));
    } finally {
      if (autoAbort === request) autoAbort = null;
    }
  }

  async function loadModel(model: ModelId, resolved?: AutoForecastSelection): Promise<void> {
    if (mapFailed) return;
    clearWind();
    if (model === AUTO_MODEL_ID && !resolved) {
      loadAbort?.abort();
      loadAbort = null;
      pendingModel = null;
      currentModel = model;
      syncModels();
      setControlsEnabled(build !== null && !expired);
      await loadAuto();
      return;
    }
    if (model !== AUTO_MODEL_ID) autoAbort?.abort();
    const replaceUrl = applyingHistory === null;
    const revision = historyRevision;
    disposeExpiry();
    if (expiryTimer !== null) {
      window.clearInterval(expiryTimer);
      expiryTimer = null;
    }
    loadAbort?.abort();
    const requestAbort = new AbortController();
    loadAbort = requestAbort;
    pendingModel = model;
    resumeModel = null;
    currentModel = model;
    expired = false;
    syncModels();
    resetTileErrors();
    horizonNotice.hidden = true;
    horizonNotice.textContent = '';
    build = null;
    selectedFrame = null;
    updateTimeUi();
    legend.hidden = true;
    legendBody.replaceChildren();
    closePoint();
    setControlsEnabled(false);
    clearError();
    freshness.textContent = `Loading ${model} latest immutable build…`;
    timestamp.textContent = 'No frame selected';
    updateOverlayStatus();
    try {
      const pending = initialDiscovery?.model === model ? initialDiscovery.build : undefined;
      if (pending) {
        initialDiscovery!.build = undefined;
        requestAbort.signal.addEventListener('abort', () => initialDiscovery?.controller.abort(), { once: true });
      }
      const next = resolved?.build ?? await (pending ?? api.latest(model, { signal: requestAbort.signal }));
      if (requestAbort.signal.aborted || loadAbort !== requestAbort) return;
      build = next;
      pointHorizonLabel.hidden = pointSeriesSelection(next).frames.length === next.manifest.frames.length;
      pointHorizonSelect.children[0].textContent = next.manifest.mapFrameCount !== undefined ? 'Map forecast' : '24 hours';
      if (resolved) selectedFrame = resolved.frame.id;
      else chooseFrame(next);
      updateTimeUi();
      updateOverlay();
      updateFreshness();
      setControlsEnabled(true);
      syncReference();
      disposeExpiry = watchBuildExpiry(next.expiresAtMs, expireView, [document, window]);
      if (expiryTimer === null) expiryTimer = window.setInterval(updateFreshness, 5000);
      if (loadAbort === requestAbort) pendingModel = null;
      urlReady = true;
      if (replaceUrl && revision === historyRevision) writeUrl('replace');
    } catch (error) {
      if (requestAbort.signal.aborted || loadAbort !== requestAbort || (error instanceof DOMException && error.name === 'AbortError')) return;
      showError(error instanceof Error ? error.message : String(error));
      freshness.textContent = 'No viewable build';
      setControlsEnabled(false);
    } finally {
      if (loadAbort === requestAbort) {
        loadAbort = null;
        pendingModel = null;
        for (const button of modelButtons) button.disabled = mapFailed;
        updateOverlayStatus();
      }
    }
  }

  function focusRegion(model: ModelId): void {
    const bounds = MODEL_OPTIONS.find(choice => choice.modelId === model)?.bounds;
    if (!bounds) return;
    const [west, south, east, north] = bounds;
    if (east - west < 360) map.fitBounds([[west, south], [west <= east ? east : east + 360, north]], { padding: 32, duration: 0 });
  }

  function showPoint(context: PointSeriesContext, payload: PointSeries, totalFrames: number, loading: boolean): void {
    if (!windgram) return;
    updatePointSeries = windgram.renderPointWindgram(pointBody, payload, context.build, {
      point: context.point, frameId: pointSeries.frameId, mapFrameId: displayedPointFrame(), unitSystem: pointUnitSystem, totalFrames, loading,
      onFrame(id) {
        if (build !== context.build || !ensureLive() || !pointSeries.selectFrame(context, id)) return;
        const index = renderedFrames(context.build.manifest).findIndex(frame => frame.id === id);
        if (index >= 0) selectIndex(index, 'push');
        else updatePointSelection();
      }
    });
    pointBody.tabIndex = 0;
    pointCard.ariaBusy = String(loading);
    if (!loading) setPointStatus();
  }

  async function openPoint(point: GeoPoint): Promise<void> {
    if (!build || expired || mapFailed || !ensureLive()) return;
    pointSeries.open(build, point);
    pointCard.hidden = false;
    pointSettings.open = pointBuildDetails.open = false;
    pointLocation.textContent = `${point.lat.toFixed(3)}°, ${point.lon.toFixed(3)}°`;
    updatePointWind();
    meta.replaceChildren();
    windgram?.disposePointWindgram(pointBody);
    pointBody.replaceChildren(); updatePointSeries = null; pointSelection = null; pointBody.tabIndex = -1;
    await loadPointRange();
  }

  async function loadPointRange(): Promise<void> {
    const context = pointSeries.current;
    if (!context || build !== context.build || !ensureLive()) return;
    await pointSeries.load(pointHorizon, selectedFrame, {
      canRender: () => build === context.build && ensureLive(),
      prepare: windgram ? undefined : async () => { windgram = await import('@av/windgram'); },
      onLoading() {
        pointCard.ariaBusy = 'true';
        setPointStatus('Loading forecast…');
        updatePointWind();
      },
      onProgress(payload, totalFrames, loading) { showPoint(context, payload, totalFrames, loading); },
      onError(detail) {
        updatePointSeries?.(pointSeries.frameId, pointUnitSystem, displayedPointFrame(), false);
        pointCard.ariaBusy = 'false';
        setPointStatus(pointBody.children.length ? detail : `Forecast unavailable. ${detail}`);
      }
    });
  }

  async function applyHistory(): Promise<void> {
    if (lifecycle.signal.aborted) return;
    const state = previewQuery(window.location.search, offlineFixture);
    const change = ++historyRevision;
    applyingHistory = change;
    try {
      reference = state.reference;
      syncReference();
      if (state.opacity !== null) {
        opacity = state.opacity;
        opacityInput.value = String(opacity);
        opacityReadout.textContent = `${Math.round(opacity * 100)}%`;
        overlay.setOpacity(opacity);
      }
      if (state.camera) map.jumpTo(state.camera, { previewHistory: true });
      requestedTime = state.validTime;
      if (state.model && state.model !== currentModel) {
        await loadModel(state.model);
        return;
      }
      if (currentModel === AUTO_MODEL_ID) { await loadAuto(); return; }
      if (build) {
        const previousFrame = selectedFrame;
        chooseFrame(build);
        if (selectedFrame !== previousFrame) followMapFrame();
        updateTimeUi();
        updateOverlay();
      }
    } finally {
      if (applyingHistory === change) applyingHistory = null;
    }
  }

  for (const button of modelButtons) {
    button.addEventListener('click', () => {
      if (button.disabled || mapFailed) return;
      if (currentModel === AUTO_MODEL_ID) applyingHistory = null;
      const model = button.value as ModelId;
      modelPicker.open = false;
      void loadModel(model);
      focusRegion(model);
    });
  }
  for (const [control, layer] of [[refAgl, 'usable-lift-agl'], [refMsl, 'usable-lift-msl']] as const) {
    const prepare = () => { if (!control.disabled && selectedFrame) overlay.prepare(layer, selectedFrame); };
    for (const event of ['pointerenter', 'focus', 'pointerdown']) control.addEventListener(event, prepare);
  }
  refAgl.addEventListener('click', () => {
    reference = 'agl';
    syncReference();
    updateOverlay();
    writeUrl('push');
    if (currentModel === AUTO_MODEL_ID) void loadAuto();
  });
  refMsl.addEventListener('click', () => {
    reference = 'msl';
    syncReference();
    updateOverlay();
    writeUrl('push');
    if (currentModel === AUTO_MODEL_ID) void loadAuto();
  });
  opacityInput.addEventListener('pointerdown', () => { opacityCommitted = false; });
  opacityInput.addEventListener('input', () => {
    opacity = Math.min(1, Math.max(0, Number(opacityInput.value)));
    store('preview-lift-opacity', String(opacity));
    opacityReadout.textContent = `${Math.round(opacity * 100)}%`;
    overlay.setOpacity(opacity);
    writeUrl(opacityCommitted ? 'replace' : 'push');
    opacityCommitted = true;
  });
  opacityInput.addEventListener('change', () => { opacityCommitted = false; });
  timeInput.addEventListener('input', () => { selectIndex(Number(timeInput.value), 'none'); });
  timeInput.addEventListener('change', () => {
    writeUrl('replace');
    if (currentModel === AUTO_MODEL_ID) void loadAuto();
  });
  setUnits(pointUnitSystem);
  metricButton.addEventListener('click', () => setUnits('metric'));
  imperialButton.addEventListener('click', () => setUnits('imperial'));
  pointUnits.addEventListener('change', () => {
    setUnits(pointUnits.value === 'imperial' ? 'imperial' : 'metric');
  });
  locateButton.addEventListener('click', () => {
    if (locateButton.disabled || mapFailed) return;
    const revision = ++locationRevision;
    if (!navigator.geolocation) { locationStatus.textContent = 'Location unavailable'; return; }
    locateButton.disabled = true;
    locateButton.ariaBusy = 'true';
    locationStatus.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(position => {
      if (revision !== locationRevision || lifecycle.signal.aborted) return;
      locateButton.disabled = false;
      locateButton.ariaBusy = 'false';
      locationStatus.textContent = 'Location found';
      map.jumpTo({ center: [position.coords.longitude, position.coords.latitude], zoom: Math.max(map.getZoom(), 10) });
    }, error => {
      if (revision !== locationRevision || lifecycle.signal.aborted) return;
      locateButton.disabled = false;
      locateButton.ariaBusy = 'false';
      locationStatus.textContent = error.code === 1 ? 'Location permission denied' : error.code === 3 ? 'Location timed out' : 'Location unavailable';
    }, { timeout: 10_000 });
  });
  pointHorizonSelect.value = pointHorizon;
  pointHorizonSelect.addEventListener('change', () => {
    pointHorizon = pointHorizonSelect.value === 'forecast' ? 'forecast' : 'day';
    void loadPointRange();
  });
  pointClose.addEventListener('click', closePoint);
  pointBuildDetails.addEventListener('toggle', () => {
    if (pointBuildDetails.open && build && pointSeries.current && !meta.children.length) renderBuildDiagnostics(meta, build);
  });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement | null)?.matches?.('input,select,textarea,button')) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (!build || !ensureLive()) return;
    event.preventDefault();
    const frames = renderedFrames(build.manifest);
    const index = frames.findIndex(frame => frame.id === selectedFrame);
    selectIndex(Math.max(0, Math.min(frames.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1))), 'replace');
  }, globalListener);
  legendToggle.addEventListener('click', () => {
    legendOpen = !legendOpen;
    legend.className = legendOpen ? 'ribbon' : 'ribbon is-collapsed';
    legendToggle.ariaExpanded = String(legendOpen);
    legendToggle.ariaLabel = legendOpen ? 'Collapse lift scale' : 'Show lift scale';
    legendToggle.textContent = legendOpen ? '⌃' : '⌄';
  });
  const pointControls = [pointCard, refAgl, refMsl, timeInput, element('wind-controls'), element('compact-timeline'), element('display-units')];
  document.addEventListener('pointerdown', event => {
    if (!pointSeries.current) return;
    const target = event.target;
    if (!(target instanceof Node) || map.getContainer().contains(target) || pointControls.some(control => control.contains(target))) return;
    closePoint();
  }, globalListener);
  map.on('click', event => {
    if (mapFailed) return;
    void openPoint(normalizePoint(event.lngLat.lat, event.lngLat.lng));
  });
  map.on('movestart', event => {
    if (currentModel !== AUTO_MODEL_ID || 'previewHistory' in event) return;
    applyingHistory = null;
    autoAbort?.abort();
  });
  map.on('moveend', () => {
    updateScale();
    if (currentModel !== AUTO_MODEL_ID) updateWind();
    if (build && !expired) updateTimeUi();
    if (currentModel === AUTO_MODEL_ID && !applyingHistory) void loadAuto();
    if (!urlReady || applyingHistory) return;
    writeUrl('push');
  });

  map.on('error', (event: { error?: unknown }) => {
    if (mapFailed || !(event.error instanceof maplibregl.GPUInitializationError)) return;
    mapFailed = true;
    lifecycle.abort();
    autoAbort?.abort();
    loadAbort?.abort(); loadAbort = null; pendingModel = null; resumeModel = null;
    closePoint(); disposeExpiry();
    clearWind(); locationRevision++;
    windOverlay.destroy(); windControls.destroy(); compactTimeline.destroy();
    terrain?.dispose();
    if (expiryTimer !== null) window.clearInterval(expiryTimer);
    expiryTimer = null;
    overlay.destroy(); scheduler.dispose(); map.remove(); showMapFailure(event.error);
  });

  window.addEventListener('popstate', applyHistory, globalListener);
  window.addEventListener('pagehide', (event: PageTransitionEvent) => {
    clearWind(); locationRevision++;
    locateButton.disabled = false;
    locateButton.ariaBusy = 'false';
    resumeModel = event.persisted ? (pendingModel ?? (currentModel === AUTO_MODEL_ID ? AUTO_MODEL_ID : null)) : null;
    loadAbort?.abort();
    autoAbort?.abort();
    const pointInterrupted = event.persisted && pointSeries.pending;
    if (pointInterrupted) {
      pointCard.hidden = false;
      pointCard.ariaBusy = 'false';
      setPointStatus('Point request interrupted. Click the map again.');
      windgram?.disposePointWindgram(pointBody);
      updatePointSeries = null;
      pointSelection = null;
    }
    if (!event.persisted || pointInterrupted) pointSeries.close();
    if (expiryTimer !== null) {
      window.clearInterval(expiryTimer);
      expiryTimer = null;
    }
    overlay.clear(true);
    if (event.persisted) return;
    lifecycle.abort();
    windgram?.disposePointWindgram(pointBody);
    updatePointSeries = null;
    pointSelection = null;
    disposeExpiry();
    windOverlay.destroy(); windControls.destroy(); compactTimeline.destroy();
    terrain?.dispose();
    overlay.destroy(); scheduler.dispose(); map.remove();
  }, globalListener);
  window.addEventListener('pageshow', (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    if (resumeModel !== null) {
      const model = resumeModel;
      resumeModel = null;
      void loadModel(model);
      return;
    }
    if (build && ensureLive()) {
      updateTimeUi();
      updateOverlay();
      setControlsEnabled(true);
      updateFreshness();
      if (expiryTimer === null) expiryTimer = window.setInterval(updateFreshness, 5000);
    }
  }, globalListener);
  document.addEventListener('visibilitychange', updateFreshness, globalListener);
  window.addEventListener('focus', updateFreshness, globalListener);
  syncReference();
  syncModels();

  map.on('load', () => {
    if (!startup.camera) focusRegion(currentModel);
    mapReady = true;
    updateOverlay();
    writeUrl('replace');
  });
  void loadModel(initialModel);
}

function showMapFailure(error: unknown): void {
  for (const button of modelButtons) button.disabled = true;
  for (const control of [refAgl, refMsl, opacityInput, timeInput]) control.disabled = true;
  errorBox.hidden = false;
  errorBox.textContent = error instanceof maplibregl.GPUInitializationError
    ? 'Map unavailable: this browser needs WebGL2. Enable graphics acceleration or try another browser.'
    : `Map initialization failed: ${error instanceof Error ? error.message : String(error)}`;
  timestamp.textContent = 'Map unavailable';
  freshness.textContent = '';
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
    const [lng, lat] = startup.camera?.center ?? [0, 20];
    const time = Date.parse(startup.validTime ?? '');
    discovery.auto = resolveAutoBuild(api, { ...normalizePoint(lat, lng), layers: startup.reference === 'agl' ? LIFT : [...LIFT].reverse(),
      signal: controller.signal, ...(Number.isFinite(time) ? { validTimeMs: time } : {}) });
    void discovery.auto.catch(() => {});
  } else {
    discovery.model = initialModel;
    discovery.build = api.latest(initialModel, { signal: controller.signal });
    void discovery.build.catch(() => {});
  }
  const onPagehide = (event: PageTransitionEvent): void => {
    lifecycle.abort();
    if (event.persisted) window.addEventListener('pageshow', bootstrap, { once: true });
  };
  window.addEventListener('pagehide', onPagehide);
  const session = new AbortController();
  lifecycle.signal.addEventListener('abort', () => session.abort(), { once: true });
  const timeout = setTimeout(() => session.abort(), 10_000);
  void googleTerrainStyle(key, session.signal).catch(() => {
    if (!lifecycle.signal.aborted) {
      const warning = document.createElement('p');
      warning.className = 'toast basemap-warning';
      warning.setAttribute('role', 'status');
      warning.textContent = 'Google terrain unavailable. Using OpenStreetMap.';
      document.getElementById('app')?.append(warning);
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
