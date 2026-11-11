import type { LayerId } from '@av/contracts/layers';
import { renderedFrames, type ModelId } from '@av/contracts/publication';
import {
  clampOpacity,
  DEFAULT_OPACITY,
  mapForecastEnd,
  mapForecastHorizonNotice,
  frameBadge,
  frameTileUrl,
  layerMaxZoom,
  hostTimestampMs,
  matchHostFrame,
  selectExplicitFrame,
  selectHostFrame,
  syncTimestampForFrame,
  windyTileOptions,
  type DatasetRange,
  type PinnedBuild,
  type WindyTileOptions
} from '@av/client';
export type { WindyTileOptions } from '@av/client';

export interface HostTileEvent {
  /** Leaflet's tile element identifies a displayed tile across load, error and unload events. */
  tile: object;
}

export type HostTileEventName = 'tileloadstart' | 'tileerror' | 'tileload' | 'tileunload';

export interface HostTileLayer {
  setUrl(url: string, maxNativeZoom?: number): unknown;
  setBuild?(build: PinnedBuild): void;
  freeze?(): void;
  onStatus?(listener: (status: 'loading' | 'ready' | 'error', displayedUrl: string) => void): void;
  setOpacity?(opacity: number): unknown;
  on?(event: HostTileEventName, listener: (event: HostTileEvent) => void): unknown;
  off?(event: HostTileEventName, listener: (event: HostTileEvent) => void): unknown;
  remove?(): unknown;
}

export interface HostMap {
  addLayer(layer: HostTileLayer): unknown;
  removeLayer(layer: HostTileLayer): unknown;
}

export interface HostStore {
  get(key: 'timestamp'): unknown;
  set(key: 'timestamp', value: number): boolean;
  on(event: 'timestamp', listener: (value: unknown) => void): unknown;
  off?(event: 'timestamp', listener: (value: unknown) => void): unknown;
}

export interface WindyHost {
  map: HostMap;
  store: HostStore;
  createTileLayer(url: string, options: WindyTileOptions): HostTileLayer;
}

export type ControllerPhase = 'idle' | 'loading' | 'ready' | 'expired' | 'error' | 'disposed';

export interface ControllerState {
  phase: ControllerPhase;
  buildId: string | null;
  model: ModelId;
  frameId: string | null;
  displayedFrameId: string | null;
  layerId: LayerId | null;
  opacity: number;
  badge: string;
  message: string | null;
  notice: string | null;
  horizonNotice: string | null;
}

export interface ControllerOptions {
  model: ModelId;
  loadBuild(model: ModelId, options: { signal: AbortSignal }): Promise<PinnedBuild>;
  host: WindyHost;
  opacity?: number;
  hostRange?: () => DatasetRange | null;
  onState?: (state: ControllerState) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

const TILE_ERROR_MESSAGE = 'Overlay tile failed to load — forecast display may be incomplete.';

export function forecastCommitted(state: ControllerState): boolean {
  return state.phase === 'ready' && state.displayedFrameId !== null && state.notice === null && (state.message === null || state.message === TILE_ERROR_MESSAGE);
}

function preferredLiftLayer(layers: readonly LayerId[]): LayerId | null {
  if (layers.includes('usable-lift-msl')) return 'usable-lift-msl';
  if (layers.includes('usable-lift-agl')) return 'usable-lift-agl';
  return layers[0] ?? null;
}

export class PluginController {
  private readonly options: ControllerOptions;
  private readonly host: WindyHost;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private loadAbort: AbortController | null = null;
  private subscribed = false;
  private build: PinnedBuild | null = null;
  private layer: HostTileLayer | null = null;
  private frameId: string | null = null;
  private layerId: LayerId | null = null;
  private opacity: number;
  private frames: ReturnType<typeof renderedFrames> = [];
  private mapRange: DatasetRange | null = null;
  private hostTime: number | null = null;
  private phase: ControllerPhase = 'idle';
  private message: string | null = null;
  private notice: string | null = null;
  // Successful LeafletGL tiles can move into the host cache without an unload
  // event. Membership must not keep those otherwise collectible tiles alive.
  private activeTiles = new WeakSet<object>();
  private readonly failedTiles = new Set<object>();
  private tileUrl: string | null = null;
  private displayedUrl: string | null = null;
  private tileMaxZoom: number | null = null;
  private timeTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private disposed = false;
  private frozen = false;
  private readonly onTimestamp = (value: unknown): void => {
    this.syncHost(value);
  };
  private readonly onTileStart = (event: HostTileEvent): void => {
    if (this.canUse()) this.activeTiles.add(event.tile);
  };
  private readonly onTileError = (event: HostTileEvent): void => {
    if (!this.canUse() || !this.activeTiles.has(event.tile)) return;
    this.failedTiles.add(event.tile);
    this.emit();
  };
  private readonly onTileLoad = (event: HostTileEvent): void => {
    if (this.canUse() && this.failedTiles.delete(event.tile)) this.emit();
  };
  private readonly onTileUnload = (event: HostTileEvent): void => {
    this.activeTiles.delete(event.tile);
    if (this.failedTiles.delete(event.tile)) this.emit();
  };

  constructor(options: ControllerOptions) {
    this.options = options;
    this.host = options.host;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle));
    this.opacity = clampOpacity(options.opacity ?? DEFAULT_OPACITY);
  }

  get currentBuild(): PinnedBuild | null {
    return this.build;
  }

  get displayedForecast(): string | null {
    const displayed = this.displayedSelection();
    return displayed ? `${this.options.model} ${displayed.frame.id} ${displayed.layer}` : null;
  }

  private displayedSelection() {
    const parts = this.displayedUrl?.split('/'), manifest = this.build?.manifest;
    if (!parts || !manifest || parts.at(-7) !== manifest.model || parts.at(-6) !== manifest.buildId) return null;
    const frame = selectExplicitFrame(this.frames, parts.at(-4) ?? '');
    return frame ? { frame, layer: parts.at(-5) } : null;
  }

  private outsideMapRange(): boolean {
    return this.hostTime !== null && this.mapRange !== null
      && (this.hostTime < this.mapRange.startMs || this.hostTime > this.mapRange.endMs);
  }

  private timeBadge(displayed: (typeof this.frames)[number] | null): string {
    if (this.phase === 'expired') return frameBadge(null, null, null, true).text;
    if (this.phase !== 'ready') return '';
    if (this.outsideMapRange()) {
      const time = new Date(this.hostTime!).toISOString();
      return `Windy time ${time} is outside the map forecast. Overlay hidden.`;
    }
    if (!displayed) return '';
    const hostMatch = this.hostTime === null ? null : matchHostFrame([displayed], this.hostTime);
    return frameBadge(displayed, hostMatch, this.hostTime).text;
  }

  state(): ControllerState {
    const displayed = this.displayedSelection()?.frame ?? null;
    return {
      phase: this.phase,
      buildId: this.build?.manifest.buildId ?? null,
      model: this.options.model,
      frameId: this.frameId,
      displayedFrameId: displayed?.id ?? null,
      layerId: this.layerId,
      opacity: this.opacity,
      badge: this.timeBadge(displayed),
      message: [this.message, this.failedTiles.size > 0 ? TILE_ERROR_MESSAGE : null].filter(Boolean).join('\n') || null,
      notice: this.notice,
      horizonNotice: this.phase === 'ready' && this.build && this.frameId !== null ? mapForecastHorizonNotice(this.build.manifest, this.now()) : null
    };
  }

  private emit(): void {
    this.options.onState?.(this.state());
  }

  private fail(message: string): void {
    this.phase = 'error';
    this.message = message;
    this.notice = null;
    this.emit();
  }

  async start(): Promise<ControllerState | null> {
    if (this.started || this.disposed) return this.state();
    this.started = true;
    this.phase = 'loading';
    this.message = null;
    this.notice = null;
    this.clearTileState();
    this.emit();
    const loadAbort = new AbortController();
    this.loadAbort = loadAbort;
    try {
      const build = await this.options.loadBuild(this.options.model, { signal: loadAbort.signal });
      if (this.disposed || this.frozen || loadAbort.signal.aborted) return null;
      if (build.manifest.model !== this.options.model) {
        this.fail('Loaded build model does not match the requested model');
        return this.state();
      }
      if (build.expiresAtMs <= this.now()) {
        this.build = build;
        this.expire();
        return this.state();
      }
      this.build = build;
      this.layerId = preferredLiftLayer(Object.keys(build.templates) as LayerId[]);
      this.frames = renderedFrames(build.manifest);
      this.hostTime = hostTimestampMs(this.host.store.get('timestamp'));
      if (!this.frames.length || !this.layerId) {
        this.fail('Build has no usable frame or layer');
        return this.state();
      }
      this.mapRange = {
        startMs: Math.min(...this.frames.map(frame => Date.parse(frame.intervalStart))),
        endMs: Math.max(...this.frames.map(frame => Date.parse(frame.validTime)))
      };
      if (!build.templates[this.layerId]) {
        this.fail(`Build has no tile template for ${this.layerId}`);
        return this.state();
      }
      // Subscribe before mounting so a host that throws never leaves a layer on the map.
      this.subscribed = true;
      this.host.store.on('timestamp', this.onTimestamp);
      if (!this.outsideMapRange()) {
        const first = this.hostTime === null ? this.frames[0] : selectHostFrame(this.frames, this.hostTime);
        this.frameId = first?.id ?? null;
        this.applyUrl();
      }
      this.scheduleTimeCheck();
      this.phase = 'ready';
      this.emit();
      return this.state();
    } catch (error) {
      if (this.disposed || (error instanceof DOMException && error.name === 'AbortError')) return null;
      this.releaseResources();
      this.fail(error instanceof Error ? error.message : String(error));
      return this.state();
    }
  }

  selectFrame(id: string, options: { syncHost?: boolean } = {}): ControllerState {
    if (!this.canUse() || this.outsideMapRange()) return this.state();
    const frame = selectExplicitFrame(this.frames, id);
    if (!frame) {
      this.message = `Unknown frame ${id}`;
      this.notice = null;
      this.emit();
      return this.state();
    }
    this.frameId = frame.id;
    this.applyUrl();
    this.emit();
    if (options.syncHost !== false) {
      const timestamp = syncTimestampForFrame(frame, this.options.hostRange?.() ?? null);
      if (timestamp !== null) this.host.store.set('timestamp', timestamp);
    }
    return this.state();
  }

  selectLayer(id: LayerId): ControllerState {
    if (!this.canUse()) return this.state();
    if (!this.build!.manifest.layers.includes(id)) {
      this.message = `Unknown layer ${id}`;
      this.notice = null;
      this.emit();
      return this.state();
    }
    const template = this.build!.templates[id];
    if (!template || !this.frameId) {
      this.message = `No tile template for ${id}`;
      this.notice = null;
      this.emit();
      return this.state();
    }
    const maxZoom = layerMaxZoom(this.build!.manifest, id);
    this.layerId = id;
    this.tileMaxZoom = maxZoom;
    this.applyUrl();
    this.emit();
    return this.state();
  }

  setOpacity(value: number): ControllerState {
    if (this.disposed) return this.state();
    this.opacity = clampOpacity(value);
    this.layer?.setOpacity?.(this.opacity);
    this.emit();
    return this.state();
  }

  syncHost(timestamp: unknown): ControllerState {
    if (!this.build || this.disposed || this.phase === 'error' || this.checkExpiry()) return this.state();
    const hostValue = hostTimestampMs(timestamp);
    if (hostValue === null) return this.state();
    this.hostTime = hostValue;
    if (this.outsideMapRange()) {
      this.frameId = null;
      this.clearTileState();
      this.message = null;
      this.notice = null;
      this.unmountLayer();
    } else if (!this.frozen) {
      this.frameId = selectHostFrame(this.frames, hostValue)?.id ?? null;
      try { this.applyUrl(); } catch (error) {
        this.releaseResources();
        this.fail(error instanceof Error ? error.message : String(error));
      }
    }
    if (this.phase === 'ready') this.emit();
    return this.state();
  }

  checkExpiry(at = this.now()): boolean {
    if (!this.build || this.phase === 'expired' || this.phase === 'disposed') return this.phase === 'expired';
    if (this.build.expiresAtMs <= at) {
      this.expire();
      return true;
    }
    return false;
  }

  refreshTime(): void {
    if (this.phase !== 'ready' || this.checkExpiry()) return;
    this.scheduleTimeCheck();
    this.syncHost(this.host.store.get('timestamp'));
    if (this.phase === 'ready') this.emit();
  }

  freeze(): void {
    if (this.frozen || this.disposed) return;
    this.frozen = true;
    this.loadAbort?.abort(); this.loadAbort = null;
    // A retained raster still needs host timestamps to hide outside its forecast window.
    this.layer?.freeze?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.phase = 'disposed';
    this.clearTileState();
    this.releaseResources();
    this.emit();
  }

  private canUse(): boolean {
    if (!this.build || this.frozen || this.disposed || this.phase === 'expired' || this.phase === 'error') return false;
    if (this.checkExpiry()) return false;
    return true;
  }

  private applyUrl(): void {
    if (!this.build || !this.frameId || !this.layerId) return;
    const template = this.build.templates[this.layerId];
    if (!template) return;
    const url = frameTileUrl(template, this.frameId);
    if (!this.layer) {
      this.mountLayer(url, layerMaxZoom(this.build.manifest, this.layerId));
      return;
    }
    if (url === this.tileUrl) return;
    this.clearTileState();
    this.tileUrl = url;
    this.layer.setUrl(url, this.tileMaxZoom ?? undefined);
  }

  private mountLayer(url: string, maxZoom: number): void {
    const layer = this.host.createTileLayer(url, windyTileOptions(maxZoom, this.opacity, this.build!.manifest.descriptors.attribution));
    this.layer = layer;
    this.tileUrl = url;
    this.tileMaxZoom = maxZoom;
    layer.on?.('tileloadstart', this.onTileStart);
    layer.on?.('tileerror', this.onTileError);
    layer.on?.('tileunload', this.onTileUnload);
    layer.on?.('tileload', this.onTileLoad);
    layer.setBuild?.(this.build!);
    layer.onStatus?.((status, displayedUrl) => {
      if (this.layer !== layer || !this.canUse()) return;
      this.displayedUrl = displayedUrl || null;
      const showing = this.displayedForecast ? `Showing ${this.displayedForecast}.` : '';
      if (status === 'ready') { this.clearTileState(); this.message = null; this.notice = null; }
      else if (status === 'error') { this.notice = null; this.message = showing ? `Forecast replacement failed. ${showing}` : 'Forecast replacement failed.'; }
      else { this.message = null; this.notice = showing ? `Loading selected forecast. ${showing}` : 'Loading selected forecast.'; }
      this.emit();
    });
    this.host.map.addLayer(layer);
  }

  private unmountLayer(): void {
    const layer = this.layer;
    this.layer = null;
    this.tileUrl = null;
    this.tileMaxZoom = null;
    this.displayedUrl = null;
    if (!layer) return;
    try {
      layer.off?.('tileloadstart', this.onTileStart);
      layer.off?.('tileerror', this.onTileError);
      layer.off?.('tileunload', this.onTileUnload);
      layer.off?.('tileload', this.onTileLoad);
    } finally { this.host.map.removeLayer(layer); }
  }

  private clearTileState(): void {
    this.activeTiles = new WeakSet();
    this.failedTiles.clear();
  }

  private scheduleTimeCheck(): void {
    if (!this.build) return;
    this.cancelTimeTimer();
    const now = this.now();
    const horizonEnd = mapForecastEnd(this.build.manifest);
    const nextChange = horizonEnd !== null && horizonEnd > now
      ? Math.min(horizonEnd, this.build.expiresAtMs)
      : this.build.expiresAtMs;
    const delay = Math.max(0, nextChange - now) + 1;
    this.timeTimer = this.setTimer(() => {
      this.timeTimer = null;
      this.refreshTime();
    }, Math.min(delay, 2_147_000_000));
  }

  private cancelTimeTimer(): void {
    if (this.timeTimer !== null) {
      this.clearTimer(this.timeTimer);
      this.timeTimer = null;
    }
  }

  private releaseResources(): void {
    this.loadAbort?.abort();
    this.loadAbort = null;
    this.cancelTimeTimer();
    try {
      if (this.subscribed) {
        this.subscribed = false;
        this.host.store.off?.('timestamp', this.onTimestamp);
      }
    } finally {
      this.unmountLayer();
    }
  }

  private expire(): void {
    if (this.phase === 'expired') return;
    this.phase = 'expired';
    this.clearTileState();
    this.message = 'This build has expired. Cached tiles are not assembled as a current view.';
    this.notice = null;
    this.releaseResources();
    this.emit();
  }
}
