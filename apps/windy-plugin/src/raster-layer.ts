import type { HostTileEvent, HostTileEventName, HostTileLayer, WindyTileOptions } from './controller';
import { createRasterTileProtocol } from '@av/contracts/client';

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
  setUrl(url: string): unknown;
  setOpacity(opacity: number): unknown;
}
export interface NativeRasterMap {
  addLayer(layer: NativeRasterLayer): unknown;
  removeLayer(layer: NativeRasterLayer): unknown;
}
export interface NativeRasterApi {
  tileLayer(url: string, options: WindyTileOptions): NativeRasterLayer;
  addProtocol(scheme: string, handler: ReturnType<typeof createRasterTileProtocol>['load']): void;
  removeProtocol(scheme: string): void;
}

/**
 * Windy 51 uses LeafletGL's MapLibre raster source, not Leaflet's DOM tiles.
 * Its public TileLayer.source() emits data/error/dataabort with the same tile
 * object; the TileLayer itself does not emit Leaflet tileload* events.
 * https://windycom.github.io/LeafletGL/docs/API/LeafletGL/classes/TileLayer/
 */
export class WindyRasterLayer implements HostTileLayer {
  private readonly native: NativeRasterLayer;
  private map: NativeRasterMap | null = null;
  private source: NativeRasterSource | null = null;
  private protocol: ReturnType<typeof createRasterTileProtocol> | null = null;
  private readonly listeners = new Map<HostTileEventName, Set<(event: HostTileEvent) => void>>();
  private readonly bindings: [SourceEventName, (event: RasterSourceEvent) => void][] = [];

  constructor(private readonly api: NativeRasterApi, private readonly baseUrl: string, url: string, options: WindyTileOptions) {
    const protocol = this.createProtocol();
    try {
      this.native = api.tileLayer(protocol.url(url), options);
      this.protocol = protocol;
    } catch (error) {
      protocol.dispose();
      api.removeProtocol(protocol.scheme);
      throw error;
    }
  }

  private createProtocol(): ReturnType<typeof createRasterTileProtocol> {
    const protocol = createRasterTileProtocol(this.baseUrl);
    try { this.api.addProtocol(protocol.scheme, protocol.load); }
    catch (error) { protocol.dispose(); throw error; }
    return protocol;
  }

  addTo(map: NativeRasterMap): void {
    if (this.map) throw new Error('Forecast raster layer is already mounted');
    if (!this.protocol) throw new Error('Forecast raster layer is disposed');
    this.map = map;
    try {
      map.addLayer(this.native);
      const source = this.native.source();
      if (!source) throw new Error('Windy raster source is unavailable');
      this.source = source;
      for (const [nativeEvent, event] of [
        ['dataloading', 'tileloadstart'], ['data', 'tileload'],
        ['error', 'tileerror'], ['dataabort', 'tileunload']
      ] as const) {
        const listener = (value: RasterSourceEvent): void => {
          if (this.source !== source || !value.tile || typeof value.tile !== 'object') return;
          this.listeners.get(event)?.forEach(callback => callback({ tile: value.tile! }));
        };
        this.bindings.push([nativeEvent, listener]);
        source.on(nativeEvent, listener);
      }
    } catch (error) {
      this.remove();
      throw error;
    }
  }

  setUrl(url: string): void {
    if (!this.protocol) return;
    // LeafletGL aborts superseded tiles, but its asynchronous source update can
    // still request the previous URL. Keep its protocol registered until removal.
    this.native.setUrl(this.protocol.url(url));
  }
  setOpacity(opacity: number): void { this.native.setOpacity(opacity); }
  on(event: HostTileEventName, listener: (event: HostTileEvent) => void): void {
    let callbacks = this.listeners.get(event);
    if (!callbacks) this.listeners.set(event, callbacks = new Set());
    callbacks.add(listener);
  }
  off(event: HostTileEventName, listener: (event: HostTileEvent) => void): void {
    this.listeners.get(event)?.delete(listener);
  }
  remove(): void {
    const source = this.source;
    this.source = null;
    for (const [event, listener] of this.bindings.splice(0)) source?.off(event, listener);
    const map = this.map;
    this.map = null;
    const protocol = this.protocol;
    this.protocol = null;
    try { if (map) map.removeLayer(this.native); }
    finally {
      protocol?.dispose();
      if (protocol) this.api.removeProtocol(protocol.scheme);
    }
  }
}
