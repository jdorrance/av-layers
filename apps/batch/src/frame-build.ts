import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { coverageAtZoom, matchesFrameIntervals, sourceIntervalHours, TERRAIN_CLEARANCE_METHOD, type CoverageMask, type LayerId, type Manifest, type ProductDefinition } from '@av/contracts';
import { deriveFrame, resolveProductFrameHours, validateNormalizedFrame, type DeriveFrameOptions } from '@av/forecast';
import type { ForecastProvider, ForecastSession } from './provider.js';
import { createRenderer } from './render.js';
import { summarizeFields } from './summary.js';
import { MAX_BUILD_LIFETIME_MS, type PreparedBuild } from './capacity.js';
import { createSamplePackBuilder } from './sample-pack.js';
import { failureReason } from './failure.js';
import { fileSha256, localPath } from './validate.js';
import type { PreparedTerrainRef } from './terrain/prepare.js';
import { loadPreparedTerrain } from './terrain/staging.js';

export interface FrameBuildOptions { signal?: AbortSignal; out: string; cycle?: string; cacheDir?: string; deriveOptions?: Pick<DeriveFrameOptions, 'daylightOnly'>; terrain?: PreparedTerrainRef }
export interface ForecastInputs { product: ProductDefinition; mask: CoverageMask; provider: ForecastProvider }
export interface BuildStamp { buildId: string; createdAt: string }
export interface FrameBuildResult {
  cycle: string;
  frames: Manifest['frames'];
  artifacts: Manifest['artifacts'];
  receipts: { hour: number; intervals: unknown; receipt: unknown }[];
  samples: { key: string; sha256: string; bytes: number; channelCount: number };
  refinements?: { id: string; samples: FrameBuildResult['samples'] }[];
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
export { matchesFrameIntervals } from '@av/contracts';

/** One bounded provider/renderer session; both local and distributed builds use this frame pipeline. */
export async function buildFrames(options: FrameBuildOptions & ForecastInputs & BuildStamp & { prepared: PreparedBuild; hours?: readonly number[]; samplesKey: string; journalPrefix: string; refinementPrefix?: string }): Promise<FrameBuildResult> {
  options.signal?.throwIfAborted();
  options = { ...options, mask: coverageAtZoom(options.mask, options.product.maxNativeZoom) };
  const { product, mask, provider, buildId, samplesKey, journalPrefix } = options;
  // Numerical overrides would disagree with the method parameters recorded in the build.
  const deriveOptions = { daylightOnly: options.deriveOptions?.daylightOnly };
  const root = resolve(options.out), started = Date.now(), prefix = `builds/${product.modelId}/${buildId}`;
  const cacheDir = options.cacheDir ?? join(root, '.cache', provider.id);
  const { indices, layout, capacity } = options.prepared, active = indices.active;
  let channel = 0;
  const frames: Manifest['frames'] = [], artifacts: Manifest['artifacts'] = [], receipts: FrameBuildResult['receipts'] = [], summaries: FrameBuildResult['metrics']['frames'] = {};
  const refinements = options.prepared.refinements.map(patch => ({ ...patch,
    pack: undefined as ReturnType<typeof createSamplePackBuilder> | undefined,
    samplesKey: `${options.refinementPrefix ?? `${prefix}/refinements`}/${patch.input.id}/samples.bin`
  }));
  const cells = mask.grid.width * mask.grid.height;
  const diagnostics = refinements.length ? { ceilingMslM: new Float32Array(cells), buoyancyM2S3: new Float32Array(cells), branch: new Uint8Array(cells) } : undefined;
  const renderer = createRenderer(mask, { signal: options.signal, rasterWorkers: capacity.rasterWorkers,
    patches: refinements.map(patch => ({ id: patch.input.id, geometry: patch.input.geometry, descriptors: { bounds: patch.input.bounds }, layers: TERRAIN_CLEARANCE_METHOD.outputs, mask: patch.mask })) });
  await mkdir(localPath(root, journalPrefix), { recursive: true });
  const journal = (name: string, data: unknown) => writeFile(localPath(root, `${journalPrefix}/${name}.json`), JSON.stringify(data));
  await journal('progress', { state: 'acquiring', buildId, startedAt: new Date(started).toISOString() });
  let pack: ReturnType<typeof createSamplePackBuilder> | undefined;
  let acquisition: ForecastSession | undefined;
  let completedFrames = 0, frameHour: number | null = null, phase = 'open-provider';
  try {
    options.signal?.throwIfAborted();
    if (options.terrain) {
      phase = 'load-terrain';
      options.prepared.terrain = await loadPreparedTerrain({ ref: options.terrain, out: root, grid: product.grid, signal: options.signal });
    }
    phase = 'open-provider';
    acquisition = await provider.open({ cycle: options.cycle, activeIndices: active, cacheDir, signal: options.signal });
    const cycle = new Date(acquisition.cycle).toISOString();
    if (options.cycle && Date.parse(cycle) !== Date.parse(options.cycle)) throw new Error('Provider cycle differs from requested cycle');
    const hours = options.hours ?? resolveProductFrameHours(product, mask, cycle, { ...deriveOptions, outputIndices: indices.output });
    const channelCount = hours.length * product.layers.length;
    pack = createSamplePackBuilder(layout, channelCount);
    for (const patch of refinements) patch.pack = createSamplePackBuilder(patch.layout, hours.length * TERRAIN_CLEARANCE_METHOD.outputs.length);
    let acquireMs = 0, deriveMs = 0, packMs = 0, renderMs = 0;
    for (const hour of hours) {
      frameHour = hour; phase = 'acquire';
      options.signal?.throwIfAborted();
      if (Date.now() - Date.parse(options.createdAt) > MAX_BUILD_LIFETIME_MS) throw new Error('Build exceeded six-hour publisher lifetime');
      const tAcquire = Date.now();
      const frame = await acquisition.acquire(hour);
      validateNormalizedFrame(frame, active, mask.grid, provider.maxLevels, product.layers, product.capabilities.verticalCoordinate);
      acquireMs += Date.now() - tAcquire;
      const descriptor = forecastFrame(cycle, hour, sourceIntervalHours(product, hour)), { id } = descriptor;
      if (!sameInstant(frame.cycle, cycle) || frame.hour !== hour || !sameInstant(frame.validAt, descriptor.validTime) || !matchesFrameIntervals(frame.intervals, descriptor, product.layers.includes('precip-rate'))) {
        throw new Error(`Acquisition interval mismatch f${hour}`);
      }
      frames.push(descriptor);
      receipts.push({ hour, intervals: frame.intervals, receipt: frame.receipt });
      const tDerive = Date.now();
      phase = 'derive';
      const fields = deriveFrame(frame, mask, { ...deriveOptions, layers: product.layers, diagnostics });
      const fineFields = refinements.map(patch => {
        if (!fields['usable-lift-msl']) throw new Error('Terrain clearance requires the native MSL field');
        return patch.columns.derive(frame, patch.terrain, descriptor, {
          daylightOnly: deriveOptions.daylightOnly,
          nativeClearance: { validTime: descriptor.validTime, grid: mask.grid, diagnostics: diagnostics!, flags: fields['usable-lift-msl'].flags }
        }).fields;
      });
      summaries[id] = summarizeFields(fields, mask, indices.output, product.layers);
      deriveMs += Date.now() - tDerive;
      phase = 'pack';
      const tFinePack = Date.now();
      for (let index = 0; index < refinements.length; index++) {
        const fieldsForPatch = fineFields[index];
        for (let layerIndex = 0; layerIndex < TERRAIN_CLEARANCE_METHOD.outputs.length; layerIndex++) {
          refinements[index].pack!.writeChannel(completedFrames * TERRAIN_CLEARANCE_METHOD.outputs.length + layerIndex, fieldsForPatch[TERRAIN_CLEARANCE_METHOD.outputs[layerIndex]]);
        }
      }
      packMs += Date.now() - tFinePack;
      const targets = product.layers.map(layer => {
        const field = fields[layer];
        if (!field) throw new Error(`Missing derived field for layer ${layer}`);
        const tilesKey = `${prefix}/${layer}/${id}.pmtiles`;
        const tPack = Date.now();
        pack!.writeChannel(channel++, field);
        packMs += Date.now() - tPack;
        const patches = (TERRAIN_CLEARANCE_METHOD.outputs as readonly LayerId[]).includes(layer)
          ? Object.fromEntries(refinements.map((patch, index) => [patch.input.id, fineFields[index][layer as typeof TERRAIN_CLEARANCE_METHOD.outputs[number]]]))
          : undefined;
        return { path: localPath(root, tilesKey), field, layer, tilesKey, ...(patches ? { patches } : {}) };
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
    const refined: NonNullable<FrameBuildResult['refinements']> = [];
    for (const patch of refinements) {
      options.signal?.throwIfAborted();
      refined.push({ id: patch.input.id, samples: { ...await patch.pack!.finish(localPath(root, patch.samplesKey)),
        key: patch.samplesKey, channelCount: hours.length * TERRAIN_CLEARANCE_METHOD.outputs.length } });
    }
    packMs += Date.now() - tPack;
    return { cycle, frames, artifacts, receipts, samples: { ...packed, key: samplesKey, channelCount }, ...(refined.length ? { refinements: refined } : {}), metrics: {
      frames: summaries, phasesMs: { acquireMs, deriveMs, packMs, renderMs }, renderer: renderer.metrics(), acquisition: acquisition.stats,
      elapsedMs: Date.now() - started, peakRssBytes: process.resourceUsage().maxRSS * 1024
    } };
  } catch (error) {
    await journal('failure', { version: 1, state: 'failed', buildId, provider: provider.id, cycle: acquisition?.cycle ?? options.cycle, phase, failedFrameHour: frameHour, completedFrames, elapsedMs: Date.now() - started, cancelled: options.signal?.aborted ?? false, error: failureReason(error) });
    throw error;
  } finally {
    pack?.close();
    for (const patch of refinements) patch.pack?.close();
    delete options.prepared.terrain;
    await acquisition?.close();
  }
}
