import { renderBuildDiagnostics, renderPaletteLegend, renderSampleTable } from '@av/contracts/client/dom';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { type LayerId, type ModelId } from '@av/contracts';
import {
  ApiClient,
  createRasterTileProtocol,
  type RasterTileProtocol,
  DEFAULT_OPACITY,
  OVERLAY_LAYER_ID,
  OVERLAY_SOURCE_ID,
  assertNotExpired,
  coverageSummaryText,
  forecastHorizonNotice,
  formatBuildFreshness,
  formatSeriesSummary,
  frameBadge,
  matchHostFrame,
  normalizePoint,
  sampleRequestText,
  populateModelOptions,
  previewRasterLayer,
  previewRasterSource,
  samePoint,
  selectExplicitFrame,
  watchBuildExpiry,
  type GeoPoint,
  type PinnedBuild
} from '@av/contracts/client';
import './style.css';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const modelSelect = element<HTMLSelectElement>('model');
const refreshButton = element<HTMLButtonElement>('refresh-latest');
const refreshStatus = element<HTMLParagraphElement>('refresh-status');
const layerSelect = element<HTMLSelectElement>('layer');
const frameSelect = element<HTMLSelectElement>('frame');
const opacityInput = element<HTMLInputElement>('opacity');
const timestampBadge = element<HTMLParagraphElement>('timestamp');
const freshness = element<HTMLParagraphElement>('freshness');
const horizonNotice = element<HTMLParagraphElement>('horizon-notice');
const tileErrorBox = element<HTMLParagraphElement>('tile-error');
const errorBox = element<HTMLParagraphElement>('error');
const coverageNote = element<HTMLParagraphElement>('coverage-note');
const meta = element<HTMLDListElement>('meta');
const legend = element<HTMLDivElement>('legend');
const seriesButton = element<HTMLButtonElement>('series-button');
const seriesStatus = element<HTMLParagraphElement>('series-status');
const seriesPanel = element<HTMLDivElement>('series');

const offlineFixture = import.meta.env.VITE_OFFLINE_FIXTURE === 'true';
const initialModel = import.meta.env.VITE_MODEL ?? 'gfs';
if (offlineFixture) {
  const warning = document.createElement('p');
  warning.className = 'notice';
  warning.textContent = 'SYNTHETIC FIXTURE — development data, not a forecast';
  document.getElementById('panel')?.prepend(warning);
}
const apiBaseUrl = import.meta.env.AV_API_BASE ?? 'http://localhost:8787';
const api = new ApiClient({ baseUrl: apiBaseUrl });

if (offlineFixture) modelSelect.add(new Option('Synthetic fixture', initialModel));
else populateModelOptions(modelSelect);
opacityInput.value = String(DEFAULT_OPACITY);

maplibregl.setWorkerUrl(workerUrl);

function startPreview(): void {
  const map = new maplibregl.Map({
    container: 'map',
    center: [-30, 25],
    zoom: 2,
    style: offlineFixture ? { version: 8, sources: {}, layers: [{ id: 'neutral-background', type: 'background', paint: { 'background-color': '#17242c' } }] } : {
      version: 8,
      sources: {
        basemap: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '© OpenStreetMap contributors'
        }
      },
      layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }]
    }
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  let build: PinnedBuild | null = null;
  let selectedFrame: string | null = null;
  let opacity = DEFAULT_OPACITY;
  let expired = false;
  let mapFailed = false;
  let overlaySourceId = OVERLAY_SOURCE_ID;
  let overlayGeneration = 0;
  let overlayProtocol: RasterTileProtocol | null = null;
  const failedTiles = new Set<object>();
  let sourceFailed = false;
  let pendingModel: ModelId | null = null;
  let resumeModel: ModelId | null = null;
  let loadAbort: AbortController | null = null;
  let refreshAbort: AbortController | null = null;
  let seriesAbort: AbortController | null = null;
  let clicked: GeoPoint | null = null;
  let expiryTimer: number | null = null;
  let disposeExpiry = () => {};
  let suspended = false;
  let lastLatestCheckAt = 0;

  function clearSeries(): void {
    seriesPanel.replaceChildren();
    seriesPanel.tabIndex = -1;
    seriesStatus.textContent = '';
  }

  map.on('click', event => {
    if (mapFailed) return;
    seriesAbort?.abort();
    seriesAbort = null;
    clearSeries();
    clicked = normalizePoint(event.lngLat.lat, event.lngLat.lng);
    seriesButton.disabled = !build || expired;
    seriesStatus.textContent = `Clicked ${clicked.lat.toFixed(4)}, ${clicked.lon.toFixed(4)}`;
  });

  type OverlayEvent = { sourceId?: string; tile?: object };

  function updateTileError(): void {
    tileErrorBox.hidden = !sourceFailed && failedTiles.size === 0;
    tileErrorBox.textContent = tileErrorBox.hidden ? '' : 'Overlay tile failed to load — forecast display may be incomplete.';
  }

  function resetTileErrors(): void {
    failedTiles.clear();
    sourceFailed = false;
    updateTileError();
  }

  map.on('error', (event: OverlayEvent & { error?: unknown }) => {
    if (event.error instanceof maplibregl.GPUInitializationError) {
      mapFailed = true;
      loadAbort?.abort();
      loadAbort = null;
      refreshAbort?.abort();
      refreshAbort = null;
      seriesAbort?.abort();
      seriesAbort = null;
      pendingModel = null;
      resumeModel = null;
      clicked = null;
      clearSeries();
      disposeExpiry();
      if (expiryTimer !== null) window.clearInterval(expiryTimer);
      expiryTimer = null;
      removeOverlay();
      map.remove();
      showMapFailure(event.error);
      return;
    }
    if (!build || expired || event.sourceId !== overlaySourceId) return;
    if (event.tile) failedTiles.add(event.tile);
    else sourceFailed = true;
    updateTileError();
  });

  // A different tile succeeding (or the source settling with errors) is not recovery.
  map.on('sourcedata', (event: OverlayEvent) => {
    if (event.sourceId === overlaySourceId && event.tile && failedTiles.delete(event.tile)) updateTileError();
  });
  map.on('sourcedataabort', (event: OverlayEvent) => {
    if (event.sourceId === overlaySourceId && event.tile && failedTiles.delete(event.tile)) updateTileError();
  });

  function showError(message: string): void {
    errorBox.hidden = false;
    errorBox.textContent = message;
  }

  function clearError(): void {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }

  function updateFreshness(): void {
    if (!build || expired) return;
    const now = Date.now();
    if (build.expiresAtMs <= now) {
      expireView();
      return;
    }
    const notice = forecastHorizonNotice(build.manifest, now);
    horizonNotice.textContent = notice ?? '';
    horizonNotice.hidden = notice === null;
    freshness.textContent = formatBuildFreshness(build.manifest, build.expiresAtMs, now);
  }

  function setControlsEnabled(enabled: boolean): void {
    modelSelect.disabled = mapFailed || pendingModel !== null;
    refreshButton.disabled = modelSelect.disabled || refreshAbort !== null;
    layerSelect.disabled = !enabled;
    frameSelect.disabled = !enabled;
    opacityInput.disabled = !enabled;
    seriesButton.disabled = !enabled || !clicked;
  }

  function removeOverlay(): void {
    const protocol = overlayProtocol;
    overlayProtocol = null;
    protocol?.dispose();
    try {
      if (map.getLayer(OVERLAY_LAYER_ID)) map.removeLayer(OVERLAY_LAYER_ID);
      if (map.getSource(overlaySourceId)) map.removeSource(overlaySourceId);
    } finally {
      if (protocol) maplibregl.removeProtocol(protocol.scheme);
    }
  }

  function expireView(): void {
    if (expired) return;
    expired = true;
    resetTileErrors();
    horizonNotice.hidden = true;
    horizonNotice.textContent = '';
    loadAbort?.abort();
    seriesAbort?.abort();
    seriesAbort = null;
    clearSeries();
    removeOverlay();
    setControlsEnabled(false);
    seriesButton.disabled = true;
    timestampBadge.textContent = frameBadge(null, null, null, true).text;
    freshness.textContent = 'Expired immutable build';
    showError('This build has expired. Refresh the latest forecast or choose another model.');
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
    if (!build || !selectedFrame || !ensureLive()) return;
    const activeLayer = layerSelect.value as LayerId;
    renderPaletteLegend(legend, build, activeLayer);
    const template = build.templates[activeLayer];
    if (!template) {
      showError(`No tile template for ${activeLayer}`);
      return;
    }
    removeOverlay();
    resetTileErrors();
    clearError();
    try {
      // Give late events from an earlier frame a distinct source identity.
      overlaySourceId = `${OVERLAY_SOURCE_ID}-${++overlayGeneration}`;
      overlayProtocol = createRasterTileProtocol(apiBaseUrl);
      maplibregl.addProtocol(overlayProtocol.scheme, overlayProtocol.load);
      const source = previewRasterSource(template, selectedFrame, build.manifest.coverage.maxZoom, build.manifest.descriptors.attribution);
      source.tiles = source.tiles.map(overlayProtocol.url);
      map.addSource(overlaySourceId, source);
      map.addLayer({ ...previewRasterLayer(opacity), source: overlaySourceId });
      const frame = selectExplicitFrame(build.manifest.frames, selectedFrame);
      timestampBadge.textContent = frameBadge(frame, null, null).text;
    } catch (error) {
      removeOverlay();
      timestampBadge.textContent = 'Overlay unavailable';
      showError(`Overlay display failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function populateFrames(buildValue: PinnedBuild, selectedTime?: number): void {
    frameSelect.replaceChildren(...buildValue.manifest.frames.map(frame => new Option(`${frame.id} · ${frame.validTime}`, frame.id)));
    selectedFrame = (selectedTime === undefined ? null : matchHostFrame(buildValue.manifest.frames, selectedTime, Infinity))?.id
      ?? buildValue.manifest.frames[0]?.id ?? null;
    if (selectedFrame) frameSelect.value = selectedFrame;
    frameSelect.disabled = false;
  }

  function populateLayers(buildValue: PinnedBuild): void {
    layerSelect.replaceChildren(...buildValue.manifest.layers.map(layer => new Option(buildValue.manifest.descriptors.layers[layer].label, layer)));
    layerSelect.value = buildValue.manifest.layers[0] ?? '';
    layerSelect.disabled = false;
  }

  function installBuild(next: PinnedBuild, preserveView = false): void {
    const selectedTime = preserveView && build
      ? Date.parse(build.manifest.frames.find(frame => frame.id === selectedFrame)?.validTime ?? '') : undefined;
    const selectedLayer = layerSelect.value as LayerId;
    disposeExpiry();
    seriesAbort?.abort();
    seriesAbort = null;
    clearSeries();
    build = next;
    expired = false;
    populateLayers(next);
    if (preserveView && next.manifest.layers.includes(selectedLayer)) layerSelect.value = selectedLayer;
    populateFrames(next, selectedTime);
    coverageNote.textContent = coverageSummaryText(next);
    renderBuildDiagnostics(meta, next);
    if (!preserveView) map.fitBounds(
      [[next.manifest.descriptors.bounds[0], next.manifest.descriptors.bounds[1]],
        [next.manifest.descriptors.bounds[2], next.manifest.descriptors.bounds[3]]],
      { padding: 24, duration: 0 }
    );
    updateOverlay();
    updateFreshness();
    setControlsEnabled(!expired);
    disposeExpiry = watchBuildExpiry(next.expiresAtMs, expireView, [document, window]);
  }

  function scheduleFreshness(): void {
    if (expiryTimer !== null || mapFailed || suspended) return;
    expiryTimer = window.setInterval(() => {
      updateFreshness();
      if (Date.now() - lastLatestCheckAt >= 60_000) void refreshLatest();
    }, 5000);
  }

  async function refreshLatest(): Promise<void> {
    if (mapFailed || suspended || document.visibilityState === 'hidden' || loadAbort || refreshAbort) return;
    if (!build && expiryTimer === null) return;
    if (!build) return loadModel(modelSelect.value);
    const previous = build;
    const requestAbort = new AbortController();
    refreshAbort = requestAbort;
    lastLatestCheckAt = Date.now();
    refreshButton.disabled = true;
    try {
      const next = await api.latest(previous.manifest.model, { signal: requestAbort.signal });
      if (requestAbort.signal.aborted || refreshAbort !== requestAbort || build !== previous) return;
      refreshStatus.hidden = true;
      refreshStatus.textContent = '';
      if (next.manifest.buildId !== previous.manifest.buildId) installBuild(next, true);
    } catch (error) {
      if (requestAbort.signal.aborted || refreshAbort !== requestAbort || build !== previous) return;
      refreshStatus.hidden = false;
      refreshStatus.textContent = `Latest forecast refresh failed: ${error instanceof Error ? error.message : String(error)}. Use Refresh latest to retry.`;
    } finally {
      if (refreshAbort === requestAbort) {
        refreshAbort = null;
        refreshButton.disabled = mapFailed || pendingModel !== null;
      }
    }
  }

  async function loadModel(model: ModelId): Promise<void> {
    if (mapFailed) return;
    disposeExpiry();
    if (expiryTimer !== null) {
      window.clearInterval(expiryTimer);
      expiryTimer = null;
    }
    loadAbort?.abort();
    refreshAbort?.abort();
    refreshAbort = null;
    seriesAbort?.abort();
    seriesAbort = null;
    clearSeries();
    const requestAbort = new AbortController();
    loadAbort = requestAbort;
    pendingModel = model;
    lastLatestCheckAt = Date.now();
    resumeModel = null;
    modelSelect.value = model;
    expired = false;
    resetTileErrors();
    horizonNotice.hidden = true;
    horizonNotice.textContent = '';
    build = null;
    selectedFrame = null;
    layerSelect.replaceChildren();
    frameSelect.replaceChildren();
    legend.replaceChildren();
    meta.replaceChildren();
    refreshStatus.hidden = true;
    refreshStatus.textContent = '';
    clicked = null;
    setControlsEnabled(false);
    removeOverlay();
    clearError();
    coverageNote.textContent = '';
    freshness.textContent = `Loading ${model} latest immutable build…`;
    timestampBadge.textContent = 'No frame selected';
    try {
      const next = await api.latest(model, { signal: requestAbort.signal });
      if (requestAbort.signal.aborted || loadAbort !== requestAbort) return;
      installBuild(next);
    } catch (error) {
      if (requestAbort.signal.aborted || loadAbort !== requestAbort || (error instanceof DOMException && error.name === 'AbortError')) return;
      const message = error instanceof Error ? error.message : String(error);
      showError(message);
      freshness.textContent = 'No viewable build';
      setControlsEnabled(false);
    } finally {
      if (loadAbort === requestAbort) {
        loadAbort = null;
        pendingModel = null;
        modelSelect.disabled = mapFailed;
        refreshButton.disabled = mapFailed;
        scheduleFreshness();
      }
    }
  }

  layerSelect.addEventListener('change', updateOverlay);
  frameSelect.addEventListener('change', () => {
    selectedFrame = frameSelect.value;
    updateOverlay();
  });
  opacityInput.addEventListener('input', () => {
    opacity = Number(opacityInput.value);
    if (map.getLayer(OVERLAY_LAYER_ID)) map.setPaintProperty(OVERLAY_LAYER_ID, 'raster-opacity', opacity);
  });
  modelSelect.addEventListener('change', () => {
    void loadModel(modelSelect.value as ModelId);
  });
  refreshButton.addEventListener('click', () => { void refreshLatest(); });

  seriesButton.addEventListener('click', async () => {
    if (!build || !clicked || expired || mapFailed) return;
    seriesAbort?.abort();
    const requestAbort = new AbortController();
    seriesAbort = requestAbort;
    const requestedBuild = build;
    const requestedPoint = { ...clicked };
    seriesButton.disabled = true;
    seriesStatus.textContent = sampleRequestText(requestedBuild, requestedPoint);
    try {
      const layers = [...requestedBuild.manifest.layers];
      const payload = await api.sample(requestedBuild, {
        lat: requestedPoint.lat,
        lon: requestedPoint.lon,
        frames: 'all',
        layers,
        signal: requestAbort.signal
      });
      if (requestAbort.signal.aborted || build !== requestedBuild || !samePoint(clicked, requestedPoint) || !ensureLive()) return;
      assertNotExpired(payload.expiresAt);
      renderSampleTable(seriesPanel, payload, layers, requestedBuild);
      seriesPanel.tabIndex = 0;
      seriesStatus.textContent = formatSeriesSummary(payload, layers, requestedPoint);
    } catch (error) {
      if (requestAbort.signal.aborted || build !== requestedBuild || !samePoint(clicked, requestedPoint) || !ensureLive()) return;
      const message = error instanceof Error ? error.message : String(error);
      seriesStatus.textContent = `Series failed: ${message}`;
    } finally {
      if (seriesAbort === requestAbort) {
        seriesAbort = null;
        if (!expired && !mapFailed && clicked) seriesButton.disabled = false;
      }
    }
  });

  map.on('load', () => {
    void loadModel(initialModel);
  });

  window.addEventListener('pagehide', (event: PageTransitionEvent) => {
    suspended = true;
    resumeModel = event.persisted ? pendingModel : null;
    loadAbort?.abort();
    refreshAbort?.abort();
    refreshAbort = null;
    if (event.persisted && seriesAbort) seriesStatus.textContent = 'Point request interrupted. Sample this point again.';
    seriesAbort?.abort();
    seriesAbort = null;
    if (expiryTimer !== null) {
      window.clearInterval(expiryTimer);
      expiryTimer = null;
    }
    removeOverlay();
    if (event.persisted) return;
    disposeExpiry();
    if (!mapFailed) map.remove();
  });

  window.addEventListener('pageshow', (event: PageTransitionEvent) => {
    suspended = false;
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
    }
    scheduleFreshness();
    void refreshLatest();
  });

  const wake = () => { updateFreshness(); void refreshLatest(); };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('focus', wake);

}

function showMapFailure(error: unknown): void {
  for (const control of [modelSelect, refreshButton, layerSelect, frameSelect, opacityInput, seriesButton]) control.disabled = true;
  errorBox.hidden = false;
  errorBox.textContent = error instanceof maplibregl.GPUInitializationError
    ? 'Map unavailable: this browser needs WebGL2. Enable graphics acceleration or try another browser.'
    : `Map initialization failed: ${error instanceof Error ? error.message : String(error)}`;
  timestampBadge.textContent = 'Map unavailable';
  freshness.textContent = '';
}

try { startPreview(); } catch (error) { showMapFailure(error); }
