import type { Map, MapSourceDataEvent, ErrorEvent } from 'maplibre-gl';
import { createSourceRasterTileProtocol, frameTileUrl, layerMaxZoom, longitudeOffsetHours, planViewportPrefetch, previewRasterLayer, previewRasterSource, type PinnedBuild, type RasterTileSourceProtocol, type RasterTileSourceTransport, viewportTiles } from '@av/client';
import type { LayerId } from '@av/contracts/layers';
import { renderedFrames } from '@av/contracts/publication';
import { addProtocol, removeProtocol } from 'maplibre-gl';
import { MAX_RASTER_SOURCES, rasterSourceLimit } from './raster-budget';
import { dayKey } from './timeline';

interface Selection { build: PinnedBuild; layer: LayerId; frame: string }
interface Slot extends Selection { id: string; transport: RasterTileSourceTransport; successful: boolean; pending: Set<object>; failed: Set<object>; sourceFailed: boolean }
export interface OverlayState { displayed: Selection | null; requested: Selection | null; incomplete: boolean; replacementFailed: boolean }
const matches = (a: Selection | null, b: Selection | null): boolean => !!a && !!b && a.build === b.build && a.layer === b.layer && a.frame === b.frame;

/** Owns the displayed raster and a bounded prepared window; dispose with the map. */
export class RasterOverlay {
  private protocol: RasterTileSourceProtocol | null = null;
  private active: Slot | null = null;
  private pendingPaint: Slot | null = null;
  private slots: Slot[] = [];
  private requested: Selection | null = null;
  private preferred: Selection | null = null;
  private warmFailed: Selection[] = [];
  private direction: 1 | -1 | undefined;
  private sourceLimits = new globalThis.Map<number, number>();
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
    const slot = this.slots.find(slot => slot.id === event.sourceId);
    if (!slot) return;
    if (event.tile) {
      slot.pending.delete(event.tile); slot.successful = true;
      const recovered = slot.failed.delete(event.tile);
      if (slot === this.active && recovered) { this.incomplete = this.problem(slot); this.emit(); }
    }
    if (slot !== this.active && event.sourceDataType === 'idle' && event.isSourceLoaded) queueMicrotask(() => this.abandonEmpty(slot));
  };
  private readonly loading = (event: MapSourceDataEvent): void => {
    const slot = this.slots.find(slot => slot.id === event.sourceId);
    if (slot && slot !== this.active && event.tile) slot.pending.add(event.tile);
  };
  private readonly abort = (event: MapSourceDataEvent): void => {
    const slot = this.slots.find(slot => slot.id === event.sourceId);
    if (!slot || !event.tile) return;
    slot.pending.delete(event.tile);
    if (slot.failed.delete(event.tile) && slot === this.active) { this.incomplete = this.problem(slot); this.emit(); }
  };
  private readonly failed = (event: ErrorEvent & { sourceId?: string; tile?: object }): void => {
    const slot = this.slots.find(slot => slot.id === event.sourceId);
    if (!slot) return;
    if (!event.tile) {
      slot.sourceFailed = true;
      if (slot !== this.active) this.abandon(slot);
      else { this.incomplete = true; this.emit(); }
      return;
    }
    slot.failed.add(event.tile); slot.pending.delete(event.tile);
    if (slot === this.active) { this.incomplete = true; this.emit(); return; }
    if (this.tilesSettled(slot) && (!slot.successful || !matches(slot, this.requested))) this.abandon(slot);
  };
  private readonly render = (): void => {
    // MapLibre fires render after drawing; only this event acknowledges an opacity swap.
    const next = this.pendingPaint;
    if (!next) { this.update(); return; }
    if (next.build.expiresAtMs <= Date.now()) { this.refresh(); return; }
    this.pendingPaint = null;
    const previous = this.active;
    this.active = next;
    next.transport.setInteractive(true);
    previous?.transport.setInteractive(false);
    this.replacementFailed = false; this.incomplete = this.problem(next);
    for (const slot of [...this.slots]) {
      if (slot !== next && (slot.build !== next.build || this.problem(slot))) this.drop(slot);
    }
    if (previous && previous.build.manifest.buildId !== next.build.manifest.buildId) this.protocol?.evictBuild(previous.build.manifest.buildId);
    queueMicrotask(() => this.prepareNext());
    this.armExpiry(); this.emit();
  };
  private readonly move = (): void => {
    this.moving = true; this.preferred = null; this.warmFailed = []; this.sourceLimits.clear();
    this.cancelPrefetch();
    for (const slot of [...this.slots]) if (slot !== this.active && !matches(slot, this.requested)) this.drop(slot);
    this.armExpiry();
  };
  private readonly resized = (): void => {
    this.sourceLimits.clear(); this.preferred = null; this.warmFailed = []; this.cancelPrefetch();
    for (const slot of [...this.slots]) if (slot !== this.active && !matches(slot, this.requested)) this.drop(slot);
    this.prepareNext(); this.armExpiry();
  };
  private readonly settled = (): boolean => {
    if (!this.moving || this.map.isMoving?.()) return false;
    this.moving = false; this.sourceLimits.clear();
    const selection = this.requested, pending = this.slots.find(slot => slot !== this.active && matches(slot, selection));
    if ((!pending && !this.retryEmpty) || !selection || selection.build.expiresAtMs <= Date.now()) {
      this.prepareNext(); return false;
    }
    // A tile can leave the viewport without an abort; restage pending replacements to reset success evidence.
    if (pending) this.drop(pending);
    try { this.select(selection.build, selection.layer, selection.frame); } catch { /* select reports replacement failure. */ }
    return true;
  };
  private readonly idle = (): void => {
    if (this.settled()) return;
    this.update();
    for (const slot of [...this.slots]) if (slot !== this.active) this.abandonEmpty(slot);
    this.prepareNext();
  };

  constructor(private readonly map: Map, private readonly baseUrl: string, opacity: number, private readonly onState: (state: OverlayState) => void) {
    this.opacity = opacity;
    map.on('sourcedata', this.data); map.on('sourcedataloading', this.loading);
    map.on('sourcedataabort', this.abort); map.on('error', this.failed);
    map.on('render', this.render); map.on('movestart', this.move);
    map.on('moveend', this.settled); map.on('idle', this.idle); map.on('resize', this.resized);
  }

  /** True when selection can reuse healthy decoded tiles in the current viewport. */
  isPrepared(build: PinnedBuild, layer: LayerId, frame: string): boolean {
    const slot = this.slots.find(slot => matches(slot, { build, layer, frame }));
    return !this.disposed && !!slot && slot.successful && !this.problem(slot) && this.tilesSettled(slot);
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
    this.retryEmpty = false; this.preferred = null; this.warmFailed = [];
    this.requested = { build, layer, frame };
    if (this.pendingPaint && !matches(this.pendingPaint, this.requested)) this.cancelPaint();
    this.replacementFailed = false; this.incomplete = this.problem(this.active);
    if (matches(this.active, this.requested)) {
      for (const slot of this.slots) if (slot !== this.active) slot.transport.setInteractive(false);
      this.cancelPrefetch(); this.prepareNext(); this.emit(); return;
    }
    let target = this.slots.find(slot => matches(slot, this.requested));
    if (target && this.problem(target)) { this.drop(target); target = undefined; }
    const ready = this.isPrepared(build, layer, frame);
    const future = this.predicted(this.requested);
    for (const slot of [...this.slots]) {
      if (slot === this.active || slot === target) continue;
      // MapLibre admits image work before our transport; cold selection frees those slots too.
      if (slot.build !== build || this.problem(slot) || ((!slot.successful || !this.tilesSettled(slot)) && (!ready || !future.some(value => matches(slot, value))))) this.drop(slot);
      else slot.transport.setInteractive(false);
    }
    if (target) {
      target.transport.setInteractive(true);
      this.cancelPrefetch(); this.emit(); this.update(); return;
    }
    while (this.slots.length >= Math.max(2, this.slotLimit(this.requested))) this.drop(this.slots.findLast(slot => slot !== this.active)!);
    try {
      this.addSlot(this.requested, true);
      this.cancelPrefetch(this.requested); this.armExpiry(); this.emit();
    } catch (error) {
      const failed = this.slots.find(slot => matches(slot, this.requested));
      if (failed) this.drop(failed);
      this.replacementFailed = true; this.cancelPrefetch(); this.emit(); throw error;
    }
  }

  /** Prepare a likely layer/time while the current requested view remains displayed. */
  prepare(layer: LayerId, frame: string): void {
    const build = this.active?.build;
    if (!build || !build.templates[layer] || !renderedFrames(build.manifest).some(item => item.id === frame)) return;
    this.preferred = { build, layer, frame }; this.warmFailed = [];
    this.cancelPrefetch(); this.prepareNext();
  }

  refresh(): void {
    let changed = false;
    for (const slot of [...this.slots]) {
      if (slot.build.expiresAtMs <= Date.now()) {
        this.drop(slot); this.protocol?.evictBuild(slot.build.manifest.buildId); changed = true;
      }
    }
    if (changed) { this.preferred = null; this.cancelPrefetch(); this.armExpiry(); this.emit(); }
  }

  setOpacity(value: number): void {
    this.opacity = value;
    const visible = this.pendingPaint ?? this.active;
    if (visible) this.map.setPaintProperty(visible.id, 'raster-opacity', value);
  }

  clear(dispose = false): void {
    const ids = new Set(this.slots.map(slot => slot.build.manifest.buildId));
    this.cancelPrefetch();
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer); this.expiryTimer = null;
    for (const slot of [...this.slots]) this.drop(slot);
    this.requested = null; this.preferred = null; this.warmFailed = []; this.direction = undefined; this.sourceLimits.clear();
    for (const id of ids) this.protocol?.evictBuild(id);
    if (dispose && this.protocol) { this.protocol.dispose(); removeProtocol(this.protocol.scheme); this.protocol = null; }
    this.incomplete = false; this.replacementFailed = false; this.retryEmpty = false; this.emit();
  }

  destroy(): void {
    this.disposed = true; this.clear(true);
    this.map.off('sourcedata', this.data); this.map.off('sourcedataloading', this.loading);
    this.map.off('sourcedataabort', this.abort); this.map.off('error', this.failed);
    this.map.off('render', this.render); this.map.off('movestart', this.move);
    this.map.off('moveend', this.settled); this.map.off('idle', this.idle); this.map.off('resize', this.resized);
  }

  private update(): void {
    this.refresh();
    const next = this.slots.find(slot => slot !== this.active && matches(slot, this.requested));
    if (next && (next.successful || next.failed.size) && this.tilesSettled(next)) {
      if (!next.successful) { this.abandon(next); return; }
      this.map.setPaintProperty(next.id, 'raster-opacity', this.opacity);
      if (this.active) this.map.setPaintProperty(this.active.id, 'raster-opacity', 0);
      this.pendingPaint = next;
      this.cancelPrefetch(); return;
    }
    this.prepareNext();
  }
  private cancelPaint(): void {
    if (!this.pendingPaint) return;
    this.map.setPaintProperty(this.pendingPaint.id, 'raster-opacity', 0);
    this.pendingPaint = null;
    if (this.active) this.map.setPaintProperty(this.active.id, 'raster-opacity', this.opacity);
  }
  private addSlot(selection: Selection, interactive: boolean): void {
    if (!this.protocol) { this.protocol = createSourceRasterTileProtocol(this.baseUrl, { maxSources: MAX_RASTER_SOURCES }); addProtocol(this.protocol.scheme, this.protocol.load); }
    this.protocol.setBuildExpiry(selection.build.manifest.buildId, selection.build.expiresAtMs);
    const id = `av-overlay-${++this.generation}`, transport = this.protocol.createSource(interactive);
    const next: Slot = { ...selection, id, transport, successful: false, pending: new Set(), failed: new Set(), sourceFailed: false };
    this.slots.push(next);
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
    if (!this.slots.includes(slot) || slot === this.active || slot.successful || !this.tilesSettled(slot)) return;
    if (matches(slot, this.requested)) this.retryEmpty = slot.failed.size === 0;
    this.abandon(slot);
  }
  private abandon(slot: Slot): void {
    const requested = matches(slot, this.requested);
    if (!requested) this.warmFailed.push({ build: slot.build, layer: slot.layer, frame: slot.frame });
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
  private drop(slot: Slot): void {
    if (slot === this.pendingPaint) this.cancelPaint();
    this.slots = this.slots.filter(value => value !== slot);
    if (this.active === slot) this.active = null;
    if (this.map.getLayer(slot.id)) this.map.removeLayer(slot.id);
    if (this.map.getSource(slot.id)) this.map.removeSource(slot.id);
    slot.transport.dispose();
  }
  private emit(): void { this.onState({ displayed: this.active, requested: this.requested, incomplete: this.incomplete, replacementFailed: this.replacementFailed }); }
  private armExpiry(): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const deadline = Math.min(...this.slots.map(slot => slot.build.expiresAtMs));
    if (!Number.isFinite(deadline)) return;
    this.expiryTimer = setTimeout(() => { this.expiryTimer = null; this.refresh(); }, Math.min(Math.max(0, deadline - Date.now()), 2_147_000_000));
  }
  private slotLimit(selection: Selection): number {
    const zoom = layerMaxZoom(selection.build.manifest, selection.layer);
    let limit = this.sourceLimits.get(zoom);
    if (limit === undefined) { limit = rasterSourceLimit(this.map, zoom); this.sourceLimits.set(zoom, limit); }
    return limit;
  }
  private predicted(slot: Selection | null = this.active): Selection[] {
    if (!slot) return [];
    const selections: Selection[] = [];
    const add = (layer: LayerId, frame: string | undefined) => {
      if (!frame || !slot.build.templates[layer]) return;
      const value = { build: slot.build, layer, frame };
      if (!matches(value, slot) && !selections.some(item => matches(item, value))) selections.push(value);
    };
    if (this.preferred?.build === slot.build) add(this.preferred.layer, this.preferred.frame);
    const frames = renderedFrames(slot.build.manifest), index = frames.findIndex(frame => frame.id === slot.frame);
    const sibling = slot.layer === 'usable-lift-agl' ? 'usable-lift-msl' : slot.layer === 'usable-lift-msl' ? 'usable-lift-agl' : null;
    if (!this.direction && sibling) add(sibling, slot.frame);
    const step = frames[index + (this.direction ?? 1)] ? this.direction ?? 1 : -(this.direction ?? 1);
    for (const offset of this.direction ? [step, 2 * step, -step] : [step, -step, 2 * step]) add(slot.layer, frames[index + offset]?.id);
    if (sibling) add(sibling, slot.frame);
    return selections;
  }
  private prepareNext(): void {
    if (this.disposed || this.pendingPaint || this.moving || this.map.isMoving?.() || !this.active || !matches(this.active, this.requested) || this.active.build.expiresAtMs <= Date.now()) return;
    const candidates = this.predicted(), limit = Math.min(this.slotLimit(this.active), ...candidates.map(value => this.slotLimit(value)));
    const desired = candidates.slice(0, limit - 1);
    for (const slot of [...this.slots]) {
      if (slot !== this.active && !desired.some(value => matches(slot, value))) this.drop(slot);
    }
    for (const next of desired) {
      if (this.warmFailed.some(value => matches(value, next))) continue;
      const slot = this.slots.find(slot => matches(slot, next));
      if (slot) {
        if (!slot.successful || !this.tilesSettled(slot)) return;
        if (this.problem(slot)) { this.abandon(slot); return; }
        continue;
      }
      this.cancelPrefetch(next);
      try { this.addSlot(next, false); this.armExpiry(); }
      catch { const failed = this.slots.find(slot => matches(slot, next)); if (failed) this.abandon(failed); else this.warmFailed.push(next); }
      return;
    }
    this.prefetchBytes();
  }
  private timelineFrames(slot: Slot): string[] {
    const frames = renderedFrames(slot.build.manifest), index = frames.findIndex(frame => frame.id === slot.frame);
    const offset = longitudeOffsetHours(this.map.getCenter().lng) * 60;
    const selectedDay = dayKey(Date.parse(frames[index].validTime), offset);
    const before = frames.slice(0, index).reverse(), after = frames.slice(index + 1);
    return (this.direction === -1 ? [...before, ...after] : [...after, ...before])
      .filter(frame => dayKey(Date.parse(frame.validTime), offset) === selectedDay).map(frame => frame.id);
  }
  private prefetchBytes(): void {
    const slot = this.active;
    if (this.disposed || this.moving || !slot || !matches(slot, this.requested) || !this.protocol || this.prefetched) return;
    const bounds = this.map.getBounds(), z = Math.min(layerMaxZoom(slot.build.manifest, slot.layer), Math.max(0, Math.round(this.map.getZoom()) + 1));
    const tiles = viewportTiles({ west: bounds.getWest(), east: bounds.getEast(), south: bounds.getSouth(), north: bounds.getNorth() }, z);
    const prepared = this.slots.filter(value => value.successful && !this.problem(value) && this.tilesSettled(value));
    const urls = planViewportPrefetch({ build: slot.build, activeLayer: slot.layer, activeFrame: slot.frame, viewportTiles: tiles,
      preferred: this.predicted()[0], direction: this.direction, prepared, timelineFrames: this.timelineFrames(slot) });
    this.prefetched = true;
    for (const url of urls) {
      const controller = new AbortController(); this.prefetchJobs.set(url, controller);
      void this.protocol.prefetch(url, controller.signal).catch(() => {}).finally(() => {
        if (this.prefetchJobs.get(url) === controller) this.prefetchJobs.delete(url);
      });
    }
  }
}
