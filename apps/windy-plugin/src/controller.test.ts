import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureBuild, fixtureManifest } from '../../../tests/forecast-fixture';
import type { PinnedBuild } from '@av/contracts/client';
import { PluginController, type HostStore, type HostTileEvent, type HostTileEventName, type HostTileLayer, type WindyHost, type WindyTileOptions } from './controller';

afterEach(() => vi.useRealTimers());

const created = '2026-10-30T00:00:00.000Z';
const expiresAt = '2026-10-31T00:00:00.000Z';
function frames() { return fixtureManifest().frames.slice(0, 3); }
function pinned(overrides: { expiresAt?: string; frames?: ReturnType<typeof frames> } = {}): PinnedBuild {
  return fixtureBuild({ buildId: 'build-1', createdAt: created, expiresAt, frames: frames(), ...overrides });
}

class StubLayer implements HostTileLayer {
  url: string;
  options: WindyTileOptions;
  opacity: number;
  listeners = new Map<string, Set<(event: HostTileEvent) => void>>();
  constructor(url: string, options: WindyTileOptions) {
    this.url = url;
    this.options = options;
    this.opacity = options.opacity;
  }
  setUrl(url: string): void {
    this.url = url;
  }
  setOpacity(opacity: number): void {
    this.opacity = opacity;
  }
  on(event: HostTileEventName, listener: (event: HostTileEvent) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }
  off(event: HostTileEventName, listener: (event: HostTileEvent) => void): void {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: HostTileEventName | 'load', payload: HostTileEvent = { tile: {} }): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

function stubHost(initialTimestamp: number | null = null) {
  const added: StubLayer[] = [];
  const removed: StubLayer[] = [];
  const listeners = new Set<(value: number) => void>();
  const values = new Map<string, unknown>();
  if (initialTimestamp !== null) values.set('timestamp', initialTimestamp);
  const store: HostStore = {
    get: key => values.get(key),
    set: (key, value) => {
      const changed = values.get(key) !== value;
      values.set(key, value);
      if (changed) for (const listener of [...listeners]) listener(value);
      return true;
    },
    on: (_event, listener) => {
      listeners.add(listener);
    },
    off: (_event, listener) => {
      listeners.delete(listener);
    }
  };
  const host: WindyHost = {
    map: {
      addLayer: layer => {
        added.push(layer as StubLayer);
      },
      removeLayer: layer => {
        removed.push(layer as StubLayer);
      }
    },
    store,
    createTileLayer: (url, options) => new StubLayer(url, options)
  };
  return { host, added, removed, listeners, values };
}

describe('PluginController', () => {
  it('removes a partially mounted view when host subscription fails', async () => {
    const stub = stubHost();
    const subscribe = stub.host.store.on;
    stub.host.store.on = (event, listener) => {
      subscribe(event, listener);
      throw new Error('Host subscription failed');
    };
    const controller = new PluginController({ model: 'gfs', loadBuild: async () => pinned(), host: stub.host, now: () => Date.parse(created) });
    expect(await controller.start()).toMatchObject({ phase: 'error', message: 'Host subscription failed' });
    expect(stub.added).toHaveLength(1);
    expect(stub.removed).toEqual(stub.added);
    expect(stub.listeners.size).toBe(0);
    expect([...stub.added[0].listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
    controller.dispose();
    expect(stub.removed).toHaveLength(1);
  });
  it('starts from an exact host frame, adds one 256px non-retina layer at 0.5 opacity', async () => {
    const stub = stubHost(Date.parse('2026-10-30T06:00:00.000Z'));
    const loadBuild = vi.fn(async () => pinned());
    const controller = new PluginController({ model: 'gfs', loadBuild, host: stub.host, now: () => Date.parse(created) });
    const state = await controller.start();
    expect(loadBuild).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({ phase: 'ready', buildId: 'build-1', frameId: 'f006', layerId: 'usable-lift-msl', opacity: 0.5 });
    expect(state?.badge).toContain('Host frame f006');
    expect(stub.added).toHaveLength(1);
    expect(stub.added[0].url).toContain('/usable-lift-msl/f006/{z}/{x}/{y}.webp');
    expect(stub.added[0].options).toMatchObject({ tileSize: 256, detectRetina: false, maxNativeZoom: 7, maxZoom: 18, opacity: 0.5 });
  });

  it('keeps each failed tile visible until that tile succeeds or leaves the viewport', async () => {
    const stub = stubHost();
    const controller = new PluginController({ model: 'gfs', loadBuild: async () => pinned(), host: stub.host, now: () => Date.parse(created) });
    await controller.start();
    const layer = stub.added[0];
    const a = { tile: {} }, b = { tile: {} }, c = { tile: {} };
    for (const tile of [a, b, c]) layer.emit('tileloadstart', tile);
    layer.emit('tileerror', a);
    layer.emit('tileerror', c);
    layer.emit('tileload', b);
    layer.emit('load');
    expect(controller.state().message).toContain('Overlay tile failed to load');
    layer.emit('tileload', a);
    expect(controller.state().message).toContain('Overlay tile failed to load');
    layer.emit('tileunload', c);
    expect(controller.state().message).toBeNull();
    layer.emit('tileerror', c);
    expect(controller.state().message).toBeNull();
    controller.dispose();
  });

  it.each(['frame', 'layer'] as const)('resets failures only on a new %s and ignores old tile events', async change => {
    const stub = stubHost();
    const controller = new PluginController({ model: 'gfs', loadBuild: async () => pinned(), host: stub.host, now: () => Date.parse(created) });
    await controller.start();
    const layer = stub.added[0];
    const oldTile = { tile: {} }, newTile = { tile: {} };
    layer.emit('tileloadstart', oldTile);
    layer.emit('tileerror', oldTile);
    controller.selectFrame('f003');
    controller.syncHost(Date.parse('2026-10-30T03:00:00.000Z'));
    controller.selectLayer('usable-lift-msl');
    expect(controller.state().message).toContain('Overlay tile failed to load');
    if (change === 'frame') controller.selectFrame('f006');
    else controller.selectLayer('precip-rate');
    expect(controller.state().message).toBeNull();
    layer.emit('tileerror', oldTile);
    expect(controller.state().message).toBeNull();
    layer.emit('tileloadstart', newTile);
    layer.emit('tileerror', newTile);
    layer.emit('tileload', oldTile);
    layer.emit('tileunload', oldTile);
    expect(controller.state().message).toContain('Overlay tile failed to load');
    layer.emit('tileload', newTile);
    expect(controller.state().message).toBeNull();
    controller.dispose();
  });

  it('preserves other errors when a failed tile recovers', async () => {
    const stub = stubHost();
    const controller = new PluginController({ model: 'gfs', loadBuild: async () => pinned(), host: stub.host, now: () => Date.parse(created) });
    await controller.start();
    controller.selectFrame('unknown');
    const tile = { tile: {} };
    stub.added[0].emit('tileloadstart', tile);
    stub.added[0].emit('tileerror', tile);
    expect(controller.state().message).toContain('Unknown frame unknown');
    expect(controller.state().message).toContain('Overlay tile failed to load');
    stub.added[0].emit('tileload', tile);
    expect(controller.state().message).toBe('Unknown frame unknown');
    controller.dispose();
  });

  it('shows exhausted forecast horizons on load while retaining historical viewing', async () => {
    const stub = stubHost();
    const controller = new PluginController({ model: 'gfs', loadBuild: async () => pinned(), host: stub.host, now: () => Date.parse('2026-10-30T10:00:00.000Z') });
    await controller.start();
    expect(controller.state().phase).toBe('ready');
    expect(controller.state().horizonNotice).toContain('Forecast ended at 2026-10-30T09:00:00.000Z');
    expect(controller.state().message).toBeNull();
    expect(stub.added).toHaveLength(1);
    expect(controller.selectFrame('f006').frameId).toBe('f006');
    controller.dispose();
  });

  it('announces an idle build reaching its horizon without hiding errors, then expires it at retention end', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-30T08:59:59.000Z'));
    const stub = stubHost();
    const onState = vi.fn();
    const controller = new PluginController({ model: 'gfs', loadBuild: async () => pinned(), host: stub.host, onState });
    await controller.start();
    const tile = { tile: {} };
    stub.added[0].emit('tileloadstart', tile);
    stub.added[0].emit('tileerror', tile);
    expect(controller.state().horizonNotice).toBeNull();
    await vi.advanceTimersByTimeAsync(1001);
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'ready',
      horizonNotice: expect.stringContaining('Forecast ended'),
      message: expect.stringContaining('Overlay tile failed to load')
    }));
    expect(stub.removed).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(Date.parse(expiresAt) - Date.now() + 1);
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'expired', horizonNotice: null }));
    expect(stub.removed).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    controller.dispose();
  });

  it('syncs an explicit frame to the host timestamp only inside the verified dataset range', async () => {
    const stub = stubHost();
    const controller = new PluginController({ model: 'gfs', loadBuild: async () => pinned(), host: stub.host, now: () => Date.parse(created), hostRange: () => ({ startMs: Date.parse(created), endMs: Date.parse('2026-10-30T07:00:00.000Z') }) });
    await controller.start();
    const state = controller.selectFrame('f006');
    expect(state.frameId).toBe('f006');
    expect(stub.values.get('timestamp')).toBe(Date.parse('2026-10-30T06:00:00.000Z'));
    expect(stub.listeners.size).toBe(1);
    expect(stub.added[0].url).toContain('/f006/');
    controller.selectFrame('f009');
    expect(stub.values.get('timestamp')).toBe(Date.parse('2026-10-30T06:00:00.000Z'));
    expect(stub.added[0].url).toContain('/f009/');
  });

  it('does not sync the host when the verified dataset range is unavailable', async () => {
    const stub = stubHost();
    const set = vi.spyOn(stub.host.store, 'set');
    const controller = new PluginController({ model: 'gfs', loadBuild: async () => pinned(), host: stub.host, now: () => Date.parse(created) });
    await controller.start();
    controller.selectFrame('f006');
    expect(set).not.toHaveBeenCalled();
    expect(stub.values.has('timestamp')).toBe(false);
  });

  it('keeps the selected frame and badges an off-frame host time without nearest substitution', async () => {
    const stub = stubHost();
    const controller = new PluginController({ model: 'gfs', loadBuild: async () => pinned(), host: stub.host, now: () => Date.parse(created) });
    await controller.start();
    controller.selectFrame('f003', { syncHost: false });
    const state = controller.syncHost(Date.parse('2026-10-30T04:59:00.000Z'));
    expect(state.frameId).toBe('f003');
    expect(state.badge).toContain('off-frame');
    expect(state.badge).toContain('f003');
    expect(stub.added[0].url).toContain('/f003/');
  });

  it('switches layers and changes opacity on the existing layer', async () => {
    const stub = stubHost();
    const controller = new PluginController({ model: 'gfs', loadBuild: async () => pinned(), host: stub.host, now: () => Date.parse(created) });
    await controller.start();
    controller.selectLayer('precip-rate');
    expect(stub.added[0].url).toContain('/precip-rate/');
    controller.setOpacity(0.7);
    expect(stub.added[0].opacity).toBe(0.7);
    expect(controller.state().opacity).toBe(0.7);
  });

  it('removes the layer, aborts in-flight work and disposes on expiry', async () => {
    const capture: { signal?: AbortSignal } = {};
    const clearTimer = vi.fn();
    const stub = stubHost();
    const controller = new PluginController({
      model: 'gfs',
      loadBuild: async (_model, options) => {
        capture.signal = options.signal;
        return pinned();
      },
      host: stub.host,
      now: () => Date.parse(created),
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer
    });
    await controller.start();
    expect(capture.signal?.aborted).toBe(false);
    const expired = controller.checkExpiry(Date.parse(expiresAt) + 1);
    expect(expired).toBe(true);
    expect(controller.state().phase).toBe('expired');
    expect(controller.state().badge).toContain('expired');
    expect(stub.removed).toHaveLength(1);
    expect(capture.signal?.aborted).toBe(true);
    expect(clearTimer).toHaveBeenCalled();
  });

  it('tears down subscriptions and ignores input after dispose', async () => {
    const stub = stubHost();
    const controller = new PluginController({ model: 'gfs', loadBuild: async () => pinned(), host: stub.host, now: () => Date.parse(created) });
    await controller.start();
    expect(stub.listeners.size).toBe(1);
    const before = stub.added[0].url;
    controller.dispose();
    expect(stub.listeners.size).toBe(0);
    expect(stub.removed).toHaveLength(1);
    const state = controller.selectFrame('f009');
    expect(state.phase).toBe('disposed');
    expect(stub.added[0].url).toBe(before);
  });

  it('cancels a pending manifest load when disposed', async () => {
    const capture: { signal?: AbortSignal } = {};
    const stub = stubHost();
    const controller = new PluginController({
      model: 'gfs',
      loadBuild: async (_model, options) => {
        capture.signal = options.signal;
        return await new Promise<PinnedBuild>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      },
      host: stub.host,
      now: () => Date.parse(created)
    });
    const pending = controller.start();
    controller.dispose();
    await expect(pending).resolves.toBeNull();
    expect(capture.signal?.aborted).toBe(true);
    expect(stub.added).toHaveLength(0);
  });
});
