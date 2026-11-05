import type { Map, MapSourceDataEvent, ErrorEvent } from 'maplibre-gl';
import { createRasterTileProtocol, layerMaxZoom, planViewportPrefetch, previewRasterLayer, previewRasterSource, type PinnedBuild, type RasterTileProtocol, viewportTiles } from '@av/contracts/client';
import type { LayerId } from '@av/contracts';
import { addProtocol, removeProtocol } from 'maplibre-gl';

interface Selection { build: PinnedBuild; layer: LayerId; frame: string }
interface Slot extends Selection { id: string; successful: boolean; pending: Set<object>; failed: Set<object>; sourceFailed: boolean; ready: boolean }
export interface OverlayState { displayed: Selection | null; requested: Selection | null; error: boolean }

/** Owns two raster slots and one bounded transport for a mounted preview map. */
export class RasterOverlay {
  private protocol: RasterTileProtocol | null = null;
  private active: Slot | null = null;
  private staging: Slot | null = null;
  private requested: Selection | null = null;
  private generation = 0;
  private opacity: number;
  private error = false;
  private moving = false;
  private prefetchAbort: AbortController | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly data = (event: MapSourceDataEvent): void => {
    if (event.sourceId === this.active?.id && event.tile && this.active.failed.delete(event.tile)) { this.error = this.active.sourceFailed || this.active.failed.size > 0; this.emit(); }
    const slot = this.staging;
    if (!slot || event.sourceId !== slot.id) return;
    if (event.tile) { slot.pending.delete(event.tile); slot.successful = true; }
    slot.ready = slot.successful && slot.pending.size === 0 && this.map.isSourceLoaded(slot.id);
  };
  private readonly loading = (event: MapSourceDataEvent): void => {
    if (event.sourceId === this.staging?.id) {
      this.staging.ready = false;
      if (event.tile) this.staging.pending.add(event.tile);
    }
  };
  private readonly abort = (event: MapSourceDataEvent): void => {
    if (event.sourceId === this.staging?.id && event.tile) this.staging.pending.delete(event.tile);
    if (event.sourceId === this.active?.id && event.tile && this.active.failed.delete(event.tile)) { this.error = this.active.sourceFailed || this.active.failed.size > 0; this.emit(); }
  };
  private readonly failed = (event: ErrorEvent & { sourceId?: string; tile?: object }): void => {
    if (!event.sourceId) return;
    if (event.sourceId !== this.staging?.id && event.sourceId !== this.active?.id) return;
    const active = this.active;
    if (active && event.sourceId === active.id) { if (event.tile) active.failed.add(event.tile); else active.sourceFailed = true; }
    this.error = true;
    if (event.sourceId === this.staging?.id) { this.drop(this.staging); this.staging = null; this.cancelPrefetch(); }
    this.emit();
  };
  private readonly render = (): void => {
    this.refresh();
    const next = this.staging;
    if (!next?.ready || this.moving || !this.map.isSourceLoaded(next.id) || next.build.expiresAtMs <= Date.now()) return;
    const previous = this.active;
    this.map.setPaintProperty(next.id, 'raster-opacity', this.opacity);
    this.active = next; this.staging = null; this.error = false;
    this.cancelPrefetch();
    this.drop(previous);
    if (previous && previous.build.manifest.buildId !== next.build.manifest.buildId) this.protocol?.evictBuild(previous.build.manifest.buildId);
    this.armExpiry(); this.emit();
  };
  private readonly move = (): void => {
    this.moving = true;
    this.cancelPrefetch();
    if (this.staging) this.staging.ready = false;
  };
  private readonly settled = (): void => { this.moving = false; if (this.staging) this.staging.ready = this.staging.successful && this.staging.pending.size === 0 && this.map.isSourceLoaded(this.staging.id); };
  private readonly idle = (): void => { this.render(); this.prefetch(); };

  constructor(private readonly map: Map, private readonly baseUrl: string, opacity: number, private readonly onState: (state: OverlayState) => void) {
    this.opacity = opacity;
    map.on('sourcedata', this.data); map.on('sourcedataloading', this.loading);
    map.on('sourcedataabort', this.abort); map.on('error', this.failed);
    map.on('render', this.render); map.on('movestart', this.move); map.on('zoomstart', this.move);
    map.on('moveend', this.settled); map.on('zoomend', this.settled); map.on('idle', this.idle);
  }

  select(build: PinnedBuild, layer: LayerId, frame: string): void {
    if (build.expiresAtMs <= Date.now()) { this.clear(); return; }
    this.requested = { build, layer, frame };
    if (this.active?.build === build && this.active.layer === layer && this.active.frame === frame) {
      this.drop(this.staging); this.staging = null; this.error = this.active.sourceFailed || this.active.failed.size > 0; this.emit(); return;
    }
    if (this.staging?.build === build && this.staging.layer === layer && this.staging.frame === frame) return;
    this.drop(this.staging); this.staging = null;
    this.error = false;
    if (!this.protocol) {
      this.protocol = createRasterTileProtocol(this.baseUrl);
      addProtocol(this.protocol.scheme, this.protocol.load);
    }
    this.protocol.setBuildExpiry(build.manifest.buildId, build.expiresAtMs);
    const id = `av-overlay-${++this.generation}`;
    const next: Slot = { ...this.requested, id, successful: false, pending: new Set(), failed: new Set(), sourceFailed: false, ready: false };
    this.staging = next;
    try {
      const source = previewRasterSource(build.templates[layer], frame, layerMaxZoom(build.manifest, layer), build.manifest.descriptors.attribution);
      source.tiles = source.tiles.map(this.protocol.url);
      this.map.addSource(id, source);
      this.map.addLayer({ ...previewRasterLayer(0), id, source: id, paint: { ...previewRasterLayer(0).paint, 'raster-opacity-transition': { duration: 0, delay: 0 } } });
      this.armExpiry(); this.emit();
    } catch (error) {
      this.drop(next); this.staging = null; this.error = true; this.cancelPrefetch(); this.emit(); throw error;
    }
  }

  refresh(): void {
    let changed = false;
    for (const name of ['active', 'staging'] as const) {
      const slot = this[name];
      if (slot && slot.build.expiresAtMs <= Date.now()) {
        this.drop(slot); this[name] = null; this.protocol?.evictBuild(slot.build.manifest.buildId); changed = true;
      }
    }
    if (changed) { this.cancelPrefetch(); this.armExpiry(); this.emit(); }
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
    for (const id of ids) if (id) this.protocol?.evictBuild(id);
    if (dispose && this.protocol) {
      this.protocol.dispose(); removeProtocol(this.protocol.scheme); this.protocol = null;
    }
    this.error = false; this.emit();
  }

  destroy(): void {
    this.clear(true);
    this.map.off('sourcedata', this.data); this.map.off('sourcedataloading', this.loading);
    this.map.off('sourcedataabort', this.abort); this.map.off('error', this.failed);
    this.map.off('render', this.render); this.map.off('movestart', this.move); this.map.off('zoomstart', this.move);
    this.map.off('moveend', this.settled); this.map.off('zoomend', this.settled); this.map.off('idle', this.idle);
  }

  private cancelPrefetch(): void { this.prefetchAbort?.abort(); this.prefetchAbort = null; }
  private drop(slot: Slot | null): void {
    if (!slot) return;
    if (this.map.getLayer(slot.id)) this.map.removeLayer(slot.id);
    if (this.map.getSource(slot.id)) this.map.removeSource(slot.id);
  }
  private emit(): void { this.onState({ displayed: this.active, requested: this.requested, error: this.error }); }
  private armExpiry(): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    const deadline = Math.min(...[this.active, this.staging].flatMap(slot => slot ? [slot.build.expiresAtMs] : []));
    if (!Number.isFinite(deadline)) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.refresh();
      this.armExpiry(); this.emit();
    }, Math.min(Math.max(0, deadline - Date.now()), 2_147_000_000));
  }
  private prefetch(): void {
    const slot = this.active;
    if (this.moving || this.staging || !slot || !this.protocol || slot.build.expiresAtMs <= Date.now() || this.prefetchAbort) return;
    const bounds = this.map.getBounds(), z = Math.min(layerMaxZoom(slot.build.manifest, slot.layer), Math.max(0, Math.round(this.map.getZoom()) + 1));
    const tiles = viewportTiles({ west: bounds.getWest(), east: bounds.getEast(), south: bounds.getSouth(), north: bounds.getNorth() }, z);
    const urls = planViewportPrefetch({ build: slot.build, activeLayer: slot.layer, activeFrame: slot.frame, viewportTiles: tiles });
    const controller = new AbortController(); this.prefetchAbort = controller;
    for (const url of urls) void this.protocol.prefetch(url, controller.signal).catch(() => {});
  }
}
