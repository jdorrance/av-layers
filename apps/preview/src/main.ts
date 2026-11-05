import { renderBuildDiagnostics, renderPointSeries } from '@av/contracts/client/dom';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { PRODUCTS, renderedFrames, type LayerId, type ModelId } from '@av/contracts';
import {
  ApiClient,
  activePalettes,
  assertNotExpired,
  pointSeriesLabel,
  forecastHorizonNotice,
  formatBuildFreshness,
  normalizePoint,
  samePoint,
  watchBuildExpiry,
  type GeoPoint,
  type PinnedBuild,
  type PointSeries,
  type PointSeriesLoader,
  type PointHorizon,
  type UnitSystem
} from '@av/contracts/client';
import './style.css';
import { RasterOverlay, type OverlayState } from './raster-overlay';

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
const pointCard = element<HTMLDivElement>('point-card');
const pointSummary = element<HTMLParagraphElement>('point-summary');
const pointStatus = element<HTMLParagraphElement>('point-status');
const pointBody = element<HTMLDivElement>('point-body');
const pointUnits = element<HTMLSelectElement>('point-units');
const pointHorizonSelect = element<HTMLSelectElement>('point-horizon');
const meta = element<HTMLDListElement>('meta');

const ARMENIA: [[number, number], [number, number]] = [[43.45, 38.84], [46.63, 41.3]];
const EUROPE: [[number, number], [number, number]] = [[-23.5, 29.5], [62.5, 70.5]];
const NORTH_AMERICA: [[number, number], [number, number]] = [[-134.12, 21.12], [-60.89, 52.63]];
const LIFT: readonly LayerId[] = ['usable-lift-agl', 'usable-lift-msl'];

const offlineFixture = import.meta.env.VITE_OFFLINE_FIXTURE === 'true';
const apiBaseUrl = import.meta.env.AV_API_BASE ?? 'http://localhost:8787';
const api = new ApiClient({ baseUrl: apiBaseUrl });

function finiteParam(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function startupQuery(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

const query = startupQuery();
const queryModel = query.get('model');
const configuredModel = import.meta.env.VITE_MODEL as ModelId | undefined;
const initialModel: ModelId = (queryModel && (offlineFixture || PRODUCTS.some(product => product.modelId === queryModel))
  ? queryModel
  : configuredModel ?? 'icon-eu') as ModelId;
const queryLat = finiteParam(query.get('lat'));
const queryLon = finiteParam(query.get('lon'));
const queryZoom = finiteParam(query.get('z'));
const hasCameraQuery = queryLat !== null && queryLon !== null && queryZoom !== null;
const queryOpacity = finiteParam(query.get('opacity'));
const initialOpacity = queryOpacity === null ? 0.7 : Math.min(1, Math.max(0, queryOpacity));
const initialReference = query.get('ref') === 'msl' ? 'msl' : 'agl';
const initialTime = query.get('t');

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

function zoneOffsetMinutes(lon: number): number {
  const wrapped = ((lon + 180) % 360 + 360) % 360 - 180;
  return Math.max(-12, Math.min(14, Math.round(wrapped / 15))) * 60;
}

function dayKey(utcMs: number, offsetMinutes: number): string {
  return new Date(utcMs + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function dayLabel(key: string, todayKey: string): string {
  const day = Date.parse(`${key}T00:00:00Z`);
  const today = Date.parse(`${todayKey}T00:00:00Z`);
  const diff = Math.round((day - today) / 86_400_000);
  if (diff === -1) return 'Yesterday';
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return new Date(day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function clockLabel(validMs: number, offsetMinutes: number): string {
  const local = new Date(validMs + offsetMinutes * 60_000);
  const utc = new Date(validMs);
  const hhmm = (date: Date) => `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  const sign = offsetMinutes >= 0 ? '+' : '−';
  const abs = Math.abs(offsetMinutes);
  const zone = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${hhmm(local)} local (${zone}) · ${hhmm(utc)} UTC`;
}

function frameIndexFor(frames: readonly { validTime: string }[], requested: string | null, now: number): number {
  if (requested) {
    const exact = frames.findIndex(frame => frame.validTime === requested);
    if (exact >= 0) return exact;
    const target = Date.parse(requested);
    if (Number.isFinite(target)) {
      let best = 0;
      let distance = Number.POSITIVE_INFINITY;
      frames.forEach((frame, index) => {
        const delta = Math.abs(Date.parse(frame.validTime) - target);
        if (delta < distance) { best = index; distance = delta; }
      });
      return best;
    }
  }
  let best = 0;
  let bestAt = Number.NEGATIVE_INFINITY;
  frames.forEach((frame, index) => {
    const at = Date.parse(frame.validTime);
    if (at <= now && at >= bestAt) { best = index; bestAt = at; }
  });
  return best;
}

function terrainStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles: [0, 1, 2, 3].map(host => `https://mt${host}.google.com/vt/lyrs=p&hl=en&x={x}&y={y}&z={z}`),
        tileSize: 256,
        maxzoom: 20,
        attribution: '© Google'
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
    : PRODUCTS.map(product => ({ modelId: product.modelId, label: product.label }));
  for (const choice of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'model-button';
    button.value = choice.modelId;
    button.textContent = choice.label;
    modelButtons.push(button);
    modelBar.append(button);
  }

  const center: [number, number] = hasCameraQuery
    ? [queryLon!, queryLat!]
    : initialModel === 'rrfs' ? [-97.5, 39] : initialModel === 'icon-eu' ? [45.04, 40.07] : [0, 20];
  const zoom = hasCameraQuery ? queryZoom! : initialModel === 'icon-eu' ? 7 : initialModel === 'rrfs' ? 3.2 : 2;
  const map = new maplibregl.Map({
    container: 'map',
    center,
    zoom,
    style: offlineFixture
      ? { version: 8, sources: {}, layers: [{ id: 'neutral-background', type: 'background', paint: { 'background-color': '#d5dde3' } }] }
      : terrainStyle()
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  let build: PinnedBuild | null = null;
  let currentModel: ModelId = initialModel;
  let reference: 'agl' | 'msl' = initialReference;
  let requestedTime = initialTime;
  let selectedFrame: string | null = null;
  let opacity = initialOpacity;
  let expired = false;
  let mapFailed = false;
  let overlayState: OverlayState = { displayed: null, requested: null, incomplete: false, replacementFailed: false };
  const overlay = new RasterOverlay(map, apiBaseUrl, opacity, state => {
    overlayState = state;
    updateOverlayStatus();
  });
  let timelineRaf: number | null = null;
  let pendingModel: ModelId | null = null;
  let resumeModel: ModelId | null = null;
  let loadAbort: AbortController | null = null;
  let seriesAbort: AbortController | null = null;
  let clicked: GeoPoint | null = null;
  let pointOpen = false;
  let pointUnitSystem: UnitSystem = 'metric';
  let pointHorizon: PointHorizon = 'day';
  let pointFrameId: string | null = null;
  let pointLoader: PointSeriesLoader | null = null;
  let updatePointSeries: ReturnType<typeof renderPointSeries> | null = null;
  let pointInterrupted = false;
  let ignoreNextMapClick = false;
  let expiryTimer: number | null = null;
  let disposeExpiry = () => {};
  let urlReady = false;
  let applyingHistory = false;
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

  function locationHref(): string {
    const params = new URLSearchParams();
    params.set('model', currentModel);
    params.set('ref', reference);
    params.set('opacity', String(Math.round(opacity * 100) / 100));
    const camera = map.getCenter();
    params.set('lat', camera.lat.toFixed(4));
    params.set('lon', camera.lng.toFixed(4));
    params.set('z', String(Math.round(map.getZoom() * 100) / 100));
    const frame = build?.manifest.frames.find(item => item.id === selectedFrame);
    if (frame) params.set('t', frame.validTime);
    return `${window.location.pathname}?${params}`;
  }

  function writeUrl(mode: 'push' | 'replace'): void {
    if (applyingHistory || !urlReady || pendingModel) return;
    const next = locationHref();
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

  function closePoint(): void {
    pointOpen = false;
    pointInterrupted = false;
    seriesAbort?.abort();
    seriesAbort = null;
    pointLoader?.dispose(); pointLoader = null; pointFrameId = null;
    pointCard.hidden = true;
    pointSummary.textContent = '';
    pointStatus.textContent = '';
    pointBody.replaceChildren();
    updatePointSeries = null;
    pointBody.tabIndex = -1;
    meta.replaceChildren();
    clicked = null;
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
    const notice = forecastHorizonNotice({ frames: renderedFrames(build.manifest) }, now);
    horizonNotice.textContent = notice ?? '';
    horizonNotice.hidden = notice === null;
    freshness.textContent = formatBuildFreshness(build.manifest, build.expiresAtMs, now);
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
    title.textContent = layer === 'usable-lift-agl' ? 'Lift above ground (m)' : 'Top of usable lift (m)';
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
    legendBody.replaceChildren(body);
  }

  function updateTimeUi(): void {
    if (!build || !selectedFrame) {
      dayBar.replaceChildren();
      timestamp.textContent = expired ? 'Build expired — overlay removed' : 'No frame selected';
      return;
    }
    const frames = renderedFrames(build.manifest);
    const offset = zoneOffsetMinutes(mapLon());
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
    updatePointSeries?.(pointFrameId, pointUnitSystem, displayedPointFrame());
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
    if (!build || !selectedFrame || !layer || !ensureLive()) return;
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
    selectedFrame = frame.id;
    requestedTime = frame.validTime;
    updateTimeUi();
    pointFrameId = selectedFrame;
    updatePointSeries?.(pointFrameId, pointUnitSystem, displayedPointFrame());
    if (timelineRaf !== null) window.cancelAnimationFrame(timelineRaf);
    timelineRaf = window.requestAnimationFrame(() => { timelineRaf = null; updateOverlay(); });
    if (history !== 'none') writeUrl(history);
  }

  function chooseFrame(value: PinnedBuild): void {
    const frames = renderedFrames(value.manifest);
    const index = frameIndexFor(frames, requestedTime, Date.now());
    selectedFrame = frames[index]?.id ?? null;
    const frame = value.manifest.frames.find(item => item.id === selectedFrame);
    if (frame) requestedTime = frame.validTime;
  }

  async function loadModel(model: ModelId): Promise<void> {
    if (mapFailed) return;
    disposeExpiry();
    if (expiryTimer !== null) {
      window.clearInterval(expiryTimer);
      expiryTimer = null;
    }
    loadAbort?.abort();
    seriesAbort?.abort();
    seriesAbort = null;
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
      const next = await api.latest(model, { signal: requestAbort.signal });
      if (requestAbort.signal.aborted || loadAbort !== requestAbort) return;
      build = next;
      chooseFrame(next);
      updateOverlay();
      updateFreshness();
      setControlsEnabled(true);
      syncReference();
      disposeExpiry = watchBuildExpiry(next.expiresAtMs, expireView, [document, window]);
      if (expiryTimer === null) expiryTimer = window.setInterval(updateFreshness, 5000);
      if (loadAbort === requestAbort) pendingModel = null;
      urlReady = true;
      if (!applyingHistory) writeUrl('replace');
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
    if (model === 'icon-eu') map.fitBounds(EUROPE, { padding: 32, duration: 0 });
    else if (model === 'rrfs') map.fitBounds(NORTH_AMERICA, { padding: 32, duration: 0 });
  }

  function showPoint(point: GeoPoint, payload: PointSeries): void {
    const place = `${point.lat.toFixed(3)}°, ${point.lon.toFixed(3)}°`;
    pointSummary.textContent = place;
    if (build) {
      const requestedBuild = build;
      if (!payload.frames.some(frame => frame.id === pointFrameId)) pointFrameId = payload.frames.some(frame => frame.id === selectedFrame) ? selectedFrame : payload.frames[0]?.id ?? null;
      updatePointSeries = renderPointSeries(pointBody, payload, build, { frameId: pointFrameId, mapFrameId: displayedPointFrame(), unitSystem: pointUnitSystem, onFrame(id) {
        if (build !== requestedBuild || !pointOpen || !ensureLive()) return;
        pointFrameId = id;
        updatePointSeries?.(id, pointUnitSystem, displayedPointFrame());
        selectIndex(renderedFrames(build.manifest).findIndex(frame => frame.id === id), 'push');
      } });
      pointBody.tabIndex = 0;
      pointStatus.textContent = pointSeriesLabel(payload);
    }
  }

  async function openPoint(point: GeoPoint): Promise<void> {
    if (!build || expired || mapFailed || !ensureLive()) return;
    pointLoader?.dispose();
    pointLoader = api.pointSeries(build, point);
    pointFrameId = selectedFrame;
    clicked = { ...point };
    pointOpen = true; pointInterrupted = false; pointCard.hidden = false;
    pointBody.replaceChildren(); updatePointSeries = null; pointBody.tabIndex = -1;
    await loadPointRange();
  }

  async function loadPointRange(): Promise<void> {
    if (!build || !clicked || !pointLoader || !pointOpen || !ensureLive()) return;
    seriesAbort?.abort();
    const requestAbort = new AbortController();
    seriesAbort = requestAbort;
    const requestedBuild = build;
    const requestedPoint = { ...clicked }, requestedLoader = pointLoader;
    pointSummary.textContent = `${requestedPoint.lat.toFixed(3)}°, ${requestedPoint.lon.toFixed(3)}°`;
    pointStatus.textContent = pointHorizon === 'forecast' ? 'Loading full point forecast…' : 'Loading point…';
    renderBuildDiagnostics(meta, requestedBuild);
    try {
      const payload = await requestedLoader.load(pointHorizon, requestAbort.signal);
      if (requestAbort.signal.aborted || build !== requestedBuild || pointLoader !== requestedLoader || !samePoint(clicked, requestedPoint) || !ensureLive()) return;
      showPoint(requestedPoint, payload);
    } catch (error) {
      if (requestAbort.signal.aborted || build !== requestedBuild || !samePoint(clicked, requestedPoint)) {
        if (pointInterrupted) pointStatus.textContent = 'Point request interrupted. Click the map again.';
        return;
      }
      if (!ensureLive()) return;
      pointStatus.textContent = `Series failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (seriesAbort === requestAbort) seriesAbort = null;
    }
  }

  function applyHistory(): void {
    const params = startupQuery();
    const model = params.get('model');
    applyingHistory = true;
    reference = params.get('ref') === 'msl' ? 'msl' : 'agl';
    syncReference();
    const nextOpacity = finiteParam(params.get('opacity'));
    if (nextOpacity !== null) {
      opacity = Math.min(1, Math.max(0, nextOpacity));
      opacityInput.value = String(opacity);
      opacityReadout.textContent = `${Math.round(opacity * 100)}%`;
      overlay.setOpacity(opacity);
    }
    const lat = finiteParam(params.get('lat'));
    const lon = finiteParam(params.get('lon'));
    const zoomLevel = finiteParam(params.get('z'));
    if (lat !== null && lon !== null && zoomLevel !== null) map.jumpTo({ center: [lon, lat], zoom: zoomLevel });
    requestedTime = params.get('t');
    if (model && model !== currentModel && (offlineFixture || PRODUCTS.some(product => product.modelId === model))) {
      void loadModel(model as ModelId).finally(() => { applyingHistory = false; });
      return;
    }
    if (build) {
      chooseFrame(build);
      updateOverlay();
    }
    applyingHistory = false;
  }

  for (const button of modelButtons) {
    button.addEventListener('click', () => {
      if (button.disabled || mapFailed) return;
      const model = button.value as ModelId;
      void loadModel(model);
      focusRegion(model);
    });
  }
  refAgl.addEventListener('click', () => {
    reference = 'agl';
    syncReference();
    updateOverlay();
    writeUrl('push');
  });
  refMsl.addEventListener('click', () => {
    reference = 'msl';
    syncReference();
    updateOverlay();
    writeUrl('push');
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
  timeInput.addEventListener('change', () => { writeUrl('replace'); });
  pointUnits.value = pointUnitSystem;
  pointUnits.addEventListener('change', () => {
    pointUnitSystem = pointUnits.value === 'imperial' ? 'imperial' : 'metric';
    updatePointSeries?.(pointFrameId, pointUnitSystem, displayedPointFrame());
  });
  pointHorizonSelect.value = pointHorizon;
  pointHorizonSelect.addEventListener('change', () => {
    pointHorizon = pointHorizonSelect.value === 'forecast' ? 'forecast' : 'day';
    void loadPointRange();
  });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement | null)?.matches?.('input,select,textarea,button')) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (!build || !ensureLive()) return;
    event.preventDefault();
    const frames = renderedFrames(build.manifest);
    const index = frames.findIndex(frame => frame.id === selectedFrame);
    selectIndex(Math.max(0, Math.min(frames.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1))), 'replace');
  });
  legendToggle.addEventListener('click', () => {
    legendOpen = !legendOpen;
    legend.className = legendOpen ? 'ribbon' : 'ribbon is-collapsed';
    legendToggle.ariaExpanded = String(legendOpen);
    legendToggle.ariaLabel = legendOpen ? 'Collapse lift scale' : 'Show lift scale';
    legendToggle.textContent = legendOpen ? '⌃' : '⌄';
  });
  document.addEventListener('pointerdown', event => {
    if (!pointOpen) return;
    const target = event.target;
    if (!(target instanceof Node) || pointCard.contains(target)) return;
    closePoint();
    if (map.getContainer().contains(target)) ignoreNextMapClick = true;
  });
  map.on('click', event => {
    if (ignoreNextMapClick) { ignoreNextMapClick = false; return; }
    if (mapFailed) return;
    if (pointOpen) { closePoint(); return; }
    void openPoint(normalizePoint(event.lngLat.lat, event.lngLat.lng));
  });
  map.on('moveend', () => {
    if (build && !expired) updateTimeUi();
    if (!urlReady || applyingHistory) return;
    writeUrl('push');
  });

  map.on('error', (event: { error?: unknown }) => {
    if (!(event.error instanceof maplibregl.GPUInitializationError)) return;
    mapFailed = true;
    loadAbort?.abort(); loadAbort = null; pendingModel = null; resumeModel = null;
    closePoint(); disposeExpiry();
    if (expiryTimer !== null) window.clearInterval(expiryTimer);
    expiryTimer = null;
    overlay.destroy(); map.remove(); showMapFailure(event.error);
  });

  window.addEventListener('popstate', applyHistory);
  window.addEventListener('pagehide', (event: PageTransitionEvent) => {
    resumeModel = event.persisted ? pendingModel : null;
    loadAbort?.abort();
    pointInterrupted = event.persisted && seriesAbort !== null;
    if (pointInterrupted) {
      pointOpen = false;
      pointCard.hidden = false;
      pointStatus.textContent = 'Point request interrupted. Click the map again.';
    }
    seriesAbort?.abort();
    seriesAbort = null;
    if (expiryTimer !== null) {
      window.clearInterval(expiryTimer);
      expiryTimer = null;
    }
    removeOverlay(true);
    if (event.persisted) return;
    pointLoader?.dispose(); pointLoader = null;
    disposeExpiry();
    if (!mapFailed) { overlay.destroy(); map.remove(); }
  });
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
  });
  document.addEventListener('visibilitychange', updateFreshness);
  window.addEventListener('focus', updateFreshness);
  syncReference();
  syncModels();

  map.on('load', () => {
    if (!hasCameraQuery && initialModel === 'icon-eu') map.fitBounds(ARMENIA, { padding: 36, duration: 0 });
    else if (!hasCameraQuery && initialModel === 'rrfs') map.fitBounds(NORTH_AMERICA, { padding: 32, duration: 0 });
    void loadModel(initialModel);
  });
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
