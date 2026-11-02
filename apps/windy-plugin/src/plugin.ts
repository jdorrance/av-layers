import type { LayerId, ModelId } from '@av/contracts';
import { ApiClient, sampleRequestText, assertNotExpired, datasetRange, normalizePoint, samePoint } from '@av/contracts/client';
import { PluginController, type WindyHost } from './controller';
import { PluginPanel } from './view';
import { WindyRasterLayer } from './raster-layer';

const { map } = W.map;
const { singleclick } = W.singleclick;
const { store, broadcast: bcast } = W;
const API_BASE = import.meta.env.AV_API_BASE || 'http://localhost:8787';
const api = new ApiClient({ baseUrl: API_BASE });
let panel: PluginPanel | null = null;
let controller: PluginController | null = null;
let seriesAbort: AbortController | null = null;
let listenersBound = false;
let mountTarget: HTMLElement | null = null;
let mountedIn: HTMLElement | null = null;

const host: WindyHost = {
  map: {
    addLayer: layer => (layer as WindyRasterLayer).addTo(map),
    removeLayer: layer => layer.remove?.()
  },
  store,
  createTileLayer: (url, options) => new WindyRasterLayer(L, API_BASE, url, options)
};

function onClick({ lat, lon }: WindySingleclickPoint): void {
  seriesAbort?.abort();
  seriesAbort = null;
  if (controller?.checkExpiry()) return;
  const point = normalizePoint(lat, lon);
  panel?.setClicked(point.lat, point.lon);
  panel?.setSeriesEnabled(controller?.state().phase === 'ready');
}

function refreshTime(): void {
  controller?.refreshTime();
}

async function requestSeries(): Promise<void> {
  const build = controller?.currentBuild;
  const activeController = controller;
  const point = panel?.clickedPoint;
  if (!panel || !build || !point || !activeController || activeController.checkExpiry()) return;
  seriesAbort?.abort();
  const requestAbort = new AbortController();
  seriesAbort = requestAbort;
  const requestedPoint = { ...point };
  panel.setSeriesEnabled(false);
  panel.setSeriesStatus(sampleRequestText(build, requestedPoint));
  try {
    const layers = [...build.manifest.layers];
    const payload = await api.sample(build, {
      lat: requestedPoint.lat,
      lon: requestedPoint.lon,
      frames: 'all',
      layers,
      signal: requestAbort.signal
    });
    if (
      requestAbort.signal.aborted ||
      controller !== activeController ||
      activeController.currentBuild !== build ||
      !samePoint(panel.clickedPoint, requestedPoint) ||
      activeController.checkExpiry()
    ) {
      return;
    }
    assertNotExpired(payload.expiresAt);
    panel.renderSeries(payload, layers, requestedPoint);
  } catch (error) {
    if (
      requestAbort.signal.aborted ||
      controller !== activeController ||
      !samePoint(panel.clickedPoint, requestedPoint) ||
      activeController.checkExpiry()
    ) {
      return;
    }
    panel.setSeriesStatus(`Series failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (seriesAbort === requestAbort) {
      seriesAbort = null;
      panel?.setSeriesEnabled(controller?.state().phase === 'ready');
    }
  }
}

function ensurePanel(): PluginPanel {
  const container = mountTarget ?? document.body;
  if (!panel) {
    panel = new PluginPanel({
      onModel: model => {
        void startController(model as ModelId);
      },
      onLayer: (layer: LayerId) => {
        controller?.selectLayer(layer);
      },
      onFrame: frame => {
        controller?.selectFrame(frame);
      },
      onOpacity: opacity => {
        controller?.setOpacity(opacity);
      },
      onSeries: () => {
        void requestSeries();
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

async function startController(model: ModelId): Promise<void> {
  controller?.dispose();
  seriesAbort?.abort();
  seriesAbort = null;
  const ui = ensurePanel();
  ui.setVisible(true);
  ui.setError(null);
  ui.clearSeries();
  ui.setStatus('Loading latest immutable build…');
  const activeController: PluginController = new PluginController({
    model,
    host,
    hostRange: () => (activeController.currentBuild ? datasetRange(activeController.currentBuild.manifest.frames) : null),
    loadBuild: (requested, options) => api.latest(requested, { signal: options.signal }),
    onState: state => {
      if (controller !== activeController) return;
      if (state.phase === 'ready' && state.buildId) {
        const build = activeController.currentBuild;
        if (build) ui.renderBuild(build);
      }
      if (state.phase === 'expired' || state.phase === 'disposed') {
        seriesAbort?.abort();
        seriesAbort = null;
        ui.clearSeries();
      }
      ui.renderState(state);
      if (seriesAbort) ui.setSeriesEnabled(false);
      if (state.phase === 'ready' && state.buildId) {
        const build = activeController.currentBuild;
        const remaining = build ? Math.max(0, build.expiresAtMs - Date.now()) : 0;
        ui.setStatus(`Pinned build ${state.buildId} · artifacts expire in ${Math.floor(remaining / 60000)} min`);
      }
    }
  });
  controller = activeController;
  await activeController.start();
}

export const onopen = (_params: unknown): void => {
  if (!listenersBound) {
    singleclick.on(__pluginConfig.name, onClick);
    window.addEventListener('focus', refreshTime);
    window.addEventListener('pageshow', refreshTime);
    document.addEventListener('visibilitychange', refreshTime);
    listenersBound = true;
  }
  void startController('gfs');
};

export function onclose(): void {
  seriesAbort?.abort();
  seriesAbort = null;
  controller?.dispose();
  controller = null;
  if (listenersBound) {
    singleclick.off(__pluginConfig.name, onClick);
    window.removeEventListener('focus', refreshTime);
    window.removeEventListener('pageshow', refreshTime);
    document.removeEventListener('visibilitychange', refreshTime);
    listenersBound = false;
  }
  panel?.clearSeries();
  panel?.setVisible(false);
}

export const __pluginConfig = __WINDY_CONFIG__;
export const title = __pluginConfig.title;

export default class ExternalApp {
  constructor(args: { target: HTMLElement; anchor?: HTMLElement }) {
    mountTarget = args.target;
    // Windy wires native pane behavior after mounting the component.
    ensurePanel();
  }

  onopen(params?: unknown): void {
    onopen(params);
  }

  $destroy(): void {
    onclose();
    panel?.mobileHeader.remove();
    panel?.root.remove();
    panel = null;
    mountTarget = null;
    mountedIn = null;
  }
}
