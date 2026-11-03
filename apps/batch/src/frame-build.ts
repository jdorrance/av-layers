import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type CoverageMask, type Manifest, type ProductDefinition } from '@av/contracts';
import { deriveFrame, resolveProductFrameHours, validateNormalizedFrame, type DeriveFrameOptions, type NormalizedFrame } from '@av/forecast';
import type { ForecastProvider, ForecastSession } from './provider.js';
import { createRenderer } from './render.js';
import { summarizeFields } from './summary.js';
import { MAX_BUILD_LIFETIME_MS, type PreparedBuild } from './capacity.js';
import { createSamplePackBuilder } from './sample-pack.js';
import { failureReason } from './failure.js';
import { fileSha256, localPath } from './validate.js';

export interface FrameBuildOptions { signal?: AbortSignal; out: string; cycle?: string; cacheDir?: string; deriveOptions?: Pick<DeriveFrameOptions, 'daylightOnly'> }
export interface ForecastInputs { product: ProductDefinition; mask: CoverageMask; provider: ForecastProvider }
export interface BuildStamp { buildId: string; createdAt: string }
export interface FrameBuildResult {
  cycle: string;
  frames: Manifest['frames'];
  artifacts: Manifest['artifacts'];
  receipts: { hour: number; intervals: unknown; receipt: unknown }[];
  samples: { key: string; sha256: string; bytes: number; channelCount: number };
  metrics: {
    /** Summary observations are metadata, never inputs to the forecast calculation. */
    frames: Record<string, Record<string, unknown>>;
    phasesMs: { acquireMs: number; deriveMs: number; packMs: number; renderMs: number };
    renderer: Record<string, unknown>;
    acquisition: Record<string, unknown>;
    elapsedMs: number;
    peakRssBytes: number;
  };
}

export function forecastFrame(cycle: string, hour: number, intervalHours: number): Manifest['frames'][number] {
  const start = new Date(Date.parse(cycle) + (hour - intervalHours) * 3_600_000).toISOString();
  const end = new Date(Date.parse(cycle) + hour * 3_600_000).toISOString();
  return { id: `f${String(hour).padStart(3, '0')}`, validTime: end, intervalStart: start, intervalEnd: end };
}

const sameInstant = (actual: unknown, expected: string): boolean => typeof actual === 'string' && Date.parse(actual) === Date.parse(expected);

/** Source intervals retain their observed times; every execution path checks the same support. */
export function matchesFrameIntervals(intervals: unknown, frame: Manifest['frames'][number], requiresPrecipitation: boolean): boolean {
  if (!intervals || typeof intervals !== 'object') return false;
  const value = intervals as Partial<NormalizedFrame['intervals']>;
  return sameInstant(value.profileTime, frame.validTime)
    && sameInstant(value.fluxWindow?.start, frame.intervalStart) && sameInstant(value.fluxWindow?.end, frame.intervalEnd)
    && (!requiresPrecipitation || (sameInstant(value.precipitationWindow?.start, frame.intervalStart) && sameInstant(value.precipitationWindow?.end, frame.intervalEnd)));
}

/** One bounded provider/renderer session; both local and distributed builds use this frame pipeline. */
export async function buildFrames(options: FrameBuildOptions & ForecastInputs & BuildStamp & { prepared: PreparedBuild; hours?: readonly number[]; samplesKey: string; journalPrefix: string }): Promise<FrameBuildResult> {
  const { product, mask, provider, buildId, samplesKey, journalPrefix } = options;
  // Numerical overrides would disagree with the method parameters recorded in the build.
  const deriveOptions = { daylightOnly: options.deriveOptions?.daylightOnly };
  const root = resolve(options.out), started = Date.now(), prefix = `builds/${product.modelId}/${buildId}`;
  const cacheDir = options.cacheDir ?? join(root, '.cache', provider.id);
  const { indices, layout, capacity } = options.prepared, active = indices.active;
  let channel = 0;
  const frames: Manifest['frames'] = [], artifacts: Manifest['artifacts'] = [], receipts: FrameBuildResult['receipts'] = [], summaries: FrameBuildResult['metrics']['frames'] = {};
  const renderer = createRenderer(mask, { signal: options.signal, rasterWorkers: capacity.rasterWorkers });
  await mkdir(localPath(root, journalPrefix), { recursive: true });
  const journal = (name: string, data: unknown) => writeFile(localPath(root, `${journalPrefix}/${name}.json`), JSON.stringify(data));
  await journal('progress', { state: 'acquiring', buildId, startedAt: new Date(started).toISOString() });
  let pack: ReturnType<typeof createSamplePackBuilder> | undefined;
  let acquisition: ForecastSession | undefined;
  let completedFrames = 0, frameHour: number | null = null, phase = 'open-provider';
  try {
    options.signal?.throwIfAborted();
    acquisition = await provider.open({ cycle: options.cycle, activeIndices: active, cacheDir, signal: options.signal });
    const cycle = new Date(acquisition.cycle).toISOString();
    if (options.cycle && Date.parse(cycle) !== Date.parse(options.cycle)) throw new Error('Provider cycle differs from requested cycle');
    const hours = options.hours ?? resolveProductFrameHours(product, mask, cycle, { ...deriveOptions, outputIndices: indices.output });
    const channelCount = hours.length * product.layers.length;
    pack = createSamplePackBuilder(layout, channelCount);
    let acquireMs = 0, deriveMs = 0, packMs = 0, renderMs = 0;
    for (const hour of hours) {
      frameHour = hour; phase = 'acquire';
      options.signal?.throwIfAborted();
      if (Date.now() - Date.parse(options.createdAt) > MAX_BUILD_LIFETIME_MS) throw new Error('Build exceeded six-hour publisher lifetime');
      const tAcquire = Date.now();
      const frame = await acquisition.acquire(hour);
      validateNormalizedFrame(frame, active, mask.grid, provider.maxLevels, product.layers, product.capabilities.verticalCoordinate);
      acquireMs += Date.now() - tAcquire;
      const descriptor = forecastFrame(cycle, hour, product.intervalHours), { id } = descriptor;
      if (!sameInstant(frame.cycle, cycle) || frame.hour !== hour || !sameInstant(frame.validAt, descriptor.validTime) || !matchesFrameIntervals(frame.intervals, descriptor, product.layers.includes('precip-rate'))) {
        throw new Error(`Acquisition interval mismatch f${hour}`);
      }
      frames.push(descriptor);
      receipts.push({ hour, intervals: frame.intervals, receipt: frame.receipt });
      const tDerive = Date.now();
      phase = 'derive';
      const fields = deriveFrame(frame, mask, { ...deriveOptions, layers: product.layers });
      summaries[id] = summarizeFields(fields, mask, indices.output, product.layers);
      deriveMs += Date.now() - tDerive;
      phase = 'pack';
      const targets = product.layers.map(layer => {
        const field = fields[layer];
        if (!field) throw new Error(`Missing derived field for layer ${layer}`);
        const tilesKey = `${prefix}/${layer}/${id}.pmtiles`;
        const tPack = Date.now();
        pack!.writeChannel(channel++, field);
        packMs += Date.now() - tPack;
        return { path: localPath(root, tilesKey), field, layer, tilesKey };
      });
      const tRender = Date.now();
      phase = 'render';
      await renderer.renderArchives(targets);
      phase = 'hash-artifacts';
      for (const { path, layer, tilesKey } of targets) artifacts.push({ layer, frame: id, tilesKey, tilesSha256: await fileSha256(path) });
      renderMs += Date.now() - tRender;
      completedFrames++;
      phase = 'write-progress';
      await journal('progress', { state: 'rendered-frame', buildId, hour, completedFrames, elapsedMs: Date.now() - started, phasesMs: { acquireMs, deriveMs, packMs, renderMs }, peakRssBytes: process.resourceUsage().maxRSS * 1024 });
    }
    frameHour = null; phase = 'finalize-pack';
    const tPack = Date.now();
    const packed = await pack.finish(localPath(root, samplesKey));
    packMs += Date.now() - tPack;
    return { cycle, frames, artifacts, receipts, samples: { ...packed, key: samplesKey, channelCount }, metrics: {
      frames: summaries, phasesMs: { acquireMs, deriveMs, packMs, renderMs }, renderer: renderer.metrics(), acquisition: acquisition.stats,
      elapsedMs: Date.now() - started, peakRssBytes: process.resourceUsage().maxRSS * 1024
    } };
  } catch (error) {
    await journal('failure', { version: 1, state: 'failed', buildId, provider: provider.id, cycle: acquisition?.cycle ?? options.cycle, phase, failedFrameHour: frameHour, completedFrames, elapsedMs: Date.now() - started, cancelled: options.signal?.aborted ?? false, error: failureReason(error) });
    throw error;
  } finally {
    pack?.close();
    await acquisition?.close();
  }
}
