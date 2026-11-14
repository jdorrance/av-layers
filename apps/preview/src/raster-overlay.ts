import type { Map, MapSourceDataEvent, ErrorEvent } from 'maplibre-gl';
import { createSourceRasterTileProtocol, frameTileUrl, layerMaxZoom, longitudeOffsetHours, planViewportPrefetch, previewRasterLayer, previewRasterSource, type PinnedBuild, type RasterTileSourceProtocol, type RasterTileSourceTransport, viewportTiles } from '@av/client';
import type { LayerId } from '@av/contracts/layers';
import { renderedFrames } from '@av/contracts/publication';
import { addProtocol, removeProtocol } from 'maplibre-gl';
import { canRetainRasterOverview, MAX_RASTER_SOURCES, rasterSourceLimit } from './raster-budget';
import { dayKey } from './timeline';
import { RasterOverview } from './raster-overview';

interface Selection { build: PinnedBuild; layer: LayerId; frame: string }
interface Slot extends Selection { id: string; transport: RasterTileSourceTransport; successful: boolean; pending: Set<object>; failed: Set<object>; sourceFailed: boolean }
export interface OverlayState { displayed: Selection | null; requested: Selection | null; quality: 'overview' | 'detail' | null; viewLoading: boolean; overviewReady: number; overviewTotal: number; overviewFailed: number; incomplete: boolean; replacementFailed: boolean }
const matches = (a: Selection | null, b: Selection | null): boolean => !!a && !!b && a.build === b.build && a.layer === b.layer && a.frame === b.frame;

/** Owns the displayed raster and a bounded prepared window; dispose with the map. */
export class RasterOverlay {
  private protocol: RasterTileSourceProtocol | null = null;
  private active: Slot | null = null;
  private pendingPaint: Slot | null = null;
  private overview: RasterOverview | null = null;
  private coarse: Selection | null = null;
  private pendingOverview: Selection | null = null;
  private refineTimer: ReturnType<typeof setTimeout> | null = null;
  private slots: Slot[] = [];
  private requested: Selection | null = null;
  private preferred: Selection | null = null;
  private warmFailed: Selection[] = [];
  private direction: 1 | -1 | undefined;
  private sourceLimits = new globalThis.Map<number, number>();
  private generation = 0;
  private opacity: number;
  private windActive = true;
  private windResident = true;
  private incomplete = false;
  private replacementFailed = false;
  private lastState: OverlayState | null = null;
  private retryEmpty = false;
  private moving = false;
  private disposed = false;
  private prefetchJobs = new globalThis.Map<string, AbortController>();
  private prefetched = false;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly data = (e: MapSourceDataEvent): void => {
    const slot = this.slots.find(s => s.id === e.sourceId);
    if (!slot) return;
    if (e.tile) {
      slot.pending.delete(e.tile); slot.successful = true;
      const recovered = slot.failed.delete(e.tile);
      if (slot === this.active) { if (recovered) this.incomplete = this.problem(slot); this.emit(); }
    }
    if (slot !== this.active && e.sourceDataType === 'idle' && e.isSourceLoaded) queueMicrotask(() => this.abandonEmpty(slot));
  };
  private readonly loading = (e: MapSourceDataEvent): void => {
    const slot = this.slots.find(s => s.id === e.sourceId);
    if (slot && e.tile) { if (slot !== this.active) slot.pending.add(e.tile); else this.emit(); }
  };
  private readonly abort = (e: MapSourceDataEvent): void => {
    const slot = this.slots.find(s => s.id === e.sourceId);
    if (!slot || !e.tile) return;
    slot.pending.delete(e.tile);
    const recovered = slot.failed.delete(e.tile);
    if (slot === this.active) { if (recovered) this.incomplete = this.problem(slot); this.emit(); }
  };
  private readonly failed = (e: ErrorEvent & { sourceId?: string; tile?: object }): void => {
    const slot = this.slots.find(s => s.id === e.sourceId);
    if (!slot) return;
    if (!e.tile) {
      slot.sourceFailed = true;
      if (slot !== this.active) this.abandon(slot); else { this.incomplete = true; this.emit(); }
      return;
    }
    slot.failed.add(e.tile); slot.pending.delete(e.tile);
    if (slot === this.active) { this.incomplete = true; this.emit(); return; }
    if (this.tilesSettled(slot) && (!slot.successful || !matches(slot, this.requested))) this.abandon(slot);
  };
  private readonly render = (): void => {
    if (this.pendingOverview) {
      const next = this.pendingOverview;
      if (!matches(next, this.requested) || !this.overview?.ready(next.build, next.layer, next.frame)) {
        this.cancelPaint(); this.refresh(); this.emit(); return;
      }
      this.coarse = next; this.pendingOverview = null; this.emit(); this.update(); return;
    }
    const next = this.pendingPaint;
    if (!next) { this.update(); return; }
    if (next.build.expiresAtMs <= Date.now()) { this.refresh(); return; }
    this.pendingPaint = null;
    const previous = this.active;
    this.active = next; this.coarse = null;
    next.transport.setInteractive(true);
    if (previous !== next) previous?.transport.setInteractive(false);
    this.replacementFailed = false; this.incomplete = this.problem(next);
    for (const slot of [...this.slots]) if (slot !== next && (slot.build !== next.build || this.problem(slot))) this.drop(slot);
    if (previous && previous.build.manifest.buildId !== next.build.manifest.buildId) this.protocol?.evictBuild(previous.build.manifest.buildId);
    queueMicrotask(() => this.prepareNext());
    this.armExpiry(); this.emit();
  };
  private readonly move = (): void => {
    this.cancelPaint(); this.cancelRefinement(); this.clearOverview();
    this.moving = true; this.preferred = null; this.warmFailed = []; this.sourceLimits.clear(); this.cancelPrefetch();
    for (const slot of [...this.slots]) if (slot !== this.active && !matches(slot, this.requested)) this.drop(slot);
    this.armExpiry(); this.emit();
  };
  private readonly viewChanged = (): void => { this.sourceLimits.clear(); this.enforceBudget(); };
  private readonly resized = (): void => {
    this.cancelPaint(); this.cancelRefinement(); this.clearOverview();
    this.sourceLimits.clear(); this.preferred = null; this.warmFailed = []; this.cancelPrefetch();
    for (const slot of [...this.slots]) if (slot !== this.active && !matches(slot, this.requested)) this.drop(slot);
    this.enforceBudget();
    if (this.requested && !this.moving) {
      this.prepareOverview(this.requested);
      try { this.loadDetail(this.requested); } catch { /* reported */ }
    }
    this.prepareNext(); this.armExpiry(); this.emit();
  };
  private readonly settled = (): boolean => {
    if (!this.moving || this.map.isMoving?.()) return false;
    this.moving = false; this.sourceLimits.clear(); this.enforceBudget();
    const sel = this.requested, pending = this.slots.find(s => s !== this.active && matches(s, sel));
    if (sel) this.prepareOverview(sel);
    if ((!pending && !this.retryEmpty && matches(this.active, sel)) || !sel || sel.build.expiresAtMs <= Date.now()) {
      this.prepareNext(); this.emit(); return false;
    }
    if (pending) this.drop(pending);
    try { this.select(sel.build, sel.layer, sel.frame); } catch { /* reported */ }
    return true;
  };
  private readonly idle = (): void => {
    if (this.settled()) return;
    this.update();
    for (const slot of [...this.slots]) if (slot !== this.active) this.abandonEmpty(slot);
    this.prepareNext(); this.emit();
  };
  private readonly events: Array<[string, (...args: never[]) => unknown]> = [
    ['sourcedata', this.data], ['sourcedataloading', this.loading], ['sourcedataabort', this.abort], ['error', this.failed],
    ['render', this.render], ['movestart', this.move], ['move', this.viewChanged], ['moveend', this.settled], ['idle', this.idle], ['resize', this.resized]
  ];

  constructor(private readonly map: Map, private readonly baseUrl: string, opacity: number, private readonly onState: (state: OverlayState) => void, private readonly fetchImpl?: typeof fetch) {
    this.opacity = opacity;
    for (const [ev, fn] of this.events) map.on(ev as never, fn as never);
  }

  isPrepared(build: PinnedBuild, layer: LayerId, frame: string): boolean {
    const slot = this.slots.find(s => matches(s, { build, layer, frame }));
    return !this.disposed && !!slot && slot.successful && !this.problem(slot) && this.tilesSettled(slot);
  }

  select(build: PinnedBuild, layer: LayerId, frame: string): void {
    if (this.disposed) return;
    if (build.expiresAtMs <= Date.now()) { this.clear(); return; }
    this.ensureProtocol(); this.cancelRefinement();
    this.moving ||= this.map.isMoving?.() ?? false;
    const prev = this.requested;
    if (prev?.build === build && prev.layer === layer && prev.frame !== frame) {
      const frames = renderedFrames(build.manifest);
      this.direction = frames.findIndex(i => i.id === frame) > frames.findIndex(i => i.id === prev.frame) ? 1 : -1;
    } else if (prev?.layer !== layer || prev?.build !== build) this.direction = undefined;
    this.retryEmpty = false; this.preferred = null; this.warmFailed = [];
    this.requested = { build, layer, frame };
    if ((this.pendingPaint && !matches(this.pendingPaint, this.requested)) || (this.pendingOverview && !matches(this.pendingOverview, this.requested))) this.cancelPaint();
    if (this.coarse && (this.coarse.build !== build || this.coarse.layer !== layer)) this.clearOverview();
    this.enforceBudget();
    if (!this.moving) this.prepareOverview(this.requested);
    this.replacementFailed = false; this.incomplete = this.problem(this.active);
    if (matches(this.active, this.requested)) {
      for (const s of this.slots) if (s !== this.active) s.transport.setInteractive(false);
      this.cancelPrefetch(); this.update(); this.emit(); return;
    }
    let target = this.slots.find(s => matches(s, this.requested));
    if (target && this.problem(target)) { this.drop(target); target = undefined; }
    const ready = this.isPrepared(build, layer, frame), future = this.predicted(this.requested);
    for (const s of [...this.slots]) {
      if (s === this.active || s === target) continue;
      if (s.build !== build || this.problem(s) || ((!s.successful || !this.tilesSettled(s)) && (!ready || !future.some(v => matches(s, v))))) this.drop(s);
      else s.transport.setInteractive(false);
    }
    if (target) { target.transport.setInteractive(true); this.cancelPrefetch(); this.emit(); this.update(); return; }
    this.cancelPrefetch(this.requested); this.emit();
    this.stageOverview();
    if (this.overview?.state.total) {
      const sel = this.requested;
      this.refineTimer = setTimeout(() => {
        this.refineTimer = null;
        if (matches(sel, this.requested) && !this.moving && sel.build.expiresAtMs > Date.now()) {
          try { this.loadDetail(sel); } catch { /* reported */ }
        }
      }, 100);
      return;
    }
    this.loadDetail(this.requested);
  }

  private loadDetail(sel: Selection): void {
    if (!matches(sel, this.requested) || this.slots.some(s => matches(s, sel))) return;
    const limit = this.slotLimit(sel);
    if (!limit) { this.cancelRefinement(); this.cancelPrefetch(); this.replacementFailed = true; this.armExpiry(); this.emit(); return; }
    while (this.slots.length >= limit) this.drop(this.slots.findLast(s => s !== this.active) ?? this.active!);
    try {
      this.addSlot(sel, true); this.replacementFailed = false; this.cancelPrefetch(sel); this.armExpiry(); this.emit();
    } catch (error) {
      const failed = this.slots.find(s => matches(s, this.requested));
      if (failed) this.drop(failed);
      this.replacementFailed = true; this.cancelPrefetch(); this.emit(); throw error;
    }
  }

  prepare(layer: LayerId, frame: string): void {
    const build = this.active?.build;
    if (!build || !build.templates[layer] || !renderedFrames(build.manifest).some(i => i.id === frame)) return;
    this.preferred = { build, layer, frame }; this.warmFailed = []; this.cancelPrefetch(); this.prepareNext();
  }

  refresh(): void {
    this.overview?.refresh();
    if (this.coarse && !this.overview?.ready(this.coarse.build, this.coarse.layer, this.coarse.frame)) this.clearOverview();
    if (this.pendingOverview && !this.overview?.ready(this.pendingOverview.build, this.pendingOverview.layer, this.pendingOverview.frame)) this.cancelPaint();
    let changed = false;
    for (const s of [...this.slots]) if (s.build.expiresAtMs <= Date.now()) {
      this.drop(s); this.protocol?.evictBuild(s.build.manifest.buildId); changed = true;
    }
    if (changed) { this.preferred = null; this.cancelPrefetch(); this.armExpiry(); this.emit(); }
  }

  setOpacity(value: number): void {
    this.opacity = value;
    const coarse = this.pendingOverview ?? (this.pendingPaint ? null : this.coarse);
    if (coarse) { this.overview?.show(coarse.build, coarse.layer, coarse.frame, value); return; }
    const visible = this.pendingPaint ?? this.active;
    if (visible) this.map.setPaintProperty(visible.id, 'raster-opacity', value);
  }

  setWindActive(active: boolean, numericResident = active): void {
    if (this.windActive === active && this.windResident === numericResident) return;
    this.windActive = active; this.windResident = numericResident;
    this.sourceLimits.clear(); this.enforceBudget(); this.prepareNext();
  }

  clear(dispose = false): void {
    this.cancelRefinement(); this.clearOverview();
    const ids = new Set(this.slots.map(s => s.build.manifest.buildId));
    this.cancelPrefetch();
    if (this.expiryTimer !== null) { clearTimeout(this.expiryTimer); this.expiryTimer = null; }
    for (const s of [...this.slots]) this.drop(s);
    this.requested = this.preferred = null; this.warmFailed = []; this.direction = undefined; this.sourceLimits.clear();
    for (const id of ids) this.protocol?.evictBuild(id);
    if (dispose && this.protocol) { this.overview?.destroy(); this.overview = null; this.protocol.dispose(); removeProtocol(this.protocol.scheme); this.protocol = null; }
    this.incomplete = this.replacementFailed = this.retryEmpty = false; this.emit();
  }

  destroy(): void {
    this.disposed = true; this.clear(true);
    for (const [ev, fn] of this.events) this.map.off(ev as never, fn as never);
  }

  private update(): void {
    this.refresh();
    if (this.pendingPaint || this.pendingOverview) return;
    const next = this.slots.find(s => matches(s, this.requested));
    if (next === this.active && !this.coarse && !(this.problem(next) && this.overview?.ready(next.build, next.layer, next.frame))) { this.prepareNext(); return; }
    if (next && (next.successful || next.failed.size) && this.tilesSettled(next)) {
      if (!next.successful) { this.abandon(next); return; }
      if (this.problem(next) && this.overview?.ready(next.build, next.layer, next.frame)) { this.abandon(next); this.stageOverview(); return; }
      this.map.setPaintProperty(next.id, 'raster-opacity', this.opacity);
      if (this.active && this.active !== next) this.map.setPaintProperty(this.active.id, 'raster-opacity', 0);
      this.overview?.hide(); this.pendingPaint = next; this.cancelPrefetch(); return;
    }
    if (!this.stageOverview()) this.prepareNext();
  }

  private cancelPaint(): void {
    if (!this.pendingPaint && !this.pendingOverview) return;
    if (this.pendingPaint) this.map.setPaintProperty(this.pendingPaint.id, 'raster-opacity', 0);
    this.pendingPaint = this.pendingOverview = null;
    if (this.coarse && this.overview?.show(this.coarse.build, this.coarse.layer, this.coarse.frame, this.opacity)) return;
    this.coarse = null; this.overview?.hide();
    if (this.active) this.map.setPaintProperty(this.active.id, 'raster-opacity', this.opacity);
  }

  private stageOverview(): boolean {
    const next = this.requested;
    if (!next || this.moving || this.map.isMoving?.() || !this.overview?.ready(next.build, next.layer, next.frame)) return false;
    if (matches(this.coarse, next) || matches(this.pendingOverview, next)) return true;
    if (!this.overview.show(next.build, next.layer, next.frame, this.opacity)) return false;
    for (const s of this.slots) this.map.setPaintProperty(s.id, 'raster-opacity', 0);
    this.pendingOverview = next;
    return true;
  }

  private clearOverview(): void {
    if (this.coarse && this.active && !matches(this.coarse, this.active)) this.drop(this.active);
    this.pendingOverview = this.coarse = null; this.overview?.clear();
    if (this.active && !this.pendingPaint) this.map.setPaintProperty(this.active.id, 'raster-opacity', this.opacity);
  }

  private prepareOverview(sel: Selection): void {
    if (!this.overview?.supported) return;
    if (canRetainRasterOverview(this.map, layerMaxZoom(sel.build.manifest, sel.layer), this.windActive, this.windResident)) {
      this.limitSlots(sel, true); this.overview.select(sel.build, sel.layer, sel.frame);
    } else this.clearOverview();
  }

  private cancelRefinement(): void { if (this.refineTimer !== null) { clearTimeout(this.refineTimer); this.refineTimer = null; } }

  private ensureProtocol(): void {
    if (this.protocol) return;
    this.protocol = createSourceRasterTileProtocol(this.baseUrl, { maxSources: MAX_RASTER_SOURCES, fetchImpl: this.fetchImpl });
    addProtocol(this.protocol.scheme, this.protocol.load);
    this.overview = new RasterOverview(this.map, this.protocol, () => { this.update(); this.emit(); });
  }

  private addSlot(sel: Selection, interactive: boolean): void {
    this.ensureProtocol();
    this.protocol!.setBuildExpiry(sel.build.manifest.buildId, sel.build.expiresAtMs);
    const id = `av-overlay-${++this.generation}`, transport = this.protocol!.createSource(interactive);
    this.slots.push({ ...sel, id, transport, successful: false, pending: new Set(), failed: new Set(), sourceFailed: false });
    const source = previewRasterSource(sel.build.templates[sel.layer], sel.frame, layerMaxZoom(sel.build.manifest, sel.layer), sel.build.manifest.descriptors.attribution);
    source.tiles = source.tiles.map(url => transport.url(url));
    this.map.addSource(id, source);
    const layer = previewRasterLayer(0);
    this.map.addLayer({ ...layer, id, source: id, paint: { ...layer.paint, 'raster-opacity-transition': { duration: 0, delay: 0 } } });
  }

  private problem(slot: Slot | null): boolean { return !!slot && (slot.sourceFailed || slot.failed.size > 0); }
  private tilesSettled(slot: Slot): boolean {
    return !this.moving && !this.map.isMoving?.() && !slot.pending.size && slot.build.expiresAtMs > Date.now() && this.map.isSourceLoaded(slot.id);
  }
  private abandonEmpty(slot: Slot): void {
    if (!this.slots.includes(slot) || slot === this.active || slot.successful || !this.tilesSettled(slot)) return;
    if (matches(slot, this.requested)) this.retryEmpty = !slot.failed.size;
    this.abandon(slot);
  }
  private abandon(slot: Slot): void {
    const req = matches(slot, this.requested);
    if (!req) this.warmFailed.push({ build: slot.build, layer: slot.layer, frame: slot.frame });
    this.drop(slot); this.cancelPrefetch();
    if (req) { this.replacementFailed = true; this.incomplete = this.problem(this.active); }
    this.armExpiry(); if (req) this.emit();
  }
  private cancelPrefetch(keep?: Selection): void {
    const template = keep && frameTileUrl(keep.build.templates[keep.layer], keep.frame);
    const prefix = template?.slice(0, template.indexOf('{z}'));
    for (const [url, ctrl] of this.prefetchJobs) if (!prefix || !url.startsWith(prefix)) { ctrl.abort(); this.prefetchJobs.delete(url); }
    this.prefetched = false;
  }
  private drop(slot: Slot): void {
    if (slot === this.pendingPaint) this.cancelPaint();
    this.slots = this.slots.filter(v => v !== slot);
    if (this.active === slot) this.active = null;
    if (this.map.getLayer(slot.id)) this.map.removeLayer(slot.id);
    if (this.map.getSource(slot.id)) this.map.removeSource(slot.id);
    slot.transport.dispose();
  }
  private emit(): void {
    const displayed = this.coarse ?? this.active, st = this.overview?.state;
    const next: OverlayState = { displayed, requested: this.requested, quality: this.coarse ? 'overview' : this.active ? 'detail' : null,
      viewLoading: this.moving || !!(this.active && !this.coarse && !this.map.isSourceLoaded(this.active.id)),
      overviewReady: st?.ready ?? 0, overviewTotal: st?.total ?? 0, overviewFailed: st?.failed ?? 0,
      incomplete: !this.coarse && this.incomplete, replacementFailed: this.replacementFailed };
    const last = this.lastState;
    if (last && (last.displayed === next.displayed || matches(last.displayed, next.displayed))
      && (last.requested === next.requested || matches(last.requested, next.requested))
      && last.quality === next.quality && last.viewLoading === next.viewLoading
      && last.overviewReady === next.overviewReady && last.overviewTotal === next.overviewTotal
      && last.overviewFailed === next.overviewFailed && last.incomplete === next.incomplete
      && last.replacementFailed === next.replacementFailed) return;
    this.lastState = next; this.onState(next);
  }
  private armExpiry(): void {
    if (this.expiryTimer !== null) { clearTimeout(this.expiryTimer); this.expiryTimer = null; }
    const deadline = Math.min(...this.slots.map(s => s.build.expiresAtMs));
    if (Number.isFinite(deadline)) this.expiryTimer = setTimeout(() => { this.expiryTimer = null; this.refresh(); }, Math.min(Math.max(0, deadline - Date.now()), 2_147_000_000));
  }
  private slotLimit(sel: Selection, overview = !!this.overview?.state.total): number {
    const zoom = layerMaxZoom(sel.build.manifest, sel.layer), key = zoom * 8 + Number(overview) * 4 + Number(this.windActive) * 2 + Number(this.windResident);
    let limit = this.sourceLimits.get(key);
    if (limit === undefined) { limit = rasterSourceLimit(this.map, zoom, overview, this.windActive, this.windResident); this.sourceLimits.set(key, limit); }
    return limit;
  }
  private limitSlots(sel: Selection, overview = !!this.overview?.state.total): number {
    const limit = Math.min(this.slotLimit(sel, overview), ...this.slots.map(s => this.slotLimit(s, overview)));
    while (this.slots.length > limit) this.drop(this.slots.findLast(s => s !== this.active) ?? this.active!);
    return limit;
  }
  private enforceBudget(): void {
    const sel = this.requested ?? this.active;
    if (!sel) return;
    if (this.overview?.state.total && !canRetainRasterOverview(this.map, layerMaxZoom(sel.build.manifest, sel.layer), this.windActive, this.windResident)) this.clearOverview();
    if (!this.limitSlots(sel)) { this.cancelRefinement(); this.cancelPrefetch(); this.replacementFailed = true; this.incomplete = false; }
    this.armExpiry(); this.emit();
  }
  private predicted(slot: Selection | null = this.active): Selection[] {
    if (!slot) return [];
    const selections: Selection[] = [];
    const add = (layer: LayerId, frame: string | undefined) => {
      if (!frame || !slot.build.templates[layer]) return;
      const v = { build: slot.build, layer, frame };
      if (!matches(v, slot) && !selections.some(i => matches(i, v))) selections.push(v);
    };
    if (this.preferred?.build === slot.build) add(this.preferred.layer, this.preferred.frame);
    const frames = renderedFrames(slot.build.manifest), index = frames.findIndex(f => f.id === slot.frame);
    const siblings = (Object.keys(slot.build.templates) as LayerId[]).filter(id => id !== slot.layer);
    const primary = slot.layer === 'usable-lift-agl' ? 'usable-lift-msl' : slot.layer === 'usable-lift-msl' ? 'usable-lift-agl' : siblings[0];
    if (!this.direction && primary) add(primary, slot.frame);
    const step = frames[index + (this.direction ?? 1)] ? this.direction ?? 1 : -(this.direction ?? 1);
    for (const offset of this.direction ? [step, 2 * step, -step] : [step, -step, 2 * step]) add(slot.layer, frames[index + offset]?.id);
    for (const sib of siblings) add(sib, slot.frame);
    return selections;
  }
  private prepareNext(): void {
    if (this.disposed || this.pendingPaint || this.pendingOverview || this.moving || this.map.isMoving?.() || !this.active || !matches(this.active, this.requested) || this.active.build.expiresAtMs <= Date.now()) return;
    if (this.overview?.supported && this.overview.state.ready + this.overview.state.failed < this.overview.state.total) return;
    const candidates = this.predicted(), limit = Math.min(this.slotLimit(this.active), ...candidates.map(v => this.slotLimit(v)));
    if (!limit) { this.enforceBudget(); return; }
    const desired = candidates.slice(0, limit - 1);
    for (const s of [...this.slots]) if (s !== this.active && !desired.some(v => matches(s, v))) this.drop(s);
    for (const next of desired) {
      if (this.warmFailed.some(v => matches(v, next))) continue;
      const slot = this.slots.find(s => matches(s, next));
      if (slot) {
        if (!slot.successful || !this.tilesSettled(slot)) return;
        if (this.problem(slot)) { this.abandon(slot); return; }
        continue;
      }
      this.cancelPrefetch(next);
      try { this.addSlot(next, false); this.armExpiry(); }
      catch { const failed = this.slots.find(s => matches(s, next)); if (failed) this.abandon(failed); else this.warmFailed.push(next); }
      return;
    }
    if (!this.overview?.supported) this.prefetchBytes();
  }
  private timelineFrames(slot: Slot): string[] {
    const frames = renderedFrames(slot.build.manifest), index = frames.findIndex(f => f.id === slot.frame);
    const offset = longitudeOffsetHours(this.map.getCenter().lng) * 60, selectedDay = dayKey(Date.parse(frames[index].validTime), offset);
    const before = frames.slice(0, index).reverse(), after = frames.slice(index + 1);
    return (this.direction === -1 ? [...before, ...after] : [...after, ...before]).filter(f => dayKey(Date.parse(f.validTime), offset) === selectedDay).map(f => f.id);
  }
  private prefetchBytes(): void {
    const slot = this.active;
    if (this.disposed || this.moving || !slot || !matches(slot, this.requested) || !this.protocol || this.prefetched) return;
    const bounds = this.map.getBounds(), z = Math.min(layerMaxZoom(slot.build.manifest, slot.layer), Math.max(0, Math.round(this.map.getZoom()) + 1));
    const tiles = viewportTiles({ west: bounds.getWest(), east: bounds.getEast(), south: bounds.getSouth(), north: bounds.getNorth() }, z);
    const prepared = this.slots.filter(v => v.successful && !this.problem(v) && this.tilesSettled(v));
    const urls = planViewportPrefetch({ build: slot.build, activeLayer: slot.layer, activeFrame: slot.frame, viewportTiles: tiles,
      preferred: this.predicted()[0], direction: this.direction, prepared, timelineFrames: this.timelineFrames(slot) });
    this.prefetched = true;
    for (const url of urls) {
      const ctrl = new AbortController(); this.prefetchJobs.set(url, ctrl);
      void this.protocol.prefetch(url, ctrl.signal).catch(() => {}).finally(() => { if (this.prefetchJobs.get(url) === ctrl) this.prefetchJobs.delete(url); });
    }
  }
}
