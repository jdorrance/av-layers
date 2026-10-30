import { describe, expect, it, vi } from 'vitest';
import type { Manifest } from '@av/contracts';
import type { PinnedBuild } from '@av/contracts/client';
import { Lifecycle } from './lifecycle';
import { PluginController, type HostStore, type HostTileLayer, type WindyHost, type WindyTileOptions } from './controller';

const created = '2026-10-30T00:00:00.000Z';
const expiresAt = '2026-10-31T00:00:00.000Z';
const layerIds = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'] as const;

function frames() {
  return [
    { id: 'f003', validTime: '2026-10-30T03:00:00.000Z', intervalStart: '2026-10-30T00:00:00.000Z', intervalEnd: '2026-10-30T06:00:00.000Z' },
    { id: 'f006', validTime: '2026-10-30T06:00:00.000Z', intervalStart: '2026-10-30T03:00:00.000Z', intervalEnd: '2026-10-30T09:00:00.000Z' },
    { id: 'f009', validTime: '2026-10-30T09:00:00.000Z', intervalStart: '2026-10-30T06:00:00.000Z', intervalEnd: '2026-10-30T12:00:00.000Z' }
  ];
}

function pinned(overrides: { expiresAt?: string; frames?: ReturnType<typeof frames> } = {}): PinnedBuild {
  const frameList = overrides.frames ?? frames();
  const manifest: Manifest = {
    version: 1,
    model: 'gfs',
    buildId: 'build-1',
    cycle: created,
    createdAt: created,
    expiresAt: overrides.expiresAt ?? expiresAt,
    method: { id: 'dry-lenschow-pbl-1p2-v1', hash: 'a'.repeat(64) },
    coverage: { id: 'soaring-land-v1', hash: 'b'.repeat(64), maskKey: 'masks/soaring-land-v1', maxZoom: 5 },
    grid: { width: 1440, height: 721, lon0: -180, lat0: 90, dx: 0.25, dy: -0.25, wrapLongitude: true },
    frames: frameList,
    layers: [...layerIds],
    artifacts: layerIds.flatMap(layer => frameList.map(frame => ({
      layer,
      frame: frame.id,
      tilesKey: `builds/gfs/build-1/${layer}/${frame.id}.pmtiles`,
      samplesKey: `builds/gfs/build-1/samples/${layer}/${frame.id}.bin`,
      tilesSha256: 'c'.repeat(64),
      samplesSha256: 'd'.repeat(64)
    }))),
    source: {},
    tool: {},
    palettes: ['lift', 'rain'],
    metrics: {}
  };
  return {
    baseUrl: 'https://api.test',
    model: 'gfs',
    pointer: { version: 1, model: 'gfs', latestBuildId: 'build-1', retained: [{ buildId: 'build-1', manifestKey: 'builds/gfs/build-1/manifest.json', cycle: created, expiresAt: manifest.expiresAt }] },
    manifest,
    templates: Object.fromEntries(layerIds.map(layer => [layer, `https://api.test/tiles/gfs/build-1/${layer}/{frame}/{z}/{x}/{y}.png`])) as PinnedBuild['templates'],
    bounds: [-180, -55, 180, 65],
    maxNativeZoom: 5,
    palettes: [],
    coverage: { id: 'soaring-land-v1', hash: 'b'.repeat(64), maskKey: 'masks/soaring-land-v1', maxZoom: 5 },
    fetchedAtMs: Date.parse(created),
    expiresAtMs: Date.parse(manifest.expiresAt)
  };
}

class StubLayer implements HostTileLayer {
  url: string;
  options: WindyTileOptions;
  opacity: number;
  listeners = new Map<string, Set<() => void>>();
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
  on(event: 'tileerror' | 'tileload' | 'load', listener: () => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }
  off(event: 'tileerror' | 'tileload' | 'load', listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: 'tileerror' | 'tileload' | 'load'): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
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

describe('Lifecycle', () => {
  it('aborts and runs cleanups in reverse order exactly once', () => {
    const lifecycle = new Lifecycle();
    const order: string[] = [];
    lifecycle.add(() => order.push('first'));
    lifecycle.add(() => order.push('second'));
    lifecycle.dispose();
    lifecycle.dispose();
    expect(lifecycle.signal.aborted).toBe(true);
    expect(order).toEqual(['second', 'first']);
  });

  it('runs a cleanup immediately when added after disposal', () => {
    const lifecycle = new Lifecycle();
    lifecycle.dispose();
    const cleanup = vi.fn();
    lifecycle.add(cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('PluginController', () => {
  it('starts from an exact host frame, adds one 256px non-retina layer at 0.5 opacity', async () => {
    const stub = stubHost(Date.parse('2026-10-30T06:00:00.000Z'));
    const loadBuild = vi.fn(async () => pinned());
    const controller = new PluginController({ model: 'gfs', loadBuild, host: stub.host, now: () => Date.parse(created) });
    const state = await controller.start();
    expect(loadBuild).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({ phase: 'ready', buildId: 'build-1', frameId: 'f006', layerId: 'usable-lift-msl', opacity: 0.5 });
    expect(state?.badge).toContain('Host frame f006');
    expect(stub.added).toHaveLength(1);
    expect(stub.added[0].url).toContain('/usable-lift-msl/f006/{z}/{x}/{y}.png');
    expect(stub.added[0].options).toMatchObject({ tileSize: 256, detectRetina: false, maxNativeZoom: 5, maxZoom: 18, opacity: 0.5 });
  });

  it('surfaces overlay tile errors explicitly and clears them on tile load or frame switch', async () => {
    const stub = stubHost();
    const controller = new PluginController({ model: 'gfs', loadBuild: async () => pinned(), host: stub.host, now: () => Date.parse(created) });
    await controller.start();
    expect(controller.state().message).toBeNull();
    stub.added[0].emit('tileerror');
    expect(controller.state().message).toContain('Overlay tile failed to load');
    stub.added[0].emit('load');
    expect(controller.state().message).toBeNull();
    stub.added[0].emit('tileerror');
    expect(controller.state().message).toContain('Overlay tile failed to load');
    controller.selectFrame('f006');
    expect(controller.state().message).toBeNull();
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
