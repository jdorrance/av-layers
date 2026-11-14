import { normalizeLon, prepareGridGeometry, snapGridCoordinate, withinGeographicBounds, type GeographicBounds, type Grid, type GridGeometry } from '@av/contracts/geometry';
import { STATUS_MASK, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_MASK } from '@av/contracts/layers';
import { WIND_CHUNK_LIMIT, WIND_FINE_CELL_BYTES, WIND_FRAME_LIMIT, WIND_HEIGHTS, WIND_INDEX_ENTRIES, WIND_OVERVIEW_CELL_BYTES, WIND_OVERVIEW_TILE_SIZE, WIND_OVERVIEW_VALUES, decodeTileMask, parseWindFrame, windLayout, windOverviewLayout, type TileMask } from '@av/contracts/wind-data';
import { nearerContributor, type SamplePlan } from '@av/forecast/sampler';
import { decodePackedWindChunk, encodeWindColumns, samplePackedWindColumns, type PackedWindChunk } from '@av/forecast/wind';
import type { PinnedBuild } from './client-types.ts';

type WindStatus = 'valid' | 'unavailable' | 'outside' | 'no-lift';
export interface WindSample { status: WindStatus; u: number | null; v: number | null }
interface Overview { stride: number; width: number; height: number; tilesAcross: number; data: Map<number, DataView> }
const empty = (status: WindStatus): WindSample => ({ status, u: null, v: null });
export const WIND_NUMERIC_BYTES = 8 * 1024 * 1024;
const MAX_CHUNKS = 64, DETAIL_MAX_BYTES = WIND_NUMERIC_BYTES / 2 - WIND_FRAME_LIMIT, SINGLE_VIEW_MAX_BYTES = WIND_NUMERIC_BYTES - WIND_FRAME_LIMIT;
const MAX_SPAN_BYTES = 1024 * 1024, SPAN_STRIPE = 8, UNAVAILABLE_BUILD_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000, MAX_LOAD_TIMEOUT_MS = 240_000, FIELD_SLOTS = 8192;
const OUTSIDE_WIND = decodePackedWindChunk(encodeWindColumns([null], 1));
const plans: SamplePlan[] = Array.from({ length: 2 }, () => ({ contributors: Array.from({ length: 4 }, () => ({ index: 0, row: 0, column: 0, weight: 0 })), byteRange: { offset: 0, length: 0 } }));
const planContributors = plans.map(plan => [...plan.contributors]);
const chunks: (PackedWindChunk | undefined)[] = [], offsets: number[] = [], values = new Float64Array(4), flags = new Uint8Array(4);

interface CachedBytes {
  url: string;
  bytes: Uint8Array;
  used: number | null;
  references: number;
  expiresAt: number;
  decoded?: PackedWindChunk | DataView;
}

/** Share immutable buffers and decoded views across viewports within a strict byte limit. */
export class WindDataCache {
  private readonly entries = new Set<CachedBytes>();
  private readonly unavailableBuilds = new Map<string, number>();
  private bytes = 0;
  private spanFailures = 0;

  get allocatedBytes(): number {
    return this.bytes;
  }

  get spansUnsupported(): boolean {
    return this.spanFailures >= 2;
  }

  set spansUnsupported(value: boolean) {
    this.spanFailures = value ? 2 : 0;
  }

  recordSpanResult(supported: boolean): void {
    this.spanFailures = supported ? 0 : Math.min(2, this.spanFailures + 1);
  }

  isBuildUnavailable(buildId: string, now = Date.now()): boolean {
    const until = this.unavailableBuilds.get(buildId);
    if (until === undefined) return false;
    if (until <= now) { this.unavailableBuilds.delete(buildId); return false; }
    return true;
  }

  markBuildUnavailable(buildId: string, now = Date.now()): void {
    if (!this.unavailableBuilds.has(buildId) && this.unavailableBuilds.size >= 64) {
      const oldest = this.unavailableBuilds.keys().next().value;
      if (oldest !== undefined) this.unavailableBuilds.delete(oldest);
    }
    this.unavailableBuilds.delete(buildId);
    this.unavailableBuilds.set(buildId, now + UNAVAILABLE_BUILD_TTL_MS);
  }

  hasReady(url: string, limit: number, now = Date.now()): boolean {
    for (const e of this.entries) if (e.url === url && e.used !== null && e.expiresAt > now && e.bytes.length === limit) return true;
    return false;
  }

  take(url: string, limit: number, expiresAt: number): CachedBytes {
    for (const e of this.entries) {
      if (e.url !== url || e.used === null || e.expiresAt <= Date.now() || e.bytes.length !== limit) continue;
      e.references++; e.expiresAt = Math.min(e.expiresAt, expiresAt);
      this.entries.delete(e); this.entries.add(e);
      return e;
    }
    for (const e of this.entries) {
      if (this.bytes + limit <= WIND_NUMERIC_BYTES && this.entries.size < 256) break;
      if (!e.references) this.remove(e);
    }
    if (this.bytes + limit > WIND_NUMERIC_BYTES || this.entries.size >= 256) throw new RangeError('Wind cache exceeds byte budget');
    const entry: CachedBytes = { url, bytes: new Uint8Array(limit), used: null, references: 1, expiresAt };
    this.entries.add(entry); this.bytes += limit;
    return entry;
  }

  release(entry: CachedBytes): void {
    if (!--entry.references && (entry.used === null || entry.expiresAt <= Date.now())) this.remove(entry);
  }

  clear(): void {
    this.unavailableBuilds.clear();
    this.spanFailures = 0;
    for (const e of this.entries) { e.expiresAt = 0; if (!e.references) this.remove(e); }
  }

  private remove(entry: CachedBytes): void {
    this.entries.delete(entry); this.bytes -= entry.bytes.length;
  }
}

function samplingPlan(grid: Grid, geometry: GridGeometry, lat: number, lon: number, slot: number): SamplePlan | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isSafeInteger(grid.width) || !Number.isSafeInteger(grid.height) || grid.width <= 0 || grid.height <= 0) return null;
  let x: number, y: number;
  if (grid.kind === 'regular-latlon') {
    if (!Number.isFinite(grid.lon0) || !Number.isFinite(grid.lat0) || !Number.isFinite(grid.dx) || !Number.isFinite(grid.dy) || !grid.dx || !grid.dy || lat < -90 || lat > 90) return null;
    x = snapGridCoordinate((lon - grid.lon0) / grid.dx); y = snapGridCoordinate((lat - grid.lat0) / grid.dy);
    if (grid.wrapLongitude) x = snapGridCoordinate(((x % grid.width) + grid.width) % grid.width);
  } else {
    const point = geometry.geographicToGrid(lat, lon);
    if (!point) return null;
    x = point.x; y = point.y;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || (!grid.wrapLongitude && (x < 0 || x > grid.width - 1)) || y < 0 || y > grid.height - 1) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, plan = plans[slot];
  let count = 0;
  for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    if ((dx && fx === 0) || (dy && fy === 0)) continue;
    const item = planContributors[slot][count++];
    item.row = y0 + dy; item.column = (x0 + dx) % grid.width; item.index = item.row * grid.width + item.column;
    item.weight = (dy ? fy : 1 - fy) * (dx ? fx : 1 - fx);
    plan.contributors[count - 1] = item;
  }
  plan.contributors.length = count;
  return plan;
}

function targetHeight(plan: SamplePlan, height: number | 'lift', useStoredMslNoLift: boolean): { value: number | null; status: number } {
  if (height !== 'lift' && (!Number.isFinite(height) || height < 0)) throw new RangeError('Invalid AGL height');
  let missing = false, allNoLift = true, noLiftWeight = 0, nearest = 0;
  for (let i = 0; i < plan.contributors.length; i++) {
    const status = flags[i] & STATUS_MASK, item = planContributors[1][i], best = plan.contributors[nearest];
    if (height !== 'lift' && (status === STATUS_NO_LIFT || (flags[i] & SUPPORT_MASK) !== 0)) throw new RangeError('Terrain cell has lift status or support');
    missing ||= status >= STATUS_UNAVAILABLE; allNoLift &&= status === STATUS_NO_LIFT;
    if (status === STATUS_NO_LIFT) noLiftWeight += item.weight;
    if (nearerContributor(item.weight, item.row, item.column, best.weight, best.row, best.column)) nearest = i;
  }
  if (missing || plan.contributors.length === 1) {
    const idx = missing ? nearest : 0, status = flags[idx] & STATUS_MASK;
    return { value: status === STATUS_VALID ? height === 'lift' ? values[idx] : values[idx] + height : null, status };
  }
  if (height === 'lift' && (allNoLift || noLiftWeight > 0.5)) return { value: null, status: STATUS_NO_LIFT };
  const renormalize = height === 'lift' && !useStoredMslNoLift && plan.contributors.length === 4 && noLiftWeight > 0;
  let value = 0;
  for (let i = 0; i < plan.contributors.length; i++) {
    value += renormalize ? (flags[i] & STATUS_MASK) === STATUS_NO_LIFT ? 0 : values[i] * (plan.contributors[i].weight / (1 - noLiftWeight)) : values[i] * plan.contributors[i].weight;
  }
  return { value: height === 'lift' ? value : value + height, status: STATUS_VALID };
}

function tilesForBounds(grid: Grid, bounds: GeographicBounds, size: number, padding = 2, mask?: TileMask): number[] | null {
  const geometry = prepareGridGeometry(grid), [west, south, east, north] = bounds;
  const span = west <= east ? east - west : east + 360 - west;
  if (span > 180) {
    const count = mask ? mask.count : Math.ceil(grid.width / size) * Math.ceil(grid.height / size);
    return count <= MAX_CHUNKS ? Array.from({ length: count }, (_, i) => i) : null;
  }
  const points: Array<{ x: number; y: number }> = [];
  for (let y = 0; y <= 32; y++) for (let x = 0; x <= 32; x++) {
    const point = geometry.geographicToGrid(south + (north - south) * y / 32, normalizeLon(west + span * x / 32));
    if (point) points.push(point);
  }
  for (const x of [0, (grid.width - 1) / 2, grid.width - 1]) for (const y of [0, (grid.height - 1) / 2, grid.height - 1]) {
    const point = geometry.gridToGeographic(x, y);
    if (point && withinGeographicBounds(point.lat, point.lon, bounds)) points.push({ x, y });
  }
  if (!points.length) return [];
  const w = Math.ceil(grid.width / size), h = Math.ceil(grid.height / size);
  const xs = points.map(p => p.x), ys = points.map(p => p.y), minX = Math.min(...xs), maxX = Math.max(...xs);
  const y0 = Math.max(0, Math.floor((Math.min(...ys) - padding) / size)), y1 = Math.min(h - 1, Math.floor((Math.max(...ys) + padding) / size));
  const intervals = grid.wrapLongitude && maxX - minX > grid.width / 2
    ? [[0, Math.max(...xs.filter(x => x < grid.width / 2)) + padding], [Math.min(...xs.filter(x => x >= grid.width / 2)) - padding, grid.width - 1]]
    : [[minX - padding, maxX + padding]];
  if (grid.wrapLongitude) for (const [s, e] of [...intervals]) {
    if (s < 0) intervals.push([grid.width + s, grid.width - 1]);
    if (e >= grid.width) intervals.push([0, e - grid.width]);
  }
  const result = new Set<number>();
  for (const [s, e] of intervals) {
    const x0 = Math.max(0, Math.floor(s / size)), x1 = Math.min(w - 1, Math.floor(e / size));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const logical = y * w + x, slot = mask ? mask.slot(logical) : logical;
      if (slot >= 0 && result.add(slot).size > MAX_CHUNKS) return null;
    }
  }
  return [...result];
}

function overviewCoordinate(point: number, length: number, stride: number, wrap = false): number {
  const last = Math.ceil(length / stride) - 1, center = (stride - 1) / 2, tail = length - last * stride;
  if (!last) return 0;
  if (tail < stride) {
    if (point > (last - 1) * stride + center) return last - 1 + (point - (last - 1) * stride - center) / ((stride + tail) / 2);
    if (wrap && point < center) return (point - center) / ((stride + tail) / 2);
  }
  return (point - center) / stride;
}

function validateChunk(kind: string, bytes: Uint8Array, tileSize: number, levels: number, isOverview: boolean): PackedWindChunk | DataView {
  if (kind === 'wind') {
    const columns = decodePackedWindChunk(bytes);
    if (columns.count !== tileSize ** 2 || columns.levels !== levels) throw new Error('Numeric chunk dimensions mismatch');
    return columns;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isOverview) {
    for (let i = 0; i < bytes.length; i += 9) {
      const u = view.getFloat32(i, true), v = view.getFloat32(i + 4, true), status = view.getUint8(i + 8);
      if (status > STATUS_OUTSIDE || !Number.isFinite(u) || !Number.isFinite(v) || (status !== STATUS_VALID && (u !== 0 || v !== 0))) throw new Error('Invalid numeric overview');
    }
    return view;
  }
  for (let i = 0; i < bytes.length; i += WIND_FINE_CELL_BYTES) {
    const packed = view.getUint8(i + 8), support = view.getUint8(i + 9), terrain = packed & STATUS_MASK, lift = (packed >> 2) & STATUS_MASK;
    if ((packed & 0xe0) !== 0 || (support & ~SUPPORT_MASK) !== 0 || terrain === STATUS_NO_LIFT
      || (terrain === STATUS_VALID && !Number.isFinite(view.getFloat32(i, true)))
      || (lift <= STATUS_NO_LIFT && !Number.isFinite(view.getFloat32(i + 4, true)))) throw new Error('Invalid numeric companion');
  }
  return view;
}

export class WindDataSource {
  private controller?: AbortController;
  private current?: { build: PinnedBuild; bounds: GeographicBounds; tileSize: number; fineTileSize: number; native: Grid; fineGrid: Grid; nativeGeometry: GridGeometry; fineGeometry: GridGeometry; wind: Map<number, PackedWindChunk>; fine: Map<number, DataView>; windMask?: TileMask; fineMask?: TileMask; overview?: Overview };
  private generation = 0;
  private disposed = false;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly cache: WindDataCache;
  private readonly held = new Set<CachedBytes>();
  private active?: AbortController;
  constructor(private readonly baseUrl: string, private readonly options: { fetchImpl?: typeof fetch; cache?: WindDataCache; coalesceSpans?: boolean } = {}) {
    this.cache = options.cache ?? new WindDataCache();
  }

  get isOverview(): boolean | undefined {
    return this.current ? !!this.current.overview : undefined;
  }

  /** Fast direct-mapped quantized field sampler (~220 m cells, zero heap allocation) for 60fps map rendering. */
  field(height: 'surface' | number | 'lift'): { sample(lat: number, lon: number): { u: number | null; v: number | null; status: number } } {
    const keys = new Float64Array(FIELD_SLOTS).fill(-1);
    const uv = new Float32Array(FIELD_SLOTS * 2), statuses = new Uint8Array(FIELD_SLOTS);
    const out = { u: null as number | null, v: null as number | null, status: STATUS_UNAVAILABLE };
    let gen = this.generation;
    return {
      sample: (lat: number, lon: number) => {
        if (!this.current || this.current.build.expiresAtMs <= Date.now()) {
          this.current = undefined; out.status = STATUS_UNAVAILABLE; out.u = out.v = null; return out;
        }
        if (gen !== this.generation) { keys.fill(-1); gen = this.generation; }
        const wrapped = normalizeLon(lon);
        const iy = Math.round((lat + 90) * 500), ix = Math.round((wrapped + 180) * 500);
        const tag = iy * 180_002 + ix, slot = ((Math.imul(iy, 2654435761) ^ Math.imul(ix, 2246822519)) >>> 0) & (FIELD_SLOTS - 1);
        if (keys[slot] === tag) {
          const st = statuses[slot];
          out.status = st; out.u = st === STATUS_VALID ? uv[slot * 2] : null; out.v = st === STATUS_VALID ? uv[slot * 2 + 1] : null;
          return out;
        }
        const s = this.sample(lat, wrapped, height);
        const st = s.status === 'valid' ? STATUS_VALID : s.status === 'no-lift' ? STATUS_NO_LIFT : s.status === 'outside' ? STATUS_OUTSIDE : STATUS_UNAVAILABLE;
        keys[slot] = tag; statuses[slot] = st;
        uv[slot * 2] = s.u ?? 0; uv[slot * 2 + 1] = s.v ?? 0;
        out.status = st; out.u = s.u; out.v = s.v;
        return out;
      }
    };
  }

  private release(): void {
    for (const entry of this.held) this.cache.release(entry);
    this.held.clear();
  }

  private hold(entry: CachedBytes): CachedBytes {
    if (this.held.has(entry)) this.cache.release(entry);
    else this.held.add(entry);
    return entry;
  }

  async load({ build, frame, bounds, signal }: { build: PinnedBuild; frame: string; bounds: GeographicBounds; signal?: AbortSignal }): Promise<'ready' | 'unavailable'> {
    this.controller?.abort(); this.current = undefined; this.generation++;
    if (this.disposed) throw new Error('Wind source is disposed');
    const controller = new AbortController(); this.controller = controller;
    const previous = this.pending;
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    this.pending = previous.then(() => turn);
    const waiting = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      waiting.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => { waiting.removeEventListener('abort', abort); reject(waiting.reason); };
        waiting.addEventListener('abort', abort, { once: true });
        if (waiting.aborted) abort();
        previous.then(() => { waiting.removeEventListener('abort', abort); resolve(); });
      });
      waiting.throwIfAborted();
      this.release();
      this.active = controller;
      return await this.loadView(build, frame, bounds, controller, signal);
    } finally {
      if (this.active === controller) {
        this.active = undefined;
        if (this.disposed || controller.signal.aborted || !this.current) this.release();
      }
      release();
    }
  }

  private async loadView(build: PinnedBuild, frame: string, bounds: GeographicBounds, controller: AbortController, signal?: AbortSignal): Promise<'ready' | 'unavailable'> {
    if (build.expiresAtMs <= Date.now() || Date.parse(build.manifest.expiresAt) !== build.expiresAtMs) return 'unavailable';
    if (this.cache.isBuildUnavailable(build.manifest.buildId)) return 'unavailable';
    if (!build.manifest.frames.slice(0, build.manifest.mapFrameCount ?? build.manifest.frames.length).some(item => item.id === frame)) return 'unavailable';
    if (!bounds.every(Number.isFinite) || bounds[1] < -90 || bounds[3] > 90 || bounds[1] > bounds[3] || bounds[0] < -180 || bounds[0] > 180 || bounds[2] < -180 || bounds[2] > 180) throw new RangeError('Invalid wind bounds');
    const native = build.manifest.surfaces.find(s => s.kind === 'native'), fine = build.manifest.surfaces.find(s => s.kind === 'fine');
    if (!native || !fine) return 'unavailable';
    const baseSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    baseSignal.throwIfAborted();
    const root = `${this.baseUrl.replace(/\/+$/, '')}/v1/models/${encodeURIComponent(build.manifest.model)}/runs/${encodeURIComponent(build.manifest.buildId)}/data/${encodeURIComponent(frame)}`;
    const readStream = async (url: string, type: string, targets: CachedBytes[], attemptSignal = baseSignal): Promise<number | null | 'product-unavailable' | 'unsupported-span' | 'retry-single'> => {
      attemptSignal.throwIfAborted();
      const limit = targets.reduce((sum, item) => sum + item.bytes.length, 0);
      const reqCtrl = new AbortController(), timer = setTimeout(() => reqCtrl.abort(new DOMException('Numeric request timed out', 'TimeoutError')), REQUEST_TIMEOUT_MS);
      const reqSig = AbortSignal.any([attemptSignal, reqCtrl.signal]);
      try {
        reqSig.throwIfAborted();
        const res = await (this.options.fetchImpl ?? fetch)(url, { signal: reqSig, redirect: 'error' });
        if (targets.length > 1 && res.status === 400) { await res.body?.cancel(); return 'unsupported-span'; }
        if (targets.length > 1 && res.status === 404) { await res.body?.cancel(); return 'retry-single'; }
        if (res.status === 409) { await res.body?.cancel(); return 'product-unavailable'; }
        if (res.status === 404) { await res.body?.cancel(); return null; }
        if (!res.ok || res.headers.get('content-type')?.split(';')[0] !== type) { await res.body?.cancel(); throw new Error('Invalid numeric response'); }
        const declared = res.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) { await res.body?.cancel(); throw new Error('Numeric response exceeds budget'); }
        if (!res.body) throw new Error('Numeric response is empty');
        const reader = res.body.getReader(), abort = () => { void reader.cancel(reqSig.reason).catch(() => {}); };
        reqSig.addEventListener('abort', abort, { once: true });
        if (reqSig.aborted) abort();
        let used = 0, slot = 0, slotOffset = 0;
        try {
          for (;;) {
            const next = await reader.read(); reqSig.throwIfAborted();
            if (next.done) break;
            if (used + next.value.length > limit) throw new Error('Numeric response exceeds budget');
            for (let pos = 0; pos < next.value.length;) {
              const dest = targets[slot]!.bytes, take = Math.min(dest.length - slotOffset, next.value.length - pos);
              dest.set(next.value.subarray(pos, pos + take), slotOffset);
              pos += take; used += take; slotOffset += take;
              if (slotOffset === dest.length) { slot++; slotOffset = 0; }
            }
          }
        } finally { reqSig.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (declared !== null && used !== Number(declared)) throw new Error('Numeric response length mismatch');
        return used;
      } finally { clearTimeout(timer); }
    };
    const descEntry = this.hold(this.cache.take(root, WIND_FRAME_LIMIT, build.expiresAtMs));
    const descUsed = descEntry.used ?? await readStream(root, 'application/json', [descEntry]);
    if (descUsed === 'product-unavailable') { this.cache.markBuildUnavailable(build.manifest.buildId); return 'unavailable'; }
    if (typeof descUsed !== 'number') return 'unavailable';
    const descriptor = parseWindFrame(descEntry.bytes.subarray(0, descUsed));
    if (descriptor.frame !== frame) throw new Error('Numeric frame mismatch');
    descEntry.used = descUsed;

    const windTotal = windLayout(native.grid.width, native.grid.height, descriptor.tileSize, descriptor.levels);
    const fineTotal = windLayout(fine.grid.width, fine.grid.height, descriptor.fineTileSize);
    const windMask = decodeTileMask(descriptor.windMask, windTotal.count) ?? undefined;
    const fineMask = decodeTileMask(descriptor.fineMask, fineTotal.count) ?? undefined;
    const winds = tilesForBounds(native.grid, bounds, descriptor.tileSize, 2, windMask);
    const fines = tilesForBounds(fine.grid, bounds, descriptor.fineTileSize, 2, fineMask);
    const windBytes = windTotal.chunkBytes, fineBytes = fineTotal.chunkBytes;
    const wind = new Map<number, PackedWindChunk>(), fineData = new Map<number, DataView>();

    const selectOverview = () => {
      for (const level of descriptor.overview ?? []) {
        const layout = windOverviewLayout(native.grid, level.stride), tiles = tilesForBounds(native.grid, bounds, WIND_OVERVIEW_TILE_SIZE * level.stride, level.stride * 2);
        if (!tiles || tiles.length * layout.chunkBytes > DETAIL_MAX_BYTES) continue;
        return {
          overview: { stride: level.stride, width: layout.width, height: layout.height, tilesAcross: Math.ceil(layout.width / WIND_OVERVIEW_TILE_SIZE), data: new Map<number, DataView>() },
          tasks: tiles.map(tile => ({ kind: `overview-${level.stride}`, tile, bytes: layout.chunkBytes }))
        };
      }
      return undefined;
    };

    const fetchTasks = async (rawTasks: Array<{ kind: string; tile: number; bytes: number }>, targetOverview?: Overview) => {
      const coalesce = (this.options.coalesceSpans ?? !this.options.fetchImpl) && !this.cache.spansUnsupported;
      const batches: Array<{ kind: string; tiles: number[]; bytes: number }> = [];
      for (const item of coalesce ? [...rawTasks].sort((a, b) => a.kind.localeCompare(b.kind) || a.tile - b.tile) : rawTasks) {
        const cached = coalesce && this.cache.hasReady(`${root}/${item.kind}/${item.tile}`, item.bytes);
        const prev = !cached && coalesce ? batches.at(-1) : undefined, lastTile = prev?.tiles.at(-1);
        if (prev && prev.kind === item.kind && lastTile !== undefined && item.tile === lastTile + 1
          && Math.floor(item.tile / SPAN_STRIPE) === Math.floor(prev.tiles[0]! / SPAN_STRIPE)
          && Math.floor(item.tile / WIND_INDEX_ENTRIES) === Math.floor(prev.tiles[0]! / WIND_INDEX_ENTRIES)
          && (prev.tiles.length + 1) * item.bytes <= MAX_SPAN_BYTES
          && !this.cache.hasReady(`${root}/${prev.kind}/${prev.tiles[0]}`, item.bytes)) {
          prev.tiles.push(item.tile);
        } else batches.push({ kind: item.kind, tiles: [item.tile], bytes: item.bytes });
      }
      const attemptCtrl = new AbortController();
      const attemptSig = AbortSignal.any([baseSignal, attemptCtrl.signal, AbortSignal.timeout(Math.min(MAX_LOAD_TIMEOUT_MS, Math.max(REQUEST_TIMEOUT_MS, Math.ceil(batches.length / 4) * REQUEST_TIMEOUT_MS)))]);
      const commit = (kind: string, tile: number, entry: CachedBytes) => {
        entry.decoded ??= validateChunk(kind, entry.bytes, descriptor.tileSize, descriptor.levels, !!targetOverview);
        entry.used = entry.bytes.length;
        if (kind === 'wind') wind.set(tile, entry.decoded as PackedWindChunk);
        else (targetOverview ? targetOverview.data : fineData).set(tile, entry.decoded as DataView);
      };
      const check = (used: number | null | 'product-unavailable' | 'unsupported-span' | 'retry-single', expected: number) => {
        if (typeof used !== 'number') throw new Error('Numeric chunk missing');
        if (used !== expected) throw new Error('Numeric chunk length mismatch');
      };
      let next = 0;
      const settled = await Promise.allSettled(Array.from({ length: Math.min(4, batches.length) }, async () => {
        try {
          while (next < batches.length) {
            const b = batches[next++]!, entries = b.tiles.map(t => this.hold(this.cache.take(`${root}/${b.kind}/${t}`, b.bytes, build.expiresAtMs)));
            if (entries.length > 1 && !this.cache.spansUnsupported && entries.every(e => e.used === null)) {
              const used = await readStream(`${root}/${b.kind}/${b.tiles[0]}-${b.tiles.at(-1)}`, 'application/octet-stream', entries, attemptSig);
              if (used !== 'unsupported-span' && used !== 'retry-single') {
                this.cache.recordSpanResult(true);
                check(used, entries.length * b.bytes);
                entries.forEach((e, i) => commit(b.kind, b.tiles[i]!, e));
                continue;
              }
              if (used === 'unsupported-span') this.cache.recordSpanResult(false);
            }
            for (let i = 0; i < entries.length; i++) {
              const e = entries[i]!, t = b.tiles[i]!;
              if (e.used === null) check(await readStream(`${root}/${b.kind}/${t}`, 'application/octet-stream', [e], attemptSig), b.bytes);
              commit(b.kind, t, e);
            }
          }
        } catch (error) { attemptCtrl.abort(); throw error; }
      }));
      const failed = settled.find(r => r.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      attemptSig.throwIfAborted();
    };

    let overview: Overview | undefined;
    const detailBudget = descriptor.overview?.length ? DETAIL_MAX_BYTES : SINGLE_VIEW_MAX_BYTES;
    if (winds && fines && winds.length + fines.length <= MAX_CHUNKS && windBytes <= WIND_CHUNK_LIMIT && winds.length * windBytes + fines.length * fineBytes <= detailBudget) {
      const detailTasks = [...winds.map(tile => ({ kind: 'wind', tile, bytes: windBytes })), ...fines.map(tile => ({ kind: 'fine', tile, bytes: fineBytes }))];
      try {
        await fetchTasks(detailTasks);
      } catch (error) {
        const fallback = !baseSignal.aborted && error instanceof Error && error.message === 'Numeric chunk missing' ? selectOverview() : undefined;
        if (!fallback) { controller.abort(); throw error; }
        for (const entry of [...this.held]) if (entry !== descEntry) { this.held.delete(entry); this.cache.release(entry); }
        wind.clear(); fineData.clear();
        overview = fallback.overview;
        try { await fetchTasks(fallback.tasks, overview); } catch (fallbackError) { controller.abort(); throw fallbackError; }
      }
    } else {
      const selected = selectOverview();
      if (!selected) return 'unavailable';
      overview = selected.overview;
      try { await fetchTasks(selected.tasks, overview); } catch (error) { controller.abort(); throw error; }
    }

    baseSignal.throwIfAborted();
    if (this.controller !== controller || build.expiresAtMs <= Date.now()) return 'unavailable';
    this.generation++;
    this.current = { build, bounds, tileSize: descriptor.tileSize, fineTileSize: descriptor.fineTileSize, native: native.grid, fineGrid: fine.grid, nativeGeometry: prepareGridGeometry(native.grid), fineGeometry: prepareGridGeometry(fine.grid), wind, fine: fineData, windMask, fineMask, overview };
    return 'ready';
  }

  sample(lat: number, lon: number, height: 'surface' | number | 'lift'): WindSample {
    const current = this.current;
    if (!current || current.build.expiresAtMs <= Date.now()) { this.current = undefined; return empty('unavailable'); }
    if (!withinGeographicBounds(lat, lon, current.bounds) || !withinGeographicBounds(lat, lon, current.build.manifest.descriptors.bounds)) return empty('outside');
    if (current.overview) return this.sampleOverview(current, lat, lon, height);
    const windPlan = samplingPlan(current.native, current.nativeGeometry, lat, lon, 0), finePlan = samplingPlan(current.fineGrid, current.fineGeometry, lat, lon, 1);
    if (!windPlan || !finePlan) return empty('outside');
    let nearest = 0, nearestOutput = 0;
    for (let i = 0; i < finePlan.contributors.length; i++) {
      const item = finePlan.contributors[i], best = finePlan.contributors[nearest], size = current.fineTileSize;
      const logical = Math.floor(item.row / size) * Math.ceil(current.fineGrid.width / size) + Math.floor(item.column / size);
      const slot = current.fineMask ? current.fineMask.slot(logical) : logical;
      let packed = STATUS_OUTSIDE | (STATUS_OUTSIDE << 2), support = 0, val = 0;
      if (slot >= 0) {
        const view = current.fine.get(slot);
        if (!view) return empty('unavailable');
        const pos = ((item.row % size) * size + item.column % size) * WIND_FINE_CELL_BYTES;
        packed = view.getUint8(pos + 8); support = view.getUint8(pos + 9);
        val = view.getFloat32(pos + (height === 'lift' ? 4 : 0), true);
      }
      values[i] = val;
      flags[i] = height === 'lift' ? ((packed >> 2) & STATUS_MASK) | support : packed & STATUS_MASK;
      if (i === 0 || nearerContributor(item.weight, item.row, item.column, best.weight, best.row, best.column)) { nearest = i; nearestOutput = (packed >> 4) & 1; }
    }
    if (!nearestOutput) return empty('outside');
    let target: number | 'surface' = 'surface';
    if (height !== 'surface') {
      const selected = targetHeight(finePlan, height, current.build.manifest.tool.useStoredMslNoLift === true);
      if (selected.status !== STATUS_VALID || selected.value === null) return empty(selected.status === STATUS_NO_LIFT ? 'no-lift' : selected.status === STATUS_OUTSIDE ? 'outside' : 'unavailable');
      target = selected.value;
    }
    chunks.length = windPlan.contributors.length;
    for (let i = 0; i < windPlan.contributors.length; i++) {
      const item = windPlan.contributors[i], size = current.tileSize;
      const logical = Math.floor(item.row / size) * Math.ceil(current.native.width / size) + Math.floor(item.column / size);
      const slot = current.windMask ? current.windMask.slot(logical) : logical;
      if (slot < 0) { chunks[i] = OUTSIDE_WIND; offsets[i] = 0; continue; }
      chunks[i] = current.wind.get(slot);
      offsets[i] = (item.row % size) * size + item.column % size;
      if (!chunks[i]) { chunks.length = 0; return empty('unavailable'); }
    }
    offsets.length = chunks.length;
    const result = samplePackedWindColumns(windPlan, chunks, offsets, target);
    chunks.length = 0;
    return { u: result.u, v: result.v, status: result.status === STATUS_VALID ? 'valid' : result.status === STATUS_OUTSIDE ? 'outside' : 'unavailable' };
  }

  private sampleOverview(current: NonNullable<WindDataSource['current']>, lat: number, lon: number, height: 'surface' | number | 'lift'): WindSample {
    const { stride, data, width, height: rows, tilesAcross } = current.overview!, point = current.nativeGeometry.geographicToGrid(lat, lon);
    if (!point || point.x < 0 || point.y < 0 || (!current.native.wrapLongitude && point.x > current.native.width - 1) || point.y > current.native.height - 1) return empty('outside');
    const mode = height === 'surface' ? 0 : height === 'lift' ? WIND_OVERVIEW_VALUES - 1 : WIND_HEIGHTS.indexOf(height as typeof WIND_HEIGHTS[number]) + 1;
    if (typeof height === 'number' && !mode) return empty('unavailable');
    const size = WIND_OVERVIEW_TILE_SIZE, ox = current.native.wrapLongitude ? Math.floor((point.x + 0.5) / stride) % width : Math.min(width - 1, Math.floor((point.x + 0.5) / stride)), oy = Math.min(rows - 1, Math.floor((point.y + 0.5) / stride));
    const owner = data.get(Math.floor(oy / size) * tilesAcross + Math.floor(ox / size));
    if (!owner) return empty('unavailable');
    const offset = ((oy % size) * size + ox % size) * WIND_OVERVIEW_CELL_BYTES + mode * 9, status = owner.getUint8(offset + 8);
    if (status !== STATUS_VALID) return empty(status === STATUS_NO_LIFT ? 'no-lift' : status === STATUS_OUTSIDE ? 'outside' : 'unavailable');
    const x = overviewCoordinate(point.x, current.native.width, stride, current.native.wrapLongitude), y = overviewCoordinate(point.y, current.native.height, stride), x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    let u = 0, v = 0;
    for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
      const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      if (!weight) continue;
      const column = current.native.wrapLongitude ? ((x0 + dx) % width + width) % width : Math.max(0, Math.min(width - 1, x0 + dx)), row = Math.max(0, Math.min(rows - 1, y0 + dy));
      const donor = data.get(Math.floor(row / size) * tilesAcross + Math.floor(column / size));
      const pos = ((row % size) * size + column % size) * WIND_OVERVIEW_CELL_BYTES + mode * 9;
      if (!donor || donor.getUint8(pos + 8) !== STATUS_VALID) return { status: 'valid', u: owner.getFloat32(offset, true), v: owner.getFloat32(offset + 4, true) };
      u += donor.getFloat32(pos, true) * weight; v += donor.getFloat32(pos + 4, true) * weight;
    }
    return { status: 'valid', u, v };
  }

  dispose(): void {
    this.disposed = true; this.controller?.abort(); this.current = undefined; this.generation++;
    if (!this.active) this.release();
  }
}
