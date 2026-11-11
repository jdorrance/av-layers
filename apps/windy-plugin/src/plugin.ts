import { DEFAULT_MODEL } from '@av/contracts/model-options';
import { renderedFrames, type ModelId } from '@av/contracts/publication';
import { ApiClient, AUTO_MODEL_ID, createRasterTileProtocol, formatBuildFreshness, hostTimestampMs, normalizePoint,
  resolveAutoBuild, type AutoForecastSelection, type GeoPoint, type RasterTileProtocol } from '@av/client';
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
let automaticController = false;
let autoListeners = false;
let autoAbort: AbortController | null = null;
let autoTimer: ReturnType<typeof setTimeout> | null = null;
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
  await panel?.openPoint(build, point);
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

function cancelAuto(): void {
  if (autoTimer !== null) clearTimeout(autoTimer);
  autoTimer = null;
  autoAbort?.abort();
}

function queueAuto(): void {
  cancelAuto();
  autoTimer = setTimeout(() => { autoTimer = null; void loadAuto(); }, 120);
}

function listenAuto(enabled: boolean): void {
  if (autoListeners === enabled) return;
  autoListeners = enabled;
  if (enabled) {
    map.maplibreMap.on('movestart', cancelAuto);
    map.maplibreMap.on('moveend', queueAuto);
    store.on('timestamp', queueAuto);
  } else {
    cancelAuto();
    map.maplibreMap.off('movestart', cancelAuto);
    map.maplibreMap.off('moveend', queueAuto);
    store.off?.('timestamp', queueAuto);
  }
}

function clearAutoForecast(message: string): void {
  controller?.dispose(); controller = null;
  previousController?.dispose(); previousController = null;
  panel?.clearPoint();
  panel?.setMapTime('');
  panel?.setNotice(null);
  panel?.setStatus('No viewable build');
  panel?.setError(message);
}

async function loadAuto(): Promise<void> {
  if (selectedModel !== AUTO_MODEL_ID) return;
  cancelAuto();
  const center = map.maplibreMap.getCenter?.();
  if (!center) { clearAutoForecast('Map location is unavailable.'); return; }
  const request = new AbortController();
  autoAbort = request;
  const time = hostTimestampMs(store.get('timestamp'));
  try {
    const selection = await resolveAutoBuild(api, { ...normalizePoint(center.lat, center.lng),
      layers: ['usable-lift-msl', 'usable-lift-agl'], signal: request.signal,
      ...(time === null ? {} : { validTimeMs: time }) });
    if (request.signal.aborted || autoAbort !== request || selectedModel !== AUTO_MODEL_ID) return;
    if (!selection) { clearAutoForecast('No forecast covers this location and time.'); return; }
    const current = controller?.currentBuild?.manifest;
    if (automaticController && current?.model === selection.build.manifest.model && current.buildId === selection.build.manifest.buildId && controller?.state().phase === 'ready') {
      controller.refreshTime();
    } else await startController(selection.build.manifest.model, selection);
  } catch (error) {
    if (!request.signal.aborted) clearAutoForecast(error instanceof Error ? error.message : String(error));
  } finally {
    if (autoAbort === request) autoAbort = null;
  }
}

async function loadSelectedModel(): Promise<void> {
  listenAuto(selectedModel === AUTO_MODEL_ID);
  if (selectedModel === AUTO_MODEL_ID) {
    if (controller?.state().phase === 'loading') { controller.dispose(); controller = null; }
    await loadAuto();
  } else await startController(selectedModel);
}

function bindHostListeners(): void {
  if (listenersBound) return;
  window.addEventListener('focus', refreshTime);
  document.addEventListener('visibilitychange', refreshTime);
  window.addEventListener('pagehide', () => {
    listenAuto(false);
    pointListener(false); panel?.clearPoint();
    controller?.dispose(); controller = null;
    previousController?.dispose(); previousController = null;
    if (rasterProtocol) { rasterProtocol.dispose(); L.removeProtocol(rasterProtocol.scheme); rasterProtocol = null; }
  });
  window.addEventListener('pageshow', (event: PageTransitionEvent) => { refreshTime(); if (event.persisted) { pointListener(paneOpen); void loadSelectedModel(); } });
  listenersBound = true;
}

function ensurePanel(): PluginPanel {
  const container = mountTarget ?? document.body;
  if (!panel) {
    panel = new PluginPanel(api, {
      onModel: model => {
        selectedModel = model as ModelId;
        void loadSelectedModel();
      },
      onOpacity: opacity => {
        controller?.setOpacity(opacity);
        previousController?.setOpacity(opacity);
      },
      canRenderPoint: build => {
        const active = controller;
        return paneOpen && active?.currentBuild === build && !active.checkExpiry();
      },
      onPointFrame: (id, build) => {
        const active = controller;
        if (active?.currentBuild === build && renderedFrames(build.manifest).some(frame => frame.id === id)) active.selectFrame(id);
      },
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
  if (state.phase === 'ready' && active.currentBuild) ui.renderBuild(active.currentBuild, selectedModel);
  ui.renderState(state);
  if (previousController?.displayedForecast) {
    const base = state.notice ?? (state.phase === 'loading' ? `Loading ${state.model}.` : null);
    ui.setNotice([base, `Showing ${previousController.displayedForecast}.`].filter(Boolean).join(' '));
    ui.setMapTime(previousController.state().badge);
  }
  if (state.phase === 'ready' && state.buildId && active.currentBuild) {
    const actual = selectedModel === AUTO_MODEL_ID ? `${state.model} · ` : '';
    ui.setStatus(actual + formatBuildFreshness(active.currentBuild.manifest, active.currentBuild.expiresAtMs));
  }
}

function showCurrent(ui: PluginPanel): boolean {
  const active = controller;
  if (!active || (selectedModel === AUTO_MODEL_ID ? !automaticController : active.state().model !== selectedModel)) return false;
  const phase = active.state().phase;
  if (phase !== 'ready' && phase !== 'loading') return false;
  ui.setVisible(true);
  renderController(ui, active);
  return true;
}

async function startController(model: ModelId, selection?: AutoForecastSelection): Promise<void> {
  panel?.clearPoint();
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
    ...(selection ? { automaticFrameId: selection.frame.id } : {}),
    opacity,
    host,
    loadBuild: (requested, options) => selection ? Promise.resolve(selection.build) : api.latest(requested, { signal: options.signal }),
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
      if ((forecastCommitted(state) || (state.phase === 'ready' && state.frameId === null)) && previousController === previous) {
        previousController = null; previous?.dispose();
        const oldBuildId = previous?.currentBuild?.manifest.buildId;
        if (oldBuildId && oldBuildId !== activeController.currentBuild?.manifest.buildId) rasterProtocol?.evictBuild(oldBuildId);
      }
      renderController(ui, activeController);
      if (state.phase === 'expired' && selectedModel === AUTO_MODEL_ID) queueAuto();
    }
  });
  controller = activeController;
  automaticController = selection !== undefined;
  await activeController.start();
}

export const onopen = (): void => {
  paneOpen = true;
  bindHostListeners();
  pointListener(true);
  const ui = ensurePanel();
  if (showCurrent(ui)) return;
  void loadSelectedModel();
};

export function onclose(): void {
  paneOpen = false; pointListener(false); panel?.clearPoint();
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
