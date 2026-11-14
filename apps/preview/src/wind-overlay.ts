import { STATUS_MASK, STATUS_VALID } from '@av/contracts/layers';
import { DISPLAY_KNOTS_PER_MPS, displayedWindSpeed, quantizedBarbSpeed, type WindSpeedSystem } from '@av/contracts/units';
import type { Map } from 'maplibre-gl';
import { WIND_CANVAS_PIXELS, WIND_TRAIL_PIXELS } from './raster-budget';

export interface WindField { sample(lat: number, lon: number): { u: number | null; v: number | null; status: number } }
export interface WindOverlayOptions { style: 'trails' | 'barbs' | 'hybrid'; visible: boolean; paused: boolean; units: WindSpeedSystem }
interface Particle { lat: number; lon: number; age: number; wind?: ReturnType<WindField['sample']> }

const MAX_PARTICLES = 600, EARTH_RADIUS = 6_371_000, MAX_LAT = 85.05112878, DEG = Math.PI / 180;
const valid = (s: ReturnType<WindField['sample']>): s is { u: number; v: number; status: number } =>
  (s.status & STATUS_MASK) === STATUS_VALID && s.u !== null && s.v !== null && Number.isFinite(s.u) && Number.isFinite(s.v);
const worldY = (lat: number, size: number) => (1 - Math.asinh(Math.tan(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * DEG)) / Math.PI) * size / 2;
const latitude = (y: number, size: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) / DEG;

export class WindOverlay {
  private readonly trails = document.createElement('canvas');
  private readonly barbs = document.createElement('canvas');
  private readonly trailCtx: CanvasRenderingContext2D;
  private readonly barbCtx: CanvasRenderingContext2D;
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
  private lastDpr = 0;
  private panX = 0;
  private panY = 0;
  private mapLost = false;
  private readonly lostCanvases = new Set<HTMLCanvasElement>();
  private destroyed = false;
  private barbSamples = new globalThis.Map<string, ReturnType<WindField['sample']>>();
  private barbZoom = NaN;
  private view: { x: number; y: number; zoom: number; bearing: number; pitch: number } | null = null;

  private readonly currentView = () => {
    const p = this.map.project([0, 0]);
    return { x: p.x, y: p.y, zoom: this.map.getZoom(), bearing: this.map.getBearing(), pitch: this.map.getPitch() };
  };

  private readonly move = (): void => {
    if ((window.devicePixelRatio || 1) !== this.lastDpr) { this.resize(); return; }
    const view = this.currentView(), prev = this.view;
    this.view = view;
    if (!prev || prev.zoom !== view.zoom || prev.bearing !== view.bearing || prev.pitch !== view.pitch || view.pitch !== 0) this.resetTrails();
    else if (view.x !== prev.x || view.y !== prev.y) {
      this.panX += (view.x - prev.x) * this.scale; this.panY += (view.y - prev.y) * this.scale;
      const dx = Math.trunc(this.panX), dy = Math.trunc(this.panY);
      if (dx || dy) {
        this.panX -= dx; this.panY -= dy;
        this.trailCtx.setTransform(1, 0, 0, 1, 0, 0);
        this.trailCtx.globalCompositeOperation = 'copy';
        this.trailCtx.drawImage(this.trails, dx, dy);
        this.trailCtx.globalCompositeOperation = 'source-over';
      }
    }
    this.barbsDirty = this.options.style !== 'trails';
    this.schedule();
  };

  private readonly resize = (): void => {
    const canvas = this.map.getCanvas();
    this.width = canvas.clientWidth; this.height = canvas.clientHeight;
    const w = Math.max(1, this.width), h = Math.max(1, this.height), dpr = window.devicePixelRatio || 1;
    this.lastDpr = dpr;
    const showBarbs = this.options.visible && this.options.style !== 'trails', showTrails = this.options.visible && this.options.style !== 'barbs';
    this.scale = showTrails ? Math.min(dpr, 1, Math.sqrt((WIND_TRAIL_PIXELS - 1) / (w * h)), 4096 / w, 4096 / h) : 1;
    const trailW = showTrails ? Math.max(1, Math.floor(w * this.scale)) : 1, trailH = showTrails ? Math.max(1, Math.floor(h * this.scale)) : 1;
    const barbBudget = Math.max(1, WIND_CANVAS_PIXELS - trailW * trailH);
    const bScale = showBarbs ? Math.min(dpr, 2, Math.sqrt(barbBudget / (w * h)), 4096 / w, 4096 / h) : 1;
    this.barbScale = bScale >= 1 ? Math.floor(bScale) : bScale;
    const barbW = showBarbs ? Math.max(1, Math.floor(w * this.barbScale)) : 1, barbH = showBarbs ? Math.max(1, Math.floor(h * this.barbScale)) : 1;
    for (const c of [this.trails, this.barbs]) { c.width = 0; c.height = 0; }
    for (const [c, vis, cw, ch] of [[this.trails, showTrails, trailW, trailH], [this.barbs, showBarbs, barbW, barbH]] as const) {
      c.width = cw; c.height = ch;
      c.style.width = `${this.width}px`; c.style.height = `${this.height}px`; c.style.display = vis ? '' : 'none';
    }
    this.resetTrails(); this.view = this.currentView(); this.drawBarbs(); this.schedule();
  };

  private readonly visibility = (): void => { this.lastTime = 0; this.schedule(); };
  private readonly syncContext = (): void => { this.resetTrails(); this.drawBarbs(); this.schedule(); };
  private readonly mapContextLost = (): void => { this.mapLost = true; this.syncContext(); };
  private readonly mapContextRestored = (): void => { this.mapLost = false; this.syncContext(); };
  private readonly contextLost = (e: Event): void => { this.lostCanvases.add(e.currentTarget as HTMLCanvasElement); this.syncContext(); };
  private readonly contextRestored = (e: Event): void => { this.lostCanvases.delete(e.currentTarget as HTMLCanvasElement); this.syncContext(); };

  constructor(private readonly map: Map) {
    const trailCtx = this.trails.getContext('2d'), barbCtx = this.barbs.getContext('2d');
    if (!trailCtx || !barbCtx) throw new Error('Canvas 2D is unavailable');
    this.trailCtx = trailCtx; this.barbCtx = barbCtx;
    for (const c of [this.trails, this.barbs]) {
      Object.assign(c.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
      c.setAttribute('aria-hidden', 'true');
      c.addEventListener('contextlost', this.contextLost); c.addEventListener('contextrestored', this.contextRestored);
      map.getCanvasContainer().appendChild(c);
    }
    map.on('move', this.move); map.on('resize', this.resize);
    map.on('webglcontextlost', this.mapContextLost); map.on('webglcontextrestored', this.mapContextRestored);
    document.addEventListener('visibilitychange', this.visibility);
    this.resize();
  }

  setField(field: WindField | null): void {
    if (this.destroyed || this.field === field) return;
    this.field = field; this.barbSamples.clear(); this.resetTrails(); this.drawBarbs(); this.schedule();
  }

  setOptions(options: Partial<WindOverlayOptions>): void {
    if (this.destroyed) return;
    const prev = this.options; this.options = { ...prev, ...options };
    if (prev.style !== this.options.style || prev.visible !== this.options.visible) { this.resize(); return; }
    if (prev.paused !== this.options.paused) this.lastTime = 0;
    if (prev.units !== this.options.units) this.drawBarbs();
    this.schedule();
  }

  clear(): void { this.setField(null); }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.schedule();
    this.map.off('move', this.move); this.map.off('resize', this.resize);
    this.map.off('webglcontextlost', this.mapContextLost); this.map.off('webglcontextrestored', this.mapContextRestored);
    document.removeEventListener('visibilitychange', this.visibility);
    for (const c of [this.trails, this.barbs]) { c.removeEventListener('contextlost', this.contextLost); c.removeEventListener('contextrestored', this.contextRestored); c.remove(); }
    this.field = null; this.particles = []; this.barbSamples.clear();
  }

  private resetTrails(): void {
    this.particles.length = 0; this.lastTime = this.panX = this.panY = 0;
    this.trailCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.trailCtx.clearRect(0, 0, this.trails.width, this.trails.height);
  }

  private schedule(): void {
    const running = !this.destroyed && !document.hidden && !this.mapLost && !this.lostCanvases.size && this.field && this.options.visible && (this.barbsDirty || (!this.options.paused && this.options.style !== 'barbs')) && this.width > 0 && this.height > 0;
    if (!running && this.frame !== null) { cancelAnimationFrame(this.frame); this.frame = null; }
    if (running && this.frame === null) this.frame = requestAnimationFrame(this.animate);
  }

  private readonly animate = (time: number): void => {
    this.frame = null;
    if (!this.field || this.destroyed) return;
    if (this.barbsDirty) this.drawBarbs();
    if (this.options.paused || this.options.style === 'barbs') { this.lastTime = 0; this.schedule(); return; }
    if (this.lastTime && time - this.lastTime < 15) { this.schedule(); return; }
    const elapsed = this.lastTime ? Math.min((time - this.lastTime) / 1000, 0.1) : 0;
    this.lastTime = time;
    if (elapsed > 0) this.advance(elapsed);
    this.schedule();
  };

  private advance(elapsed: number): void {
    const ctx = this.trailCtx, field = this.field!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = `rgba(0,0,0,${1 - Math.exp(-elapsed * 0.9)})`;
    ctx.fillRect(0, 0, this.trails.width, this.trails.height);
    ctx.globalCompositeOperation = 'source-over'; ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 1.45; ctx.lineCap = 'round'; ctx.beginPath();
    const count = Math.min(MAX_PARTICLES, Math.ceil(this.width * this.height / 3000));
    while (this.particles.length < count) {
      const loc = this.map.unproject([Math.random() * this.width, Math.random() * this.height]);
      this.particles.push({ lat: loc.lat, lon: loc.lng, age: 1.5 + Math.random() * 2.5 });
    }
    const zoomScale = elapsed * 600 * 2 ** (9 - this.map.getZoom());
    let write = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]!, wind = p.wind ?? field.sample(p.lat, p.lon);
      if (!valid(wind) || p.age <= 0 || Math.abs(p.lat) >= MAX_LAT) continue;
      const speed = Math.hypot(wind.u, wind.v), boost = speed > 0 && speed < 4 ? Math.sqrt(4 / speed) : 1;
      const start = this.map.project([p.lon, p.lat]), cosLat = Math.cos(p.lat * DEG), sec = zoomScale * cosLat * boost;
      const lat = p.lat + wind.v * sec / EARTH_RADIUS / DEG, lon = p.lon + wind.u * sec / (EARTH_RADIUS * cosLat) / DEG;
      if (Math.abs(lat) >= MAX_LAT) continue;
      const end = this.map.project([lon, lat]), dist = Math.hypot(end.x - start.x, end.y - start.y);
      if (!Number.isFinite(dist) || end.x < 0 || end.y < 0 || end.x > this.width || end.y > this.height || dist > 30) continue;
      const steps = Math.max(1, Math.ceil(dist));
      let nextWind: ReturnType<WindField['sample']> = wind, blocked = false;
      for (let s = 1; s <= steps; s++) {
        nextWind = field.sample(p.lat + (lat - p.lat) * s / steps, p.lon + (lon - p.lon) * s / steps);
        if (!valid(nextWind)) { blocked = true; break; }
      }
      if (blocked) continue;
      ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y);
      p.lat = lat; p.lon = lon; p.age -= elapsed; p.wind = { status: nextWind.status, u: nextWind.u, v: nextWind.v };
      if (p.age > 0) this.particles[write++] = p;
    }
    ctx.stroke(); this.particles.length = write;
  }

  private haloStroke(ctx: CanvasRenderingContext2D): void {
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.82)'; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.stroke(); ctx.restore();
    ctx.stroke();
  }

  private drawBarbs(): void {
    this.barbsDirty = false;
    const ctx = this.barbCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.barbs.width, this.barbs.height);
    if (!this.field || !this.options.visible || this.options.style === 'trails' || this.mapLost || this.lostCanvases.size || !this.width || !this.height) return;
    const bounds = this.map.getBounds(), zoom = this.map.getZoom(), size = 512 * 2 ** zoom;
    if (this.barbZoom !== zoom) { this.barbSamples.clear(); this.barbZoom = zoom; }
    const samples = new globalThis.Map<string, ReturnType<WindField['sample']>>(), step = this.options.style === 'hybrid' ? 64 : 32;
    const x0 = Math.ceil(((bounds.getWest() + 180) / 360 * size - 16) / step), x1 = Math.floor(((bounds.getEast() + 180) / 360 * size - 16) / step);
    const y0 = Math.max(0, Math.ceil((worldY(bounds.getNorth(), size) - 16) / step)), y1 = Math.min(Math.floor(size / step), Math.floor((worldY(bounds.getSouth(), size) - 16) / step));
    const stride = Math.max(1, Math.ceil(Math.sqrt(Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1) / 5000)));
    ctx.setTransform(this.barbScale, 0, 0, this.barbScale, 0, 0);
    ctx.strokeStyle = '#111'; ctx.fillStyle = '#0f172a'; ctx.lineWidth = 0.9; ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let y = Math.ceil(y0 / stride) * stride; y <= y1; y += stride) for (let x = Math.ceil(x0 / stride) * stride; x <= x1; x += stride) {
      const lon = (x * step + 16) / size * 360 - 180, lat = latitude(y * step + 16, size), pt = this.map.project([lon, lat]);
      if (pt.x < -24 || pt.y < -24 || pt.x > this.width + 24 || pt.y > this.height + 24) continue;
      const key = `${x * step},${y * step}`;
      let wind = this.barbSamples.get(key);
      if (!wind) { const s = this.field.sample(lat, lon); wind = { status: s.status, u: s.u, v: s.v }; }
      samples.set(key, wind);
      if (!valid(wind)) continue;
      const dist = Math.hypot(wind.u, wind.v), speedKt = dist * DISPLAY_KNOTS_PER_MPS, speed = displayedWindSpeed(dist, this.options.units);
      if (!Number.isFinite(speedKt) || speed === null) continue;
      const q = quantizedBarbSpeed(speedKt);
      if (!q) { ctx.beginPath(); ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2); this.haloStroke(ctx); continue; }
      const ahead = this.map.project([lon + wind.u / dist * 0.001 / Math.cos(lat * DEG), lat + wind.v / dist * 0.001]), hemi = lat < 0 ? 1 : -1;
      ctx.save(); ctx.translate(pt.x, pt.y); ctx.rotate(Math.atan2(ahead.y - pt.y, ahead.x - pt.x));
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-21, 0); this.haloStroke(ctx);
      const flags = Math.min(16, Math.floor(q / 50)), feathers = Math.floor((q % 50) / 10), half = q % 10 >= 5;
      const spacing = Math.min(4, 20 / Math.max(1, flags * 2 + feathers + Number(half)));
      let d = -21;
      for (let i = 0; i < flags; i++) {
        ctx.beginPath(); ctx.moveTo(d, 0); ctx.lineTo(d, 6 * hemi); ctx.lineTo(d + spacing * 2, 0); ctx.closePath();
        ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.82)'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke(); ctx.restore();
        ctx.fill(); d += spacing * 2;
      }
      ctx.beginPath();
      for (let i = 0; i < feathers; i++) { ctx.moveTo(d, 0); ctx.lineTo(d - 3, 6 * hemi); d += spacing; }
      if (half) { ctx.moveTo(d, 0); ctx.lineTo(d - 1.5, 3 * hemi); }
      this.haloStroke(ctx); ctx.restore();
      const lx = Math.round(pt.x * this.barbScale) / this.barbScale, ly = Math.round((pt.y + 3) * this.barbScale) / this.barbScale;
      ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.94)'; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.miterLimit = 2;
      ctx.strokeText(String(speed), lx, ly); ctx.restore(); ctx.fillText(String(speed), lx, ly);
    }
    this.barbSamples = samples;
  }
}
