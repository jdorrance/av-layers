import { STATUS_MASK, STATUS_VALID } from '@av/contracts/layers';
import type { Map } from 'maplibre-gl';
import { displayedBarbSpeed, quantizedBarbSpeed } from '@av/windgram';
import { WIND_CANVAS_BYTES } from './raster-budget';

export interface WindField {
  sample(lat: number, lon: number): { u: number | null; v: number | null; status: number };
}

export interface WindOverlayOptions {
  style: 'trails' | 'barbs' | 'hybrid';
  visible: boolean;
  paused: boolean;
  units: 'metric' | 'imperial';
}

interface Particle { lat: number; lon: number; age: number; wind?: ReturnType<WindField['sample']> }
const MAX_PIXELS = Math.floor(WIND_CANVAS_BYTES / 4);
const MAX_PARTICLES = 600;
const EARTH_RADIUS = 6_371_000;
const MAX_LAT = 85.05112878;

function valid(sample: ReturnType<WindField['sample']>): sample is { u: number; v: number; status: number } {
  return (sample.status & STATUS_MASK) === STATUS_VALID && sample.u !== null && sample.v !== null && Number.isFinite(sample.u) && Number.isFinite(sample.v);
}

function worldY(lat: number, size: number): number {
  const radians = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI / 180;
  return (1 - Math.asinh(Math.tan(radians)) / Math.PI) * size / 2;
}

function latitude(y: number, size: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) * 180 / Math.PI;
}

export class WindOverlay {
  private readonly trails = document.createElement('canvas');
  private readonly barbs = document.createElement('canvas');
  private readonly trailContext: CanvasRenderingContext2D;
  private readonly barbContext: CanvasRenderingContext2D;
  private field: WindField | null = null;
  private options: WindOverlayOptions = { style: 'trails', visible: true, paused: false, units: 'metric' };
  private particles: Particle[] = [];
  private frame: number | null = null;
  private lastTime = 0;
  private barbsDirty = false;
  private width = 0;
  private height = 0;
  private scale = 1;
  private barbScale = 1;
  private mapLost = false;
  private readonly lostCanvases = new Set<HTMLCanvasElement>();
  private destroyed = false;
  private barbSamples = new globalThis.Map<string, ReturnType<WindField['sample']>>();
  private barbZoom = NaN;
  private view: { x: number; y: number; zoom: number; bearing: number; pitch: number } | null = null;

  private readonly move = (): void => {
    const point = this.map.project([0, 0]);
    const view = { x: point.x, y: point.y, zoom: this.map.getZoom(), bearing: this.map.getBearing(), pitch: this.map.getPitch() };
    const previous = this.view;
    this.view = view;
    if (!previous || previous.zoom !== view.zoom || previous.bearing !== view.bearing || previous.pitch !== view.pitch || view.pitch !== 0) this.resetTrails();
    else if (view.x !== previous.x || view.y !== previous.y) {
      const ctx = this.trailContext;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(this.trails, (view.x - previous.x) * this.scale, (view.y - previous.y) * this.scale);
      ctx.globalCompositeOperation = 'source-over';
    }
    this.barbsDirty = this.options.style !== 'trails';
    this.schedule();
  };
  private readonly resize = (): void => {
    const canvas = this.map.getCanvas();
    this.width = canvas.clientWidth;
    this.height = canvas.clientHeight;
    const width = Math.max(1, this.width), height = Math.max(1, this.height);
    const showBarbs = this.options.visible && this.options.style !== 'trails';
    const showTrails = this.options.visible && this.options.style !== 'barbs';
    const barbPixels = showTrails ? MAX_PIXELS * 0.8 : MAX_PIXELS - 1;
    const barbScale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(barbPixels / (width * height)), 4096 / width, 4096 / height);
    this.barbScale = barbScale >= 1 ? Math.floor(barbScale) : barbScale;
    const remaining = MAX_PIXELS - (showBarbs ? Math.floor(width * this.barbScale) * Math.floor(height * this.barbScale) : 1);
    this.scale = Math.min(window.devicePixelRatio || 1, 1, Math.sqrt(remaining / (width * height)), 4096 / width, 4096 / height);
    for (const canvas of [this.trails, this.barbs]) {
      canvas.width = 0;
      canvas.height = 0;
    }
    for (const canvas of [this.trails, this.barbs]) {
      const visible = canvas === this.barbs ? showBarbs : showTrails;
      const scale = canvas === this.barbs ? this.barbScale : this.scale;
      canvas.width = visible ? Math.max(1, Math.floor(width * scale)) : 1;
      canvas.height = visible ? Math.max(1, Math.floor(height * scale)) : 1;
      canvas.style.width = `${this.width}px`;
      canvas.style.height = `${this.height}px`;
      canvas.style.display = visible ? '' : 'none';
    }
    this.resetTrails();
    const point = this.map.project([0, 0]);
    this.view = { x: point.x, y: point.y, zoom: this.map.getZoom(), bearing: this.map.getBearing(), pitch: this.map.getPitch() };
    this.drawBarbs();
    this.schedule();
  };
  private readonly visibility = (): void => { this.lastTime = 0; this.schedule(); };
  private readonly mapContextLost = (): void => { this.mapLost = true; this.resetTrails(); this.drawBarbs(); this.schedule(); };
  private readonly mapContextRestored = (): void => { this.mapLost = false; this.resetTrails(); this.drawBarbs(); this.schedule(); };
  private readonly contextLost = (event: Event): void => {
    this.lostCanvases.add(event.currentTarget as HTMLCanvasElement);
    this.resetTrails(); this.drawBarbs(); this.schedule();
  };
  private readonly contextRestored = (event: Event): void => {
    this.lostCanvases.delete(event.currentTarget as HTMLCanvasElement);
    this.resetTrails(); this.drawBarbs(); this.schedule();
  };

  constructor(private readonly map: Map) {
    const trailContext = this.trails.getContext('2d'), barbContext = this.barbs.getContext('2d');
    if (!trailContext || !barbContext) throw new Error('Canvas 2D is unavailable');
    this.trailContext = trailContext; this.barbContext = barbContext;
    for (const canvas of [this.trails, this.barbs]) {
      Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
      canvas.setAttribute('aria-hidden', 'true');
      canvas.addEventListener('contextlost', this.contextLost);
      canvas.addEventListener('contextrestored', this.contextRestored);
      map.getCanvasContainer().appendChild(canvas);
    }
    map.on('move', this.move); map.on('resize', this.resize);
    map.on('webglcontextlost', this.mapContextLost); map.on('webglcontextrestored', this.mapContextRestored);
    document.addEventListener('visibilitychange', this.visibility);
    this.resize();
  }

  setField(field: WindField | null): void {
    if (this.destroyed || this.field === field) return;
    this.field = field;
    this.barbSamples.clear();
    this.resetTrails(); this.drawBarbs(); this.schedule();
  }

  setOptions(options: Partial<WindOverlayOptions>): void {
    if (this.destroyed) return;
    const previous = this.options;
    this.options = { ...previous, ...options };
    if (previous.style !== this.options.style || previous.visible !== this.options.visible) {
      this.resize();
      return;
    }
    if (previous.paused !== this.options.paused) this.lastTime = 0;
    if (previous.units !== this.options.units) this.drawBarbs();
    this.schedule();
  }

  clear(): void { this.setField(null); }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.schedule();
    this.map.off('move', this.move); this.map.off('resize', this.resize);
    this.map.off('webglcontextlost', this.mapContextLost); this.map.off('webglcontextrestored', this.mapContextRestored);
    document.removeEventListener('visibilitychange', this.visibility);
    for (const canvas of [this.trails, this.barbs]) {
      canvas.removeEventListener('contextlost', this.contextLost);
      canvas.removeEventListener('contextrestored', this.contextRestored);
      canvas.remove();
    }
    this.field = null; this.particles = []; this.barbSamples.clear();
  }

  private resetTrails(): void {
    this.particles = []; this.lastTime = 0;
    this.trailContext.setTransform(1, 0, 0, 1, 0, 0);
    this.trailContext.clearRect(0, 0, this.trails.width, this.trails.height);
  }

  private schedule(): void {
    const running = !this.destroyed && !document.hidden && !this.mapLost && !this.lostCanvases.size && this.field && this.options.visible && (this.barbsDirty || !this.options.paused && this.options.style !== 'barbs') && this.width > 0 && this.height > 0;
    if (!running && this.frame !== null) { cancelAnimationFrame(this.frame); this.frame = null; }
    if (running && this.frame === null) this.frame = requestAnimationFrame(this.animate);
  }

  private readonly animate = (time: number): void => {
    this.frame = null;
    if (!this.field || this.destroyed) return;
    if (this.barbsDirty) this.drawBarbs();
    if (this.options.paused || this.options.style === 'barbs') { this.lastTime = 0; this.schedule(); return; }
    const elapsed = this.lastTime ? Math.min((time - this.lastTime) / 1000, 0.1) : 0;
    this.lastTime = time;
    if (elapsed > 0) this.advance(elapsed);
    this.schedule();
  };

  private advance(elapsed: number): void {
    const ctx = this.trailContext, field = this.field!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = `rgba(0,0,0,${1 - Math.exp(-elapsed * 1.5)})`;
    ctx.fillRect(0, 0, this.trails.width, this.trails.height);
    ctx.globalCompositeOperation = 'source-over'; ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1; ctx.lineCap = 'round'; ctx.beginPath();
    const count = Math.min(MAX_PARTICLES, Math.ceil(this.width * this.height / 3000));
    while (this.particles.length < count) {
      const location = this.map.unproject([Math.random() * this.width, Math.random() * this.height]);
      this.particles.push({ lat: location.lat, lon: location.lng, age: Math.random() * 3 });
    }
    for (const particle of this.particles) {
      const wind = particle.wind ?? field.sample(particle.lat, particle.lon);
      if (!valid(wind) || particle.age <= 0 || Math.abs(particle.lat) >= MAX_LAT) { particle.age = 0; continue; }
      const start = this.map.project([particle.lon, particle.lat]);
      // Keep illustrative advection readable as Mercator magnification changes.
      const seconds = elapsed * 600 * 2 ** (9 - this.map.getZoom()) * Math.cos(particle.lat * Math.PI / 180);
      const lat = particle.lat + wind.v * seconds / EARTH_RADIUS * 180 / Math.PI;
      const lon = particle.lon + wind.u * seconds / (EARTH_RADIUS * Math.cos(particle.lat * Math.PI / 180)) * 180 / Math.PI;
      if (Math.abs(lat) >= MAX_LAT) { particle.age = 0; continue; }
      const end = this.map.project([lon, lat]);
      const distance = Math.hypot(end.x - start.x, end.y - start.y);
      if (!Number.isFinite(distance) || end.x < 0 || end.y < 0 || end.x > this.width || end.y > this.height || distance > 30) { particle.age = 0; continue; }
      // Check every rendered pixel, including the destination, before painting across a mask.
      const steps = Math.max(1, Math.ceil(distance));
      for (let step = 1; step <= steps; step++) {
        particle.wind = field.sample(particle.lat + (lat - particle.lat) * step / steps, particle.lon + (lon - particle.lon) * step / steps);
        if (!valid(particle.wind)) { particle.age = 0; break; }
      }
      if (particle.age <= 0) continue;
      ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y);
      particle.lat = lat; particle.lon = lon; particle.age -= elapsed;
    }
    ctx.stroke();
    this.particles = this.particles.filter(particle => particle.age > 0);
  }

  private drawBarbs(): void {
    this.barbsDirty = false;
    const ctx = this.barbContext;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.barbs.width, this.barbs.height);
    if (!this.field || !this.options.visible || this.options.style === 'trails' || this.mapLost || this.lostCanvases.size || !this.width || !this.height) return;
    const bounds = this.map.getBounds(), size = 512 * 2 ** this.map.getZoom();
    if (this.barbZoom !== this.map.getZoom()) { this.barbSamples.clear(); this.barbZoom = this.map.getZoom(); }
    const samples = new globalThis.Map<string, ReturnType<WindField['sample']>>();
    const step = this.options.style === 'hybrid' ? 64 : 32;
    const west = (bounds.getWest() + 180) / 360 * size, east = (bounds.getEast() + 180) / 360 * size;
    const north = worldY(bounds.getNorth(), size), south = worldY(bounds.getSouth(), size);
    const x0 = Math.ceil((west - 16) / step), x1 = Math.floor((east - 16) / step);
    const y0 = Math.max(0, Math.ceil((north - 16) / step)), y1 = Math.min(Math.floor(size / step), Math.floor((south - 16) / step));
    const stride = Math.max(1, Math.ceil(Math.sqrt(Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1) / 5000)));
    ctx.setTransform(this.barbScale, 0, 0, this.barbScale, 0, 0);
    ctx.strokeStyle = '#111'; ctx.fillStyle = '#111'; ctx.lineWidth = 0.75; ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    ctx.font = '9px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let y = Math.ceil(y0 / stride) * stride; y <= y1; y += stride) for (let x = Math.ceil(x0 / stride) * stride; x <= x1; x += stride) {
      const lon = (x * step + 16) / size * 360 - 180, lat = latitude(y * step + 16, size);
      const point = this.map.project([lon, lat]);
      if (point.x < -24 || point.y < -24 || point.x > this.width + 24 || point.y > this.height + 24) continue;
      const key = `${x * step},${y * step}`;
      const wind = this.barbSamples.get(key) ?? this.field.sample(lat, lon);
      samples.set(key, wind);
      if (!valid(wind)) continue;
      const speed = displayedBarbSpeed(Math.hypot(wind.u, wind.v), this.options.units);
      if (speed === null) continue;
      if (!speed) { ctx.beginPath(); ctx.arc(point.x, point.y, 2.5, 0, Math.PI * 2); ctx.stroke(); continue; }
      const distance = Math.hypot(wind.u, wind.v);
      const ahead = this.map.project([lon + wind.u / distance * 0.001 / Math.cos(lat * Math.PI / 180), lat + wind.v / distance * 0.001]);
      const angle = Math.atan2(ahead.y - point.y, ahead.x - point.x);
      ctx.save(); ctx.translate(point.x, point.y); ctx.rotate(angle);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-21, 0);
      ctx.stroke();
      const quantized = quantizedBarbSpeed(speed);
      const flags = Math.min(16, Math.floor(quantized / 50)), feathers = Math.floor((quantized % 50) / 10), half = quantized % 10 >= 5;
      const spacing = Math.min(4, 20 / Math.max(1, flags * 2 + feathers + Number(half)));
      let d = -21;
      for (let i = 0; i < flags; i++) {
        ctx.beginPath(); ctx.moveTo(d, 0); ctx.lineTo(d, -6); ctx.lineTo(d + spacing * 2, 0); ctx.closePath(); ctx.fill();
        d += spacing * 2;
      }
      ctx.beginPath();
      for (let i = 0; i < feathers; i++) { ctx.moveTo(d, 0); ctx.lineTo(d - 3, -6); d += spacing; }
      if (half) { ctx.moveTo(d, 0); ctx.lineTo(d - 1.5, -3); }
      ctx.stroke(); ctx.restore();
      this.label(String(speed), point.x, point.y + 6);
    }
    this.barbSamples = samples;
  }

  private label(text: string, x: number, y: number): void {
    const ctx = this.barbContext;
    x = Math.round(x * this.barbScale) / this.barbScale;
    y = Math.round(y * this.barbScale) / this.barbScale;
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y); ctx.restore(); ctx.fillText(text, x, y);
  }
}
