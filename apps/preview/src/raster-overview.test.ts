import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Map } from 'maplibre-gl';
import type { RasterTileResponse, RasterTileSourceProtocol } from '@av/client';
import { MAX_TILE_BYTES } from '@av/contracts/format';
import { fixtureBuild } from '../../../tests/forecast-fixture';
import { RasterOverview } from './raster-overview';

class Bitmap {
  readonly width = 256;
  readonly height = 256;
  readonly close = vi.fn();
  constructor(readonly kind: 'tile' | 'overview') { bitmaps.push(this); }
}
const bitmaps: Bitmap[] = [];
const canvases: Canvas[] = [];
class Canvas {
  readonly context = { clearRect: vi.fn(), drawImage: vi.fn() };
  constructor(public width: number, public height: number) { canvases.push(this); }
  getContext() { return this.context; }
  transferToImageBitmap() { return new Bitmap('overview'); }
}
const decode = vi.fn<(...args: unknown[]) => Promise<Bitmap>>();
function build(count = 1) {
  const original = fixtureBuild(), first = original.manifest.frames[0];
  const frames = Array.from({ length: count }, (_, index) => {
    const validTime = new Date(Date.parse(first.validTime) + index * 3600_000).toISOString();
    return { id: `f${String(index + 1).padStart(3, '0')}`, validTime, intervalEnd: validTime,
      intervalStart: new Date(Date.parse(validTime) - 3600_000).toISOString() };
  });
  return fixtureBuild({ frames, mapFrameCount: count });
}
function fixture(held = false, bytes = 12, abortable = true) {
  let bounds = { west: -80, east: 80, south: -50, north: 50 }, zoom = 4;
  const sources = new globalThis.Map<string, { coordinates: number[][]; updateImage: ReturnType<typeof vi.fn> }>();
  const layers = new globalThis.Map<string, object>();
  const map = {
    getCanvas: () => ({}), getZoom: () => zoom,
    getBounds: () => ({ getWest: () => bounds.west, getEast: () => bounds.east, getSouth: () => bounds.south, getNorth: () => bounds.north }),
    getSource: (id: string) => sources.get(id), getLayer: (id: string) => layers.get(id),
    addSource: vi.fn((id: string, spec: { coordinates: number[][] }) => sources.set(id, { coordinates: spec.coordinates, updateImage: vi.fn() })),
    addLayer: vi.fn((layer: { id: string }) => layers.set(layer.id, layer)),
    removeLayer: vi.fn((id: string) => layers.delete(id)), removeSource: vi.fn((id: string) => sources.delete(id)),
    setPaintProperty: vi.fn()
  };
  const transport = { url: (url: string) => url, setInteractive: vi.fn(), dispose: vi.fn() };
  const requests: { url: string; signal: AbortSignal; resolve: (response: RasterTileResponse) => void; reject: (error: Error) => void }[] = [];
  const load = vi.fn(({ url }: { url: string }, controller: AbortController): Promise<RasterTileResponse> => new Promise((resolve, reject) => {
    requests.push({ url, signal: controller.signal, resolve, reject });
    if (abortable) controller.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    if (!held) resolve({ data: new ArrayBuffer(bytes) });
  }));
  const protocol = { load, createSource: vi.fn(() => transport), setBuildExpiry: vi.fn() };
  const onReady = vi.fn(), overview = new RasterOverview(map as unknown as Map, protocol as unknown as RasterTileSourceProtocol, onReady);
  const finish = (index: number, returnedBytes = bytes) => requests[index].resolve({ data: new ArrayBuffer(returnedBytes) });
  return { overview, map, sources, layers, requests, protocol, transport, onReady, finish,
    view: (value: typeof bounds, valueZoom = zoom) => { bounds = value; zoom = valueZoom; } };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-30T00:00:00Z'));
  bitmaps.length = 0; canvases.length = 0; decode.mockReset().mockImplementation(async () => new Bitmap('tile'));
  vi.stubGlobal('OffscreenCanvas', Canvas); vi.stubGlobal('createImageBitmap', decode);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('waits for every viewport tile while admitting at most two reads at once', async () => {
  const f = fixture(true), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.overview.select(b, 'usable-lift-agl', frame);
    expect(f.requests).toHaveLength(2);
    expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(false);
    f.finish(0); await Promise.resolve();
    expect(f.requests).toHaveLength(2);
    f.finish(1); await vi.waitFor(() => expect(f.requests).toHaveLength(4));
    f.finish(2); await Promise.resolve();
    expect(f.overview.state.ready).toBe(0);
    f.finish(3); await vi.waitFor(() => expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(true));
    expect(f.overview.state).toEqual({ ready: 1, total: 1, failed: 0 });
    expect(canvases[0].context.drawImage).toHaveBeenCalledTimes(4);
    expect(bitmaps.filter(image => image.kind === 'tile').every(image => image.close.mock.calls.length === 1)).toBe(true);
    expect(f.protocol.createSource).toHaveBeenCalledWith(false);
  } finally { f.overview.destroy(); }
});

it('reuses one image source and decoded frames for immediate timeline changes', async () => {
  const f = fixture(), b = build(3), frames = b.manifest.frames;
  try {
    f.overview.select(b, 'usable-lift-agl', frames[1].id);
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(3));
    const requests = f.requests.length;
    expect(f.overview.show(b, 'usable-lift-agl', frames[1].id, 0.7)).toBe(true);
    expect(f.overview.show(b, 'usable-lift-agl', frames[2].id, 0.7)).toBe(true);
    expect(f.overview.show(b, 'usable-lift-agl', frames[2].id, 0.4)).toBe(true);
    expect(f.map.addSource).toHaveBeenCalledOnce(); expect(f.map.addLayer).toHaveBeenCalledOnce();
    expect(f.sources.get(f.overview.id)!.updateImage).toHaveBeenCalledTimes(2);
    expect(f.requests).toHaveLength(requests);
    f.overview.hide();
    expect(f.map.setPaintProperty).toHaveBeenLastCalledWith(f.overview.id, 'raster-opacity', 0);
  } finally { f.overview.destroy(); }
});

it('never promotes a partially failed frame into an empty fallback', async () => {
  const f = fixture(true), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.overview.select(b, 'usable-lift-agl', frame);
    f.finish(0); f.requests[1].reject(new Error('503'));
    await vi.waitFor(() => expect(bitmaps.filter(image => image.kind === 'tile')[0]?.close).toHaveBeenCalledOnce());
    expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(false);
    expect(f.overview.show(b, 'usable-lift-agl', frame, 0.7)).toBe(false);
    expect(f.map.addSource).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.overview.state).toEqual({ ready: 0, total: 1, failed: 1 }));
    expect(f.onReady).toHaveBeenCalledOnce();
  } finally { f.overview.destroy(); }
});

it.each([
  { west: 170, east: 190, south: -20, north: 20 },
  { west: 530, east: 550, south: -20, north: 20 },
  { west: -190, east: -170, south: -20, north: 20 },
  { west: -170, east: 170, south: -2, north: 2 },
  { west: -2, east: 2, south: -90, north: 90 },
  { west: -540, east: 540, south: -85, north: 85 }
])('covers the whole canonical Mercator viewport with at most four tiles: %j', async bounds => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.view(bounds, 10); f.overview.select(b, 'usable-lift-agl', frame);
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(1));
    expect(f.requests.length).toBeGreaterThan(0); expect(f.requests.length).toBeLessThanOrEqual(4);
    for (const { url } of f.requests) {
      const [, z, x, y] = /\/(\d+)\/(\d+)\/(\d+)\.webp$/.exec(url)!;
      expect(Number(x)).toBeGreaterThanOrEqual(0); expect(Number(x)).toBeLessThan(2 ** Number(z));
      expect(Number(y)).toBeGreaterThanOrEqual(0); expect(Number(y)).toBeLessThan(2 ** Number(z));
    }
    f.overview.show(b, 'usable-lift-agl', frame, 0.7);
    const coordinates = f.sources.get(f.overview.id)!.coordinates;
    const middle = (coordinates[0][0] + coordinates[1][0]) / 2;
    expect(middle).toBeGreaterThanOrEqual(-180); expect(middle).toBeLessThan(180);
    expect(coordinates[1][0] - coordinates[0][0]).toBeCloseTo(Math.min(360, bounds.east - bounds.west));
    expect(coordinates[0][1]).toBeCloseTo(Math.min(85.0511287798066, bounds.north));
    expect(coordinates[2][1]).toBeCloseTo(Math.max(-85.0511287798066, bounds.south));
    const boxes = canvases[0].context.drawImage.mock.calls.map(call => call.slice(1) as number[]);
    expect(Math.min(...boxes.map(box => box[0]))).toBeLessThanOrEqual(0);
    expect(Math.min(...boxes.map(box => box[1]))).toBeLessThanOrEqual(0);
    expect(Math.max(...boxes.map(box => box[0] + box[2]))).toBeGreaterThanOrEqual(256);
    expect(Math.max(...boxes.map(box => box[1] + box[3]))).toBeGreaterThanOrEqual(256);
  } finally { f.overview.destroy(); }
});

it.each([
  { bounds: { west: -100, east: -80, south: 10, north: 40 }, tiles: 2, zoom: 3 },
  { bounds: { west: -10, east: 10, south: -10, north: 10 }, tiles: 4, zoom: 4 }
])('uses $tiles tiles at zoom $zoom while coarsening at most one level', async ({ bounds, tiles, zoom }) => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.view(bounds, 6); f.overview.select(b, 'usable-lift-agl', frame);
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(1));
    expect(f.requests).toHaveLength(tiles);
    for (const request of f.requests) expect(/\/(\d+)\/\d+\/\d+\.webp$/.exec(request.url)![1]).toBe(String(zoom));
    f.overview.show(b, 'usable-lift-agl', frame, 0.7);
    expect(f.sources.get(f.overview.id)!.coordinates).toEqual([
      [bounds.west, expect.closeTo(bounds.north)], [bounds.east, expect.closeTo(bounds.north)],
      [bounds.east, expect.closeTo(bounds.south)], [bounds.west, expect.closeTo(bounds.south)]
    ]);
  } finally { f.overview.destroy(); }
});

it('preempts an obsolete frame and retains the single reserved transport across contexts', async () => {
  const f = fixture(true), b = build(2), [first, second] = b.manifest.frames;
  try {
    f.overview.select(b, 'usable-lift-agl', first.id);
    f.overview.select(b, 'usable-lift-agl', first.id);
    expect(f.requests[0].signal.aborted).toBe(false);
    f.overview.select(b, 'usable-lift-agl', second.id);
    expect(f.requests.slice(0, 2).every(request => request.signal.aborted)).toBe(true);
    await vi.waitFor(() => expect(f.requests).toHaveLength(4));
    expect(f.requests[2].url).toContain(`/${second.id}/`);
    f.overview.clear(); f.overview.select(b, 'usable-lift-msl', second.id);
    await vi.waitFor(() => expect(f.requests).toHaveLength(6));
    expect(f.protocol.createSource).toHaveBeenCalledOnce(); expect(f.transport.dispose).not.toHaveBeenCalled();
  } finally { f.overview.destroy(); }
  expect(f.transport.dispose).toHaveBeenCalledOnce();
});

it('closes late decoded images before allocating work for a new context', async () => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  const pending: ((image: Bitmap) => void)[] = [];
  decode.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  try {
    f.overview.select(b, 'usable-lift-agl', frame);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    f.overview.clear(); f.overview.select(b, 'usable-lift-msl', frame);
    expect(f.requests).toHaveLength(2);
    decode.mockImplementation(async () => new Bitmap('tile'));
    const stale = [new Bitmap('tile'), new Bitmap('tile')];
    pending.forEach((resolve, index) => resolve(stale[index]));
    await vi.waitFor(() => expect(f.overview.ready(b, 'usable-lift-msl', frame)).toBe(true));
    expect(stale.every(image => image.close.mock.calls.length === 1)).toBe(true);
    expect(f.onReady).toHaveBeenCalledOnce();
    expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(false);
  } finally { f.overview.destroy(); }
});

it('bounds a long timeline to forty bitmaps while preserving the displayed image', async () => {
  const f = fixture(), b = build(60), frames = b.manifest.frames;
  try {
    f.overview.select(b, 'usable-lift-agl', frames[59].id);
    await vi.waitFor(() => expect(f.overview.state).toEqual({ ready: 40, total: 40, failed: 0 }));
    f.overview.show(b, 'usable-lift-agl', frames[59].id, 0.7);
    const shown = f.sources.get(f.overview.id)!.updateImage.mock.calls[0][0].image as Bitmap;
    f.overview.select(b, 'usable-lift-agl', frames[0].id);
    expect(shown.close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.overview.ready(b, 'usable-lift-agl', frames[0].id)).toBe(true));
    f.overview.show(b, 'usable-lift-agl', frames[0].id, 0.7);
    expect(shown.close).not.toHaveBeenCalled();
    // The owner can restore the last painted frame before superseding this staged image.
    expect(f.overview.show(b, 'usable-lift-agl', frames[59].id, 0.7)).toBe(true);
    f.overview.select(b, 'usable-lift-agl', frames[1].id);
    await vi.waitFor(() => expect(f.overview.ready(b, 'usable-lift-agl', frames[1].id)).toBe(true));
    f.overview.show(b, 'usable-lift-agl', frames[1].id, 0.7);
    f.overview.select(b, 'usable-lift-agl', frames[2].id);
    expect(shown.close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(40));
    expect(bitmaps.filter(image => image.kind === 'overview' && !image.close.mock.calls.length)).toHaveLength(40);
    expect(canvases).toHaveLength(1);
  } finally { f.overview.destroy(); }
});

it('rejects an uncovered viewport and disposes resident images on expiry', async () => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.overview.select(b, 'usable-lift-agl', frame);
    await vi.waitFor(() => expect(f.overview.state.ready).toBe(1));
    f.overview.show(b, 'usable-lift-agl', frame, 0.7);
    f.view({ west: 100, east: 120, south: 20, north: 40 });
    expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(false);
    expect(f.overview.show(b, 'usable-lift-agl', frame, 0.7)).toBe(false);
    vi.setSystemTime(b.expiresAtMs); f.overview.refresh();
    expect(f.overview.state).toEqual({ ready: 0, total: 0, failed: 0 });
    expect(f.sources.size).toBe(0);
    expect(bitmaps.every(image => image.close.mock.calls.length === 1)).toBe(true);
    expect(f.transport.dispose).not.toHaveBeenCalled();
  } finally { f.overview.destroy(); }
});

it('caps speculative returned bytes per context while allowing explicit frame selections', async () => {
  const f = fixture(false, 128 * 1024), b = build(4), frames = b.manifest.frames;
  try {
    f.overview.select(b, 'usable-lift-agl', frames[0].id);
    await vi.waitFor(() => expect(f.overview.state).toEqual({ ready: 2, total: 4, failed: 2 }));
    expect(f.requests).toHaveLength(8);
    expect(f.overview.ready(b, 'usable-lift-agl', frames[3].id)).toBe(false);
    f.overview.select(b, 'usable-lift-agl', frames[3].id);
    await vi.waitFor(() => expect(f.overview.ready(b, 'usable-lift-agl', frames[3].id)).toBe(true));
    expect(f.requests).toHaveLength(12);
    expect(f.overview.state).toEqual({ ready: 3, total: 4, failed: 1 });
    f.overview.select(b, 'usable-lift-msl', frames[0].id);
    await vi.waitFor(() => expect(f.overview.state).toEqual({ ready: 2, total: 4, failed: 2 }));
    expect(f.requests).toHaveLength(20);
  } finally { f.overview.destroy(); }
});

it('finishes the in-flight pair and stops before a further speculative tile batch', async () => {
  const f = fixture(true), b = build(3), frame = b.manifest.frames[0].id;
  try {
    f.overview.select(b, 'usable-lift-agl', frame);
    f.finish(0); f.finish(1); await vi.waitFor(() => expect(f.requests).toHaveLength(4));
    f.finish(2); f.finish(3); await vi.waitFor(() => expect(f.requests).toHaveLength(6));
    f.finish(4, MAX_TILE_BYTES); f.finish(5, MAX_TILE_BYTES);
    await vi.waitFor(() => expect(f.overview.state).toEqual({ ready: 1, total: 3, failed: 2 }));
    expect(f.requests).toHaveLength(6);
    expect(bitmaps.filter(image => image.kind === 'overview' && !image.close.mock.calls.length)).toHaveLength(1);
  } finally { f.overview.destroy(); }
});

it('excludes late aborted responses from the new context prefill budget', async () => {
  const f = fixture(true, 128 * 1024, false), b = build(3), frame = b.manifest.frames[0].id;
  try {
    f.overview.select(b, 'usable-lift-agl', frame);
    f.overview.clear(); f.overview.select(b, 'usable-lift-msl', frame);
    expect(f.requests).toHaveLength(2);
    f.finish(0, MAX_TILE_BYTES); f.finish(1, MAX_TILE_BYTES);
    await vi.waitFor(() => expect(f.requests).toHaveLength(4));
    f.finish(2); f.finish(3); await vi.waitFor(() => expect(f.requests).toHaveLength(6));
    f.finish(4); f.finish(5); await vi.waitFor(() => expect(f.requests).toHaveLength(8));
    f.finish(6); f.finish(7); await vi.waitFor(() => expect(f.requests).toHaveLength(10));
    f.finish(8); f.finish(9);
    await vi.waitFor(() => expect(f.overview.state).toEqual({ ready: 2, total: 3, failed: 1 }));
    expect(f.requests).toHaveLength(10);
    expect(f.overview.ready(b, 'usable-lift-msl', frame)).toBe(true);
    expect(f.overview.ready(b, 'usable-lift-agl', frame)).toBe(false);
  } finally { f.overview.destroy(); }
});

it('releases the canvas backing on clear and reallocates only for an admitted context', async () => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  expect(canvases[0]).toMatchObject({ width: 0, height: 0 });
  f.overview.select(b, 'usable-lift-agl', frame);
  expect(canvases[0]).toMatchObject({ width: 256, height: 256 });
  await vi.waitFor(() => expect(f.overview.state.ready).toBe(1));
  f.overview.clear();
  expect(canvases[0]).toMatchObject({ width: 0, height: 0 });
  expect(bitmaps.every(image => image.close.mock.calls.length === 1)).toBe(true);
  f.overview.select(b, 'usable-lift-msl', frame);
  expect(canvases[0]).toMatchObject({ width: 256, height: 256 });
  await vi.waitFor(() => expect(f.overview.state.ready).toBe(1));
  f.overview.destroy();
  expect(canvases[0]).toMatchObject({ width: 0, height: 0 });
});

it('leaves unsupported browsers on the existing fine renderer without reserving a handle', () => {
  vi.stubGlobal('createImageBitmap', undefined);
  const f = fixture(), b = build();
  f.overview.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
  expect(f.overview.supported).toBe(false); expect(f.protocol.createSource).not.toHaveBeenCalled();
  expect(f.overview.state).toEqual({ ready: 0, total: 0, failed: 0 });
  f.overview.destroy();
});
