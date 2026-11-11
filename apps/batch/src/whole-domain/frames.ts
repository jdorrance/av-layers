import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertWholeDomainDonorsActive, coverageAtZoom, layerSurface, matchesFrameIntervals, renderedLayers, mapFrameCount, sourceIntervalHours, type ProvenanceFrameReference, type LayerId, type Manifest } from '@av/contracts';
import { deriveFrame, prepareNativeProfiles, writeProfileRecord, resolveProductFrameHours, validateNormalizedFrame, type GridField, type PackedGridField, type ShardedSamplePackLayout } from '@av/forecast';
import { createNormalizedFrameTarget, type ForecastProvider } from '../provider.js';
import type { NormalizedFrame } from '@av/forecast/inputs';
import { BUILD_BUDGETS } from '../capacity.js';
import { failureReason } from '../failure.js';
import { createRenderer } from '../render.js';
import { summarizeFields } from '../summary.js';
import { fileSha256, localPath } from '../validate.js';
import { forecastFrame, type BuildStamp, type ForecastInputs, type FrameBuildOptions } from '../frame-build.js';
import { planWholeDomainCapacity, wholeDomainCapacityInput, type WholeDomainCapacity } from './capacity.js';
import { writeFrameProvenance } from '../frame-provenance.js';
import { createShardedSamplePackWriter } from '../sample-pack-v5.js';
import type { ShardedSamplePackShard } from '../sample-pack-v5.js';
import { loadWholeDomainTerrain } from './prepare.js';
import type { WholeDomainPrepared } from './prepare.js';
import { createWholeDomainDerivePool } from './derive-pool.js';

export interface WholeDomainSurfaceResult {
  id: 'native' | 'fine';
  kind: 'native' | 'fine';
  grid: WholeDomainPrepared['plan']['fine'];
  gridHash: string;
  coverage: { id: string; hash: string; maskKey: string; maxZoom: number; gridHash: string };
  layers: LayerId[];
  layout: ShardedSamplePackLayout;
  shards?: ShardedSamplePackShard[];
  profiles?: { layout: ShardedSamplePackLayout; levelCount: number; recordBytes: number; shards: ShardedSamplePackShard[] };
  terrain?: { dataId: string; verticalDatum: string; surface: string; ref: WholeDomainPrepared['terrain']; layoutVersion: 1 };
}
export interface WholeDomainFrameResult {
  cycle: string;
  frames: Manifest['frames'];
  artifacts: Manifest['artifacts'];
  receipts: ProvenanceFrameReference[];
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
  sampleGroup?: number;
}

export async function buildWholeDomainFrames(options: WholeDomainFrameOptions): Promise<WholeDomainFrameResult> {
  options.signal?.throwIfAborted();
  const localController = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, localController.signal]) : localController.signal;
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
  let profileWriter: ReturnType<typeof createShardedSamplePackWriter> | undefined;
  let profileFrame: ReturnType<typeof prepareNativeProfiles>['forFrame'] | undefined;
  let prefetch: Promise<{ frame: NormalizedFrame; workMs: number }> | undefined;
  let derivePool: Awaited<ReturnType<typeof createWholeDomainDerivePool>> | undefined;
  let packing: Promise<void> | undefined;
  let failed = false;
  let completedFrames = 0, frameHour: number | null = null, phase = 'open-provider';
  let backgroundFailure: { phase: 'acquire' | 'pack'; hour: number } | undefined;
  const abortFrame = (error: unknown, phase: 'acquire' | 'pack', hour: number): never => {
    if (!signal.aborted) {
      backgroundFailure = { phase, hour };
      localController.abort(error);
    }
    throw error;
  };
  try {
    const nativeLayers = prepared.nativeSurfaceLayers.length, fineLayers = prepared.fineSurfaceLayers.length;
    const capacityInput = wholeDomainCapacityInput(product, provider, prepared, [options.hours ?? product.frameHours]);
    const admission = planWholeDomainCapacity(capacityInput);
    if (admission.capacity.violations.length) throw new Error(`Whole-domain build exceeds capacity: ${admission.capacity.violations.join('; ')}`);
    phase = 'load-terrain';
    const terrainData = capacityInput.mapFrames ? await loadWholeDomainTerrain({ ref: prepared.terrain, out: root, grid: prepared.plan.fine,
      coverage: prepared.fine.mask.coverage, coverageDescriptor: prepared.fine.bytes, signal }) : undefined;
    phase = 'open-provider';
    acquisition = await provider.open({ cycle: options.cycle, activeIndices: prepared.acquisitionActive, cacheDir, signal,
      ...(options.sourceStore ? { store: options.sourceStore } : {}), ...(options.sourcePin ? { sourcePin: options.sourcePin } : {}) });
    const cycle = new Date(acquisition.cycle).toISOString();
    if (options.cycle && Date.parse(cycle) !== Date.parse(options.cycle)) throw new Error('Provider cycle differs from requested cycle');
    const outputIndices = indicesOf(mask);
    const hours = options.hours ?? resolveProductFrameHours(product, mask, cycle, { ...deriveOptions, outputIndices });
    const mapFrames = mapFrameCount({ ...product, frameHours: hours });
    const { capacity, layouts, profileLayout, assemblyBufferBytes } = hours.length === capacityInput.frames && mapFrames === capacityInput.mapFrames
      ? admission : planWholeDomainCapacity(wholeDomainCapacityInput(product, provider, prepared, [hours]));
    if (capacity.violations.length) throw new Error(`Whole-domain build exceeds capacity: ${capacity.violations.join('; ')}`);
    const writer = (surface: 'native' | 'fine', layout: ShardedSamplePackLayout, coverage: typeof prepared.fine.mask.coverage) =>
      createShardedSamplePackWriter(layout, coverage, { root, model: product.modelId, buildId,
        surfaceId: options.surfaceTarget?.(surface) ?? surface, ...(options.sampleGroup === undefined ? {} : { group: options.sampleGroup }) }, { signal });
    nativeWriter = layouts.native ? writer('native', layouts.native, prepared.native.mask.coverage) : undefined;
    fineWriter = layouts.fine ? writer('fine', layouts.fine, prepared.fine.mask.coverage) : undefined;
    const profileBytes = profileLayout?.recordBytes ?? 0;
    const profilesEnabled = profileLayout !== null;
    const outsideProfile = profilesEnabled ? new Uint8Array(profileBytes) : undefined;
    if (profileLayout) {
      writeProfileRecord(outsideProfile!, { modelTerrainM: null, status: 'outside-domain', levels: [] });
      profileWriter = createShardedSamplePackWriter(profileLayout, prepared.native.mask.coverage,
        { root, model: product.modelId, buildId, surfaceId: 'native', kind: 'profiles', group: options.sampleGroup ?? 0 }, { signal });
    }
    const workingHalo = mask.halo.slice();
    for (let i = 0; i < workingHalo.length; i++) workingHalo[i] |= prepared.requiredDonors[i]!;
    const workingMask = { ...mask, halo: workingHalo };
    const diagnosticCells = mask.grid.width * mask.grid.height;
    const diagnostics = mapFrames ? { ceilingMslM: new Float32Array(new SharedArrayBuffer(diagnosticCells * 4)), buoyancyM2S3: new Float32Array(new SharedArrayBuffer(diagnosticCells * 4)), branch: new Uint8Array(new SharedArrayBuffer(diagnosticCells)) } : undefined;
    const rendererOptions = { signal, rasterWorkers: capacity.rasterWorkers, rasterSharedInputBytes: capacity.rasterSharedInputBytes };
    const nativeRenderer = createRenderer(coverageAtZoom(mask, product.maxNativeZoom), rendererOptions);
    const fineRenderer = createRenderer(coverageAtZoom(prepared.fine.mask, product.maxNativeZoom), rendererOptions);
    const frames: Manifest['frames'] = [], artifacts: Manifest['artifacts'] = [], receipts: WholeDomainFrameResult['receipts'] = [], summaries: Record<string, Record<string, unknown>> = {};
    const fineCells = prepared.fine.mask.coverage.offsets[prepared.fine.mask.coverage.blockIds.length]!;
    const fineOutput = mapFrames ? Object.fromEntries((['usable-lift-msl', 'usable-lift-agl'] as const).map(layer => [layer, {
      values: new Float32Array(new SharedArrayBuffer(fineCells * Float32Array.BYTES_PER_ELEMENT)),
      flags: new Uint8Array(new SharedArrayBuffer(fineCells))
    }])) as { 'usable-lift-msl': GridField; 'usable-lift-agl': GridField } : undefined;
    if (fineOutput && terrainData && provider.directTargets && capacity.deriveWorkers > 0) derivePool = await createWholeDomainDerivePool({
      plan: prepared.plan, coverage: prepared.fine.mask.coverage, activeIndices: prepared.acquisitionActive, maxLevels: provider.maxLevels,
      terrain: terrainData, output: fineOutput, workers: capacity.deriveWorkers, maxFrameCopyBytes: capacity.deriveFrameCopyBytes, signal
    });
    let acquireMs = 0, deriveMs = 0, packMs = 0, renderMs = 0;
    const ring = provider.directTargets ? Array.from({ length: 1 + capacity.prefetchFrameCount }, () => createNormalizedFrameTarget(prepared.acquisitionActive.length, provider.maxLevels,
      product.capabilities.verticalCoordinate === 'model-levels', product.layers.includes('precip-rate'))) : undefined;
    const session = acquisition;
    const acquire = async (hour: number, ordinal: number) => {
      const start = Date.now();
      const frame = await session.acquire(hour, ring?.[ordinal % ring.length]);
      return { frame, workMs: Date.now() - start };
    };
    for (let ordinal = 0; ordinal < hours.length; ordinal++) {
      const hour = hours[ordinal]!;
      frameHour = hour; phase = 'acquire'; signal.throwIfAborted();
      if (Date.now() - Date.parse(options.createdAt) > BUILD_BUDGETS.elapsedMs) throw new Error('Build exceeded elapsedMs budget');
      const tAcquire = Date.now();
      const { frame, workMs: acquireTotalWorkMs } = await (prefetch ?? acquire(hour, ordinal));
      prefetch = undefined;
      const acquireWaitWallMs = Date.now() - tAcquire;
      validateNormalizedFrame(frame, prepared.acquisitionActive, mask.grid, provider.maxLevels, product.layers, product.capabilities.verticalCoordinate);
      assertWholeDomainDonorsActive(prepared.plan, prepared.requiredDonors, frame.activeIndices);
      if (profilesEnabled && frame.hgtM.length !== provider.maxLevels) throw new Error('Profile levels differ from provider capacity');
      acquireMs += acquireWaitWallMs;
      const descriptor = forecastFrame(cycle, hour, sourceIntervalHours(product, hour)), { id } = descriptor;
      if (!frame.cycle || !sameInstant(frame.cycle, cycle) || frame.hour !== hour || !sameInstant(frame.validAt, descriptor.validTime) || !matchesFrameIntervals(frame.intervals, descriptor, product.layers.includes('precip-rate'))) throw new Error(`Acquisition interval mismatch f${hour}`);
      frames.push(descriptor);
      receipts.push(await writeFrameProvenance(root, { model: product.modelId, buildId, cycle }, descriptor, { hour, intervals: frame.intervals, receipt: frame.receipt }));
      if (capacity.prefetchFrameCount && ordinal + 1 < hours.length) {
        const nextHour = hours[ordinal + 1]!;
        prefetch = acquire(nextHour, ordinal + 1).catch(error => abortFrame(error, 'acquire', nextHour));
        void prefetch.catch(() => {});
      }
      const tDerive = Date.now(); phase = 'derive';
      const inMap = ordinal < mapFrames;
      const frameLayers = inMap ? product.layers : prepared.nativeSurfaceLayers;
      const nativeFields = deriveFrame(frame, workingMask, { ...deriveOptions, layers: frameLayers, diagnostics: inMap ? diagnostics : undefined, nativeCoverage: prepared.native.mask.coverage });
      if (inMap && !nativeFields['usable-lift-msl']) throw new Error('Whole-domain terrain derivation requires native MSL flags');
      const deriveNativeWallMs = Date.now() - tDerive, tFine = Date.now();
      const nativeClearance = inMap ? { validTime: descriptor.validTime, grid: mask.grid, diagnostics: diagnostics!, flags: nativeFields['usable-lift-msl']!.flags } : undefined;
      const deadlineAt = Date.parse(options.createdAt) + BUILD_BUDGETS.elapsedMs;
      const fineFields = inMap ? (derivePool
        ? await derivePool.derive({ generation: completedFrames, frame, time: descriptor, daylightOnly: deriveOptions.daylightOnly, nativeClearance, deadlineAt })
        : await prepared.columns.deriveAsync(frame, terrainData!, descriptor, { daylightOnly: deriveOptions.daylightOnly,
          nativeClearance, signal, output: fineOutput, deadlineAt, yieldControl: () => new Promise<void>(resolve => setImmediate(resolve)) })).fields : undefined;
      const deriveFineWallMs = Date.now() - tFine;
      summaries[id] = summarizeFields(nativeFields, mask, outputIndices, frameLayers);
      deriveMs += Date.now() - tDerive;
      const tPack = Date.now(); phase = 'pack';
      let packWriteWallMs = 0;
      packing = (async () => {
        for (let index = 0; index < prepared.nativeSurfaceLayers.length; index++) {
          const layer = prepared.nativeSurfaceLayers[index]!, field = nativeFields[layer];
          if (!field) throw new Error(`Missing native field ${layer}`);
          await nativeWriter!.writeChannel(completedFrames * nativeLayers + index, field);
        }
        for (let index = 0; inMap && index < prepared.fineSurfaceLayers.length; index++) {
          const layer = prepared.fineSurfaceLayers[index]!, field = fineFields![layer as keyof NonNullable<typeof fineFields>];
          if (!field) throw new Error(`Missing fine field ${layer}`);
          await fineWriter!.writeChannel(completedFrames * fineLayers + index, field);
        }
        if (profileWriter) {
          const profiles = profileFrame?.(frame) ?? prepareNativeProfiles(frame, prepared.native.mask.coverage);
          // Keep the immutable index factory; bound readers retain their input frame.
          profileFrame ??= profiles.forFrame;
          await profileWriter.writeRawChannel(completedFrames, profiles.readRecord, { outsideRecord: outsideProfile! });
        }
        packWriteWallMs = Date.now() - tPack;
        packMs += packWriteWallMs;
      })().catch(error => abortFrame(error, 'pack', hour));
      void packing.catch(() => {});
      const tRender = Date.now(); phase = 'render';
      const nativeTargets: { path: string; field: GridField; layer: LayerId }[] = [];
      const fineTargets: { path: string; field: PackedGridField; layer: LayerId }[] = [];
      for (const layer of inMap ? renderedLayers(product.layers) : []) {
        const tilesKey = `${prefix}/${layer}/${id}.pmtiles`, path = localPath(root, tilesKey);
        if (layerSurface(layer) === 'native') nativeTargets.push({ path, field: nativeFields[layer]!, layer });
        else fineTargets.push({ path, field: fineFields![layer as keyof NonNullable<typeof fineFields>]!, layer });
      }
      if (nativeTargets.length) await nativeRenderer.renderArchives(nativeTargets);
      const renderNativeWallMs = Date.now() - tRender, tFineRender = Date.now();
      if (fineTargets.length) await fineRenderer.renderArchives(fineTargets);
      const renderFineWallMs = Date.now() - tFineRender;
      renderMs += Date.now() - tRender;
      await packing;
      packing = undefined;
      summaries[id].timings = { acquireWaitWallMs, acquireTotalWorkMs, deriveNativeWallMs, deriveFineWallMs, packWriteWallMs, renderNativeWallMs, renderFineWallMs };
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
    const assembly = Buffer.allocUnsafe(assemblyBufferBytes);
    const shards = { native: await nativeWriter?.finish(assembly), fine: await fineWriter?.finish(assembly), profiles: await profileWriter?.finish(assembly) };
    const packFinishWallMs = Date.now() - tPack;
    const surfaces: WholeDomainSurfaceResult[] = [];
    const coverageFor = (surface: 'native' | 'fine') => {
      const info = surface === 'native' ? prepared.native : prepared.fine;
      return { id: info.descriptor.id, hash: info.hash, maskKey: `coverage/${info.hash}/manifest.json`, maxZoom: product.maxNativeZoom, gridHash: info.descriptor.gridHash };
    };
    for (const surface of ['native', 'fine'] as const) {
      const layout = surface === 'native' ? layouts.native : layouts.fine, selected = surface === 'native' ? shards.native : shards.fine;
      if (!layout || !selected) continue;
      const terrain = surface === 'fine' ? { dataId: terrainData!.descriptor.dataId, verticalDatum: terrainData!.descriptor.source.verticalDatum,
        surface: terrainData!.descriptor.source.surface, ref: prepared.terrain, layoutVersion: 1 as const } : undefined;
      surfaces.push({ id: surface, kind: surface, grid: surface === 'native' ? prepared.plan.native : prepared.plan.fine,
        gridHash: surface === 'native' ? prepared.native.descriptor.gridHash : prepared.fine.descriptor.gridHash,
        coverage: coverageFor(surface), layers: surface === 'native' ? [...prepared.nativeSurfaceLayers] : [...prepared.fineSurfaceLayers],
        layout, shards: [...selected], ...(surface === 'native' && profileLayout && shards.profiles ? { profiles: { layout: profileLayout, levelCount: provider.maxLevels, recordBytes: profileBytes, shards: [...shards.profiles] } } : {}), ...(terrain ? { terrain } : {}) });
    }
    packMs += Date.now() - tPack;
    return { cycle, frames, artifacts, receipts, surfaces, capacity, metrics: {
      frames: summaries, phasesMs: { acquireMs, deriveMs, packMs, renderMs },
      renderer: { native: nativeRenderer.metrics(), fine: fineRenderer.metrics(), packFinishWallMs }, acquisition: acquisition.stats,
      elapsedMs: Date.now() - started, peakRssBytes: process.resourceUsage().maxRSS * 1024
    } };
  } catch (caught) {
    const error = localController.signal.aborted ? localController.signal.reason : caught;
    localController.abort(error);
    failed = true;
    await journal('failure', { version: 1, state: 'failed', buildId, provider: provider.id, cycle: acquisition?.cycle ?? options.cycle,
      phase: backgroundFailure?.phase ?? phase, failedFrameHour: backgroundFailure?.hour ?? frameHour,
      completedFrames, elapsedMs: Date.now() - started, cancelled: options.signal?.aborted ?? false, error: failureReason(error) }).catch(() => {});
    throw error;
  } finally {
    await Promise.allSettled([prefetch, packing]);
    const results = await Promise.allSettled([nativeWriter?.close(), fineWriter?.close(), profileWriter?.close(), derivePool?.close(), acquisition?.close()]);
    if (!failed) for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}

const sameInstant = (actual: unknown, expected: string): boolean => typeof actual === 'string' && Date.parse(actual) === Date.parse(expected);
function indicesOf(mask: { grid: { width: number; height: number }; output: Uint8Array }): Uint32Array {
  const result: number[] = [];
  for (let i = 0; i < mask.grid.width * mask.grid.height; i++) if (mask.output[i >> 3]! & (1 << (i & 7))) result.push(i);
  return Uint32Array.from(result);
}
