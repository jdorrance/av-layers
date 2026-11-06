/** Select and cache one point's scalar frames; at most sixteen bounded pages load serially. */
import { renderedFrames, type LayerId } from './index.ts';
import type { FrameSample, PinnedBuild, PointHorizon, PointSeriesLoader, SamplePayload } from './client-types.ts';

const MAX_PAGES = 16;
const fields: readonly LayerId[] = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate', 'thermal-velocity', 'thermal-top-msl',
  'surface-lcl-msl', 'bl-mean-wind-u', 'bl-mean-wind-v', 'wind-10m-u', 'wind-10m-v', 'cloud-cover-total'];

export function pointSeriesSelection(build: PinnedBuild, horizon: PointHorizon = 'day') {
  const layers = fields.filter(layer => build.manifest.layers.includes(layer));
  let frames = build.manifest.frames;
  if (horizon !== 'forecast') {
    if (build.manifest.version === 5 && build.manifest.mapFrameCount !== undefined) frames = renderedFrames(build.manifest);
    else {
      const until = Date.parse(frames[0].validTime) + 24 * 3600000;
      frames = frames.filter(frame => Date.parse(frame.validTime) < until);
    }
  }
  return { layers, frames: layers.length ? frames.map(frame => frame.id) : [] };
}

export function createPointSeriesLoader(
  build: PinnedBuild,
  read: (frames: readonly string[], layers: readonly LayerId[], signal: AbortSignal) => Promise<SamplePayload>,
  assertLive: () => void
): PointSeriesLoader {
  const m = build.manifest, cache = new Map<string, FrameSample>();
  let pending: Promise<unknown> = Promise.resolve(), active: AbortController | null = null, disposed = false;
  return {
    load(horizon, signal, options) {
      active?.abort();
      const controller = new AbortController(); active = controller;
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const previous = pending;
      const work = (async () => {
        await previous.catch(() => {});
        controller.signal.throwIfAborted();
        if (disposed) throw new Error('Point series is closed');
        assertLive();
        const { frames, layers } = pointSeriesSelection(build, horizon);
        const pageSize = Math.floor(m.descriptors.maxSampleValues / layers.length);
        if (!frames.length || pageSize < 1) throw new Error('Point fields are unavailable');
        const missing = frames.filter(id => !cache.has(id));
        const first = frames.find(id => id === options?.frameId) ?? frames[0];
        const priority = cache.has(first) ? [] : [first], rest = missing.filter(id => id !== first);
        if (priority.length + Math.ceil(rest.length / pageSize) > MAX_PAGES) throw new RangeError('Point forecast page budget exceeded');
        const view = () => ({ layers, frames: frames.flatMap(id => cache.has(id) ? [cache.get(id)!] : []) });
        const progress = () => {
          controller.signal.throwIfAborted();
          assertLive();
          options?.onProgress?.(view(), frames.length);
          controller.signal.throwIfAborted();
          assertLive();
        };
        if (!priority.length) progress();
        const pages = priority.length ? [priority] : [];
        for (let offset = 0; offset < rest.length; offset += pageSize) pages.push(rest.slice(offset, offset + pageSize));
        for (const ids of pages) {
          const page = await read(ids, layers, controller.signal);
          controller.signal.throwIfAborted();
          assertLive();
          for (const frame of page.frames) cache.set(frame.id, frame);
          progress();
        }
        assertLive();
        return view();
      })();
      pending = work;
      return work.finally(() => {
        signal?.removeEventListener('abort', abort);
        if (active === controller) active = null;
      });
    },
    dispose() { disposed = true; active?.abort(); cache.clear(); }
  };
}
