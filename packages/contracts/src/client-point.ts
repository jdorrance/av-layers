/** Load a point's selected sample first, with bounded pages for the remaining forecast. */
import { maxProfileFrames, renderedFrames, surfaceFrameCount, type LayerId, type PublishedManifest } from './index.ts';
import type { PinnedBuild, PointFrame, PointHorizon, PointSeries, PointSeriesLoader } from './client-types.ts';

const MAX_PAGES = 16;
const liftLayers = ['usable-lift-msl', 'usable-lift-agl'] as const;
const diagnostics = ['precip-rate', 'thermal-velocity', 'thermal-top-msl', 'surface-lcl-msl',
  'bl-mean-wind-u', 'bl-mean-wind-v', 'wind-10m-u', 'wind-10m-v'] as const;
const scalarFields: readonly LayerId[] = [...liftLayers, ...diagnostics, 'cloud-cover-total'];
// Chart scalars and the inputs to /profile cloud and wind diagnostics.
const profileFields: readonly LayerId[] = [...diagnostics, 'pbl-height-agl', 'wind-gust-10m',
  'sfc-temp-c', 'sfc-dewpoint-c', 'cape-jkg'];

/** Published map-lift layers and the frames where those layers can be sampled. */
export function pointLiftExpectation(build: PinnedBuild): { layers: readonly LayerId[]; frames: ReadonlySet<string> } {
  const { manifest } = build;
  if (manifest.version !== 5) {
    const layers = liftLayers.filter(layer => manifest.layers.includes(layer));
    return { layers, frames: new Set(layers.length ? manifest.frames.map(frame => frame.id) : []) };
  }
  const fine = manifest.surfaces.find(surface => surface.kind === 'fine');
  if (!fine) return { layers: [], frames: new Set() };
  const layers = liftLayers.filter(layer => fine.layers.includes(layer));
  return { layers, frames: new Set(manifest.frames.slice(0, surfaceFrameCount(manifest, fine)).map(frame => frame.id)) };
}

function pointSelection(build: PinnedBuild) {
  const { manifest } = build;
  const native = manifest.version === 5 ? manifest.surfaces.find(surface => surface.kind === 'native') : undefined;
  if (!native?.profiles) {
    const layers = scalarFields.filter(layer => manifest.layers.includes(layer));
    return { layers, sample: { layers, frames: undefined }, profile: null };
  }
  const sample = pointLiftExpectation(build);
  const selected = native.layers.filter(layer => profileFields.includes(layer));
  // The profile route requires a scalar selection alongside the atmospheric levels.
  const layers = selected.length ? selected : native.layers.slice(0, 1);
  return { layers: [...sample.layers, ...layers], sample, profile: { layers, levelCount: native.profiles.levelCount } };
}

function pointFrames(manifest: PublishedManifest, horizon: PointHorizon) {
  let frames = manifest.frames;
  if (horizon !== 'forecast') {
    if (manifest.version === 5 && manifest.mapFrameCount !== undefined) frames = renderedFrames(manifest);
    else {
      const until = Date.parse(frames[0].validTime) + 24 * 3600000;
      frames = frames.filter(frame => Date.parse(frame.validTime) < until);
    }
  }
  return frames.map(frame => frame.id);
}

export function pointSeriesSelection(build: PinnedBuild, horizon: PointHorizon = 'day') {
  const { layers } = pointSelection(build);
  return { layers, frames: layers.length ? pointFrames(build.manifest, horizon) : [] };
}

type ReadPage = (frames: readonly string[], layers: readonly LayerId[], signal: AbortSignal) => Promise<{ frames: readonly PointFrame[] }>;
interface PointSource {
  read: ReadPage;
  layers: readonly LayerId[];
  frames?: ReadonlySet<string>;
  ready: Set<string>;
  pageSize(): number;
}

export function createPointSeriesLoader(
  build: PinnedBuild,
  readSample: ReadPage,
  readProfile: ReadPage,
  assertLive: () => void
): PointSeriesLoader {
  const m = build.manifest, cache = new Map<string, PointFrame>();
  const sampled = new Set<string>(), profiled = new Set<string>();
  const { layers, sample, profile } = pointSelection(build);
  const sources: PointSource[] = [];
  if (sample.layers.length) sources.push({ read: readSample, layers: sample.layers, frames: sample.frames,
    ready: sampled, pageSize: () => Math.floor(m.descriptors.maxSampleValues / sample.layers.length) });
  if (profile) sources.push({ read: readProfile, layers: profile.layers, frames: undefined,
    ready: profiled, pageSize: () => maxProfileFrames(profile.levelCount, profile.layers.length) });
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
        if (disposed) throw new Error('Point series is closed');
        const assertActive = () => { controller.signal.throwIfAborted(); assertLive(); };
        assertActive();
        if (!layers.length) throw new Error('Point fields are unavailable');
        const frames = pointFrames(m, horizon);
        const first = frames.find(id => id === options?.frameId) ?? frames[0];
        const plans = sources.map(source => {
          const missing = frames.filter(id => (!source.frames || source.frames.has(id)) && !source.ready.has(id));
          const requests: string[][] = [];
          if (missing.length) {
            const pageSize = source.pageSize();
            if (pageSize < 1) throw new RangeError('Point response exceeds the byte budget');
            if (missing.includes(first)) requests.push([first]);
            const rest = missing.filter(id => id !== first);
            if (requests.length + Math.ceil(rest.length / pageSize) > MAX_PAGES) throw new RangeError('Point forecast page budget exceeded');
            for (let offset = 0; offset < rest.length; offset += pageSize) requests.push(rest.slice(offset, offset + pageSize));
          }
          return { source, requests };
        });
        const view = (): PointSeries => ({ layers, frames: frames.flatMap(id => cache.get(id) ?? []) });
        const progress = (loading: boolean, result?: PointSeries) => {
          assertActive();
          options?.onProgress?.(result ?? view(), frames.length, loading);
          assertActive();
        };
        let outstanding = plans.reduce((count, plan) => count + plan.requests.length, 0);
        if (outstanding && cache.has(first)) progress(true);
        let failure: { cause: unknown } | undefined;
        const settled = await Promise.allSettled(plans.map(async ({ source, requests }) => {
          for (const [index, ids] of requests.entries()) {
            let response;
            try { response = await source.read(ids, source.layers, controller.signal); }
            catch (cause) {
              assertActive();
              failure ??= { cause };
              outstanding -= requests.length - index;
              return;
            }
            assertActive();
            for (const frame of response.frames) {
              const previousFrame = cache.get(frame.id);
              cache.set(frame.id, previousFrame
                ? { ...previousFrame, ...frame, layers: { ...previousFrame.layers, ...frame.layers } }
                : frame);
              source.ready.add(frame.id);
            }
            if (--outstanding > 0) progress(true);
          }
        }));
        for (const result of settled) if (result.status === 'rejected') throw result.reason;
        assertActive();
        const result = view();
        if (!failure || result.frames.length) progress(false, result);
        if (failure) throw failure.cause;
        return result;
      })();
      pending = work;
      return work.finally(() => {
        signal?.removeEventListener('abort', abort);
        if (active === controller) active = null;
      });
    },
    dispose() { disposed = true; active?.abort(); cache.clear(); sampled.clear(); profiled.clear(); }
  };
}
