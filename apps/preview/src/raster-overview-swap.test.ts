import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Map } from 'maplibre-gl';
import type { PinnedBuild, RasterTileSourceProtocol, RasterTileSourceTransport } from '@av/client';
import type { LayerId } from '@av/contracts/layers';
import { renderedFrames } from '@av/contracts/publication';
import { fixtureBuild } from '../../../tests/forecast-fixture';
import { RasterOverlay, type OverlayState } from './raster-overlay';

interface Selection { build: PinnedBuild; layer: LayerId; frame: string }
interface Source { type: string; tiles?: string[]; selection?: Selection }
interface Paint { frame: string; quality: 'overview' | 'detail'; opacity: number }
interface OverviewDouble {
  id: string;
  warm(frame: string): void;
  warmAll(): void;
}
const overviews: OverviewDouble[] = [];
vi.mock('maplibre-gl', () => ({ addProtocol: vi.fn(), removeProtocol: vi.fn() }));
vi.mock('./raster-overview', () => ({ RasterOverview: class {
  readonly id = 'av-overview-test';
  readonly supported = true;
  private build: PinnedBuild | null = null;
  private layer: LayerId | null = null;
  private readonly frames = new Set<string>();
  private readonly transport: RasterTileSourceTransport;
  constructor(private readonly map: Map, protocol: RasterTileSourceProtocol, private readonly notify: () => void) {
    this.transport = protocol.createSource(false); overviews.push(this);
  }
  get state() { return { ready: this.frames.size, total: this.build ? renderedFrames(this.build.manifest).length : 0, failed: 0 }; }
  select(build: PinnedBuild, layer: LayerId) {
    if (this.build !== build || this.layer !== layer) { this.clear(); this.build = build; this.layer = layer; }
  }
  ready(build: PinnedBuild, layer: LayerId, frame: string) { return this.build === build && this.layer === layer && build.expiresAtMs > Date.now() && this.frames.has(frame); }
  show(build: PinnedBuild, layer: LayerId, frame: string, opacity: number) {
    if (!this.ready(build, layer, frame)) return false;
    if (!this.map.getSource(this.id)) {
      this.map.addSource(this.id, { type: 'image', coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] });
      this.map.addLayer({ id: this.id, type: 'raster', source: this.id, paint: { 'raster-opacity': 0, 'raster-fade-duration': 0 } });
    }
    (this.map.getSource(this.id) as unknown as Source).selection = { build, layer, frame };
    this.map.setPaintProperty(this.id, 'raster-opacity', opacity);
    return true;
  }
  hide() { if (this.map.getLayer(this.id)) this.map.setPaintProperty(this.id, 'raster-opacity', 0); }
  clear() {
    this.frames.clear(); this.build = null; this.layer = null;
    if (this.map.getLayer(this.id)) this.map.removeLayer(this.id);
    if (this.map.getSource(this.id)) this.map.removeSource(this.id);
  }
  refresh() { if (this.build && this.build.expiresAtMs <= Date.now()) { this.clear(); this.notify(); } }
  destroy() { this.clear(); this.transport.dispose(); }
  warm(frame: string) { this.frames.add(frame); this.notify(); }
  warmAll() { for (const frame of renderedFrames(this.build!.manifest)) this.frames.add(frame.id); this.notify(); }
} }));

function fixture(coveringCount = 1) {
  const handlers = new globalThis.Map<string, Set<(event: never) => void>>();
  const sources = new globalThis.Map<string, Source>(), opacity = new globalThis.Map<string, number>(), loaded = new Set<string>();
  const states: OverlayState[] = [], paints: Paint[][] = [];
  let moving = false;
  const map = {
    on: (event: string, callback: (event: never) => void) => { const set = handlers.get(event) ?? new Set(); set.add(callback); handlers.set(event, set); },
    off: (event: string, callback: (event: never) => void) => handlers.get(event)?.delete(callback),
    addSource: (id: string, source: Source) => sources.set(id, source), getSource: (id: string) => sources.get(id), removeSource: (id: string) => sources.delete(id),
    addLayer: (layer: { id: string; paint: Record<string, number> }) => opacity.set(layer.id, layer.paint['raster-opacity']),
    getLayer: (id: string) => opacity.has(id), removeLayer: (id: string) => opacity.delete(id),
    setPaintProperty: (id: string, _property: string, value: number) => opacity.set(id, value),
    isSourceLoaded: (id: string) => loaded.has(id), isMoving: () => moving,
    coveringTiles: () => Array.from({ length: coveringCount }, () => ({})), getZoom: () => 4, getCenter: () => ({ lng: -117, lat: 32 }),
    getBounds: () => ({ getWest: () => -118, getEast: () => -117, getSouth: () => 32, getNorth: () => 33 })
  };
  const overlay = new RasterOverlay(map as unknown as Map, 'https://api.test', 0.7, state => states.push(state));
  const emit = (name: string, event: object = {}) => {
    if (name === 'movestart') moving = true;
    if (name === 'moveend') moving = false;
    if (name === 'render') paints.push([...sources].flatMap(([id, source]) => {
      const value = opacity.get(id) ?? 0;
      if (!value) return [];
      return [{ frame: source.selection?.frame ?? /\/(f\d+)\//.exec(source.tiles![0])![1], quality: source.type === 'image' ? 'overview' : 'detail', opacity: value }];
    }));
    for (const handler of handlers.get(name) ?? []) handler(event as never);
  };
  const fine = (frame: string, layer: LayerId = 'usable-lift-agl') => [...sources].find(([, source]) => source.tiles?.[0].includes(`/${layer}/${frame}/`))?.[0];
  const complete = async (id: string) => { loaded.add(id); emit('sourcedata', { sourceId: id, tile: {} }); emit('render'); emit('render'); await Promise.resolve(); };
  const state = () => states.at(-1)!;
  const painted = () => paints.at(-1)!;
  const initial = async (build = fixtureBuild()) => {
    overlay.select(build, 'usable-lift-agl', build.manifest.frames[0].id);
    vi.advanceTimersByTime(100);
    await complete(fine(build.manifest.frames[0].id)!);
    return build;
  };
  return { overlay, sources, opacity, loaded, states, paints, emit, fine, complete, state, painted, initial, overview: () => overviews.at(-1)! };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-30T00:00:00Z')); overviews.length = 0;
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('acknowledges coarse pixels on render and hands off to fine pixels without alpha overlap', async () => {
  const f = fixture();
  try {
    const b = await f.initial(), [first, second] = b.manifest.frames;
    f.overview().warm(second.id); f.overlay.select(b, 'usable-lift-agl', second.id);
    expect(f.state()).toMatchObject({ displayed: { frame: first.id }, quality: 'detail' });
    expect(f.fine(second.id)).toBeUndefined();
    f.emit('render');
    expect(f.painted()).toEqual([{ frame: second.id, quality: 'overview', opacity: 0.7 }]);
    expect(f.state()).toMatchObject({ displayed: { frame: second.id }, quality: 'overview' });
    vi.advanceTimersByTime(100);
    const detail = f.fine(second.id)!; expect(detail).toBeDefined();
    f.loaded.add(detail); f.emit('sourcedata', { sourceId: detail, tile: {} }); f.emit('render');
    expect(f.state().quality).toBe('overview');
    expect(f.painted()).toEqual([{ frame: second.id, quality: 'overview', opacity: 0.7 }]);
    f.emit('render');
    expect(f.painted()).toEqual([{ frame: second.id, quality: 'detail', opacity: 0.7 }]);
    expect(f.state()).toMatchObject({ displayed: { frame: second.id }, quality: 'detail' });
    expect(f.paints.every(paint => paint.length <= 1)).toBe(true);
  } finally { f.overlay.destroy(); }
});

it('starts only the final cold detail after its own quiet interval', async () => {
  const f = fixture();
  try {
    const b = await f.initial(), [, second, third] = b.manifest.frames;
    f.overlay.select(b, 'usable-lift-agl', second.id);
    vi.advanceTimersByTime(60); f.overlay.select(b, 'usable-lift-agl', third.id);
    vi.advanceTimersByTime(40);
    expect(f.fine(second.id)).toBeUndefined(); expect(f.fine(third.id)).toBeUndefined();
    vi.advanceTimersByTime(59); expect(f.fine(third.id)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(f.fine(second.id)).toBeUndefined(); expect(f.fine(third.id)).toBeDefined();
    await f.complete(f.fine(third.id)!);
    expect(f.state()).toMatchObject({ displayed: { frame: third.id }, quality: 'detail' });
  } finally { f.overlay.destroy(); }
});

it('supersedes an unpainted overview without ever drawing its frame', async () => {
  const f = fixture();
  try {
    const b = await f.initial(), [first, second, third] = b.manifest.frames;
    f.overview().warm(second.id); f.overlay.select(b, 'usable-lift-agl', second.id);
    f.overlay.select(b, 'usable-lift-agl', third.id); f.emit('render');
    expect(f.painted()).toEqual([{ frame: first.id, quality: 'detail', opacity: 0.7 }]);
    vi.advanceTimersByTime(100); expect(f.fine(second.id)).toBeUndefined();
    vi.advanceTimersByTime(100); await f.complete(f.fine(third.id)!);
    expect(f.state()).toMatchObject({ displayed: { frame: third.id }, quality: 'detail' });
    expect(f.paints.flat().some(paint => paint.frame === second.id)).toBe(false);
  } finally { f.overlay.destroy(); }
});

it('restores the painted overview when a pending fine swap is superseded', async () => {
  const f = fixture();
  try {
    const b = await f.initial(), [, second, third] = b.manifest.frames;
    f.overview().warm(second.id); f.overlay.select(b, 'usable-lift-agl', second.id); f.emit('render');
    vi.advanceTimersByTime(100);
    const detail = f.fine(second.id)!;
    f.loaded.add(detail); f.emit('sourcedata', { sourceId: detail, tile: {} }); f.emit('render');
    f.overlay.select(b, 'usable-lift-agl', third.id); f.emit('render');
    expect(f.painted()).toEqual([{ frame: second.id, quality: 'overview', opacity: 0.7 }]);
    expect(f.state()).toMatchObject({ displayed: { frame: second.id }, quality: 'overview' });
    vi.advanceTimersByTime(100); await f.complete(f.fine(third.id)!);
    expect(f.paints.flat().some(paint => paint.frame === second.id && paint.quality === 'detail')).toBe(false);
    expect(f.paints.every(paint => paint.length <= 1)).toBe(true);
  } finally { f.overlay.destroy(); }
});

it.each(['movestart', 'resize'] as const)('cancels deferred refinement on %s and resumes detail for the settled viewport', async event => {
  const f = fixture();
  try {
    const b = await f.initial(), [, second] = b.manifest.frames;
    f.overview().warm(second.id); f.overlay.select(b, 'usable-lift-agl', second.id); f.emit('render');
    f.emit(event); f.emit('render');
    expect(f.painted()).toEqual([]);
    expect(f.state()).toMatchObject({ displayed: null, quality: null });
    const afterResize = f.fine(second.id);
    vi.advanceTimersByTime(200);
    if (event === 'movestart') { expect(f.fine(second.id)).toBeUndefined(); f.emit('moveend'); vi.advanceTimersByTime(100); }
    else { expect(afterResize).toBeDefined(); expect(f.fine(second.id)).toBe(afterResize); }
    const detail = f.fine(second.id)!; expect(detail).toBeDefined();
    await f.complete(detail);
    expect(f.state()).toMatchObject({ displayed: { frame: second.id }, quality: 'detail' });
  } finally { f.overlay.destroy(); }
});

it('retains a complete overview when some requested detail tiles fail', async () => {
  const f = fixture();
  try {
    const b = await f.initial(), [, second] = b.manifest.frames;
    f.overview().warm(second.id); f.overlay.select(b, 'usable-lift-agl', second.id); f.emit('render');
    vi.advanceTimersByTime(100);
    const detail = f.fine(second.id)!, good = {}, failed = {};
    f.emit('sourcedataloading', { sourceId: detail, tile: good });
    f.emit('sourcedataloading', { sourceId: detail, tile: failed });
    f.emit('sourcedata', { sourceId: detail, tile: good }); f.loaded.add(detail);
    f.emit('error', { sourceId: detail, tile: failed, error: new Error('503') });
    f.emit('render'); f.emit('render');
    expect(f.painted()).toEqual([{ frame: second.id, quality: 'overview', opacity: 0.7 }]);
    expect(f.state()).toMatchObject({ displayed: { frame: second.id }, quality: 'overview', replacementFailed: true });
    expect(f.paints.every(paint => paint.length <= 1)).toBe(true);
  } finally { f.overlay.destroy(); }
});

it.each(['build', 'layer'] as const)('clears an invalidated painted overview on %s without resurrecting older fine pixels', async action => {
  const f = fixture();
  try {
    const b = await f.initial(), [, second, third] = b.manifest.frames;
    f.overview().warm(second.id); f.overlay.select(b, 'usable-lift-agl', second.id); f.emit('render');
    if (action === 'build') f.overlay.select(fixtureBuild(), 'usable-lift-agl', third.id);
    else f.overlay.select(b, 'usable-lift-msl', third.id);
    f.emit('render');
    expect(f.painted()).toEqual([]);
    expect(f.state()).toMatchObject({ displayed: null, quality: null });
    vi.advanceTimersByTime(100);
    const detail = f.fine(third.id, action === 'layer' ? 'usable-lift-msl' : 'usable-lift-agl')!;
    await f.complete(detail);
    expect(f.state()).toMatchObject({ displayed: { frame: third.id }, quality: 'detail' });
  } finally { f.overlay.destroy(); }
});

it.each(['sourcedata', 'sourcedataabort'] as const)('keeps the active viewport loading until its outstanding tile settles via %s', async event => {
  const f = fixture();
  try {
    const b = await f.initial(), frame = b.manifest.frames[0].id, active = f.fine(frame)!, tile = {};
    f.emit('movestart'); f.loaded.delete(active);
    f.emit('sourcedataloading', { sourceId: active, tile }); f.emit('moveend'); f.emit('render');
    expect(f.state()).toMatchObject({ displayed: { frame }, viewLoading: true });
    f.loaded.add(active); f.emit(event, { sourceId: active, tile }); f.emit('render');
    expect(f.state()).toMatchObject({ displayed: { frame }, viewLoading: false });
  } finally { f.overlay.destroy(); }
});

it.each([false, true])('keeps one fine source within a large viewport budget (overview ready: %s)', async ready => {
  const f = fixture(64);
  try {
    const b = await f.initial(), [, second] = b.manifest.frames;
    if (ready) f.overview().warm(second.id);
    f.overlay.select(b, 'usable-lift-agl', second.id); f.emit('render');
    if (ready) {
      expect(f.painted()).toEqual([{ frame: second.id, quality: 'overview', opacity: 0.7 }]);
      vi.advanceTimersByTime(100); f.emit('render');
      expect(f.painted()).toEqual([{ frame: second.id, quality: 'overview', opacity: 0.7 }]);
    } else {
      vi.advanceTimersByTime(100); f.emit('render');
      expect(f.painted()).toEqual([]);
      expect(f.state()).toMatchObject({ displayed: null, quality: null });
    }
    expect([...f.sources.values()].filter(source => source.type === 'raster')).toHaveLength(1);
    const detail = f.fine(second.id)!; expect(detail).toBeDefined();
    await f.complete(detail);
    expect(f.painted()).toEqual([{ frame: second.id, quality: 'detail', opacity: 0.7 }]);
    expect([...f.sources.values()].filter(source => source.type === 'raster')).toHaveLength(1);
  } finally { f.overlay.destroy(); }
});

it.each(['clear', 'expire', 'build', 'layer'] as const)('invalidates an unpainted overview on %s', async action => {
  const f = fixture();
  try {
    const b = await f.initial(), [, second, third] = b.manifest.frames;
    f.overview().warm(second.id); f.overlay.select(b, 'usable-lift-agl', second.id);
    if (action === 'clear') f.overlay.clear();
    else if (action === 'expire') { vi.setSystemTime(b.expiresAtMs); f.overlay.refresh(); }
    else if (action === 'build') f.overlay.select(fixtureBuild(), 'usable-lift-agl', third.id);
    else f.overlay.select(b, 'usable-lift-msl', third.id);
    f.emit('render'); vi.advanceTimersByTime(200); f.emit('render');
    expect(f.paints.flat().some(paint => paint.frame === second.id)).toBe(false);
    expect(f.states.some(state => state.displayed?.frame === second.id)).toBe(false);
    if (action === 'clear' || action === 'expire') expect(f.state().displayed).toBeNull();
  } finally { f.overlay.destroy(); }
});

it('disables overview residency when one visible fine source consumes its reserved budget', async () => {
  const f = fixture(160);
  try {
    const b = await f.initial(), [, second] = b.manifest.frames;
    expect(f.state()).toMatchObject({ overviewReady: 0, overviewTotal: 0 });
    expect([...f.sources.values()].filter(source => source.type === 'raster')).toHaveLength(1);
    f.overlay.select(b, 'usable-lift-agl', second.id); f.emit('render');
    expect(f.state()).toMatchObject({ displayed: null, overviewReady: 0, overviewTotal: 0 });
    expect([...f.sources.values()].filter(source => source.type === 'raster')).toHaveLength(1);
    const detail = f.fine(second.id)!; expect(detail).toBeDefined();
    await f.complete(detail);
    expect(f.state()).toMatchObject({ displayed: { frame: second.id }, quality: 'detail', overviewTotal: 0 });
    expect(f.sources.has(f.overview().id)).toBe(false);
  } finally { f.overlay.destroy(); }
});

it('retains at most three fine source handles alongside the reserved overview handle', async () => {
  const f = fixture();
  try {
    const b = await f.initial(); f.overview().warmAll();
    for (let round = 0; round < 5; round++) {
      for (const [id, source] of [...f.sources]) if (source.type === 'raster' && !f.loaded.has(id)) await f.complete(id);
    }
    expect([...f.sources.values()].filter(source => source.type === 'raster')).toHaveLength(3);
    for (const frame of b.manifest.frames.slice(2, 6)) {
      f.overlay.select(b, 'usable-lift-agl', frame.id); f.emit('render'); vi.advanceTimersByTime(100);
      await f.complete(f.fine(frame.id)!);
      expect([...f.sources.values()].filter(source => source.type === 'raster').length).toBeLessThanOrEqual(3);
      expect(f.state().replacementFailed).toBe(false);
    }
    expect(f.paints.every(paint => paint.length <= 1)).toBe(true);
  } finally { f.overlay.destroy(); }
});
