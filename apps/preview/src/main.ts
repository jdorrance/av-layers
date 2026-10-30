import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { paletteBinLabel, type LayerId, type ModelId } from '@av/contracts';
import {
  ApiClient,
  DEFAULT_OPACITY,
  OVERLAY_LAYER_ID,
  OVERLAY_SOURCE_ID,
  activePalettes,
  assertNotExpired,
  buildAgeMs,
  buildDiagnosticRows,
  coverageSummaryText,
  formatDuration,
  forecastHorizonNotice,
  formatSampleStatus,
  formatSeriesSummary,
  formatSupportFlags,
  noLiftLabel,
  normalizePoint,
  paletteNoteText,
  populateModelOptions,
  previewRasterLayer,
  previewRasterSource,
  samePoint,
  watchBuildExpiry,
  type FrameSample,
  type GeoPoint,
  type PaletteSummary,
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

const api = new ApiClient({ baseUrl: import.meta.env.VITE_API_BASE ?? 'http://localhost:8787' });

populateModelOptions(modelSelect);
opacityInput.value = String(DEFAULT_OPACITY);

const map = new maplibregl.Map({
  container: 'map',
  center: [-30, 25],
  zoom: 2,
  style: {
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
let overlaySourceId = OVERLAY_SOURCE_ID;
let overlayGeneration = 0;
const failedTiles = new Set<object>();
let sourceFailed = false;
let pendingModel: ModelId | null = null;
let resumeModel: ModelId | null = null;
let loadAbort: AbortController | null = null;
let seriesAbort: AbortController | null = null;
let clicked: GeoPoint | null = null;
let expiryTimer: number | null = null;
let disposeExpiry = () => {};

map.on('click', event => {
  seriesAbort?.abort();
  seriesAbort = null;
  seriesPanel.replaceChildren();
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

map.on('error', (event: OverlayEvent) => {
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

function renderMeta(buildValue: PinnedBuild): void {
  coverageNote.textContent = coverageSummaryText(buildValue);
  const rows = buildDiagnosticRows(buildValue);
  meta.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      if (label === 'Provenance' && /^https?:\/\//.test(value)) {
        const link = document.createElement('a');
        link.href = value;
        link.textContent = 'View source receipts';
        dd.append(link);
      } else dd.textContent = value;
      return [dt, dd];
    })
  );
}

function renderLegend(palettes: readonly PaletteSummary[], activeLayer: string | null): void {
  legend.replaceChildren();
  const visible = activePalettes(palettes, activeLayer);
  if (visible.length === 0) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = 'Palette registry summary was not returned by the API.';
    legend.append(note);
    return;
  }
  for (const palette of visible) {
    const section = document.createElement('section');
    const title = document.createElement('h2');
    title.textContent = `${palette.id} · ${palette.units}`;
    section.append(title);
    palette.colors.forEach((color, index) => {
      const row = document.createElement('div');
      row.className = 'legend-row';
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = color;
      const label = document.createElement('span');
      label.textContent = paletteBinLabel(palette.edges, palette.colors.length, index);
      row.append(swatch, label);
      section.append(row);
    });
    if (palette.noLiftColor) {
      const row = document.createElement('div');
      row.className = 'legend-row';
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = palette.noLiftColor;
      const label = document.createElement('span');
      label.textContent = noLiftLabel(palette.noLiftColor);
      row.append(swatch, label);
      section.append(row);
    }
    const noteText = paletteNoteText(palette);
    if (noteText) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = noteText;
      section.append(note);
    }
    legend.append(section);
  }
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
  if (map.getLayer(OVERLAY_LAYER_ID)) map.removeLayer(OVERLAY_LAYER_ID);
  if (map.getSource(overlaySourceId)) map.removeSource(overlaySourceId);
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
  seriesPanel.replaceChildren();
  seriesStatus.textContent = '';
  removeOverlay();
  setControlsEnabled(false);
  seriesButton.disabled = true;
  timestampBadge.textContent = 'Build expired — cached tiles are not assembled as a current view';
  freshness.textContent = 'Expired immutable build';
  showError('This build has expired. Reload to discover the latest retained build.');
}

function ensureLive(): boolean {
  if (!build) return false;
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
  renderLegend(build.palettes, activeLayer);
  const template = build.templates[activeLayer];
  if (!template) {
    showError(`No tile template for ${activeLayer}`);
    return;
  }
  removeOverlay();
  resetTileErrors();
  // Give late events from an earlier frame a distinct source identity.
  overlaySourceId = `${OVERLAY_SOURCE_ID}-${++overlayGeneration}`;
  map.addSource(overlaySourceId, previewRasterSource(template, selectedFrame, build.maxNativeZoom));
  map.addLayer({ ...previewRasterLayer(opacity), source: overlaySourceId });
  const frame = build.manifest.frames.find(item => item.id === selectedFrame);
  timestampBadge.textContent = frame
    ? `Explicit frame ${frame.id} · valid ${frame.validTime} · interval ${frame.intervalStart} → ${frame.intervalEnd}`
    : `Explicit frame ${selectedFrame}`;
}

function populateFrames(buildValue: PinnedBuild): void {
  frameSelect.replaceChildren(...buildValue.manifest.frames.map(frame => new Option(`${frame.id} · ${frame.validTime}`, frame.id)));
  selectedFrame = buildValue.manifest.frames[0]?.id ?? null;
  if (selectedFrame) frameSelect.value = selectedFrame;
  frameSelect.disabled = false;
}

function populateLayers(buildValue: PinnedBuild): void {
  layerSelect.replaceChildren(...buildValue.manifest.layers.map(layer => new Option(layer, layer)));
  layerSelect.value = buildValue.manifest.layers[0] ?? '';
  layerSelect.disabled = false;
}

async function loadModel(model: ModelId): Promise<void> {
  disposeExpiry();
  loadAbort?.abort();
  seriesAbort?.abort();
  seriesAbort = null;
  seriesPanel.replaceChildren();
  seriesStatus.textContent = '';
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
    renderMeta(next);
    renderLegend(next.palettes, layerSelect.value);
    map.fitBounds(
      [
        [next.bounds[0], next.bounds[1]],
        [next.bounds[2], next.bounds[3]]
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

function renderSeries(
  payload: { frames: FrameSample[]; method: unknown; source: unknown; coverage: unknown; expiresAt: string },
  layers: string[],
  point: GeoPoint
): void {
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const text of ['Frame', 'Valid', ...layers.map(layer => `${layer} value`), ...layers.map(layer => `${layer} status/support`)]) {
    const th = document.createElement('th');
    th.textContent = text;
    head.append(th);
  }
  table.append(head);
  for (const frame of payload.frames) {
    const row = document.createElement('tr');
    const cells = [frame.id, frame.validTime];
    for (const layer of layers) cells.push(formatSampleStatus(frame.layers[layer]));
    for (const layer of layers) {
      const sample = frame.layers[layer];
      cells.push(`${sample.status} / ${formatSupportFlags(sample.support)}${sample.interpolated ? ' / interpolated' : ''}`);
    }
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      row.append(td);
    }
    table.append(row);
  }
  seriesPanel.replaceChildren(table);
  seriesStatus.textContent = formatSeriesSummary(payload, layers, point);
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
  if (!build || !clicked || expired) return;
  seriesAbort?.abort();
  const requestAbort = new AbortController();
  seriesAbort = requestAbort;
  const requestedBuild = build;
  const requestedPoint = { ...clicked };
  seriesButton.disabled = true;
  seriesStatus.textContent = `Requesting all 8 frames × 3 layers at ${requestedPoint.lat.toFixed(4)}, ${requestedPoint.lon.toFixed(4)}…`;
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
    renderSeries(payload, layers, requestedPoint);
  } catch (error) {
    if (requestAbort.signal.aborted || build !== requestedBuild || !samePoint(clicked, requestedPoint) || !ensureLive()) return;
    const message = error instanceof Error ? error.message : String(error);
    seriesStatus.textContent = `Series failed: ${message}`;
  } finally {
    if (seriesAbort === requestAbort) {
      seriesAbort = null;
      if (!expired && clicked) seriesButton.disabled = false;
    }
  }
});

map.on('load', () => {
  void loadModel('gfs');
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
  if (event.persisted) return;
  disposeExpiry();
  removeOverlay();
  map.remove();
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
    setControlsEnabled(true);
    updateFreshness();
    if (expiryTimer === null) {
      expiryTimer = window.setInterval(updateFreshness, 5000);
    }
  }
});

document.addEventListener('visibilitychange', updateFreshness);
window.addEventListener('focus', updateFreshness);
