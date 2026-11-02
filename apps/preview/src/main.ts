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
  buildAgeMs,
  coverageSummaryText,
  formatDuration,
  forecastHorizonNotice,
  formatSeriesSummary,
  normalizePoint,
  sampleRequestText,
  populateModelOptions,
  previewRasterLayer,
  previewRasterSource,
  samePoint,
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
  let seriesAbort: AbortController | null = null;
  let clicked: GeoPoint | null = null;
  let expiryTimer: number | null = null;
  let disposeExpiry = () => {};

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
    freshness.textContent = `Build ${build.manifest.buildId} · age ${formatDuration(buildAgeMs(build.manifest.createdAt, now))} · expires in ${formatDuration(build.expiresAtMs - now)} · pinned immutable build`;
  }

  function setControlsEnabled(enabled: boolean): void {
    modelSelect.disabled = !enabled;
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
    if (expiryTimer !== null) {
      window.clearInterval(expiryTimer);
      expiryTimer = null;
    }
    loadAbort?.abort();
    seriesAbort?.abort();
    seriesAbort = null;
    clearSeries();
    removeOverlay();
    setControlsEnabled(false);
    seriesButton.disabled = true;
    timestampBadge.textContent = 'Build expired — cached tiles are not assembled as a current view';
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
      const frame = build.manifest.frames.find(item => item.id === selectedFrame);
      timestampBadge.textContent = frame
        ? `Explicit frame ${frame.id} · valid ${frame.validTime} · interval ${frame.intervalStart} → ${frame.intervalEnd}`
        : `Explicit frame ${selectedFrame}`;
    } catch (error) {
      removeOverlay();
      timestampBadge.textContent = 'Overlay unavailable';
      showError(`Overlay display failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function populateFrames(buildValue: PinnedBuild): void {
    frameSelect.replaceChildren(...buildValue.manifest.frames.map(frame => new Option(`${frame.id} · ${frame.validTime}`, frame.id)));
    selectedFrame = buildValue.manifest.frames[0]?.id ?? null;
    if (selectedFrame) frameSelect.value = selectedFrame;
    frameSelect.disabled = false;
  }

  function populateLayers(buildValue: PinnedBuild): void {
    layerSelect.replaceChildren(...buildValue.manifest.layers.map(layer => new Option(buildValue.manifest.descriptors.layers[layer].label, layer)));
    layerSelect.value = buildValue.manifest.layers[0] ?? '';
    layerSelect.disabled = false;
  }

  async function loadModel(model: ModelId): Promise<void> {
    if (mapFailed) return;
    disposeExpiry();
    loadAbort?.abort();
    seriesAbort?.abort();
    seriesAbort = null;
    clearSeries();
    const requestAbort = new AbortController();
    loadAbort = requestAbort;
    pendingModel = model;
    resumeModel = null;
    modelSelect.value = model;
    expired = false;
    resetTileErrors();
    horizonNotice.hidden = true;
    horizonNotice.textContent = '';
    build = null;
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
      build = next;
      populateLayers(next);
      populateFrames(next);
      coverageNote.textContent = coverageSummaryText(next);
      renderBuildDiagnostics(meta, next);
      map.fitBounds(
        [
          [next.manifest.descriptors.bounds[0], next.manifest.descriptors.bounds[1]],
          [next.manifest.descriptors.bounds[2], next.manifest.descriptors.bounds[3]]
        ],
        { padding: 24, duration: 0 }
      );
      updateOverlay();
      updateFreshness();
      setControlsEnabled(true);
      disposeExpiry = watchBuildExpiry(next.expiresAtMs, expireView, [document, window]);
      if (expiryTimer === null) {
        expiryTimer = window.setInterval(updateFreshness, 5000);
      }
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
    resumeModel = event.persisted ? pendingModel : null;
    loadAbort?.abort();
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
      if (expiryTimer === null) {
        expiryTimer = window.setInterval(updateFreshness, 5000);
      }
    }
  });

  document.addEventListener('visibilitychange', updateFreshness);
  window.addEventListener('focus', updateFreshness);

}

function showMapFailure(error: unknown): void {
  for (const control of [modelSelect, layerSelect, frameSelect, opacityInput, seriesButton]) control.disabled = true;
  errorBox.hidden = false;
  errorBox.textContent = error instanceof maplibregl.GPUInitializationError
    ? 'Map unavailable: this browser needs WebGL2. Enable graphics acceleration or try another browser.'
    : `Map initialization failed: ${error instanceof Error ? error.message : String(error)}`;
  timestampBadge.textContent = 'Map unavailable';
  freshness.textContent = '';
}

try { startPreview(); } catch (error) { showMapFailure(error); }
