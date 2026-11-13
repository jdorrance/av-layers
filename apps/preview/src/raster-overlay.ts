import type { Map, MapSourceDataEvent, ErrorEvent } from 'maplibre-gl';
import { createSourceRasterTileProtocol, frameTileUrl, layerMaxZoom, planViewportPrefetch, previewRasterLayer, previewRasterSource, type PinnedBuild, type RasterTileSourceProtocol, type RasterTileSourceTransport, viewportTiles } from '@av/client';
import type { LayerId } from '@av/contracts/layers';
import { renderedFrames } from '@av/contracts/publication';
import { addProtocol, removeProtocol } from 'maplibre-gl';

interface Selection { build: PinnedBuild; layer: LayerId; frame: string }
interface Slot extends Selection { id: string; transport: RasterTileSourceTransport; successful: boolean; pending: Set<object>; failed: Set<object>; sourceFailed: boolean }
export interface OverlayState { displayed: Selection | null; requested: Selection | null; incomplete: boolean; replacementFailed: boolean }
const matches = (a: Selection | null, b: Selection | null): boolean => !!a && !!b && a.build === b.build && a.layer === b.layer && a.frame === b.frame;

/** Owns the displayed raster and one prepared replacement; dispose with the map. */
export class RasterOverlay {
  private protocol: RasterTileSourceProtocol | null = null;
  private active: Slot | null = null;
  private staging: Slot | null = null;
  private requested: Selection | null = null;
  private preferred: Selection | null = null;
  private warmFailed: Selection | null = null;
  private direction: 1 | -1 | undefined;
  private generation = 0;
  private opacity: number;
  private incomplete = false;
  private replacementFailed = false;
  private retryEmpty = false;
  private moving = false;
  private disposed = false;
  private prefetchJobs = new globalThis.Map<string, AbortController>();
  private prefetched = false;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly data = (event: MapSourceDataEvent): void => {
    if (event.sourceId === this.active?.id && event.tile && this.active.failed.delete(event.tile)) {
      this.incomplete = this.problem(this.active); this.emit();
    }
    const slot = this.staging;
    if (!slot || event.sourceId !== slot.id) return;
    if (event.tile) { slot.pending.delete(event.tile); slot.failed.delete(event.tile); slot.successful = true; }
    if (event.sourceDataType === 'idle' && event.isSourceLoaded) queueMicrotask(() => this.abandonEmpty(slot));
  };
  private readonly loading = (event: MapSourceDataEvent): void => {
    if (event.sourceId === this.staging?.id && event.tile) this.staging.pending.add(event.tile);
  };
  private readonly abort = (event: MapSourceDataEvent): void => {
    if (event.sourceId === this.staging?.id && event.tile) {
      this.staging.pending.delete(event.tile); this.staging.failed.delete(event.tile);
    }
    if (event.sourceId === this.active?.id && event.tile && this.active.failed.delete(event.tile)) { this.incomplete = this.problem(this.active); this.emit(); }
  };
  private readonly failed = (event: ErrorEvent & { sourceId?: string; tile?: object }): void => {
    if (!event.sourceId) return;
    const slot = event.sourceId === this.staging?.id ? this.staging : event.sourceId === this.active?.id ? this.active : null;
    if (!slot) return;
    if (!event.tile) {
      slot.sourceFailed = true;
      if (slot === this.staging) this.abandon();
      else { this.incomplete = true; this.emit(); }
      return;
    }
    slot.failed.add(event.tile); slot.pending.delete(event.tile);
    if (slot === this.active) { this.incomplete = true; this.emit(); return; }
    if (!slot.successful && this.tilesSettled(slot)) this.abandon();
  };
  private readonly render = (): void => {
    this.refresh();
    const next = this.staging;
    if (!next || (!next.successful && !next.failed.size) || !this.tilesSettled(next)) return;
    if (!next.successful) { this.abandon(); return; }
    if (!matches(next, this.requested)) { this.prefetchBytes(); return; }
    const previous = this.active;
    this.map.setPaintProperty(next.id, 'raster-opacity', this.opacity);
    if (previous) this.map.setPaintProperty(previous.id, 'raster-opacity', 0);
    this.active = next; this.staging = previous;
    next.transport.setInteractive(true);
    previous?.transport.setInteractive(false);
    this.replacementFailed = false;
    this.incomplete = this.problem(next);
    this.cancelPrefetch();
    if (previous && (previous.build !== next.build || this.problem(previous))) {
      this.drop(previous); this.staging = null;
      if (previous.build.manifest.buildId !== next.build.manifest.buildId) this.protocol?.evictBuild(previous.build.manifest.buildId);
    }
    queueMicrotask(() => this.prepareNext());
    this.armExpiry(); this.emit();
  };
  private readonly move = (): void => {
    this.moving = true; this.preferred = null; this.warmFailed = null;
    this.cancelPrefetch();
    if (this.staging && !matches(this.staging, this.requested)) { this.drop(this.staging); this.staging = null; this.armExpiry(); }
  };
  private readonly settled = (): boolean => {
    if (!this.moving || this.map.isMoving?.()) return false;
    this.moving = false;
    const selection = this.requested;
    if ((!matches(this.staging, selection) && !this.retryEmpty) || !selection || selection.build.expiresAtMs <= Date.now()) {
      this.prepareNext(); return false;
    }
    // A tile can leave the viewport without an abort; restage pending replacements to reset success evidence.
    const staging = this.staging; this.staging = null; this.drop(staging);
    try { this.select(selection.build, selection.layer, selection.frame); } catch { /* select reports replacement failure. */ }
    return true;
  };
  private readonly idle = (): void => {
    if (this.settled()) return;
    this.render();
    if (this.staging) this.abandonEmpty(this.staging);
    this.prepareNext();
  };

  constructor(private readonly map: Map, private readonly baseUrl: string, opacity: number, private readonly onState: (state: OverlayState) => void) {
    this.opacity = opacity;
    map.on('sourcedata', this.data); map.on('sourcedataloading', this.loading);
    map.on('sourcedataabort', this.abort); map.on('error', this.failed);
    map.on('render', this.render); map.on('movestart', this.move);
    map.on('moveend', this.settled); map.on('idle', this.idle);
  }

  select(build: PinnedBuild, layer: LayerId, frame: string): void {
    if (this.disposed) return;
    if (build.expiresAtMs <= Date.now()) { this.clear(); return; }
    this.moving ||= this.map.isMoving?.() ?? false;
    const previous = this.requested;
    if (previous?.build === build && previous.layer === layer && previous.frame !== frame) {
      const frames = renderedFrames(build.manifest);
      this.direction = frames.findIndex(item => item.id === frame) > frames.findIndex(item => item.id === previous.frame) ? 1 : -1;
    } else if (previous?.layer !== layer || previous.build !== build) this.direction = undefined;
    this.retryEmpty = false; this.preferred = null; this.warmFailed = null;
    this.requested = { build, layer, frame };
    this.replacementFailed = false; this.incomplete = this.problem(this.active);
    if (matches(this.active, this.requested)) {
      if (this.staging) this.staging.transport.setInteractive(false);
      this.cancelPrefetch(); this.prepareNext(); this.emit(); return;
    }
    if (matches(this.staging, this.requested) && !this.problem(this.staging)) {
      this.staging!.transport.setInteractive(true);
      this.cancelPrefetch(); this.emit(); this.render(); return;
    }
    this.drop(this.staging); this.staging = null;
    try {
      this.addSlot(this.requested, true);
      this.cancelPrefetch(this.requested); this.armExpiry(); this.emit();
    } catch (error) {
      this.drop(this.staging); this.staging = null; this.replacementFailed = true; this.cancelPrefetch(); this.emit(); throw error;
    }
  }

  /** Prepare a likely layer/time while the current requested view remains displayed. */
  prepare(layer: LayerId, frame: string): void {
    const build = this.active?.build;
    if (!build || !build.templates[layer] || !renderedFrames(build.manifest).some(item => item.id === frame)) return;
    this.preferred = { build, layer, frame }; this.warmFailed = null;
    this.prepareNext();
  }

  refresh(): void {
    let changed = false;
    for (const name of ['active', 'staging'] as const) {
      const slot = this[name];
      if (slot && slot.build.expiresAtMs <= Date.now()) {
        this.drop(slot); this[name] = null; this.protocol?.evictBuild(slot.build.manifest.buildId); changed = true;
      }
    }
    if (changed) { this.preferred = null; this.cancelPrefetch(); this.armExpiry(); this.emit(); }
  }

  setOpacity(value: number): void {
    this.opacity = value;
    if (this.active) this.map.setPaintProperty(this.active.id, 'raster-opacity', value);
  }

  clear(dispose = false): void {
    const ids = new Set([this.active?.build.manifest.buildId, this.staging?.build.manifest.buildId]);
    this.cancelPrefetch();
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer); this.expiryTimer = null;
    this.drop(this.staging); this.drop(this.active); this.active = null; this.staging = null; this.requested = null;
    this.preferred = null; this.warmFailed = null; this.direction = undefined;
    for (const id of ids) if (id) this.protocol?.evictBuild(id);
    if (dispose && this.protocol) { this.protocol.dispose(); removeProtocol(this.protocol.scheme); this.protocol = null; }
    this.incomplete = false; this.replacementFailed = false; this.retryEmpty = false; this.emit();
  }

  destroy(): void {
    this.disposed = true; this.clear(true);
    this.map.off('sourcedata', this.data); this.map.off('sourcedataloading', this.loading);
    this.map.off('sourcedataabort', this.abort); this.map.off('error', this.failed);
    this.map.off('render', this.render); this.map.off('movestart', this.move);
    this.map.off('moveend', this.settled); this.map.off('idle', this.idle);
  }

  private addSlot(selection: Selection, interactive: boolean): void {
    if (!this.protocol) { this.protocol = createSourceRasterTileProtocol(this.baseUrl); addProtocol(this.protocol.scheme, this.protocol.load); }
    this.protocol.setBuildExpiry(selection.build.manifest.buildId, selection.build.expiresAtMs);
    const id = `av-overlay-${++this.generation}`, transport = this.protocol.createSource(interactive);
    const next: Slot = { ...selection, id, transport, successful: false, pending: new Set(), failed: new Set(), sourceFailed: false };
    this.staging = next;
    const source = previewRasterSource(selection.build.templates[selection.layer], selection.frame, layerMaxZoom(selection.build.manifest, selection.layer), selection.build.manifest.descriptors.attribution);
    source.tiles = source.tiles.map(url => transport.url(url));
    this.map.addSource(id, source);
    this.map.addLayer({ ...previewRasterLayer(0), id, source: id, paint: { ...previewRasterLayer(0).paint, 'raster-opacity-transition': { duration: 0, delay: 0 } } });
  }
  private problem(slot: Slot | null): boolean { return !!slot && (slot.sourceFailed || slot.failed.size > 0); }
  private tilesSettled(slot: Slot): boolean {
    return !this.moving && !this.map.isMoving?.() && !slot.pending.size && slot.build.expiresAtMs > Date.now() && this.map.isSourceLoaded(slot.id);
  }
  private abandonEmpty(slot: Slot): void {
    if (slot !== this.staging || slot.successful || !this.tilesSettled(slot)) return;
    if (matches(slot, this.requested)) this.retryEmpty = slot.failed.size === 0;
    this.abandon();
  }
  private abandon(): void {
    const slot = this.staging; this.staging = null;
    const requested = matches(slot, this.requested);
    if (!requested) this.warmFailed = slot;
    this.drop(slot); this.cancelPrefetch();
    if (requested) { this.replacementFailed = true; this.incomplete = this.problem(this.active); }
    this.armExpiry(); if (requested) this.emit();
  }
  private cancelPrefetch(keep?: Selection): void {
    const template = keep && frameTileUrl(keep.build.templates[keep.layer], keep.frame);
    const prefix = template?.slice(0, template.indexOf('{z}'));
    for (const [url, controller] of this.prefetchJobs) {
      if (prefix && url.startsWith(prefix)) continue;
      controller.abort(); this.prefetchJobs.delete(url);
    }
    this.prefetched = false;
  }
  private drop(slot: Slot | null): void {
    if (!slot) return;
    if (this.map.getLayer(slot.id)) this.map.removeLayer(slot.id);
    if (this.map.getSource(slot.id)) this.map.removeSource(slot.id);
    slot.transport.dispose();
  }
  private emit(): void { this.onState({ displayed: this.active, requested: this.requested, incomplete: this.incomplete, replacementFailed: this.replacementFailed }); }
  private armExpiry(): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    const deadline = Math.min(...[this.active, this.staging].flatMap(slot => slot ? [slot.build.expiresAtMs] : []));
    if (!Number.isFinite(deadline)) return;
    this.expiryTimer = setTimeout(() => { this.expiryTimer = null; this.refresh(); this.armExpiry(); this.emit(); }, Math.min(Math.max(0, deadline - Date.now()), 2_147_000_000));
  }
  private predicted(): Selection | null {
    const slot = this.active;
    if (!slot) return null;
    if (this.preferred?.build === slot.build) return this.preferred;
    const frames = renderedFrames(slot.build.manifest), index = frames.findIndex(frame => frame.id === slot.frame);
    if (this.direction) {
      const frame = frames[index + this.direction] ?? frames[index - this.direction];
      if (frame) return { build: slot.build, layer: slot.layer, frame: frame.id };
    }
    const sibling = slot.layer === 'usable-lift-agl' ? 'usable-lift-msl' : slot.layer === 'usable-lift-msl' ? 'usable-lift-agl' : null;
    if (sibling && slot.build.templates[sibling]) return { build: slot.build, layer: sibling, frame: slot.frame };
    const frame = frames[index + 1] ?? frames[index - 1];
    return frame ? { build: slot.build, layer: slot.layer, frame: frame.id } : null;
  }
  private prepareNext(): void {
    if (this.disposed || this.moving || this.map.isMoving?.() || !this.active || !matches(this.active, this.requested) || this.active.build.expiresAtMs <= Date.now()) return;
    const next = this.predicted();
    if (!next || matches(next, this.active) || matches(next, this.warmFailed)) return;
    if (!matches(next, this.staging)) {
      this.cancelPrefetch(next); this.drop(this.staging); this.staging = null;
      try { this.addSlot(next, false); this.armExpiry(); }
      catch { this.abandon(); this.warmFailed = next; }
    }
    this.prefetchBytes();
  }
  private prefetchBytes(): void {
    const slot = this.active, standby = this.staging;
    if (this.disposed || this.moving || !slot || !matches(slot, this.requested) || !standby?.successful || !this.tilesSettled(standby) || !this.protocol || this.prefetched) return;
    const bounds = this.map.getBounds(), z = Math.min(layerMaxZoom(slot.build.manifest, slot.layer), Math.max(0, Math.round(this.map.getZoom()) + 1));
    const tiles = viewportTiles({ west: bounds.getWest(), east: bounds.getEast(), south: bounds.getSouth(), north: bounds.getNorth() }, z);
    const urls = planViewportPrefetch({ build: slot.build, activeLayer: slot.layer, activeFrame: slot.frame, viewportTiles: tiles, preferred: standby, direction: this.direction });
    this.prefetched = true;
    for (const url of urls) {
      const controller = new AbortController(); this.prefetchJobs.set(url, controller);
      void this.protocol.prefetch(url, controller.signal).catch(() => {}).finally(() => {
        if (this.prefetchJobs.get(url) === controller) this.prefetchJobs.delete(url);
      });
    }
  }
}
