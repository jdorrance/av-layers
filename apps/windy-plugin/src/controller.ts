import type { LayerId, ModelId } from '@av/contracts';
import type { PinnedBuild } from '../../preview/src/api';
import { frameBadge, matchHostFrame, selectExplicitFrame, syncTimestampForFrame, type DatasetRange } from '../../preview/src/time';
import { clampOpacity, frameTileUrl, windyTileOptions, type WindyTileOptions } from '../../preview/src/tiles';
export type { WindyTileOptions } from '../../preview/src/tiles';
import { Lifecycle } from './lifecycle';

export interface HostTileLayer {
  setUrl(url: string): unknown;
  setOpacity?(opacity: number): unknown;
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
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private disposed = false;
  private readonly onTimestamp = (value: number): void => {
    this.syncHost(value);
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
      message: this.message
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
      const initialLayer = this.options.initialLayer && build.manifest.layers.includes(this.options.initialLayer)
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
      this.layer = this.host.createTileLayer(
        frameTileUrl(template, first.id),
        windyTileOptions(build.maxNativeZoom, this.opacity)
      );
      this.host.map.addLayer(this.layer);
      this.host.store.on('timestamp', this.onTimestamp);
      this.lifecycle.add(() => {
        this.host.store.off?.('timestamp', this.onTimestamp);
        if (this.layer) this.host.map.removeLayer(this.layer);
        this.layer = null;
      });
      this.lifecycle.add(() => this.cancelExpiryTimer());
      this.scheduleExpiry();
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
    this.lifecycle?.dispose();
    this.lifecycle = null;
    this.cancelExpiryTimer();
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
    if (template) this.layer.setUrl(frameTileUrl(template, this.frameId));
  }

  private scheduleExpiry(): void {
    if (!this.build) return;
    this.cancelExpiryTimer();
    const delay = Math.max(0, this.build.expiresAtMs - this.now()) + 1;
    this.expiryTimer = this.setTimer(() => {
      this.expiryTimer = null;
      this.checkExpiry();
    }, Math.min(delay, 2_147_000_000));
  }

  private cancelExpiryTimer(): void {
    if (this.expiryTimer !== null) {
      this.clearTimer(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  private expire(): void {
    if (this.phase === 'expired') return;
    this.phase = 'expired';
    this.badge = 'Build expired — overlay removed';
    this.message = 'This build has expired. Cached tiles are not assembled as a current view.';
    this.cancelExpiryTimer();
    this.lifecycle?.dispose();
    this.lifecycle = null;
    this.layer = null;
    this.emit();
  }
}
