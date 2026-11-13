import { renderBuildDiagnostics } from '@av/client/dom';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { LIFT_RENDER_STYLE, LIFT_STEP_RENDER_STYLE, type LayerId } from '@av/contracts/layers';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import { renderedFrames, type ModelId } from '@av/contracts/publication';
import {
  ApiClient,
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
import { previewQuery, previewUrl, type AltitudeReference } from './url-state';
import { clockLabel, dayKey, dayLabel, frameIndexFor } from './timeline';

type PointWindgram = typeof import('@av/windgram');

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const modelBar = element<HTMLDivElement>('models');
const refAgl = element<HTMLButtonElement>('ref-agl');
const refMsl = element<HTMLButtonElement>('ref-msl');
const opacityInput = element<HTMLInputElement>('opacity');
const opacityReadout = element<HTMLSpanElement>('opacity-readout');
const timeInput = element<HTMLInputElement>('time');
const dayBar = element<HTMLDivElement>('days');
const timestamp = element<HTMLParagraphElement>('timestamp');
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
const pointStatus = element<HTMLParagraphElement>('point-status');
const pointBody = element<HTMLDivElement>('point-body');
const pointUnits = element<HTMLSelectElement>('point-units');
const pointHorizonSelect = element<HTMLSelectElement>('point-horizon');
const pointHorizonLabel = element<HTMLLabelElement>('point-horizon-label');
const meta = element<HTMLDListElement>('meta');

const LIFT: readonly LayerId[] = ['usable-lift-agl', 'usable-lift-msl'];

const offlineFixture = import.meta.env.VITE_OFFLINE_FIXTURE === 'true';
const apiBaseUrl = import.meta.env.AV_API_BASE ?? 'http://localhost:8787';
const api = new ApiClient({ baseUrl: apiBaseUrl });

const startup = previewQuery(window.location.search, offlineFixture);
const initialModel = startup.model ?? import.meta.env.VITE_MODEL ?? 'icon-eu';
const initialOpacity = startup.opacity ?? 0.7;

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

function startPreview(): void {
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
    maxTileCacheSize: 16,
    style: offlineFixture
      ? { version: 8, sources: {}, layers: [{ id: 'neutral-background', type: 'background', paint: { 'background-color': '#d5dde3' } }] }
      : basemapStyle()
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  const lifecycle = new AbortController();
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
  let overlayState: OverlayState = { displayed: null, requested: null, incomplete: false, replacementFailed: false };
  const overlay = new RasterOverlay(map, apiBaseUrl, opacity, state => {
    overlayState = state;
    updateOverlayStatus();
  });
  let timelineRaf: number | null = null;
  let pendingModel: ModelId | null = null;
  let resumeModel: ModelId | null = null;
  let loadAbort: AbortController | null = null;
  let autoAbort: AbortController | null = null;
  const pointSeries = new PointSeriesController(api);
  let pointUnitSystem: UnitSystem = 'metric';
  let pointHorizon: PointHorizon = 'day';
  let windgram: PointWindgram | null = null;
  let updatePointSeries: ReturnType<PointWindgram['renderPointWindgram']> | null = null;
  let expiryTimer: number | null = null;
  let disposeExpiry = () => {};
  let urlReady = false;
  let historyRevision = 0;
  let applyingHistory: number | null = null;
  let opacityCommitted = false;
  let legendOpen = true;

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
    pointBody.tabIndex = -1;
    meta.replaceChildren();
  }

  function setControlsEnabled(enabled: boolean): void {
    for (const button of modelButtons) button.disabled = mapFailed || pendingModel !== null;
    for (const button of Array.from(dayBar.children)) (button as HTMLButtonElement).disabled = !enabled;
    refAgl.disabled = !enabled;
    refMsl.disabled = !enabled;
    opacityInput.disabled = !enabled;
    timeInput.disabled = !enabled;
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
    const palette = displayedBuild ? activePalettes(displayedBuild.manifest.descriptors.palettes, layer, displayedBuild.manifest.descriptors.layers)[0] : undefined;
    if (!displayedBuild || !palette) {
      legend.hidden = true;
      legendBody.replaceChildren();
      return;
    }
    legend.hidden = false;
    const title = document.createElement('p');
    title.className = 'ribbon-title';
    const descriptor = displayedBuild.manifest.descriptors.layers[layer];
    title.textContent = layer === 'usable-lift-agl' ? 'Lift above ground (m AGL)' : 'Top of usable lift (m MSL)';
    const scale = document.createElement('div');
    scale.className = 'ribbon-scale';
    const colorCount = palette.colors.length;
    const colors = [...palette.colors].reverse();
    const labels = palette.colors.map((_, index) => {
      const edge = index === colorCount - 1 && palette.edges.length > colorCount ? palette.edges[colorCount] : palette.edges[index];
      return String(edge ?? '');
    }).reverse();
    colors.forEach((color, index) => {
      const row = document.createElement('div');
      row.className = 'ribbon-stop';
      const swatch = document.createElement('span');
      swatch.style.background = color;
      const tick = document.createElement('span');
      tick.textContent = labels[index] ?? '';
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
    if (!build || !selectedFrame) {
      dayBar.replaceChildren();
      timestamp.textContent = expired ? 'Build expired — overlay removed' : 'No frame selected';
      return;
    }
    const frames = renderedFrames(build.manifest);
    const offset = longitudeOffsetHours(mapLon()) * 60;
    const today = dayKey(Date.now(), offset);
    const selected = frames.find(frame => frame.id === selectedFrame) ?? frames[0];
    const selectedKey = selected ? dayKey(Date.parse(selected.validTime), offset) : '';
    dayBar.replaceChildren(...[...new Set(frames.map(frame => dayKey(Date.parse(frame.validTime), offset)))].map(key => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = key === selectedKey ? 'day is-selected' : 'day';
      button.ariaPressed = String(key === selectedKey);
      button.value = key;
      button.textContent = dayLabel(key, today);
      button.disabled = expired || mapFailed;
      button.addEventListener('click', () => {
        const index = frames.findIndex(frame => dayKey(Date.parse(frame.validTime), offset) === key);
        if (index >= 0) selectIndex(index, 'push');
      });
      return button;
    }));
    const index = Math.max(0, frames.findIndex(frame => frame.id === selectedFrame));
    timeInput.min = '0';
    timeInput.max = String(Math.max(0, frames.length - 1));
    if (document.activeElement !== timeInput) timeInput.value = String(index);
    timestamp.textContent = selected ? clockLabel(Date.parse(selected.validTime), offset) : 'No frame selected';
  }

  function removeOverlay(dispose = false): void {
    if (timelineRaf !== null) window.cancelAnimationFrame(timelineRaf);
    timelineRaf = null;
    overlay.clear(dispose);
  }

  function resetTileErrors(): void {
    tileErrorBox.hidden = true;
    tileErrorBox.textContent = '';
  }

  function updateOverlayStatus(): void {
    const { displayed, requested, incomplete, replacementFailed } = overlayState;
    const showing = displayed ? `Showing ${displayed.build.manifest.model} ${displayed.frame} ${displayed.layer}.` : 'No forecast displayed.';
    const pending = requested && (!displayed || displayed.build !== requested.build || displayed.layer !== requested.layer || displayed.frame !== requested.frame);
    const olderBuild = displayed && displayed.build !== build;
    const alert = replacementFailed || incomplete;
    tileErrorBox.className = alert ? 'toast error' : 'toast status';
    tileErrorBox.role = alert ? 'alert' : 'status';
    tileErrorBox.hidden = !alert && !pending && !pendingModel && !olderBuild;
    tileErrorBox.textContent = replacementFailed ? `Forecast replacement failed. ${showing}` : incomplete ? `Overlay tile failed to load — forecast display may be incomplete. ${showing}` : pendingModel ? `Loading ${pendingModel}. ${showing}` : pending ? `Loading ${requested.frame} ${requested.layer}. ${showing}` : olderBuild ? showing : '';
    if (displayed) renderRibbon(displayed.layer, displayed.build);
    else { legend.hidden = true; legendBody.replaceChildren(); }
    updatePointSeries?.(pointSeries.frameId, pointUnitSystem, displayedPointFrame());
  }

  function displayedPointFrame(): string | null {
    return overlayState.displayed?.build === build ? overlayState.displayed.frame : null;
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
    closePoint();
    disposeExpiry();
    removeOverlay();
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
    clearError();
    try {
      overlay.select(build, layer, selectedFrame);
      updateTimeUi();
    } catch (error) {
      showError(`Overlay display failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function selectIndex(index: number, history: 'none' | 'push' | 'replace'): void {
    const frame = build ? renderedFrames(build.manifest)[index] : undefined;
    if (!frame) return;
    if (currentModel === AUTO_MODEL_ID && requestedTime !== frame.validTime) autoAbort?.abort();
    selectedFrame = frame.id;
    requestedTime = frame.validTime;
    updateTimeUi();
    followMapFrame();
    if (timelineRaf !== null) window.cancelAnimationFrame(timelineRaf);
    timelineRaf = window.requestAnimationFrame(() => { timelineRaf = null; updateOverlay(); });
    if (history !== 'none') {
      writeUrl(history);
      if (currentModel === AUTO_MODEL_ID) void loadAuto();
    }
  }

  function followMapFrame(): void {
    pointSeries.followMapFrame(selectedFrame);
    updatePointSeries?.(pointSeries.frameId, pointUnitSystem, displayedPointFrame());
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
      const next = await resolveAutoBuild(api, { ...normalizePoint(lat, lng), layers, signal: request.signal,
        ...(Number.isFinite(time) ? { validTimeMs: time } : {}) });
      if (request.signal.aborted || autoAbort !== request || currentModel !== AUTO_MODEL_ID) return;
      if (next) {
        if (build?.manifest.model === next.build.manifest.model && build.manifest.buildId === next.build.manifest.buildId) {
          selectedFrame = next.frame.id;
          followMapFrame();
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
      closePoint();
      removeOverlay();
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
    dayBar.replaceChildren();
    legend.hidden = true;
    legendBody.replaceChildren();
    closePoint();
    setControlsEnabled(false);
    clearError();
    freshness.textContent = `Loading ${model} latest immutable build…`;
    timestamp.textContent = 'No frame selected';
    updateOverlayStatus();
    try {
      const next = resolved?.build ?? await api.latest(model, { signal: requestAbort.signal });
      if (requestAbort.signal.aborted || loadAbort !== requestAbort) return;
      build = next;
      pointHorizonLabel.hidden = pointSeriesSelection(next).frames.length === next.manifest.frames.length;
      pointHorizonSelect.children[0].textContent = next.manifest.mapFrameCount !== undefined ? 'Map forecast' : '24 hours';
      if (resolved) selectedFrame = resolved.frame.id;
      else chooseFrame(next);
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
      dayBar.replaceChildren();
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
        updatePointSeries?.(id, pointUnitSystem, displayedPointFrame());
        selectIndex(renderedFrames(context.build.manifest).findIndex(frame => frame.id === id), 'push');
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
    meta.replaceChildren();
    windgram?.disposePointWindgram(pointBody);
    pointBody.replaceChildren(); updatePointSeries = null; pointBody.tabIndex = -1;
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
  pointUnits.value = pointUnitSystem;
  pointUnits.addEventListener('change', () => {
    pointUnitSystem = pointUnits.value === 'imperial' ? 'imperial' : 'metric';
    updatePointSeries?.(pointSeries.frameId, pointUnitSystem, displayedPointFrame());
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
  const pointControls = [pointCard, refAgl, refMsl, timeInput, dayBar];
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
    if (expiryTimer !== null) window.clearInterval(expiryTimer);
    expiryTimer = null;
    overlay.destroy(); map.remove(); showMapFailure(event.error);
  });

  window.addEventListener('popstate', applyHistory, globalListener);
  window.addEventListener('pagehide', (event: PageTransitionEvent) => {
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
    }
    if (!event.persisted || pointInterrupted) pointSeries.close();
    if (expiryTimer !== null) {
      window.clearInterval(expiryTimer);
      expiryTimer = null;
    }
    removeOverlay(true);
    if (event.persisted) return;
    lifecycle.abort();
    windgram?.disposePointWindgram(pointBody);
    disposeExpiry();
    overlay.destroy(); map.remove();
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

try { startPreview(); } catch (error) { showMapFailure(error); }
