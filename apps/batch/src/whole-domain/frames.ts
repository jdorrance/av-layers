import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertWholeDomainDonorsActive, type LayerId, type Manifest } from '@av/contracts';
import { deriveFrame, resolveProductFrameHours, validateNormalizedFrame, type GridField, type PackedGridField, type ShardedSamplePackLayout } from '@av/forecast';
import type { ForecastProvider } from '../provider.js';
import { BUILD_BUDGETS } from '../capacity.js';
import { failureReason } from '../failure.js';
import { createRenderer } from '../render.js';
import { summarizeFields } from '../summary.js';
import { fileSha256, localPath } from '../validate.js';
import { forecastFrame, matchesFrameIntervals, type BuildStamp, type ForecastInputs, type FrameBuildOptions } from '../frame-build.js';
import { admitWholeDomain, wholeDomainSampleLayouts, type WholeDomainCapacity } from './capacity.js';
import { createShardedSamplePackWriter } from '../sample-pack-v5.js';
import type { ShardedSamplePackShard } from '../sample-pack-v5.js';
import { loadWholeDomainTerrain } from './prepare.js';
import type { WholeDomainPrepared } from './prepare.js';

export interface WholeDomainSurfaceResult {
  id: 'native' | 'fine';
  kind: 'native' | 'fine';
  grid: WholeDomainPrepared['plan']['fine'];
  gridHash: string;
  coverage: { id: string; hash: string; maskKey: string; maxZoom: number; gridHash: string };
  layers: LayerId[];
  layout: ShardedSamplePackLayout;
  shards?: ShardedSamplePackShard[];
  terrain?: { dataId: string; verticalDatum: string; surface: string; ref: WholeDomainPrepared['terrain']; layoutVersion: 1 };
}
export interface WholeDomainFrameResult {
  cycle: string;
  frames: Manifest['frames'];
  artifacts: Manifest['artifacts'];
  receipts: { hour: number; intervals: unknown; receipt: unknown }[];
  surfaces: WholeDomainSurfaceResult[];
  capacity: WholeDomainCapacity;
  metrics: {
    frames: Record<string, Record<string, unknown>>;
    phasesMs: { acquireMs: number; deriveMs: number; packMs: number; renderMs: number };
    renderer: Record<string, unknown>;
    acquisition: Record<string, unknown>;
    elapsedMs: number;
    peakRssBytes: number;
  };
}

export interface WholeDomainFrameOptions extends FrameBuildOptions, ForecastInputs, BuildStamp {
  prepared: WholeDomainPrepared;
  hours?: readonly number[];
  journalPrefix: string;
  surfaceTarget?: (surface: 'native' | 'fine') => string;
}

export async function buildWholeDomainFrames(options: WholeDomainFrameOptions): Promise<WholeDomainFrameResult> {
  options.signal?.throwIfAborted();
  const { product, mask, provider, prepared, buildId } = options;
  const root = resolve(options.out), started = Date.now(), cacheDir = options.cacheDir ?? join(root, '.cache', provider.id);
  const deriveOptions = { daylightOnly: options.deriveOptions?.daylightOnly };
  const prefix = `builds/${product.modelId}/${buildId}`;
  const journal = (name: string, data: unknown) => writeFile(localPath(root, `${options.journalPrefix}/${name}.json`), JSON.stringify(data));
  await mkdir(localPath(root, options.journalPrefix), { recursive: true });
  await journal('progress', { state: 'acquiring', buildId, startedAt: new Date(started).toISOString() });
  let acquisition: Awaited<ReturnType<ForecastProvider['open']>> | undefined;
  let nativeWriter: ReturnType<typeof createShardedSamplePackWriter> | undefined;
  let fineWriter: ReturnType<typeof createShardedSamplePackWriter> | undefined;
  let failed = false;
  let completedFrames = 0, frameHour: number | null = null, phase = 'open-provider';
  try {
    const nativeLayers = prepared.nativeSurfaceLayers.length, fineLayers = prepared.fineSurfaceLayers.length;
    const nativeBlocks = prepared.native.mask.coverage.blockIds;
    const capacityInput = { product, plan: prepared.plan, nativeBlocks, nativeActive: prepared.acquisitionActive.length,
      maxLevels: provider.maxLevels, retainedGeometryFields: provider.retainedGeometryFields ?? 0,
      fine: prepared.fine.mask, nativeMaskBytes: prepared.nativeMask.output.byteLength + prepared.nativeMask.halo.byteLength + prepared.nativeMask.tiles.byteLength,
      frames: options.hours?.length ?? product.frameHours.length, nativeLayers, fineLayers, columns: prepared.columns,
      terrainBytes: prepared.terrain.arrayBytes };
    const admission = admitWholeDomain(capacityInput);
    if (admission.violations.length) throw new Error(`Whole-domain build exceeds capacity: ${admission.violations.join('; ')}`);
    phase = 'load-terrain';
    const terrainData = await loadWholeDomainTerrain({ ref: prepared.terrain, out: root, grid: prepared.plan.fine,
      coverage: prepared.fine.mask.coverage, coverageDescriptor: prepared.fine.bytes, signal: options.signal });
    phase = 'open-provider';
    acquisition = await provider.open({ cycle: options.cycle, activeIndices: prepared.acquisitionActive, cacheDir, signal: options.signal });
    const cycle = new Date(acquisition.cycle).toISOString();
    if (options.cycle && Date.parse(cycle) !== Date.parse(options.cycle)) throw new Error('Provider cycle differs from requested cycle');
    const outputIndices = indicesOf(mask);
    const hours = options.hours ?? resolveProductFrameHours(product, mask, cycle, { ...deriveOptions, outputIndices });
    const capacity = admitWholeDomain({ ...capacityInput, frames: hours.length });
    if (capacity.violations.length) throw new Error(`Whole-domain build exceeds capacity: ${capacity.violations.join('; ')}`);
    const layouts = wholeDomainSampleLayouts({ ...capacityInput, frames: hours.length });
    const writer = (surface: 'native' | 'fine', layout: ShardedSamplePackLayout, coverage: typeof prepared.fine.mask.coverage) =>
      createShardedSamplePackWriter(layout, coverage, { root, model: product.modelId, buildId,
        surfaceId: options.surfaceTarget?.(surface) ?? surface }, { signal: options.signal });
    nativeWriter = layouts.native ? writer('native', layouts.native, prepared.native.mask.coverage) : undefined;
    fineWriter = writer('fine', layouts.fine, prepared.fine.mask.coverage);
    const workingHalo = mask.halo.slice();
    for (let i = 0; i < workingHalo.length; i++) workingHalo[i] |= prepared.requiredDonors[i]!;
    const workingMask = { ...mask, halo: workingHalo };
    const diagnostics = { ceilingMslM: new Float32Array(mask.grid.width * mask.grid.height), buoyancyM2S3: new Float32Array(mask.grid.width * mask.grid.height), branch: new Uint8Array(mask.grid.width * mask.grid.height) };
    const rendererOptions = { signal: options.signal, rasterWorkers: capacity.rasterWorkers, rasterSharedInputBytes: capacity.rasterSharedInputBytes };
    const nativeRenderer = createRenderer(mask, rendererOptions);
    const fineRenderer = createRenderer(prepared.fine.mask, rendererOptions);
    const frames: Manifest['frames'] = [], artifacts: Manifest['artifacts'] = [], receipts: WholeDomainFrameResult['receipts'] = [], summaries: Record<string, Record<string, unknown>> = {};
    let acquireMs = 0, deriveMs = 0, packMs = 0, renderMs = 0;
    for (const hour of hours) {
      frameHour = hour; phase = 'acquire'; options.signal?.throwIfAborted();
      if (Date.now() - Date.parse(options.createdAt) > BUILD_BUDGETS.elapsedMs) throw new Error('Build exceeded elapsedMs budget');
      const tAcquire = Date.now();
      const frame = await acquisition.acquire(hour);
      validateNormalizedFrame(frame, prepared.acquisitionActive, mask.grid, provider.maxLevels, product.layers, product.capabilities.verticalCoordinate);
      assertWholeDomainDonorsActive(prepared.plan, prepared.requiredDonors, frame.activeIndices);
      acquireMs += Date.now() - tAcquire;
      const descriptor = forecastFrame(cycle, hour, product.intervalHours), { id } = descriptor;
      if (!frame.cycle || !sameInstant(frame.cycle, cycle) || frame.hour !== hour || !sameInstant(frame.validAt, descriptor.validTime) || !matchesFrameIntervals(frame.intervals, descriptor, product.layers.includes('precip-rate'))) throw new Error(`Acquisition interval mismatch f${hour}`);
      frames.push(descriptor); receipts.push({ hour, intervals: frame.intervals, receipt: frame.receipt });
      const tDerive = Date.now(); phase = 'derive';
      const nativeFields = deriveFrame(frame, workingMask, { ...deriveOptions, layers: product.layers, diagnostics });
      if (!nativeFields['usable-lift-msl']) throw new Error('Whole-domain terrain derivation requires native MSL flags');
      const fineFields = (await prepared.columns.deriveAsync(frame, terrainData, descriptor, { daylightOnly: deriveOptions.daylightOnly,
        nativeClearance: { validTime: descriptor.validTime, grid: mask.grid, diagnostics, flags: nativeFields['usable-lift-msl'].flags },
        signal: options.signal, deadlineAt: Date.parse(options.createdAt) + BUILD_BUDGETS.elapsedMs,
        yieldControl: () => new Promise<void>(resolve => setImmediate(resolve)) })).fields;
      summaries[id] = summarizeFields(nativeFields, mask, outputIndices, product.layers);
      deriveMs += Date.now() - tDerive;
      const tPack = Date.now(); phase = 'pack';
      for (let index = 0; index < prepared.nativeSurfaceLayers.length; index++) {
        const layer = prepared.nativeSurfaceLayers[index]!, field = nativeFields[layer];
        if (!field) throw new Error(`Missing native field ${layer}`);
        await nativeWriter!.writeChannel(completedFrames * nativeLayers + index, field);
      }
      for (let index = 0; index < prepared.fineSurfaceLayers.length; index++) {
        const layer = prepared.fineSurfaceLayers[index]!, field = fineFields[layer as keyof typeof fineFields];
        if (!field) throw new Error(`Missing fine field ${layer}`);
        await fineWriter.writeChannel(completedFrames * fineLayers + index, field);
      }
      packMs += Date.now() - tPack;
      const tRender = Date.now(); phase = 'render';
      const nativeTargets: { path: string; field: GridField; layer: LayerId }[] = [];
      const fineTargets: { path: string; field: PackedGridField; layer: LayerId }[] = [];
      for (const layer of product.layers) {
        const tilesKey = `${prefix}/${layer}/${id}.pmtiles`, path = localPath(root, tilesKey);
        if (layer === 'precip-rate') nativeTargets.push({ path, field: nativeFields[layer]!, layer });
        else fineTargets.push({ path, field: fineFields[layer as keyof typeof fineFields]!, layer });
      }
      if (nativeTargets.length) await nativeRenderer.renderArchives(nativeTargets);
      if (fineTargets.length) await fineRenderer.renderArchives(fineTargets);
      renderMs += Date.now() - tRender;
      phase = 'hash-artifacts';
      for (const target of [...nativeTargets, ...fineTargets]) {
        const layer = target.layer;
        artifacts.push({ layer, frame: id, tilesKey: `${prefix}/${layer}/${id}.pmtiles`, tilesSha256: await fileSha256(target.path) });
      }
      completedFrames++;
      phase = 'write-progress';
      await journal('progress', { state: 'rendered-frame', buildId, hour, completedFrames, elapsedMs: Date.now() - started,
        phasesMs: { acquireMs, deriveMs, packMs, renderMs }, peakRssBytes: process.resourceUsage().maxRSS * 1024 });
    }
    frameHour = null; phase = 'finalize-pack';
    const tPack = Date.now();
    const shards = { native: await nativeWriter?.finish(), fine: await fineWriter.finish() };
    const surfaces: WholeDomainSurfaceResult[] = [];
    const coverageFor = (surface: 'native' | 'fine') => {
      const info = surface === 'native' ? prepared.native : prepared.fine;
      return { id: info.descriptor.id, hash: info.hash, maskKey: `coverage/${info.hash}/manifest.json`, maxZoom: info.mask.maxZoom, gridHash: info.descriptor.gridHash };
    };
    for (const surface of ['native', 'fine'] as const) {
      const layout = surface === 'native' ? layouts.native : layouts.fine, selected = surface === 'native' ? shards.native : shards.fine;
      if (!layout || !selected) continue;
      const terrain = surface === 'fine' ? { dataId: terrainData.descriptor.dataId, verticalDatum: terrainData.descriptor.source.verticalDatum,
        surface: terrainData.descriptor.source.surface, ref: prepared.terrain, layoutVersion: 1 as const } : undefined;
      surfaces.push({ id: surface, kind: surface, grid: surface === 'native' ? prepared.plan.native : prepared.plan.fine,
        gridHash: surface === 'native' ? prepared.native.descriptor.gridHash : prepared.fine.descriptor.gridHash,
        coverage: coverageFor(surface), layers: surface === 'native' ? [...prepared.nativeSurfaceLayers] : [...prepared.fineSurfaceLayers],
        layout, shards: [...selected], ...(terrain ? { terrain } : {}) });
    }
    packMs += Date.now() - tPack;
    return { cycle, frames, artifacts, receipts, surfaces, capacity, metrics: {
      frames: summaries, phasesMs: { acquireMs, deriveMs, packMs, renderMs },
      renderer: { native: nativeRenderer.metrics(), fine: fineRenderer.metrics() }, acquisition: acquisition.stats,
      elapsedMs: Date.now() - started, peakRssBytes: process.resourceUsage().maxRSS * 1024
    } };
  } catch (error) {
    failed = true;
    await journal('failure', { version: 1, state: 'failed', buildId, provider: provider.id, cycle: acquisition?.cycle ?? options.cycle,
      phase, failedFrameHour: frameHour, completedFrames, elapsedMs: Date.now() - started, cancelled: options.signal?.aborted ?? false, error: failureReason(error) });
    throw error;
  } finally {
    const results = await Promise.allSettled([nativeWriter?.close(), fineWriter?.close(), acquisition?.close()]);
    if (!failed) for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}

const sameInstant = (actual: unknown, expected: string): boolean => typeof actual === 'string' && Date.parse(actual) === Date.parse(expected);
function indicesOf(mask: { grid: { width: number; height: number }; output: Uint8Array }): Uint32Array {
  const result: number[] = [];
  for (let i = 0; i < mask.grid.width * mask.grid.height; i++) if (mask.output[i >> 3]! & (1 << (i & 7))) result.push(i);
  return Uint32Array.from(result);
}
