import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addProtocol, type Map } from 'maplibre-gl';
import type { RasterTileProtocol } from '@av/client';
import { fixtureBuild } from '../../../tests/forecast-fixture';
import { RasterOverlay, type OverlayState } from './raster-overlay';

vi.mock('maplibre-gl', () => ({ addProtocol: vi.fn(), removeProtocol: vi.fn() }));
const build = () => fixtureBuild();
function fixture() {
  const handlers = new globalThis.Map<string, Set<(event: never) => void>>();
  const sources = new globalThis.Map<string, unknown>();
  const opacity = new globalThis.Map<string, number>();
  const loaded = new Set<string>();
  const map = {
    on: (name: string, listener: (event: never) => void) => { const set = handlers.get(name) ?? new Set(); set.add(listener); handlers.set(name, set); },
    off: (name: string, listener: (event: never) => void) => handlers.get(name)?.delete(listener),
    addSource: (id: string, source: unknown) => sources.set(id, source),
    getSource: (id: string) => sources.get(id),
    removeSource: (id: string) => sources.delete(id),
    addLayer: (layer: { id: string; paint: Record<string, number> }) => opacity.set(layer.id, layer.paint['raster-opacity']),
    getLayer: (id: string) => opacity.has(id),
    removeLayer: (id: string) => opacity.delete(id),
    setPaintProperty: (id: string, _property: string, value: number) => opacity.set(id, value),
    isSourceLoaded: (id: string) => loaded.has(id),
    getZoom: () => 0,
    getBounds: () => ({ getWest: () => -118, getEast: () => -117, getSouth: () => 32, getNorth: () => 33 })
  };
  const states: OverlayState[] = [];
  const overlay = new RasterOverlay(map as unknown as Map, 'https://api.test', 0.7, state => states.push(state));
  const emit = (name: string, event: object = {}) => { for (const handler of handlers.get(name) ?? []) handler(event as never); };
  const stage = () => [...sources.keys()].at(-1)!;
  const complete = async (sourceId = stage()) => { loaded.add(sourceId); emit('sourcedata', { sourceId, tile: {} }); emit('render'); await Promise.resolve(); };
  return { overlay, emit, complete, stage, opacity, sources, states, markLoaded: (id: string) => loaded.add(id) };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-30T00:00:00Z'));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(Uint8Array.of(82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80), {
    headers: { 'content-type': 'image/webp', 'content-length': '12', 'cache-control': 'public, max-age=3600' }
  })));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('warms the next frame after commit without waiting for map idle', async () => {
  const f = fixture(), b = build();
  try {
    f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
    expect(fetch).not.toHaveBeenCalled();
    await f.complete();
    expect(fetch).toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes(`/${b.manifest.frames[1].id}/`))).toBe(true);
    const started = vi.mocked(fetch).mock.calls.length;
    f.emit('idle'); f.emit('idle');
    expect(fetch).toHaveBeenCalledTimes(started);
  } finally { f.overlay.destroy(); }
});

it.each(['supersede', 'move', 'clear', 'destroy', 'expire'] as const)('skips queued commit prefetch after %s', async action => {
  const f = fixture(), b = build();
  try {
    f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
    const sourceId = f.stage(); f.markLoaded(sourceId);
    f.emit('sourcedata', { sourceId, tile: {} }); f.emit('render');
    if (action === 'supersede') f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[1].id);
    else if (action === 'move') f.emit('movestart');
    else if (action === 'clear') f.overlay.clear();
    else if (action === 'destroy') f.overlay.destroy();
    else vi.setSystemTime(b.expiresAtMs + 1);
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  } finally { f.overlay.destroy(); }
});

it('waits beyond 150 ms and retains the committed frame until successful replacement rendering', async () => {
  const f = fixture(), b = build();
  f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[0].id); await f.complete();
  const old = f.stage();
  f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[1].id);
  expect(f.opacity.get(old)).toBe(0.7); expect(f.opacity.get(f.stage())).toBe(0);
  vi.advanceTimersByTime(1000); f.emit('render');
  expect(f.sources.has(old)).toBe(true);
  await f.complete();
  expect(f.sources.has(old)).toBe(false);
  expect(f.states.at(-1)?.displayed?.frame).toBe(b.manifest.frames[1].id);
  f.overlay.destroy();
});

it('keeps old imagery on a source failure and ignores success events from superseded sources', async () => {
  const f = fixture(), b = build();
  f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[0].id); await f.complete();
  const committed = f.stage();
  f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[1].id); const superseded = f.stage();
  f.overlay.select(b, 'usable-lift-msl', b.manifest.frames[1].id);
  await f.complete(superseded);
  expect(f.sources.has(committed)).toBe(true);
  f.emit('error', { sourceId: f.stage(), error: new Error('offline') });
  expect(f.sources.size).toBe(1); expect(f.opacity.get(committed)).toBe(0.7);
  expect(f.states.at(-1)?.replacementFailed).toBe(true);
  f.overlay.destroy();
});

it('keeps partial staging imagery when one tile fails and commits it with the remaining tiles', async () => {
  const f = fixture(), b = build();
  f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[0].id); await f.complete();
  const committed = f.stage();
  f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[1].id);
  const staging = f.stage(), tile = {};
  f.emit('error', { sourceId: staging, tile, error: new Error('offline') });
  expect(f.sources.has(staging)).toBe(true);
  expect(f.states.at(-1)?.replacementFailed).toBe(false);
  f.markLoaded(staging);
  f.emit('error', { sourceId: staging, tile: {}, error: new Error('settled empty') });
  expect(f.sources.has(staging)).toBe(false);
  expect(f.states.at(-1)?.replacementFailed).toBe(true);
  f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[1].id);
  const retry = f.stage();
  f.emit('error', { sourceId: retry, tile, error: new Error('offline') });
  await f.complete(retry);
  expect(f.sources.has(committed)).toBe(false);
  expect(f.states.at(-1)?.incomplete).toBe(true);
  expect(f.states.at(-1)?.replacementFailed).toBe(false);
  f.overlay.destroy();
});

it.each([false, true])('settles a stationary viewport with no tiles and retries on movement (old raster: %s)', async committed => {
  const f = fixture(), b = build();
  if (committed) { f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[0].id); await f.complete(); }
  const previous = committed ? f.stage() : null;
  f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[1].id);
  const empty = f.stage(), tile = {};
  f.markLoaded(empty);
  f.emit('render');
  expect(f.sources.has(empty)).toBe(true);
  f.emit('movestart');
  f.emit('sourcedataloading', { sourceId: empty, tile });
  f.emit('sourcedataabort', { sourceId: empty, tile });
  f.emit('idle');
  expect(f.sources.has(empty)).toBe(true);
  f.emit('moveend');
  f.emit('idle');
  expect([...f.sources.keys()]).toEqual(previous ? [previous] : []);
  expect(f.states.at(-1)?.replacementFailed).toBe(true);
  f.emit('idle');
  expect(f.sources.has(empty)).toBe(false);
  f.emit('movestart'); f.emit('moveend');
  expect(f.stage()).not.toBe(empty);
  await f.complete();
  expect(f.states.at(-1)?.displayed?.frame).toBe(b.manifest.frames[1].id);
  expect(f.states.at(-1)?.replacementFailed).toBe(false);
  f.overlay.destroy();
});

it('settles from the staging source idle event even while unrelated map sources remain busy', async () => {
  const f = fixture(), b = build();
  f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
  const sourceId = f.stage();
  f.markLoaded(sourceId);
  f.emit('sourcedata', { sourceId, isSourceLoaded: true, sourceDataType: 'metadata' });
  f.emit('sourcedata', { sourceId: 'basemap', isSourceLoaded: true, sourceDataType: 'idle' });
  await Promise.resolve();
  expect(f.sources.has(sourceId)).toBe(true);
  f.emit('sourcedata', { sourceId, isSourceLoaded: true, sourceDataType: 'idle' });
  await Promise.resolve();
  expect(f.sources.has(sourceId)).toBe(false);
  expect(f.states.at(-1)?.replacementFailed).toBe(true);
  f.overlay.destroy();
});

it('ignores a failed staging tile that leaves the viewport during a pan', async () => {
  const f = fixture(), b = build();
  f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
  await f.complete();
  f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[1].id);
  const sourceId = f.stage(), tile = {};
  f.emit('movestart');
  f.markLoaded(sourceId);
  f.emit('error', { sourceId, tile, error: new Error('offscreen tile failed') });
  expect(f.sources.has(sourceId)).toBe(true);
  f.emit('sourcedataabort', { sourceId, tile });
  f.emit('moveend');
  await f.complete();
  expect(f.states.at(-1)).toMatchObject({
    displayed: { frame: b.manifest.frames[1].id }, incomplete: false, replacementFailed: false
  });
  f.overlay.destroy();
});

it('rechecks camera readiness and expires old imagery while a new model is loading', async () => {
  const f = fixture(), b = build();
  b.expiresAtMs = Date.now() + 1000;
  f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[0].id); await f.complete();
  f.overlay.select(b, 'usable-lift-msl', b.manifest.frames[0].id);
  f.emit('movestart'); await f.complete();
  expect(f.sources.size).toBe(2);
  f.emit('moveend'); f.emit('render'); await Promise.resolve(); expect(f.sources.size).toBe(1);
  vi.advanceTimersByTime(1001); expect(f.sources.size).toBe(0);
  f.overlay.destroy();
});

it('allows a healthy replacement to finish after the displayed source reports an error', async () => {
  const f = fixture(), b = build();
  f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[0].id); await f.complete();
  const old = f.stage();
  f.overlay.select(b, 'usable-lift-msl', b.manifest.frames[0].id); const next = f.stage();
  f.emit('error', { sourceId: old, tile: {}, error: new Error('old viewport failed') });
  expect(f.sources.has(next)).toBe(true);
  await f.complete(next);
  expect(f.states.at(-1)?.incomplete).toBe(false);
  expect(f.states.at(-1)?.replacementFailed).toBe(false);
  expect(f.sources.has(old)).toBe(false);
  f.overlay.destroy();
});

it.each(['commit', 'failure'] as const)('preserves target prefetch through selection and cancels background work on %s', async outcome => {
  const requests: { url: string; signal: AbortSignal; resolve(response: Response): void }[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>((url, init) => new Promise((resolve, reject) => {
    const signal = init!.signal!;
    requests.push({ url: String(url), signal, resolve });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })));
  const f = fixture(), b = build();
  let interactive: Promise<unknown> | null = null;
  try {
    f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[0].id); await f.complete(); f.emit('idle');
    expect(requests.length).toBeGreaterThan(0);
    const target = requests[0];
    f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[1].id);
    expect(target.signal.aborted).toBe(false);
    const [scheme, handler] = vi.mocked(addProtocol).mock.calls.at(-1)!;
    const load = handler as RasterTileProtocol['load'];
    interactive = load({ url: `${scheme}://${target.url}` }, new AbortController());
    void interactive.catch(() => {});
    expect(requests.filter(request => request.url === target.url)).toHaveLength(1);
    const bytes = new Uint8Array([82,73,70,70,4,0,0,0,87,69,66,80]);
    target.resolve(new Response(bytes, { headers: { 'content-type': 'image/webp', 'content-length': '12', 'cache-control': 'public, max-age=3600' } }));
    await interactive;
    if (outcome === 'commit') await f.complete();
    else f.emit('error', { sourceId: f.stage(), error: new Error('decode failed') });
    expect(requests.some(request => request !== target && request.signal.aborted)).toBe(true);
    expect(requests.filter(request => request.url === target.url)).toHaveLength(1);
  } finally { f.overlay.destroy(); await interactive?.catch(() => {}); }
});
