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
  let moving = false;
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
    isMoving: () => moving,
    getZoom: () => 0,
    getBounds: () => ({ getWest: () => -118, getEast: () => -117, getSouth: () => 32, getNorth: () => 33 })
  };
  const states: OverlayState[] = [];
  const overlay = new RasterOverlay(map as unknown as Map, 'https://api.test', 0.7, state => states.push(state));
  const emit = (name: string, event: object = {}) => {
    if (name === 'movestart') moving = true;
    if (name === 'moveend') moving = false;
    for (const handler of handlers.get(name) ?? []) handler(event as never);
  };
  const stage = () => [...sources.keys()].find(id => opacity.get(id) === 0)!;
  const displayed = () => [...sources.keys()].find(id => opacity.get(id)! > 0)!;
  const complete = async (sourceId = stage()) => { loaded.add(sourceId); emit('sourcedata', { sourceId, tile: {} }); emit('render'); await Promise.resolve(); };
  return { overlay, map, setMoving: (value: boolean) => { moving = value; }, emit, complete, stage, displayed, opacity, sources, states, markLoaded: (id: string) => loaded.add(id) };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-30T00:00:00Z'));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(Uint8Array.of(82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80), {
    headers: { 'content-type': 'image/webp', 'content-length': '12', 'cache-control': 'public, max-age=3600' }
  })));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('prepares the sibling source before warming additional frames', async () => {
  const f = fixture(), b = build();
  try {
    f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
    expect(fetch).not.toHaveBeenCalled();
    await f.complete();
    expect(f.sources.size).toBe(2);
    expect((f.sources.get(f.stage()) as { tiles: string[] }).tiles[0]).toContain('/usable-lift-msl/');
    expect(fetch).not.toHaveBeenCalled();
    await f.complete();
    expect(fetch).toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes(`/${b.manifest.frames[1].id}/`))).toBe(true);
    const started = vi.mocked(fetch).mock.calls.length;
    f.emit('idle'); f.emit('idle');
    expect(fetch).toHaveBeenCalledTimes(started);
  } finally { f.overlay.destroy(); }
});

it('keeps a prepared layer invisible and reuses both sources on repeated toggles', async () => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.overlay.select(b, 'usable-lift-agl', frame); await f.complete();
    const agl = f.displayed(), msl = f.stage(), stateCount = f.states.length;
    await f.complete(msl);
    expect(f.states).toHaveLength(stateCount);
    expect(f.opacity.get(msl)).toBe(0);
    for (let i = 0; i < 10; i++) {
      const layer = i % 2 ? 'usable-lift-agl' : 'usable-lift-msl';
      f.overlay.select(b, layer, frame); f.emit('render'); await Promise.resolve();
      expect(f.states.at(-1)?.displayed).toMatchObject({ layer, frame });
      expect(f.sources.size).toBe(2);
      expect([...f.sources.keys()]).toEqual([agl, msl]);
      expect(f.opacity.get(i % 2 ? agl : msl)).toBe(0.7);
      expect(f.opacity.get(i % 2 ? msl : agl)).toBe(0);
    }
  } finally { f.overlay.destroy(); }
});

it.each([1, -1])('retains the previous prepared frame at the timeline boundary when stepping %i', async direction => {
  const f = fixture(), b = build(), frames = b.manifest.frames;
  const edge = direction === 1 ? frames.length - 1 : 0, previous = edge - direction;
  try {
    f.overlay.select(b, 'usable-lift-agl', frames[previous].id); await f.complete();
    const retained = f.displayed();
    f.overlay.select(b, 'usable-lift-agl', frames[edge].id); await f.complete();
    expect(f.stage()).toBe(retained);
    f.overlay.select(b, 'usable-lift-agl', frames[previous].id);
    expect(f.displayed()).toBe(retained);
    expect(f.sources.size).toBe(2);
  } finally { f.overlay.destroy(); }
});

it('retries partially failed speculative tiles before replacing the displayed view', async () => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.overlay.select(b, 'usable-lift-agl', frame); await f.complete();
    const displayed = f.displayed(), damaged = f.stage();
    await f.complete(damaged);
    f.emit('error', { sourceId: damaged, tile: {}, error: new Error('temporary tile failure') });
    f.overlay.select(b, 'usable-lift-msl', frame);
    expect(f.sources.has(damaged)).toBe(false);
    expect(f.displayed()).toBe(displayed);
    expect(f.states.at(-1)?.incomplete).toBe(false);
    await f.complete();
    expect(f.states.at(-1)).toMatchObject({ displayed: { layer: 'usable-lift-msl' }, incomplete: false });
  } finally { f.overlay.destroy(); }
});

it('rebuilds a damaged previous source before switching back after a pan', async () => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.overlay.select(b, 'usable-lift-agl', frame); await f.complete();
    const damaged = f.displayed();
    f.emit('movestart');
    f.emit('error', { sourceId: damaged, tile: {}, error: new Error('new viewport failed') });
    f.emit('moveend'); await f.complete();
    f.overlay.select(b, 'usable-lift-msl', frame); await Promise.resolve();
    const healthy = f.displayed();
    expect(f.sources.has(damaged)).toBe(false);
    f.overlay.select(b, 'usable-lift-agl', frame);
    expect(f.displayed()).toBe(healthy);
    expect(f.states.at(-1)?.incomplete).toBe(false);
    await f.complete();
    expect(f.states.at(-1)).toMatchObject({ displayed: { layer: 'usable-lift-agl' }, incomplete: false });
  } finally { f.overlay.destroy(); }
});

it('prepares an intended time without selecting it and follows the scrub direction', async () => {
  const f = fixture(), b = build(), [first, next, following] = b.manifest.frames;
  try {
    f.overlay.select(b, 'usable-lift-agl', first.id); await f.complete();
    const displayed = f.displayed(), discarded = f.stage();
    f.overlay.prepare('usable-lift-agl', next.id);
    const prepared = f.stage();
    expect(f.sources.has(discarded)).toBe(false);
    await f.complete(prepared);
    expect(f.states.at(-1)?.displayed?.frame).toBe(first.id);
    f.overlay.select(b, 'usable-lift-agl', next.id); await Promise.resolve();
    expect(f.displayed()).toBe(prepared);
    expect(f.sources.has(displayed)).toBe(false);
    expect((f.sources.get(f.stage()) as { tiles: string[] }).tiles[0]).toContain(`/${following.id}/`);
    expect(f.sources.size).toBe(2);
  } finally { f.overlay.destroy(); }
});

it('keeps background failures out of displayed state and retries on explicit selection', async () => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.overlay.select(b, 'usable-lift-agl', frame); await f.complete();
    const failed = f.stage(), stateCount = f.states.length;
    f.emit('error', { sourceId: failed, error: new Error('standby unavailable') });
    for (let i = 0; i < 3; i++) f.emit('idle');
    expect(f.sources.size).toBe(1);
    expect(f.states).toHaveLength(stateCount);
    expect(f.states.at(-1)).toMatchObject({ incomplete: false, replacementFailed: false });
    f.overlay.select(b, 'usable-lift-msl', frame);
    const retry = f.stage(); expect(retry).not.toBe(failed);
    await f.complete(retry);
    expect(f.states.at(-1)?.displayed?.layer).toBe('usable-lift-msl');
  } finally { f.overlay.destroy(); }
});

it('keeps both sources transparent when opacity is zero through a prepared swap', async () => {
  const f = fixture(), b = build(), frame = b.manifest.frames[0].id;
  try {
    f.overlay.select(b, 'usable-lift-agl', frame); await f.complete();
    const prepared = f.stage(); await f.complete(prepared);
    f.overlay.setOpacity(0);
    f.overlay.select(b, 'usable-lift-msl', frame); await Promise.resolve();
    expect([...f.opacity.values()]).toEqual([0, 0]);
    expect(f.states.at(-1)?.displayed?.layer).toBe('usable-lift-msl');
    f.overlay.setOpacity(0.5);
    expect(f.opacity.get(prepared)).toBe(0.5);
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
  const old = f.displayed();
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
  const committed = f.displayed();
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
  const committed = f.displayed();
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
  const previous = committed ? f.displayed() : null;
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
  const settled = f.stage();
  expect(settled).not.toBe(empty);
  f.markLoaded(settled);
  f.emit('idle');
  expect([...f.sources.keys()]).toEqual(previous ? [previous] : []);
  expect(f.states.at(-1)?.replacementFailed).toBe(true);
  f.emit('idle');
  expect(f.sources.has(settled)).toBe(false);
  f.emit('movestart'); f.emit('moveend');
  expect(f.stage()).not.toBe(settled);
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

it('keeps the displayed raster if the replacement only succeeded before a pan', async () => {
  const f = fixture(), b = build();
  try {
    const [previous, next] = b.manifest.frames;
    f.overlay.select(b, 'usable-lift-agl', previous.id); await f.complete();
    const displayed = f.displayed();
    f.overlay.select(b, 'usable-lift-agl', next.id);
    const oldViewport = f.stage(), pending = {};
    f.emit('sourcedataloading', { sourceId: oldViewport, tile: pending });
    f.emit('sourcedata', { sourceId: oldViewport, tile: {} });
    f.emit('movestart');
    f.emit('sourcedataabort', { sourceId: oldViewport, tile: pending });
    f.emit('moveend');
    const newViewport = f.stage();
    expect(newViewport).not.toBe(oldViewport);
    f.markLoaded(newViewport);
    f.emit('error', { sourceId: newViewport, tile: {}, error: new Error('new viewport failed') });
    f.emit('render'); await Promise.resolve();
    expect([...f.sources.keys()]).toEqual([displayed]);
    expect(f.states.at(-1)).toMatchObject({ displayed: { frame: previous.id }, replacementFailed: true });
  } finally { f.overlay.destroy(); }
});

it('rechecks camera readiness and expires old imagery while a new model is loading', async () => {
  const f = fixture(), b = build();
  b.expiresAtMs = Date.now() + 1000;
  f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[0].id); await f.complete();
  f.overlay.select(b, 'usable-lift-msl', b.manifest.frames[0].id);
  f.emit('movestart'); await f.complete();
  expect(f.sources.size).toBe(2);
  f.emit('moveend'); await f.complete(); expect(f.sources.size).toBe(2);
  vi.advanceTimersByTime(1001); expect(f.sources.size).toBe(0);
  f.overlay.destroy();
});

it('waits until moveend when first selected while the map is already moving', async () => {
  const f = fixture(), b = build();
  f.overlay.destroy();
  f.setMoving(true);
  const states: OverlayState[] = [];
  const overlay = new RasterOverlay(f.map as unknown as Map, 'https://api.test', 0.7, state => states.push(state));
  try {
    overlay.select(b, 'usable-lift-agl', b.manifest.frames[0].id);
    const midMove = f.stage();
    await f.complete(midMove);
    expect(states.at(-1)?.displayed).toBeNull();
    f.emit('moveend');
    const settled = f.stage();
    expect(settled).not.toBe(midMove);
    await f.complete(settled);
    expect(states.at(-1)?.displayed?.frame).toBe(b.manifest.frames[0].id);
  } finally { overlay.destroy(); }
});

it('restages on idle when a clamped zoom emits no movement events', async () => {
  const f = fixture(), b = build();
  try {
    const [previous, next] = b.manifest.frames;
    f.overlay.select(b, 'usable-lift-agl', previous.id);
    await f.complete();
    f.setMoving(true);
    f.overlay.select(b, 'usable-lift-agl', next.id);
    const midZoom = f.stage();
    await f.complete(midZoom);
    expect(f.states.at(-1)?.displayed?.frame).toBe(previous.id);
    f.setMoving(false);
    f.emit('idle');
    const settled = f.stage();
    expect(settled).not.toBe(midZoom);
    expect(f.states.at(-1)?.displayed?.frame).toBe(previous.id);
    await f.complete(settled);
    expect(f.states.at(-1)?.displayed?.frame).toBe(next.id);
  } finally { f.overlay.destroy(); }
});

it('allows a healthy replacement to finish after the displayed source reports an error', async () => {
  const f = fixture(), b = build();
  f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[0].id); await f.complete();
  const old = f.displayed();
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
    f.overlay.select(b, 'usable-lift-agl', b.manifest.frames[0].id); await f.complete(); await f.complete(); f.emit('idle');
    expect(requests.length).toBeGreaterThan(0);
    const target = requests.find(request => request.url.includes(`/${b.manifest.frames[1].id}/`))!;
    expect(target).toBeDefined();
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
