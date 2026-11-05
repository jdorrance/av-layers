/** Select and cache one point's scalar frames; at most sixteen bounded pages load serially. */
import { renderedFrames, type LayerId } from './index.ts';
import type { FrameSample, PinnedBuild, PointHorizon, PointSeriesLoader, SamplePayload } from './client-types.ts';

const MAX_PAGES = 16;
const fields: readonly LayerId[] = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate', 'thermal-velocity', 'thermal-top-msl',
  'surface-lcl-msl', 'bl-mean-wind-u', 'bl-mean-wind-v', 'wind-10m-u', 'wind-10m-v', 'cloud-cover-total'];

export function pointSeriesSelection(build: PinnedBuild, horizon: PointHorizon = 'day') {
  const layers = fields.filter(layer => build.manifest.layers.includes(layer));
  const frames = horizon === 'forecast' ? build.manifest.frames : renderedFrames(build.manifest).filter(frame =>
    Date.parse(frame.validTime) < Date.parse(build.manifest.frames[0].validTime) + 24 * 3600000);
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
    load(horizon, signal) {
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
        if (Math.ceil(missing.length / pageSize) > MAX_PAGES) throw new RangeError('Point forecast page budget exceeded');
        for (let offset = 0; offset < missing.length; offset += pageSize) {
          const page = await read(missing.slice(offset, offset + pageSize), layers, controller.signal);
          controller.signal.throwIfAborted();
          assertLive();
          for (const frame of page.frames) cache.set(frame.id, frame);
        }
        assertLive();
        return { layers, frames: frames.map(id => cache.get(id)!) };
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
