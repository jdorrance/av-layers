import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ModelId } from '@av/contracts';
import { ApiClient, assertNotExpired, type FrameSample, type PinnedBuild, type PaletteSummary } from './api';
import { buildAgeMs, formatDuration, watchBuildExpiry } from './time';
import { DEFAULT_OPACITY, OVERLAY_LAYER_ID, OVERLAY_SOURCE_ID, previewRasterLayer, previewRasterSource } from './tiles';
import { populateModelOptions } from './models';
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
const errorBox = element<HTMLParagraphElement>('error');
const meta = element<HTMLDivElement>('meta');
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
let loadAbort: AbortController | null = null;
let seriesAbort: AbortController | null = null;
let clicked: { lat: number; lon: number } | null = null;
let expiryTimer: number | null = null;
let disposeExpiry = () => {};

map.on('click', event => {
  clicked = { lat: event.lngLat.lat, lon: event.lngLat.lng };
  seriesButton.disabled = !build || expired;
  seriesStatus.textContent = `Clicked ${clicked.lat.toFixed(4)}, ${clicked.lon.toFixed(4)}`;
});

function showError(message: string): void {
  errorBox.hidden = false;
  errorBox.textContent = message;
}

function clearError(): void {
  errorBox.hidden = true;
  errorBox.textContent = '';
}

function sourceLabel(buildValue: PinnedBuild): string {
  const source = buildValue.manifest.source as Record<string, unknown>;
  const model = typeof source.model === 'string' ? source.model : buildValue.model.toUpperCase();
  const native = typeof source.nativeResolutionDeg === 'number' ? `${source.nativeResolutionDeg}° native columns` : 'native model columns';
  return `${model} · ${native}`;
}

function renderMeta(buildValue: PinnedBuild): void {
  const manifest = buildValue.manifest;
  const grid = manifest.grid;
  const rows: Array<[string, string]> = [
    ['Build', manifest.buildId],
    ['Cycle', manifest.cycle],
    ['Method', `${manifest.method.id} · ${manifest.method.hash.slice(0, 12)}…`],
    ['Source', sourceLabel(buildValue)],
    ['Display', `z0–${buildValue.maxNativeZoom} · 256 px raster · overzoomed above z${buildValue.maxNativeZoom}`],
    ['Grid', `${grid.width} × ${grid.height} · ${grid.dx}° × ${Math.abs(grid.dy)}° EPSG:4326`],
    ['Coverage', `${buildValue.coverage.id} · ${buildValue.bounds[1]}° to ${buildValue.bounds[3]}° lat`],
    ['Exclusions', 'soaring-land-v1: land/coastal + 50 km seaward buffer; excludes RUS, ATA, GRL'],
    ['MSL / AGL', 'MSL uses model terrain + usable AGL; AGL uses the same model terrain, not a high-resolution DEM'],
    ['Method caveat', '1.2 m/s sink threshold; PBL closure only for the first layer; parcel-crossing/profile-top/PBL support flags are explicit'],
    ['Coverage caveat', 'Coastal and exclusion borders can differ from the true coastline by about one cell diagonal'],
    ['Expiry', manifest.expiresAt]
  ];
  meta.replaceChildren(...rows.flatMap(([label, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    return [dt, dd];
  }));
}

function renderLegend(palettes: readonly PaletteSummary[]): void {
  legend.replaceChildren();
  if (palettes.length === 0) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = 'Palette registry summary was not returned by the API.';
    legend.append(note);
    return;
  }
  for (const palette of palettes) {
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
      const from = palette.edges[index];
      const to = palette.edges[index + 1];
      label.textContent = to === undefined ? `≥ ${from}` : index === palette.colors.length - 1 ? `${from}–${to}+` : `${from}–${to}`;
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
      label.textContent = 'no usable lift';
      row.append(swatch, label);
      section.append(row);
    }
    if (palette.provisional || palette.transparentBelow !== undefined) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = palette.transparentBelow === undefined
        ? 'Provisional palette.'
        : `Transparent below ${palette.transparentBelow} ${palette.units}; provisional palette.`;
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
  if (map.getSource(OVERLAY_SOURCE_ID)) map.removeSource(OVERLAY_SOURCE_ID);
}

function expireView(): void {
  if (expired) return;
  expired = true;
  loadAbort?.abort();
  seriesAbort?.abort();
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
  const template = build.templates[layerSelect.value as keyof typeof build.templates];
  if (!template) {
    showError(`No tile template for ${layerSelect.value}`);
    return;
  }
  removeOverlay();
  map.addSource(OVERLAY_SOURCE_ID, previewRasterSource(template, selectedFrame, build.maxNativeZoom));
  map.addLayer(previewRasterLayer(opacity));
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
  seriesPanel.replaceChildren();
  seriesStatus.textContent = '';
  loadAbort = new AbortController();
  expired = false;
  build = null;
  clicked = null;
  setControlsEnabled(false);
  removeOverlay();
  clearError();
  freshness.textContent = `Loading ${model} latest immutable build…`;
  timestampBadge.textContent = 'No frame selected';
  try {
    const next = await api.latest(model, { signal: loadAbort.signal });
    build = next;
    populateLayers(next);
    populateFrames(next);
    renderMeta(next);
    renderLegend(next.palettes);
    map.fitBounds([[next.bounds[0], next.bounds[1]], [next.bounds[2], next.bounds[3]]], { padding: 24, duration: 0 });
    updateOverlay();
    updateFreshness();
    setControlsEnabled(true);
    disposeExpiry = watchBuildExpiry(next.expiresAtMs, expireView, [document, window]);
    if (expiryTimer === null) {
      expiryTimer = window.setInterval(updateFreshness, 5000);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    const message = error instanceof Error ? error.message : String(error);
    showError(message);
    freshness.textContent = 'No viewable build';
    setControlsEnabled(false);
  }
}

function statusText(sample: FrameSample['layers'][string]): string {
  if (sample.status === 'valid') return sample.value === null ? '—' : String(sample.value);
  if (sample.status === 'no-usable-lift') return 'no lift';
  if (sample.status === 'unavailable') return 'unavailable';
  return 'outside coverage';
}

function supportText(support: number): string {
  const flags: string[] = [];
  if (support & 4) flags.push('parcel');
  if (support & 8) flags.push('top');
  if (support & 16) flags.push('PBL');
  return flags.join('+') || '—';
}

function renderSeries(payload: { frames: FrameSample[]; method: unknown; source: unknown; coverage: unknown; expiresAt: string }, layers: string[]): void {
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
    for (const layer of layers) cells.push(statusText(frame.layers[layer]));
    for (const layer of layers) {
      const sample = frame.layers[layer];
      cells.push(`${sample.status} / ${supportText(sample.support)}${sample.interpolated ? ' / interpolated' : ''}`);
    }
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      row.append(td);
    }
    table.append(row);
  }
  seriesPanel.replaceChildren(table);
  const method = payload.method as { id?: unknown } | null;
  const coverage = payload.coverage as { id?: unknown } | null;
  seriesStatus.textContent = `8 explicit frames × ${layers.length} layers · method ${String(method?.id ?? 'unknown')} · coverage ${String(coverage?.id ?? 'unknown')} · expires ${payload.expiresAt}`;
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
  seriesButton.disabled = true;
  seriesStatus.textContent = 'Requesting all 8 frames × 3 layers…';
  try {
    const layers = [...requestedBuild.manifest.layers];
    const payload = await api.sample(requestedBuild, {
      lat: clicked.lat,
      lon: clicked.lon,
      frames: 'all',
      layers,
      signal: requestAbort.signal
    });
    if (requestAbort.signal.aborted || build !== requestedBuild || !ensureLive()) return;
    assertNotExpired(payload.expiresAt);
    renderSeries(payload, layers);
  } catch (error) {
    if (requestAbort.signal.aborted || build !== requestedBuild || !ensureLive()) return;
    const message = error instanceof Error ? error.message : String(error);
    seriesStatus.textContent = `Series failed: ${message}`;
  } finally {
    if (seriesAbort === requestAbort) {
      seriesAbort = null;
      if (!expired) seriesButton.disabled = false;
    }
  }
});

map.on('load', () => {
  void loadModel('gfs');
});

window.addEventListener('pagehide', () => {
  disposeExpiry();
  loadAbort?.abort();
  seriesAbort?.abort();
  if (expiryTimer !== null) window.clearInterval(expiryTimer);
  removeOverlay();
  map.remove();
});
