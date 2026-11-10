import type { HostTileEvent, HostTileEventName, HostTileLayer, WindyTileOptions } from './controller';
import { createRasterTileProtocol, layerMaxZoom, planViewportPrefetch, type PinnedBuild, type RasterTileProtocol, viewportTiles } from '@av/contracts/client';
import type { LayerId } from '@av/contracts';

export interface ForecastLayerOrder {
  MAIN?: number;
  PARTICLES?: number;
  PARTICLES_HIGH_ZOOM?: number;
}

/** Sit one step above the weather color and below wind particles. A one-step gap uses the midpoint so particles stay on top. */
export function forecastStackZIndex(order: ForecastLayerOrder | undefined): number {
  const main = typeof order?.MAIN === 'number' && Number.isFinite(order.MAIN) ? order.MAIN : 0;
  const ceiling = [order?.PARTICLES, order?.PARTICLES_HIGH_ZOOM]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > main)
    .reduce((lowest, value) => Math.min(lowest, value), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(ceiling)) return main + 1;
  return ceiling - main > 1 ? main + 1 : (main + ceiling) / 2;
}

type SourceEventName = 'dataloading' | 'data' | 'error' | 'dataabort';
export interface RasterSourceEvent { tile?: object }
export interface NativeRasterSource {
  on(event: SourceEventName, listener: (event: RasterSourceEvent) => void): unknown;
  off(event: SourceEventName, listener: (event: RasterSourceEvent) => void): unknown;
}
export interface NativeRasterLayer {
  source(): NativeRasterSource | undefined;
  isLoading(): boolean;
  layer(): { id: string };
  alwaysLoadTiles: boolean;
  setOpacity(opacity: number): unknown;
}
interface RenderMap {
  setPaintProperty(id: string, property: string, value: number | { duration: number; delay: number }): unknown;
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  isMoving(): boolean;
  getBounds(): { getWest(): number; getEast(): number; getNorth(): number; getSouth(): number };
  getZoom(): number;
}
export interface NativeRasterMap {
  maplibreMap: RenderMap;
  addLayer(layer: NativeRasterLayer): unknown;
  removeLayer(layer: NativeRasterLayer): unknown;
}
export interface NativeRasterApi {
  tileLayer(url: string, options: WindyTileOptions): NativeRasterLayer;
  addProtocol(scheme: string, handler: RasterTileProtocol['load']): void;
  removeProtocol(scheme: string): void;
}
interface Slot {
  native: NativeRasterLayer;
  source: NativeRasterSource;
  url: string;
  successful: boolean;
  pending: Set<object>;
  failed: Set<object>;
  bindings: [SourceEventName, (event: RasterSourceEvent) => void][];
}

/** LeafletGL source events and render readiness own the two forecast slots. */
export class WindyRasterLayer implements HostTileLayer {
  private map: NativeRasterMap | null = null;
  private active: Slot | null = null;
  private staging: Slot | null = null;
  private protocol: RasterTileProtocol | null;
  private readonly ownsProtocol: boolean;
  private readonly listeners = new Map<HostTileEventName, Set<(event: HostTileEvent) => void>>();
  private statusListener: ((status: 'loading' | 'ready' | 'error', url: string) => void) | null = null;
  private build: PinnedBuild | null = null;
  private prefetchAbort: AbortController | null = null;
  private status: 'loading' | 'ready' | 'error' = 'loading';
  private frozen = false;
  private retryEmpty = false;
  private readonly render = (): void => {
    const next = this.staging;
    if (!next || this.map?.maplibreMap.isMoving()) return;
    if (this.build && this.build.expiresAtMs <= Date.now()) return;
    if (next.pending.size || next.native.isLoading()) return;
    if (!next.successful) { if (next.failed.size > 0) this.abandon(next); return; }
    next.native.setOpacity(this.options.opacity);
    const previous = this.active;
    this.active = next; this.staging = null;
    this.move();
    const failed = [...next.failed];
    queueMicrotask(() => {
      if (this.active !== next) return;
      this.drop(previous);
      this.setStatus('ready');
      for (const tile of failed) {
        this.listeners.get('tileloadstart')?.forEach(callback => callback({ tile }));
        this.listeners.get('tileerror')?.forEach(callback => callback({ tile }));
      }
      this.prefetch();
    });
  };
  private readonly move = (): void => { this.prefetchAbort?.abort(); this.prefetchAbort = null; };
  private readonly idle = (): void => {
    this.render();
    const slot = this.staging;
    if (slot && !this.map?.maplibreMap.isMoving() && !slot.successful && !slot.pending.size && !slot.native.isLoading()
      && (!this.build || this.build.expiresAtMs > Date.now())) {
      this.retryEmpty = slot.failed.size === 0;
      this.abandon(slot);
    }
    this.prefetch();
  };
  private readonly settled = (): void => {
    if (this.retryEmpty && !this.map?.maplibreMap.isMoving() && (!this.build || this.build.expiresAtMs > Date.now())) this.setUrl(this.url);
  };

  constructor(private readonly api: NativeRasterApi, baseUrl: string, private url: string, private options: WindyTileOptions, protocol?: RasterTileProtocol) {
    this.ownsProtocol = !protocol;
    this.protocol = protocol ?? createRasterTileProtocol(baseUrl);
    if (this.ownsProtocol) {
      try { api.addProtocol(this.protocol.scheme, this.protocol.load); }
      catch (error) { this.protocol.dispose(); throw error; }
    }
  }

  addTo(map: NativeRasterMap): void {
    if (this.map) throw new Error('Forecast raster layer is already mounted');
    if (!this.protocol) throw new Error('Forecast raster layer is disposed');
    this.map = map;
    map.maplibreMap.on('render', this.render); map.maplibreMap.on('idle', this.idle);
    map.maplibreMap.on('movestart', this.move); map.maplibreMap.on('zoomstart', this.move);
    map.maplibreMap.on('moveend', this.settled);
    try { this.stage(); } catch (error) { this.remove(); throw error; }
  }

  setBuild(build: PinnedBuild): void {
    this.build = build;
    this.protocol?.setBuildExpiry(build.manifest.buildId, build.expiresAtMs);
  }
  onStatus(listener: (status: 'loading' | 'ready' | 'error', url: string) => void): void {
    this.statusListener = listener; listener(this.status, this.active?.url ?? '');
  }
  freeze(): void {
    this.frozen = true;
    this.retryEmpty = false;
    this.move(); this.drop(this.staging); this.staging = null;
  }
  setUrl(url: string, maxNativeZoom = this.options.maxNativeZoom): void {
    if (this.frozen || !this.protocol || (url === this.url && this.status !== 'error')) return;
    this.url = url;
    this.options = { ...this.options, maxNativeZoom };
    try { this.stage(); } catch { this.move(); this.setStatus('error'); }
  }
  setOpacity(opacity: number): void {
    this.options = { ...this.options, opacity };
    this.active?.native.setOpacity(opacity);
  }
  on(event: HostTileEventName, listener: (event: HostTileEvent) => void): void {
    let callbacks = this.listeners.get(event);
    if (!callbacks) this.listeners.set(event, callbacks = new Set());
    callbacks.add(listener);
  }
  off(event: HostTileEventName, listener: (event: HostTileEvent) => void): void { this.listeners.get(event)?.delete(listener); }
  remove(): void {
    const map = this.map; this.map = null;
    this.move();
    if (map) {
      map.maplibreMap.off('render', this.render); map.maplibreMap.off('idle', this.idle);
      map.maplibreMap.off('movestart', this.move); map.maplibreMap.off('zoomstart', this.move);
      map.maplibreMap.off('moveend', this.settled);
    }
    this.drop(this.staging, map); this.drop(this.active, map); this.staging = null; this.active = null;
    if (this.build) this.protocol?.evictBuild(this.build.manifest.buildId);
    if (this.protocol && this.ownsProtocol) { this.protocol.dispose(); this.api.removeProtocol(this.protocol.scheme); }
    this.protocol = null; this.statusListener = null;
  }

  private stage(): void {
    if (!this.map || !this.protocol) return;
    this.retryEmpty = false;
    this.drop(this.staging); this.staging = null;
    if (this.active?.url === this.url) { this.setStatus('ready'); return; }
    const native = this.api.tileLayer(this.protocol.url(this.url), { ...this.options, opacity: 0 });
    native.alwaysLoadTiles = true;
    try {
      this.map.addLayer(native);
      const styleId = native.layer().id;
      this.map.maplibreMap.setPaintProperty(styleId, 'raster-opacity-transition', { duration: 0, delay: 0 });
      this.map.maplibreMap.setPaintProperty(styleId, 'raster-fade-duration', 0);
      const source = native.source();
      if (!source) throw new Error('Windy raster source is unavailable');
      const slot: Slot = { native, source, url: this.url, successful: false, pending: new Set(), failed: new Set(), bindings: [] };
      this.staging = slot;
      for (const [nativeEvent, event] of [['dataloading', 'tileloadstart'], ['data', 'tileload'], ['error', 'tileerror'], ['dataabort', 'tileunload']] as const) {
        const listener = (value: RasterSourceEvent): void => {
          if (this.active !== slot && this.staging !== slot) return;
          if (!value.tile) { if (nativeEvent === 'error' && this.staging === slot) this.abandon(slot); return; }
          if (nativeEvent === 'dataloading') slot.pending.add(value.tile);
          else slot.pending.delete(value.tile);
          if (nativeEvent === 'data') { slot.successful = true; slot.failed.delete(value.tile); }
          if (nativeEvent === 'error') slot.failed.add(value.tile);
          if (this.staging === slot && nativeEvent === 'error') { this.consider(slot); return; }
          this.listeners.get(event)?.forEach(callback => callback({ tile: value.tile! }));
          if (this.staging === slot) this.consider(slot);
        };
        slot.bindings.push([nativeEvent, listener]); source.on(nativeEvent, listener);
      }
    } catch (error) {
      if (this.staging?.native === native) { this.drop(this.staging); this.staging = null; }
      else this.map.removeLayer(native);
      throw error;
    }
    this.setStatus('loading');
  }
  private consider(slot: Slot): void {
    if (this.staging !== slot || this.map?.maplibreMap.isMoving() || slot.pending.size || slot.native.isLoading()) return;
    if (!slot.successful && slot.failed.size > 0) this.abandon(slot);
  }
  private abandon(slot: Slot): void {
    if (this.staging !== slot) return;
    this.staging = null; this.drop(slot); this.move(); this.setStatus('error');
  }
  private setStatus(status: 'loading' | 'ready' | 'error'): void {
    this.status = status; this.statusListener?.(status, this.active?.url ?? '');
  }
  private drop(slot: Slot | null, map = this.map): void {
    if (!slot) return;
    for (const [event, listener] of slot.bindings) slot.source.off(event, listener);
    map?.removeLayer(slot.native);
  }
  private prefetch(): void {
    const build = this.build, active = this.active, map = this.map?.maplibreMap;
    if (this.frozen || !build || !active || !map || !this.protocol || this.staging || this.prefetchAbort || map.isMoving() || build.expiresAtMs <= Date.now()) return;
    const parts = new URL(active.url).pathname.split('/'), layer = parts.at(-5) as LayerId, frame = parts.at(-4)!;
    if (!build.manifest.layers.includes(layer)) return;
    const z = Math.max(0, Math.min(layerMaxZoom(build.manifest, layer), Math.round(map.getZoom()) + 1)), bounds = map.getBounds();
    const tiles = viewportTiles({ west: bounds.getWest(), east: bounds.getEast(), south: bounds.getSouth(), north: bounds.getNorth() }, z);
    const controller = new AbortController(); this.prefetchAbort = controller;
    for (const url of planViewportPrefetch({ build, activeLayer: layer, activeFrame: frame, viewportTiles: tiles })) void this.protocol.prefetch(url, controller.signal).catch(() => {});
  }
}
