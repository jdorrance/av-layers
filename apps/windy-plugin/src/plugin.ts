import type { LayerId, ModelId } from '@av/contracts';
import { ApiClient, sampleRequestText, assertNotExpired, datasetRange, normalizePoint, samePoint } from '@av/contracts/client';
import { PluginController, type WindyHost } from './controller';
import { PluginPanel } from './view';
import { WindyRasterLayer } from './raster-layer';

const { map } = W.map;
const { store, broadcast: bcast } = W;
const API_BASE = import.meta.env.AV_API_BASE || 'http://localhost:8787';
const api = new ApiClient({ baseUrl: API_BASE });
let panel: PluginPanel | null = null;
let controller: PluginController | null = null;
let seriesAbort: AbortController | null = null;
let mapClickBound = false;
let mountTarget: HTMLElement | null = null;

const host: WindyHost = {
  map: {
    addLayer: layer => (layer as WindyRasterLayer).addTo(map),
    removeLayer: layer => layer.remove?.()
  },
  store,
  createTileLayer: (url, options) => new WindyRasterLayer(L, API_BASE, url, options)
};

function onClick(event: { latlng?: { lat: number; lng: number } }): void {
  if (!event.latlng) return;
  seriesAbort?.abort();
  seriesAbort = null;
  const point = normalizePoint(event.latlng.lat, event.latlng.lng);
  panel?.setClicked(point.lat, point.lon);
  panel?.setSeriesEnabled(controller?.state().phase === 'ready');
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
  if (panel) return panel;
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
      bcast.emit('rqstOpen', 'menu');
    }
  });
  (mountTarget ?? document.body).append(panel.root);
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
  controller = new PluginController({
    model,
    host,
    hostRange: () => (controller?.currentBuild ? datasetRange(controller.currentBuild.manifest.frames) : null),
    loadBuild: (requested, options) => api.latest(requested, { signal: options.signal }),
    onState: state => {
      if (state.phase === 'ready' && state.buildId) {
        const build = controller?.currentBuild;
        if (build) ui.renderBuild(build);
      }
      if (state.phase === 'expired' || state.phase === 'disposed') {
        seriesAbort?.abort();
        seriesAbort = null;
        ui.clearSeries();
      }
      ui.renderState(state);
      if (state.phase === 'ready' && state.buildId) {
        const build = controller?.currentBuild;
        const remaining = build ? Math.max(0, build.expiresAtMs - Date.now()) : 0;
        ui.setStatus(`Pinned build ${state.buildId} · artifacts expire in ${Math.floor(remaining / 60000)} min`);
      }
    }
  });
  await controller.start();
}

export const onopen = (_params: unknown): void => {
  if (!mapClickBound) {
    map.on('click', onClick);
    mapClickBound = true;
  }
  void startController('gfs');
};

export function onclose(): void {
  seriesAbort?.abort();
  seriesAbort = null;
  controller?.dispose();
  controller = null;
  if (mapClickBound) {
    map.off('click', onClick);
    mapClickBound = false;
  }
  panel?.setVisible(false);
}

export const __pluginConfig = __WINDY_CONFIG__;
export const title = __pluginConfig.title;

export default class ExternalApp {
  constructor(args: { target: HTMLElement; anchor?: HTMLElement }) {
    mountTarget = args.target;
  }

  onopen(params?: unknown): void {
    onopen(params);
  }

  $destroy(): void {
    onclose();
    panel?.root.remove();
    panel = null;
    mountTarget = null;
  }
}
