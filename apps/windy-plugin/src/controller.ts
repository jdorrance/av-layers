import type { LayerId, ModelId } from '@av/contracts';
import {
  clampOpacity,
  forecastHorizonNotice,
  frameBadge,
  frameTileUrl,
  frameTime,
  matchHostFrame,
  selectExplicitFrame,
  syncTimestampForFrame,
  windyTileOptions,
  type DatasetRange,
  type PinnedBuild,
  type WindyTileOptions
} from '@av/contracts/client';
export type { WindyTileOptions } from '@av/contracts/client';
import { Lifecycle } from './lifecycle';

export interface HostTileEvent {
  /** Leaflet's tile element identifies a displayed tile across load, error and unload events. */
  tile: object;
}

export type HostTileEventName = 'tileloadstart' | 'tileerror' | 'tileload' | 'tileunload';

export interface HostTileLayer {
  setUrl(url: string): unknown;
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
  on(event: 'timestamp', listener: (value: number) => void): unknown;
  off?(event: 'timestamp', listener: (value: number) => void): unknown;
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
  layerId: LayerId | null;
  opacity: number;
  badge: string;
  message: string | null;
  horizonNotice: string | null;
}

export interface ControllerOptions {
  model: ModelId;
  loadBuild(model: ModelId, options: { signal: AbortSignal }): Promise<PinnedBuild>;
  host: WindyHost;
  initialLayer?: LayerId;
  opacity?: number;
  hostRange?: () => DatasetRange | null;
  onState?: (state: ControllerState) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

const TILE_ERROR_MESSAGE = 'Overlay tile failed to load — forecast display may be incomplete.';

export class PluginController {
  private readonly options: ControllerOptions;
  private readonly host: WindyHost;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private lifecycle: Lifecycle | null = null;
  private build: PinnedBuild | null = null;
  private layer: HostTileLayer | null = null;
  private frameId: string | null = null;
  private layerId: LayerId | null = null;
  private opacity: number;
  private badge = 'No frame selected';
  private phase: ControllerPhase = 'idle';
  private message: string | null = null;
  private readonly activeTiles = new Set<object>();
  private readonly failedTiles = new Set<object>();
  private tileUrl: string | null = null;
  private timeTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private disposed = false;
  private readonly onTimestamp = (value: number): void => {
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
    this.opacity = clampOpacity(options.opacity ?? 0.5);
  }

  get currentBuild(): PinnedBuild | null {
    return this.build;
  }

  state(): ControllerState {
    return {
      phase: this.phase,
      buildId: this.build?.manifest.buildId ?? null,
      model: this.options.model,
      frameId: this.frameId,
      layerId: this.layerId,
      opacity: this.opacity,
      badge: this.badge,
      message: [this.message, this.failedTiles.size > 0 ? TILE_ERROR_MESSAGE : null].filter(Boolean).join('\n') || null,
      horizonNotice: this.phase === 'ready' && this.build ? forecastHorizonNotice(this.build.manifest, this.now()) : null
    };
  }

  private emit(): void {
    this.options.onState?.(this.state());
  }

  private fail(message: string): void {
    this.phase = 'error';
    this.message = message;
    this.emit();
  }

  async start(): Promise<ControllerState | null> {
    if (this.started || this.disposed) return this.state();
    this.started = true;
    this.phase = 'loading';
    this.message = null;
    this.clearTileState();
    this.emit();
    this.lifecycle = new Lifecycle();
    try {
      const build = await this.options.loadBuild(this.options.model, { signal: this.lifecycle.signal });
      if (this.disposed || this.lifecycle.isDisposed) return null;
      if (build.model !== this.options.model) {
        this.fail('Loaded build model does not match the requested model');
        return this.state();
      }
      if (build.expiresAtMs <= this.now()) {
        this.build = build;
        this.expire();
        return this.state();
      }
      this.build = build;
      const initialLayer =
        this.options.initialLayer && build.manifest.layers.includes(this.options.initialLayer)
          ? this.options.initialLayer
          : build.manifest.layers[0];
      this.layerId = initialLayer ?? null;
      const hostTimestamp = this.host.store.get('timestamp');
      const hostValue = typeof hostTimestamp === 'number' && Number.isFinite(hostTimestamp) ? hostTimestamp : null;
      const hostFrame = hostValue === null ? null : matchHostFrame(build.manifest.frames, hostValue);
      const first = hostFrame ?? selectExplicitFrame(build.manifest.frames, build.manifest.frames[0]?.id ?? '');
      if (!first || !this.layerId) {
        this.fail('Build has no usable frame or layer');
        return this.state();
      }
      this.frameId = first.id;
      const template = build.templates[this.layerId];
      if (!template) {
        this.fail(`Build has no tile template for ${this.layerId}`);
        return this.state();
      }
      this.badge = frameBadge(first, hostFrame, hostValue).text;
      this.tileUrl = frameTileUrl(template, first.id);
      const tileLayer = this.host.createTileLayer(this.tileUrl, windyTileOptions(build.maxNativeZoom, this.opacity));
      this.layer = tileLayer;
      tileLayer.on?.('tileloadstart', this.onTileStart);
      tileLayer.on?.('tileerror', this.onTileError);
      tileLayer.on?.('tileunload', this.onTileUnload);
      tileLayer.on?.('tileload', this.onTileLoad);
      this.host.map.addLayer(tileLayer);
      this.host.store.on('timestamp', this.onTimestamp);
      this.lifecycle.add(() => {
        this.host.store.off?.('timestamp', this.onTimestamp);
        tileLayer.off?.('tileloadstart', this.onTileStart);
        tileLayer.off?.('tileerror', this.onTileError);
        tileLayer.off?.('tileunload', this.onTileUnload);
        tileLayer.off?.('tileload', this.onTileLoad);
        if (this.layer) this.host.map.removeLayer(this.layer);
        this.layer = null;
      });
      this.lifecycle.add(() => this.cancelTimeTimer());
      this.scheduleTimeCheck();
      this.phase = 'ready';
      this.emit();
      return this.state();
    } catch (error) {
      if (this.disposed || (error instanceof DOMException && error.name === 'AbortError')) return null;
      this.fail(error instanceof Error ? error.message : String(error));
      return this.state();
    }
  }

  selectFrame(id: string, options: { syncHost?: boolean } = {}): ControllerState {
    if (!this.canUse()) return this.state();
    const frame = selectExplicitFrame(this.build!.manifest.frames, id);
    if (!frame) {
      this.message = `Unknown frame ${id}`;
      this.emit();
      return this.state();
    }
    this.frameId = frame.id;
    this.applyUrl();
    this.badge = frameBadge(frame, null, null).text;
    this.message = null;
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
      this.emit();
      return this.state();
    }
    this.layerId = id;
    this.applyUrl();
    this.message = null;
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

  syncHost(timestampMs: number): ControllerState {
    if (!this.canUse()) return this.state();
    if (!Number.isFinite(timestampMs)) return this.state();
    const matched = matchHostFrame(this.build!.manifest.frames, timestampMs);
    if (matched) {
      this.frameId = matched.id;
      this.applyUrl();
    }
    const selected = this.frameId ? selectExplicitFrame(this.build!.manifest.frames, this.frameId) : null;
    this.badge = frameBadge(selected, matched, timestampMs).text;
    this.emit();
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.phase = 'disposed';
    this.badge = 'Plugin closed';
    this.clearTileState();
    this.lifecycle?.dispose();
    this.lifecycle = null;
    this.cancelTimeTimer();
    this.layer = null;
    this.emit();
  }

  private canUse(): boolean {
    if (!this.build || this.disposed || this.phase === 'expired') return false;
    if (this.checkExpiry()) return false;
    return true;
  }

  private applyUrl(): void {
    if (!this.build || !this.frameId || !this.layerId || !this.layer) return;
    const template = this.build.templates[this.layerId];
    if (!template) return;
    const url = frameTileUrl(template, this.frameId);
    if (url === this.tileUrl) return;
    this.clearTileState();
    this.tileUrl = url;
    this.layer.setUrl(url);
  }

  private clearTileState(): void {
    this.activeTiles.clear();
    this.failedTiles.clear();
  }

  private scheduleTimeCheck(): void {
    if (!this.build) return;
    this.cancelTimeTimer();
    const now = this.now();
    const horizonEnd = Math.max(...this.build.manifest.frames.map(frame => frameTime(frame.validTime)));
    const nextChange = horizonEnd > now
      ? Math.min(horizonEnd, this.build.expiresAtMs)
      : this.build.expiresAtMs;
    const delay = Math.max(0, nextChange - now) + 1;
    this.timeTimer = this.setTimer(() => {
      this.timeTimer = null;
      if (!this.checkExpiry()) {
        this.emit();
        this.scheduleTimeCheck();
      }
    }, Math.min(delay, 2_147_000_000));
  }

  private cancelTimeTimer(): void {
    if (this.timeTimer !== null) {
      this.clearTimer(this.timeTimer);
      this.timeTimer = null;
    }
  }

  private expire(): void {
    if (this.phase === 'expired') return;
    this.phase = 'expired';
    this.clearTileState();
    this.badge = 'Build expired — overlay removed';
    this.message = 'This build has expired. Cached tiles are not assembled as a current view.';
    this.cancelTimeTimer();
    this.lifecycle?.dispose();
    this.lifecycle = null;
    this.layer = null;
    this.emit();
  }
}
