import { DEFAULT_MODEL, type ModelId } from '@av/contracts';
import { ApiClient, createRasterTileProtocol, formatBuildFreshness, type RasterTileProtocol } from '@av/contracts/client';
import { PluginController, type WindyHost } from './controller';
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
    controller?.dispose(); controller = null;
    previousController?.dispose(); previousController = null;
    if (rasterProtocol) { rasterProtocol.dispose(); L.removeProtocol(rasterProtocol.scheme); rasterProtocol = null; }
  });
  window.addEventListener('pageshow', (event: PageTransitionEvent) => { refreshTime(); if (event.persisted) void startController(selectedModel); });
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
      onBack: () => {
        panel?.setVisible(false);
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
  if (previousController?.displayedForecast) ui.setError(`${state.message ?? `Loading ${state.model}.`} Showing ${previousController.displayedForecast}.`);
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
  const opacity = controller?.state().opacity;
  const previous = previousController ?? controller;
  if (previousController) controller?.dispose();
  previous?.freeze();
  previousController = previous;
  controller = null;
  const ui = ensurePanel();
  ui.setVisible(true);
  ui.setError(null);
  ui.setStatus('Loading latest immutable build…');
  const activeController = new PluginController({
    model,
    opacity,
    host,
    loadBuild: (requested, options) => api.latest(requested, { signal: options.signal }),
    onState: state => {
      if (controller !== activeController) {
        if (previousController === activeController && controller) renderController(ui, controller);
        return;
      }
      if (state.phase === 'ready' && state.message === null && previousController === previous) {
        previousController = null; previous?.dispose();
        const oldBuildId = previous?.currentBuild?.manifest.buildId;
        if (oldBuildId && oldBuildId !== activeController.currentBuild?.manifest.buildId) rasterProtocol?.evictBuild(oldBuildId);
      }
      renderController(ui, activeController);
    }
  });
  controller = activeController;
  selectedModel = model;
  await activeController.start();
}

export const onopen = (): void => {
  bindHostListeners();
  const ui = ensurePanel();
  if (showCurrent(ui)) return;
  void startController(selectedModel);
};

export function onclose(): void {
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
