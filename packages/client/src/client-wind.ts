import { prepareGridGeometry, snapGridCoordinate, withinGeographicBounds, type GeographicBounds, type Grid, type GridGeometry } from '@av/contracts/geometry';
import { STATUS_MASK, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_MASK } from '@av/contracts/layers';
import { WIND_CHUNK_LIMIT, WIND_FINE_CELL_BYTES, WIND_FRAME_LIMIT, parseWindFrame, windLayout } from '@av/contracts/wind-data';
import { nearerContributor, type SamplePlan } from '@av/forecast/sampler';
import { decodePackedWindChunk, samplePackedWindColumns, type PackedWindChunk } from '@av/forecast/wind';
import type { PinnedBuild } from './client-types.ts';

type WindStatus = 'valid' | 'unavailable' | 'outside' | 'no-lift';
export interface WindSample { status: WindStatus; u: number | null; v: number | null }
const empty = (status: WindStatus): WindSample => ({ status, u: null, v: null });
export const WIND_NUMERIC_BYTES = 8 * 1024 * 1024;
const MAX_CHUNKS = 64, MAX_BYTES = WIND_NUMERIC_BYTES / 2;
const REQUEST_TIMEOUT_MS = 15_000, MAX_LOAD_TIMEOUT_MS = 240_000;
const plans: SamplePlan[] = Array.from({ length: 2 }, () => ({ contributors: Array.from({ length: 4 }, () => ({ index: 0, row: 0, column: 0, weight: 0 })), byteRange: { offset: 0, length: 0 } }));
const planContributors = plans.map(plan => [...plan.contributors]);
const chunks: (PackedWindChunk | undefined)[] = [], offsets: number[] = [], values = new Float64Array(4), flags = new Uint8Array(4);

function samplingPlan(grid: Grid, geometry: GridGeometry, lat: number, lon: number, slot: number): SamplePlan | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isSafeInteger(grid.width) || !Number.isSafeInteger(grid.height) || grid.width <= 0 || grid.height <= 0) return null;
  let x: number, y: number;
  if (grid.kind === 'regular-latlon') {
    if (!Number.isFinite(grid.lon0) || !Number.isFinite(grid.lat0) || !Number.isFinite(grid.dx) || !Number.isFinite(grid.dy) || grid.dx === 0 || grid.dy === 0 || lat < -90 || lat > 90) return null;
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
    item.weight = (dy === 0 ? 1 - fy : fy) * (dx === 0 ? 1 - fx : fx);
    plan.contributors[count - 1] = item;
  }
  plan.contributors.length = count;
  return plan;
}

function targetHeight(plan: SamplePlan, height: number | 'lift', useStoredMslNoLift: boolean): { value: number | null; status: number } {
  if (height !== 'lift' && (!Number.isFinite(height) || height < 0)) throw new RangeError('Invalid AGL height');
  let missing = false, allNoLift = true, noLiftWeight = 0, nearest = 0;
  for (let i = 0; i < plan.contributors.length; i++) {
    const status = flags[i] & STATUS_MASK, item = plan.contributors[i], best = plan.contributors[nearest];
    if (height !== 'lift' && (status === STATUS_NO_LIFT || (flags[i] & SUPPORT_MASK) !== 0)) throw new RangeError('Terrain cell has lift status or support');
    missing ||= status >= STATUS_UNAVAILABLE; allNoLift &&= status === STATUS_NO_LIFT;
    if (status === STATUS_NO_LIFT) noLiftWeight += item.weight;
    if (nearerContributor(item.weight, item.row, item.column, best.weight, best.row, best.column)) nearest = i;
  }
  if (missing) {
    const status = flags[nearest] & STATUS_MASK;
    return { value: status === STATUS_VALID ? height === 'lift' ? values[nearest] : values[nearest] + height : null, status };
  }
  if (plan.contributors.length === 1) {
    const status = flags[0] & STATUS_MASK;
    return { value: status === STATUS_VALID ? height === 'lift' ? values[0] : values[0] + height : null, status };
  }
  if (height === 'lift' && (allNoLift || noLiftWeight > 0.5)) return { value: null, status: STATUS_NO_LIFT };
  const renormalize = height === 'lift' && !useStoredMslNoLift && plan.contributors.length === 4 && noLiftWeight > 0;
  let value = 0;
  for (let i = 0; i < plan.contributors.length; i++) {
    value += renormalize ? (flags[i] & STATUS_MASK) === STATUS_NO_LIFT ? 0 : values[i] * (plan.contributors[i].weight / (1 - noLiftWeight)) : values[i] * plan.contributors[i].weight;
  }
  return { value: height === 'lift' ? value : value + height, status: STATUS_VALID };
}

function tilesForBounds(grid: Grid, bounds: GeographicBounds, size: number): number[] | null {
  const geometry = prepareGridGeometry(grid), [west, south, east, north] = bounds;
  const span = west <= east ? east - west : east + 360 - west;
  if (span > 180) return null;
  const points: Array<{ x: number; y: number }> = [];
  for (let y = 0; y <= 32; y++) for (let x = 0; x <= 32; x++) {
    const lon = ((west + span * x / 32 + 180) % 360 + 360) % 360 - 180;
    const point = geometry.geographicToGrid(south + (north - south) * y / 32, lon);
    if (point) points.push(point);
  }
  if (!points.length) return [];
  const w = Math.ceil(grid.width / size), h = Math.ceil(grid.height / size);
  const y0 = Math.max(0, Math.floor((Math.min(...points.map(p => p.y)) - 2) / size));
  const y1 = Math.min(h - 1, Math.floor((Math.max(...points.map(p => p.y)) + 2) / size));
  const xs = points.map(point => point.x), minX = Math.min(...xs), maxX = Math.max(...xs);
  const intervals = grid.wrapLongitude && maxX - minX > grid.width / 2
    ? [[0, Math.max(...xs.filter(x => x < grid.width / 2)) + 2], [Math.min(...xs.filter(x => x >= grid.width / 2)) - 2, grid.width - 1]]
    : [[minX - 2, maxX + 2]];
  if (grid.wrapLongitude) {
    for (const [start, end] of [...intervals]) {
      if (start < 0) intervals.push([grid.width + start, grid.width - 1]);
      if (end >= grid.width) intervals.push([0, end - grid.width]);
    }
  }
  const result = new Set<number>();
  for (const [start, end] of intervals) {
    const x0 = Math.max(0, Math.floor(start / size)), x1 = Math.min(w - 1, Math.floor(end / size));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      result.add(y * w + x);
      if (result.size > MAX_CHUNKS) return null;
    }
  }
  return [...result];
}

export class WindDataSource {
  private controller?: AbortController;
  private current?: { build: PinnedBuild; bounds: GeographicBounds; tileSize: number; fineTileSize: number; native: Grid; fineGrid: Grid; nativeGeometry: GridGeometry; fineGeometry: GridGeometry; wind: Map<number, PackedWindChunk>; fine: Map<number, DataView> };
  private disposed = false;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly baseUrl: string, private readonly options: { fetchImpl?: typeof fetch } = {}) {}

  async load({ build, frame, bounds, signal }: { build: PinnedBuild; frame: string; bounds: GeographicBounds; signal?: AbortSignal }): Promise<'ready' | 'unavailable' | 'zoom-in'> {
    this.controller?.abort(); this.current = undefined;
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
      return await this.loadView(build, frame, bounds, controller, signal);
    } finally { release(); }
  }

  private async loadView(build: PinnedBuild, frame: string, bounds: GeographicBounds, controller: AbortController, signal?: AbortSignal): Promise<'ready' | 'unavailable' | 'zoom-in'> {
    if (build.expiresAtMs <= Date.now() || Date.parse(build.manifest.expiresAt) !== build.expiresAtMs) return 'unavailable';
    if (!build.manifest.frames.slice(0, build.manifest.mapFrameCount ?? build.manifest.frames.length).some(item => item.id === frame)) return 'unavailable';
    if (!bounds.every(Number.isFinite) || bounds[1] < -90 || bounds[3] > 90 || bounds[1] > bounds[3] || bounds[0] < -180 || bounds[0] > 180 || bounds[2] < -180 || bounds[2] > 180) throw new RangeError('Invalid wind bounds');
    const native = build.manifest.surfaces.find(surface => surface.kind === 'native'), fine = build.manifest.surfaces.find(surface => surface.kind === 'fine');
    if (!native || !fine) return 'unavailable';
    let combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    combined.throwIfAborted();
    const root = `${this.baseUrl.replace(/\/+$/, '')}/v1/models/${encodeURIComponent(build.manifest.model)}/runs/${encodeURIComponent(build.manifest.buildId)}/data/${encodeURIComponent(frame)}`;
    const fetchBytes = async (url: string, type: string, limit: number): Promise<Uint8Array | null> => {
      const requestController = new AbortController(), timer = setTimeout(() => requestController.abort(new DOMException('Numeric request timed out', 'TimeoutError')), REQUEST_TIMEOUT_MS);
      const requestSignal = AbortSignal.any([combined, requestController.signal]);
      try {
        requestSignal.throwIfAborted();
        const result = await (this.options.fetchImpl ?? fetch)(url, { signal: requestSignal, redirect: 'error' });
        if (result.status === 404 || result.status === 409) { await result.body?.cancel(); return null; }
        if (!result.ok || result.headers.get('content-type')?.split(';')[0] !== type) { await result.body?.cancel(); throw new Error('Invalid numeric response'); }
        const declared = result.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) { await result.body?.cancel(); throw new Error('Numeric response exceeds budget'); }
        if (!result.body) throw new Error('Numeric response is empty');
        const reader = result.body.getReader(), bytes = new Uint8Array(limit);
        const abort = () => { void reader.cancel(requestSignal.reason).catch(() => {}); };
        requestSignal.addEventListener('abort', abort, { once: true });
        if (requestSignal.aborted) abort();
        let used = 0;
        try {
          for (;;) {
            const next = await reader.read(); requestSignal.throwIfAborted();
            if (next.done) break;
            if (used + next.value.length > limit) throw new Error('Numeric response exceeds budget');
            bytes.set(next.value, used); used += next.value.length;
          }
        } finally { requestSignal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (declared !== null && used !== Number(declared)) throw new Error('Numeric response length mismatch');
        return bytes.subarray(0, used);
      } finally { clearTimeout(timer); }
    };
    const descriptorBytes = await fetchBytes(root, 'application/json', WIND_FRAME_LIMIT);
    if (!descriptorBytes) return 'unavailable';
    const descriptor = parseWindFrame(descriptorBytes);
    if (descriptor.frame !== frame) throw new Error('Numeric frame mismatch');
    const winds = tilesForBounds(native.grid, bounds, descriptor.tileSize), fines = tilesForBounds(fine.grid, bounds, descriptor.fineTileSize);
    if (!winds || !fines || winds.length + fines.length > MAX_CHUNKS) return 'zoom-in';
    const windBytes = windLayout(native.grid.width, native.grid.height, descriptor.tileSize, descriptor.levels).chunkBytes, fineBytes = windLayout(fine.grid.width, fine.grid.height, descriptor.fineTileSize).chunkBytes;
    if (windBytes > WIND_CHUNK_LIMIT || winds.length * windBytes + fines.length * fineBytes > MAX_BYTES) return 'zoom-in';
    const wind = new Map<number, PackedWindChunk>(), fineData = new Map<number, DataView>();
    const tasks = [...winds.map(tile => ({ kind: 'wind' as const, tile })), ...fines.map(tile => ({ kind: 'fine' as const, tile }))];
    combined = AbortSignal.any([combined, AbortSignal.timeout(Math.min(MAX_LOAD_TIMEOUT_MS, Math.max(REQUEST_TIMEOUT_MS, Math.ceil(tasks.length / 4) * REQUEST_TIMEOUT_MS)))]);
    let next = 0;
    try {
      const jobs = Array.from({ length: Math.min(4, tasks.length) }, async () => {
        try {
        while (next < tasks.length) {
          const task = tasks[next++], bytes = await fetchBytes(`${root}/${task.kind}/${task.tile}`, 'application/octet-stream', task.kind === 'wind' ? windBytes : fineBytes);
          if (!bytes) throw new Error('Numeric chunk missing');
          if (bytes.length !== (task.kind === 'wind' ? windBytes : fineBytes)) throw new Error('Numeric chunk length mismatch');
          if (task.kind === 'wind') {
            const columns = decodePackedWindChunk(bytes);
            if (columns.count !== descriptor.tileSize ** 2 || columns.levels !== descriptor.levels) throw new Error('Numeric chunk dimensions mismatch');
            wind.set(task.tile, columns);
          } else {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            for (let i = 0; i < bytes.length; i += WIND_FINE_CELL_BYTES) {
              const packed = view.getUint8(i + 8), support = view.getUint8(i + 9), terrain = packed & STATUS_MASK, lift = (packed >> 2) & STATUS_MASK;
              if ((packed & 0xe0) !== 0 || (support & ~SUPPORT_MASK) !== 0 || terrain === STATUS_NO_LIFT
                || (terrain === STATUS_VALID && !Number.isFinite(view.getFloat32(i, true)))
                || (lift <= STATUS_NO_LIFT && !Number.isFinite(view.getFloat32(i + 4, true)))) throw new Error('Invalid numeric companion');
            }
            fineData.set(task.tile, view);
          }
        }
        } catch (error) { controller.abort(); throw error; }
      });
      const settled = await Promise.allSettled(jobs), failed = settled.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    } catch (error) { controller.abort(); throw error; }
    combined.throwIfAborted();
    if (this.controller !== controller || build.expiresAtMs <= Date.now()) return 'unavailable';
    this.current = { build, bounds, tileSize: descriptor.tileSize, fineTileSize: descriptor.fineTileSize, native: native.grid, fineGrid: fine.grid, nativeGeometry: prepareGridGeometry(native.grid), fineGeometry: prepareGridGeometry(fine.grid), wind, fine: fineData };
    return 'ready';
  }

  sample(lat: number, lon: number, height: 'surface' | number | 'lift'): WindSample {
    const current = this.current;
    if (!current || current.build.expiresAtMs <= Date.now()) { this.current = undefined; return empty('unavailable'); }
    if (!withinGeographicBounds(lat, lon, current.bounds) || !withinGeographicBounds(lat, lon, current.build.manifest.descriptors.bounds)) return empty('outside');
    const windPlan = samplingPlan(current.native, current.nativeGeometry, lat, lon, 0), finePlan = samplingPlan(current.fineGrid, current.fineGeometry, lat, lon, 1);
    if (!windPlan || !finePlan) return empty('outside');
    let nearest = 0, nearestOutput = 0;
    for (let i = 0; i < finePlan.contributors.length; i++) {
      const item = finePlan.contributors[i], best = finePlan.contributors[nearest], size = current.fineTileSize;
      const tile = Math.floor(item.row / size) * Math.ceil(current.fineGrid.width / size) + Math.floor(item.column / size);
      const view = current.fine.get(tile);
      if (!view) return empty('unavailable');
      const pos = ((item.row % size) * size + item.column % size) * WIND_FINE_CELL_BYTES, packed = view.getUint8(pos + 8);
      values[i] = view.getFloat32(pos + (height === 'lift' ? 4 : 0), true);
      flags[i] = height === 'lift' ? ((packed >> 2) & STATUS_MASK) | view.getUint8(pos + 9) : packed & STATUS_MASK;
      if (i === 0 || nearerContributor(item.weight, item.row, item.column, best.weight, best.row, best.column)) {
        nearest = i; nearestOutput = (packed >> 4) & 1;
      }
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
      const tile = Math.floor(item.row / size) * Math.ceil(current.native.width / size) + Math.floor(item.column / size);
      chunks[i] = current.wind.get(tile); offsets[i] = (item.row % size) * size + item.column % size;
      if (!chunks[i]) { chunks.length = 0; return empty('unavailable'); }
    }
    offsets.length = chunks.length;
    const result = samplePackedWindColumns(windPlan, chunks, offsets, target);
    chunks.length = 0;
    return { u: result.u, v: result.v, status: result.status === STATUS_VALID ? 'valid' : result.status === STATUS_OUTSIDE ? 'outside' : 'unavailable' };
  }
  dispose(): void { this.disposed = true; this.controller?.abort(); this.current = undefined; }
}
