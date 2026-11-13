import type { ImageSource, Map } from 'maplibre-gl';
import { clampOpacity, frameTileUrl, layerMaxZoom, previewRasterLayer, type PinnedBuild, type RasterTileSourceProtocol, type RasterTileSourceTransport } from '@av/client';
import type { LayerId } from '@av/contracts/layers';
import { renderedFrames } from '@av/contracts/publication';
import { RASTER_TILE_SIZE } from '@av/contracts/format';

const FRAME_LIMIT = 40;
const PREFILL_BYTES = 1024 * 1024;
const LATITUDE_LIMIT = 85.0511287798066;
interface Window { west: number; east: number; top: number; bottom: number }
interface Tile { x: number; y: number; z: number }
interface Geometry extends Window { tiles: Tile[]; coordinates: [[number, number], [number, number], [number, number], [number, number]] }
interface Context { build: PinnedBuild; layer: LayerId; geometry: Geometry; frames: string[]; bytes: number }
interface Job { context: Context; frame: string; controller: AbortController }
export interface RasterOverviewState { ready: number; total: number; failed: number }

function viewport(map: Map): Window | null {
  const bounds = map.getBounds();
  let west = bounds.getWest(), east = bounds.getEast();
  const north = Math.min(LATITUDE_LIMIT, bounds.getNorth()), south = Math.max(-LATITUDE_LIMIT, bounds.getSouth());
  if (![west, east, north, south].every(Number.isFinite) || north <= south) return null;
  if (east <= west) east += 360;
  if (east <= west) return null;
  const middle = (west + east) / 2, span = Math.min(360, east - west);
  // Shift the entire rectangle together so dateline corners retain their separation.
  const shift = Math.floor((middle + 180) / 360) * 360;
  west = (middle - span / 2 - shift + 180) / 360;
  east = west + span / 360;
  const y = (latitude: number) => Math.max(0, Math.min(1, (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2));
  return { west, east, top: y(north), bottom: y(south) };
}

function geometry(map: Map, maxzoom: number): Geometry | null {
  const window = viewport(map);
  if (!window || window.bottom <= window.top || !Number.isFinite(map.getZoom())) return null;
  let fallback: Geometry | null = null;
  for (let z = Math.max(0, Math.min(maxzoom, Math.floor(map.getZoom()) - 2)); z >= 0; z--) {
    const count = 2 ** z, left = Math.floor(window.west * count), right = Math.ceil(window.east * count) - 1;
    const top = Math.floor(window.top * count), bottom = Math.min(count - 1, Math.ceil(window.bottom * count) - 1);
    if ((right - left + 1) * (bottom - top + 1) > 4) continue;
    const tiles: Tile[] = [];
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) tiles.push({ x, y, z });
    const latitude = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
    const west = window.west * 360 - 180, east = window.east * 360 - 180;
    const candidate: Geometry = { ...window, tiles, coordinates: [[west, latitude(window.top)], [east, latitude(window.top)], [east, latitude(window.bottom)], [west, latitude(window.bottom)]] };
    if (tiles.length <= 2) return candidate;
    // Spend at most one zoom level to fit a single background request batch.
    if (fallback) return fallback;
    fallback = candidate;
  }
  return fallback;
}

/** Resident 256² viewport images for one build/layer; the owner commits visible paint changes. */
export class RasterOverview {
  readonly id = `av-overview-${crypto.randomUUID()}`;
  readonly supported: boolean;
  private readonly canvas: OffscreenCanvas | null;
  private readonly transport: RasterTileSourceTransport | null;
  private context: Context | null = null;
  private selected: string | null = null;
  private shown: string | null = null;
  private readonly images = new globalThis.Map<string, ImageBitmap>();
  private readonly unavailable = new Set<string>();
  private job: Job | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly map: Map, private readonly protocol: RasterTileSourceProtocol, private readonly onReady: () => void) {
    this.canvas = typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function' && typeof map.getCanvas === 'function'
      ? new OffscreenCanvas(RASTER_TILE_SIZE, RASTER_TILE_SIZE) : null;
    this.supported = !!this.canvas?.getContext('2d') && typeof this.canvas.transferToImageBitmap === 'function';
    if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0; }
    this.transport = this.supported ? protocol.createSource(false) : null;
  }

  get state(): RasterOverviewState {
    const frames = this.context?.frames ?? [];
    return { ready: frames.filter(frame => this.images.has(frame)).length, total: frames.length, failed: frames.filter(frame => this.unavailable.has(frame)).length };
  }

  select(build: PinnedBuild, layer: LayerId, frame: string): void {
    if (!this.supported || this.disposed) return;
    if (build.expiresAtMs <= Date.now() || !build.templates[layer] || !renderedFrames(build.manifest).some(value => value.id === frame)) { this.clear(); return; }
    if (this.context?.build !== build || this.context.layer !== layer || !this.covers()) {
      this.clear();
      const area = geometry(this.map, layerMaxZoom(build.manifest, layer));
      if (!area) return;
      this.canvas!.width = RASTER_TILE_SIZE; this.canvas!.height = RASTER_TILE_SIZE;
      this.context = { build, layer, geometry: area, frames: [], bytes: 0 };
      this.protocol.setBuildExpiry(build.manifest.buildId, build.expiresAtMs);
      this.expiry = setTimeout(() => this.refresh(), Math.min(build.expiresAtMs - Date.now(), 2_147_000_000));
    }
    this.selected = frame;
    this.window(); this.unavailable.delete(frame);
    if (this.job && this.job.frame !== frame && !this.images.has(frame)) this.job.controller.abort();
    this.pump();
  }

  ready(build: PinnedBuild, layer: LayerId, frame: string): boolean {
    return !this.disposed && this.context?.build === build && this.context.layer === layer && build.expiresAtMs > Date.now() && this.images.has(frame) && this.covers();
  }

  show(build: PinnedBuild, layer: LayerId, frame: string, opacity: number): boolean {
    if (!this.ready(build, layer, frame)) return false;
    const coordinates = this.context!.geometry.coordinates;
    if (!this.map.getSource(this.id)) {
      this.map.addSource(this.id, { type: 'image', coordinates });
      this.map.addLayer({ ...previewRasterLayer(0), id: this.id, source: this.id, paint: { ...previewRasterLayer(0).paint, 'raster-opacity-transition': { duration: 0, delay: 0 } } });
    }
    if (this.shown !== frame) {
      (this.map.getSource(this.id) as ImageSource).updateImage({ image: this.images.get(frame)!, coordinates });
      this.shown = frame;
    }
    this.map.setPaintProperty(this.id, 'raster-opacity', clampOpacity(opacity));
    return true;
  }

  hide(): void { if (this.map.getLayer(this.id)) this.map.setPaintProperty(this.id, 'raster-opacity', 0); }

  refresh(): void { if (this.context && this.context.build.expiresAtMs <= Date.now()) { this.clear(); this.onReady(); } }

  clear(): void {
    this.job?.controller.abort();
    this.context = null; this.selected = null; this.shown = null;
    if (this.expiry !== null) clearTimeout(this.expiry); this.expiry = null;
    if (this.map.getLayer(this.id)) this.map.removeLayer(this.id);
    if (this.map.getSource(this.id)) this.map.removeSource(this.id);
    for (const image of this.images.values()) image.close();
    this.images.clear(); this.unavailable.clear();
    if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0; }
  }

  destroy(): void { this.disposed = true; this.clear(); this.transport?.dispose(); }

  private covers(): boolean {
    const current = viewport(this.map), area = this.context?.geometry;
    if (!current || !area) return false;
    const shift = Math.round((area.west + area.east - current.west - current.east) / 2), epsilon = 1e-9;
    return current.top >= area.top - epsilon && current.bottom <= area.bottom + epsilon
      && (area.east - area.west >= 1 - epsilon || (current.west + shift >= area.west - epsilon && current.east + shift <= area.east + epsilon));
  }

  private window(): void {
    if (!this.context || !this.selected) return;
    const frames = renderedFrames(this.context.build.manifest).map(frame => frame.id), index = frames.indexOf(this.selected);
    const first = Math.max(0, Math.min(index - Math.floor(FRAME_LIMIT / 2), frames.length - FRAME_LIMIT));
    const retained = frames.slice(first, first + FRAME_LIMIT);
    // Keep ImageSource's current bitmap alive while a distant timeline window warms.
    if (this.shown && !retained.includes(this.shown)) {
      const farthest = retained.reduce((previous, frame) => Math.abs(frames.indexOf(frame) - index) > Math.abs(frames.indexOf(previous) - index) ? frame : previous);
      retained[retained.indexOf(farthest)] = this.shown;
    }
    this.context.frames = retained;
    for (const [frame, image] of this.images) if (!retained.includes(frame)) { image.close(); this.images.delete(frame); }
  }

  private pump(): void {
    const context = this.context;
    if (this.disposed || this.job || !context || context.build.expiresAtMs <= Date.now()) return;
    let changed = false;
    if (context.bytes >= PREFILL_BYTES) {
      for (const frame of context.frames) if (frame !== this.selected && !this.images.has(frame) && !this.unavailable.has(frame)) {
        this.unavailable.add(frame); changed = true;
      }
    }
    const all = renderedFrames(context.build.manifest), selected = all.findIndex(frame => frame.id === this.selected);
    const frame = context.frames.filter(frame => !this.images.has(frame) && !this.unavailable.has(frame))
      .sort((a, b) => Math.abs(all.findIndex(frame => frame.id === a) - selected) - Math.abs(all.findIndex(frame => frame.id === b) - selected))[0];
    if (changed) this.onReady();
    if (!frame || this.context !== context || this.disposed || this.job) return;
    const job: Job = { context, frame, controller: new AbortController() }; this.job = job;
    void this.load(job).then(image => {
      if (!this.current(job) || !context.frames.includes(frame)) { image.close(); return; }
      this.images.set(frame, image); this.onReady();
    }).catch(() => {
      if (this.current(job)) { this.unavailable.add(frame); this.onReady(); }
    }).finally(() => {
      if (this.job === job) this.job = null;
      this.pump();
    });
  }

  private current(job: Job): boolean {
    return !this.disposed && this.context === job.context && !job.controller.signal.aborted && job.context.build.expiresAtMs > Date.now();
  }

  private async load(job: Job): Promise<ImageBitmap> {
    const context = this.canvas!.getContext('2d')!, area = job.context.geometry;
    context.clearRect(0, 0, RASTER_TILE_SIZE, RASTER_TILE_SIZE);
    const template = frameTileUrl(job.context.build.templates[job.context.layer], job.frame);
    for (let offset = 0; offset < area.tiles.length; offset += 2) {
      // Explicit selections retain their four-tile bound after speculative prefill reaches its budget.
      if (job.frame !== this.selected && job.context.bytes >= PREFILL_BYTES) throw new Error('Overview prefill budget reached');
      const results = await Promise.allSettled(area.tiles.slice(offset, offset + 2).map(async tile => {
        const count = 2 ** tile.z, x = ((tile.x % count) + count) % count;
        const url = template.replaceAll('{z}', String(tile.z)).replaceAll('{x}', String(x)).replaceAll('{y}', String(tile.y));
        const response = await this.protocol.load({ url: this.transport!.url(url) }, job.controller);
        if (!this.current(job)) throw new Error('Overview cancelled');
        job.context.bytes += response.data.byteLength;
        const image = await createImageBitmap(new Blob([response.data], { type: 'image/webp' }));
        if (!this.current(job) || image.width !== RASTER_TILE_SIZE || image.height !== RASTER_TILE_SIZE) { image.close(); throw new Error('Invalid overview tile'); }
        return { tile, image };
      }));
      try {
        if (!this.current(job) || results.some(result => result.status === 'rejected')) throw new Error('Incomplete overview');
        for (const result of results) if (result.status === 'fulfilled') {
          const { tile, image } = result.value, count = 2 ** tile.z;
          const width = RASTER_TILE_SIZE / (area.east - area.west), height = RASTER_TILE_SIZE / (area.bottom - area.top);
          context.drawImage(image, (tile.x / count - area.west) * width, (tile.y / count - area.top) * height, width / count, height / count);
        }
      } finally {
        for (const result of results) if (result.status === 'fulfilled') result.value.image.close();
      }
    }
    if (!this.current(job)) throw new Error('Overview cancelled');
    return this.canvas!.transferToImageBitmap();
  }
}
