import { DEFAULT_MODEL, renderedFrames, type ModelId } from '@av/contracts';
import { ApiClient, createRasterTileProtocol, formatBuildFreshness, normalizePoint, pointSeriesSelection, type GeoPoint, type RasterTileProtocol, type PointSeriesLoader, type PointHorizon } from '@av/client';
import { forecastCommitted, PluginController, type WindyHost } from './controller';
import { forecastStackZIndex, WindyRasterLayer } from './raster-layer';
import { PluginPanel } from './view';

const { map } = W.map;
const { store, broadcast: bcast } = W;
const API_BASE = import.meta.env.AV_API_BASE || 'http://localhost:8787';
const api = new ApiClient({ baseUrl: API_BASE });
let panel: PluginPanel | null = null;
let controller: PluginController | null = null;
let listenersBound = false;
let mountTarget: HTMLElement | null = null;
let mountedIn: HTMLElement | null = null;
let selectedModel: ModelId = DEFAULT_MODEL;
let rasterProtocol: RasterTileProtocol | null = null;
let previousController: PluginController | null = null;
let paneOpen = false;
let pointListening = false;
let pointAbort: AbortController | null = null;
let pointLoader: PointSeriesLoader | null = null;
let pointHorizon: PointHorizon = 'day';

function clearPoint(): void {
  pointAbort?.abort(); pointAbort = null; panel?.clearPoint();
  pointLoader?.dispose(); pointLoader = null;
}

const pointClick = (point: GeoPoint): void => { void loadPoint(normalizePoint(point.lat, point.lon)); };

function pointListener(enabled: boolean): void {
  if (pointListening === enabled) return;
  pointListening = enabled;
  if (enabled) W.singleclick.singleclick.on(__pluginConfig.name, pointClick);
  else W.singleclick.singleclick.off(__pluginConfig.name, pointClick);
}

async function loadPoint(point: GeoPoint): Promise<void> {
  const active = controller, build = active?.currentBuild;
  if (!paneOpen || !active || !build || active.state().phase !== 'ready' || active.checkExpiry()) return;
  clearPoint();
  pointLoader = api.pointSeries(build, point);
  panel?.loadPoint(point);
  await loadPointRange();
}

async function loadPointRange(): Promise<void> {
  const active = controller, build = active?.currentBuild, loader = pointLoader;
  if (!paneOpen || !active || !build || !loader || active.state().phase !== 'ready' || active.checkExpiry()) return;
  pointAbort?.abort();
  const pending = new AbortController(); pointAbort = pending;
  const frames = pointSeriesSelection(build, pointHorizon).frames;
  const frameId = panel?.pointLoading(frames, active.state().frameId) ?? null;
  try {
    await loader.load(pointHorizon, pending.signal, { frameId, onProgress(payload, _totalFrames, loading) {
      if (pending.signal.aborted || controller !== active || active.currentBuild !== build || pointLoader !== loader || !paneOpen || active.checkExpiry()) return;
      panel?.renderPoint(payload, build, id => {
        if (paneOpen && controller === active && active.currentBuild === build && renderedFrames(build.manifest).some(frame => frame.id === id)) active.selectFrame(id);
      }, loading);
    } });
  } catch (error) {
    if (pending.signal.aborted || controller !== active || active.currentBuild !== build || pointLoader !== loader || !paneOpen || active.checkExpiry()) return;
    panel?.pointError(error instanceof Error ? error.message : String(error));
  } finally { if (pointAbort === pending) pointAbort = null; }
}
function protocol(): RasterTileProtocol {
  if (!rasterProtocol) {
    rasterProtocol = createRasterTileProtocol(API_BASE);
    L.addProtocol(rasterProtocol.scheme, rasterProtocol.load);
  }
  return rasterProtocol;
}

const host: WindyHost = {
  map: {
    addLayer: layer => (layer as WindyRasterLayer).addTo(map),
    removeLayer: layer => layer.remove?.()
  },
  store,
  createTileLayer: (url, options) => new WindyRasterLayer(L, API_BASE, url, { ...options, zIndex: forecastStackZIndex(W.map.layerOrder) }, protocol())
};

function refreshTime(): void {
  controller?.refreshTime();
  previousController?.refreshTime();
}

function bindHostListeners(): void {
  if (listenersBound) return;
  window.addEventListener('focus', refreshTime);
  document.addEventListener('visibilitychange', refreshTime);
  window.addEventListener('pagehide', () => {
    pointListener(false); clearPoint();
    controller?.dispose(); controller = null;
    previousController?.dispose(); previousController = null;
    if (rasterProtocol) { rasterProtocol.dispose(); L.removeProtocol(rasterProtocol.scheme); rasterProtocol = null; }
  });
  window.addEventListener('pageshow', (event: PageTransitionEvent) => { refreshTime(); if (event.persisted) { pointListener(paneOpen); void startController(selectedModel); } });
  listenersBound = true;
}

function ensurePanel(): PluginPanel {
  const container = mountTarget ?? document.body;
  if (!panel) {
    panel = new PluginPanel({
      onModel: model => {
        selectedModel = model as ModelId;
        void startController(selectedModel);
      },
      onOpacity: opacity => {
        controller?.setOpacity(opacity);
        previousController?.setOpacity(opacity);
      },
      onPointHorizon: horizon => { pointHorizon = horizon; void loadPointRange(); },
      onBack: () => {
        onclose();
        bcast.emit('rqstClose', __pluginConfig.name);
        bcast.emit('rqstOpen', 'menu');
      }
    });
  }
  if (mountedIn !== container) {
    if (mountedIn) {
      panel.mobileHeader.remove();
      panel.root.remove();
    }
    container.append(panel.mobileHeader, panel.root);
    mountedIn = container;
  }
  return panel;
}

function renderController(ui: PluginPanel, active: PluginController): void {
  const state = active.state();
  if (state.phase === 'ready' && active.currentBuild) ui.renderBuild(active.currentBuild);
  ui.renderState(state);
  if (previousController?.displayedForecast) {
    const base = state.notice ?? (state.phase === 'loading' ? `Loading ${state.model}.` : null);
    ui.setNotice([base, `Showing ${previousController.displayedForecast}.`].filter(Boolean).join(' '));
  }
  if (state.phase === 'ready' && state.buildId && active.currentBuild) {
    ui.setStatus(formatBuildFreshness(active.currentBuild.manifest, active.currentBuild.expiresAtMs));
  }
}

function showCurrent(ui: PluginPanel): boolean {
  const active = controller;
  if (!active || active.state().model !== selectedModel) return false;
  const phase = active.state().phase;
  if (phase !== 'ready' && phase !== 'loading') return false;
  ui.setVisible(true);
  renderController(ui, active);
  return true;
}

async function startController(model: ModelId): Promise<void> {
  clearPoint();
  const opacity = controller?.state().opacity;
  const previous = previousController ?? controller;
  if (previousController) controller?.dispose();
  previous?.freeze();
  previousController = previous;
  controller = null;
  const ui = ensurePanel();
  ui.setVisible(paneOpen);
  ui.setError(null);
  ui.setNotice(null);
  ui.setStatus('Loading latest immutable build…');
  const activeController = new PluginController({
    model,
    opacity,
    host,
    loadBuild: (requested, options) => api.latest(requested, { signal: options.signal }),
    onState: state => {
      if (controller !== activeController) {
        if (previousController === activeController && controller) {
          const expired = state.phase === 'expired';
          const expiredMessage = state.message;
          if (expired) previousController = null;
          renderController(ui, controller);
          if (expired && expiredMessage) ui.setError(expiredMessage);
        }
        return;
      }
      if (forecastCommitted(state) && previousController === previous) {
        previousController = null; previous?.dispose();
        const oldBuildId = previous?.currentBuild?.manifest.buildId;
        if (oldBuildId && oldBuildId !== activeController.currentBuild?.manifest.buildId) rasterProtocol?.evictBuild(oldBuildId);
      }
      if (state.phase === 'expired' || state.phase === 'disposed' || state.phase === 'error') clearPoint();
      renderController(ui, activeController);
    }
  });
  controller = activeController;
  selectedModel = model;
  await activeController.start();
}

export const onopen = (): void => {
  paneOpen = true;
  bindHostListeners();
  pointListener(true);
  const ui = ensurePanel();
  if (showCurrent(ui)) return;
  void startController(selectedModel);
};

export function onclose(): void {
  paneOpen = false; pointListener(false); clearPoint();
  panel?.setVisible(false);
}

export const __pluginConfig = __WINDY_CONFIG__;
export const title = __pluginConfig.title;

export default class ExternalApp {
  private static active: ExternalApp | null = null;

  constructor(args: { target: HTMLElement; anchor?: HTMLElement }) {
    ExternalApp.active = this;
    mountTarget = args.target;
    ensurePanel();
  }

  onopen(): void {
    if (ExternalApp.active !== this) return;
    onopen();
  }

  $destroy(): void {
    if (ExternalApp.active !== this) return;
    ExternalApp.active = null;
    onclose();
    panel?.mobileHeader.remove();
    panel?.root.remove();
    mountTarget = null;
    mountedIn = null;
  }
}
