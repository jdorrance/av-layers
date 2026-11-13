import { Map as PreviewMap, type MapOptions } from 'maplibre-gl';
import { recognizeViewport, TILE_SIZE, type BenchLayer, type PixelProbe } from '../../scripts/preview-pixels';
export * from 'maplibre-gl';

interface TextureMemory { bytes: number; peakBytes: number; rasterBytes: number; peakRasterBytes: number; textures: number; peakTextures: number }
interface InputSample { index: number; layer: BenchLayer; inputAt: number; inputEpochMs: number; firstCorrectMs: number | null; detailedMs: number | null; renders: number; pixels?: number[][]; sources: number }
export interface PreviewBench {
  ready: Promise<void>;
  select(index: number): Promise<InputSample>;
  layer(reference: BenchLayer): Promise<InputSample>;
  drag(indices: number[], intervalMs: number): Promise<{ samples: InputSample[]; staleFramePaints: number; lastTarget: InputSample }>;
  settled(): boolean;
  snapshot(): { sources: number; peakSources: number; renderer: string; frames: string[]; memory: TextureMemory; decoded: ReturnType<typeof decodedMemory.snapshot>; initialFirstCorrectMs: number | null; initialDetailedMs: number | null; overviewReady: number; overviewTotal: number; viewportQuality: 'overview' | 'detail' | null; selectedIndex: number; displayedIndex: number; width: number; height: number };
  pan(longitude: number): void;
  resetPeaks(): void;
}
declare global { interface Window { bench: PreviewBench } }

type GL = WebGLRenderingContext | WebGL2RenderingContext;
interface Level { width: number; height: number; bytes: number; bytesPerPixel: number }
interface Allocation { levels: globalThis.Map<number, Level> }

// Count requested texture storage, including textures retained by MapLibre's pool.
function textureAccounting(): { snapshot(): TextureMemory; resetPeaks(): void } {
  const allocations = new globalThis.Map<WebGLTexture, Allocation>();
  const states = new WeakMap<GL, { unit: number; bound: globalThis.Map<string, WebGLTexture | null> }>();
  let peakBytes = 0, peakRasterBytes = 0, peakTextures = 0;
  const totals = () => {
    let bytes = 0, rasterBytes = 0;
    for (const allocation of allocations.values()) {
      const size = [...allocation.levels.values()].reduce((sum, level) => sum + level.bytes, 0);
      bytes += size;
      const base = allocation.levels.get(0);
      if (base?.width === 256 && base.height === 256 && base.bytesPerPixel === 4) rasterBytes += size;
    }
    return { bytes, rasterBytes, textures: allocations.size };
  };
  function changed() { const now = totals(); peakBytes = Math.max(peakBytes, now.bytes); peakRasterBytes = Math.max(peakRasterBytes, now.rasterBytes); peakTextures = Math.max(peakTextures, now.textures); }
  function state(gl: GL) {
    let value = states.get(gl);
    if (!value) { value = { unit: gl.TEXTURE0, bound: new globalThis.Map() }; states.set(gl, value); }
    return value;
  }
  function allocation(gl: GL, target: number): Allocation | undefined {
    const current = state(gl), texture = current.bound.get(`${current.unit}/${target}`);
    return texture ? allocations.get(texture) : undefined;
  }
  const pixelBytes = (format: number) => ({ 6406: 1, 6407: 3, 6408: 4, 6409: 1, 6410: 2, 33321: 1, 33323: 2, 32849: 3, 32856: 4, 35907: 4, 33325: 2, 33327: 4, 34842: 8, 34836: 16 }[format] ?? 4);
  function level(value: Allocation | undefined, index: number, width: number, height: number, bytesPerPixel: number) {
    if (!value) return;
    value.levels.set(index, { width, height, bytesPerPixel, bytes: width * height * bytesPerPixel }); changed();
  }
  function wrap(prototype: object, name: string, after: (gl: GL, args: unknown[], result: unknown) => void) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor || typeof descriptor.value !== 'function') return;
    const original = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(prototype, name, { ...descriptor, value: function (this: GL, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args); after(this, args, result); return result;
    } });
  }
  for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
    wrap(prototype, 'createTexture', (_gl, _args, texture) => { if (texture) { allocations.set(texture as WebGLTexture, { levels: new globalThis.Map() }); changed(); } });
    wrap(prototype, 'deleteTexture', (_gl, [texture]) => { allocations.delete(texture as WebGLTexture); });
    wrap(prototype, 'activeTexture', (gl, [unit]) => { state(gl).unit = Number(unit); });
    wrap(prototype, 'bindTexture', (gl, [target, texture]) => { const current = state(gl); current.bound.set(`${current.unit}/${target}`, texture as WebGLTexture | null); });
    wrap(prototype, 'texStorage2D', (gl, args) => {
      const [target, levels, format, width, height] = args.map(Number), value = allocation(gl, target);
      for (let index = 0; index < levels; index++) level(value, index, Math.max(1, width >> index), Math.max(1, height >> index), pixelBytes(format));
    });
    wrap(prototype, 'texImage2D', (gl, args) => {
      const [target, index, format] = args.map(Number), source = args[5] as { width?: number; height?: number } | null;
      const width = args.length >= 9 ? Number(args[3]) : source?.width ?? 0, height = args.length >= 9 ? Number(args[4]) : source?.height ?? 0;
      level(allocation(gl, target), index, width, height, pixelBytes(format));
    });
    wrap(prototype, 'generateMipmap', (gl, [target]) => {
      const value = allocation(gl, Number(target)), base = value?.levels.get(0);
      if (base) for (let index = 1; Math.max(base.width, base.height) >> index; index++) level(value, index, Math.max(1, base.width >> index), Math.max(1, base.height >> index), base.bytesPerPixel);
    });
  }
  return {
    snapshot() { return { ...totals(), peakBytes, peakRasterBytes, peakTextures }; },
    resetPeaks() { const now = totals(); peakBytes = now.bytes; peakRasterBytes = now.rasterBytes; peakTextures = now.textures; }
  };
}
const memory = textureAccounting();

function decodedAccounting() {
  interface Allocation { kind: 'bitmap' | 'canvas'; bytes: number }
  const tracked = new WeakMap<object, Allocation>();
  let bitmapBytes = 0, canvasBytes = 0, pendingDecodeBytes = 0, pendingDecodes = 0, peakPixelBytes = 0, peakPendingDecodes = 0;
  const changed = () => { peakPixelBytes = Math.max(peakPixelBytes, bitmapBytes + canvasBytes + pendingDecodeBytes); peakPendingDecodes = Math.max(peakPendingDecodes, pendingDecodes); };
  const release = (record: Allocation) => { if (record.kind === 'bitmap') bitmapBytes -= record.bytes; else canvasBytes -= record.bytes; record.bytes = 0; };
  // Weak tracking preserves GC ownership; explicit close and finalization release the same allocation once.
  const finalized = new FinalizationRegistry<Allocation>(release);
  const track = (target: ImageBitmap | OffscreenCanvas | HTMLCanvasElement, kind: Allocation['kind']) => {
    const previous = tracked.get(target); if (previous) release(previous);
    const record = previous ?? { kind, bytes: 0 }; record.bytes = target.width * target.height * 4;
    if (kind === 'bitmap') bitmapBytes += record.bytes; else canvasBytes += record.bytes;
    if (!previous) { tracked.set(target, record); finalized.register(target, record, record); }
    changed();
  };
  const create = globalThis.createImageBitmap;
  globalThis.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => {
    const source = args[0], width = 'width' in source ? Number(source.width) : TILE_SIZE, height = 'height' in source ? Number(source.height) : TILE_SIZE;
    const bytes = width * height * 4; pendingDecodeBytes += bytes; pendingDecodes++; changed();
    return (Reflect.apply(create, globalThis, args) as Promise<ImageBitmap>).then(bitmap => {
      pendingDecodeBytes -= bytes; pendingDecodes--; track(bitmap, 'bitmap'); return bitmap;
    }, error => { pendingDecodeBytes -= bytes; pendingDecodes--; throw error; });
  }) as typeof createImageBitmap;
  const close = ImageBitmap.prototype.close;
  ImageBitmap.prototype.close = function () { const record = tracked.get(this); if (record) { release(record); finalized.unregister(record); tracked.delete(this); } return close.call(this); };
  const NativeCanvas = OffscreenCanvas;
  globalThis.OffscreenCanvas = class extends NativeCanvas { constructor(width: number, height: number) { super(width, height); track(this, 'canvas'); } };
  const transfer = NativeCanvas.prototype.transferToImageBitmap;
  NativeCanvas.prototype.transferToImageBitmap = function () { const bitmap = transfer.call(this); track(bitmap, 'bitmap'); return bitmap; };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: Parameters<typeof getContext>) {
    const context = Reflect.apply(getContext, this, args);
    if (args[0] === '2d') track(this, 'canvas');
    return context;
  } as typeof getContext;
  for (const prototype of [NativeCanvas.prototype, HTMLCanvasElement.prototype]) for (const name of ['width', 'height']) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor?.set) continue;
    Object.defineProperty(prototype, name, { ...descriptor, set(this: OffscreenCanvas | HTMLCanvasElement, value: number) { descriptor.set!.call(this, value); if (tracked.has(this)) track(this, 'canvas'); } });
  }
  return { snapshot: () => ({ bitmapBytes, canvasBytes, pendingDecodeBytes, pendingDecodes, peakPixelBytes, peakPendingDecodes }) };
}
const decodedMemory = decodedAccounting();

/** Vite-only Map wrapper: the product still mounts its real main module and controls. */
export class Map extends PreviewMap {
  constructor(options: MapOptions) {
    super({ ...options, canvasContextAttributes: { ...options.canvasContextAttributes, preserveDrawingBuffer: true } });
    installBench(this);
  }
}

function installBench(map: PreviewMap): void {
  const time = document.querySelector<HTMLInputElement>('#time')!;
  const canvas = map.getCanvas(), gl = canvas.getContext('webgl2')!;
  if (!gl) throw new Error('WebGL2 is required by the benchmark');
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  const sources = () => Object.keys(map.getStyle().sources).filter(id => id.startsWith('av-overlay-') || id.startsWith('av-overview-')).length;
  const samples: InputSample[] = [];
  let frames: string[] = [], transparent = false, renders = 0, peakSources = 0, displayedIndex = -1, staleFramePaints = 0;
  let initialFirstCorrectMs: number | null = null, initialDetailedMs: number | null = null;
  let viewportQuality: 'overview' | 'detail' | null = null;
  let waiting: { sample: InputSample; render: number; resolve: (sample: InputSample) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  let requested: { resolve: (sample: InputSample) => void; reject: (error: Error) => void } | undefined;
  let readyResolve!: () => void;
  const ready = new Promise<void>(resolve => { readyResolve = resolve; });
  const selectedLayer = (): BenchLayer => document.querySelector('#ref-msl')?.getAttribute('aria-pressed') === 'true' ? 'msl' : 'agl';
  void fetch('/bench/config.json').then(response => response.json()).then((config: { frames: string[]; transparent: boolean }) => { frames = config.frames; transparent = config.transparent; map.triggerRepaint(); });
  function finish() {
    if (!waiting) return;
    const value = { ...waiting.sample, renders: renders - waiting.render, sources: sources() };
    clearTimeout(waiting.timer); samples.push(value); waiting.resolve(value); waiting = undefined;
  }
  function begin(layer = selectedLayer()) {
    finish();
    const observer = requested;
    requested = undefined;
    const index = Number(time.value), inputAt = performance.now();
    const sample: InputSample = { index, layer, inputAt, inputEpochMs: performance.timeOrigin + inputAt, firstCorrectMs: null, detailedMs: null, renders: 0, sources: sources() };
    waiting = { sample, render: renders, resolve: observer?.resolve ?? (() => {}), reject: observer?.reject ?? (() => {}),
      timer: setTimeout(() => { const pending = waiting; waiting = undefined; pending?.reject(new Error(`Slider target ${index} did not render`)); }, 15000) };
  }
  time.addEventListener('input', () => begin(), { capture: true });
  for (const layer of ['agl', 'msl'] as const) document.querySelector(`#ref-${layer}`)!.addEventListener('click', () => begin(layer), { capture: true });
  function select(index: number): Promise<InputSample> {
    if (index < 0 || index >= frames.length || !Number.isInteger(index)) throw new Error('Unknown benchmark frame');
    return new Promise((resolve, reject) => {
      requested = { resolve, reject }; time.value = String(index); time.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  map.on('render', () => {
    renders++; peakSources = Math.max(peakSources, sources());
    const probes: PixelProbe[] = [0.02, 0.5, 0.98].flatMap(x => [0.02, 0.5, 0.98].map(y => {
      const px = Math.floor(canvas.width * x), py = Math.floor(canvas.height * y), pixel = new Uint8Array(4);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      const position = map.unproject([(px + 0.5) / canvas.width * canvas.clientWidth, (1 - (py + 0.5) / canvas.height) * canvas.clientHeight]);
      return { pixel: [...pixel], u: ((position.lng + 180) / 360 % 1 + 1) % 1, v: (1 - Math.asinh(Math.tan(position.lat * Math.PI / 180)) / Math.PI) / 2 };
    }));
    const layer = selectedLayer(), opacity = Number(document.querySelector<HTMLInputElement>('#opacity')!.value);
    const match = recognizeViewport(probes, layer, opacity, transparent, frames.length);
    viewportQuality = match?.index === Number(time.value) ? match.quality : null;
    if (!match) return;
    if (displayedIndex !== match.index && match.index !== Number(time.value)) staleFramePaints++;
    displayedIndex = match.index;
    if (match.index === Number(time.value) && !time.disabled) {
      initialFirstCorrectMs ??= performance.now();
      if (match.quality === 'detail') { initialDetailedMs ??= performance.now(); readyResolve(); }
    }
    if (waiting?.sample.index === match.index && waiting.sample.layer === layer) {
      waiting.sample.firstCorrectMs ??= performance.now() - waiting.sample.inputAt;
      waiting.sample.pixels = probes.map(probe => [...probe.pixel]);
      if (match.quality === 'detail') { waiting.sample.detailedMs = performance.now() - waiting.sample.inputAt; finish(); }
    }
  });
  window.bench = {
    ready, select,
    layer(reference) { return new Promise((resolve, reject) => { requested = { resolve, reject }; document.querySelector<HTMLButtonElement>(`#ref-${reference}`)!.click(); }); },
    async drag(indices, intervalMs) {
      const first = samples.length, stale = staleFramePaints;
      let last: Promise<InputSample> | undefined;
      for (const index of indices) { last = select(index); await new Promise(resolve => setTimeout(resolve, intervalMs)); }
      const final = await last;
      return { samples: samples.slice(first), staleFramePaints: staleFramePaints - stale, lastTarget: final! };
    },
    settled() { return !waiting && viewportQuality === 'detail' && map.loaded() && map.areTilesLoaded() && !map.isMoving(); },
    snapshot() { const timeline = document.querySelector<HTMLElement>('#timeline-status'); return { sources: sources(), peakSources, renderer, frames, memory: memory.snapshot(), decoded: decodedMemory.snapshot(), initialFirstCorrectMs, initialDetailedMs, overviewReady: Number(timeline?.dataset.ready ?? 0), overviewTotal: Number(timeline?.dataset.total ?? 0), viewportQuality, selectedIndex: Number(time.value), displayedIndex, width: canvas.width, height: canvas.height }; },
    pan(longitude) { map.jumpTo({ center: [longitude, 40] }); },
    resetPeaks() { peakSources = sources(); memory.resetPeaks(); }
  };
}
