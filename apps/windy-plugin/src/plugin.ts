import { DEFAULT_MODEL, type ModelId } from '@av/contracts';
import { ApiClient, formatBuildFreshness } from '@av/contracts/client';
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

const host: WindyHost = {
  map: {
    addLayer: layer => (layer as WindyRasterLayer).addTo(map),
    removeLayer: layer => layer.remove?.()
  },
  store,
  createTileLayer: (url, options) => new WindyRasterLayer(L, API_BASE, url, { ...options, zIndex: forecastStackZIndex(W.map.layerOrder) })
};

function refreshTime(): void {
  controller?.refreshTime();
}

function bindHostListeners(): void {
  if (listenersBound) return;
  window.addEventListener('focus', refreshTime);
  window.addEventListener('pageshow', refreshTime);
  document.addEventListener('visibilitychange', refreshTime);
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

function showCurrent(ui: PluginPanel): boolean {
  const active = controller;
  if (!active || active.state().model !== selectedModel) return false;
  const phase = active.state().phase;
  if (phase !== 'ready' && phase !== 'loading') return false;
  ui.setVisible(true);
  if (phase === 'ready' && active.currentBuild) ui.renderBuild(active.currentBuild);
  ui.renderState(active.state());
  return true;
}

async function startController(model: ModelId): Promise<void> {
  const opacity = controller?.state().opacity;
  const previous = controller;
  controller = null;
  previous?.dispose();
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
      if (controller !== activeController) return;
      if (state.phase === 'ready' && activeController.currentBuild) ui.renderBuild(activeController.currentBuild);
      ui.renderState(state);
      if (state.phase === 'ready' && state.buildId && activeController.currentBuild) {
        ui.setStatus(formatBuildFreshness(activeController.currentBuild.manifest, activeController.currentBuild.expiresAtMs));
      }
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
