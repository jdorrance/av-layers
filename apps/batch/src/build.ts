import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { GFS_PRODUCT, createProductDescriptors, encodeBoundedJson, MAX_MANIFEST_BYTES, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, getBit, LIFT_METHOD_PARAMETERS, LIFT_RENDER_STYLE, manifestSchema, RETENTION_DAYS, SAMPLE_BLOCK_SIZE, STATUS_OUTSIDE, type CoverageMask, type LayerId, type Manifest, type ProductDefinition } from '@av/contracts';
import { deriveColumn, precipitationRateStatus, type GridField } from '@av/forecast';
import { gfsProvider, validateNormalizedFrame, type ForecastProvider, type ForecastSession, type NormalizedFrame } from './providers.js';
import { buildIdentity } from './identity.js';
import { writeCoverage } from './coverage.js';
import { createRenderer } from './render.js';
import { WEBP_ENCODER } from './webp.js';
import { summarizeFields } from './summary.js';
import { prepareBuild } from './capacity.js';
import { createSamplePackBuilder } from './sample-pack.js';
import { failureReason } from './failure.js';
import { fileSha256, finalizeValidatedMetrics, loadCoverage, localPath, sha256, validateBuild } from './validate.js';

const { kelvinOffset: KELVIN_OFFSET, pascalsPerHectopascal: PA_PER_HPA } = LIFT_METHOD_PARAMETERS;

function field(mask: CoverageMask): GridField {
  const size = mask.grid.width * mask.grid.height;
  return { values: new Float32Array(size), flags: new Uint8Array(size).fill(STATUS_OUTSIDE) };
}

export function deriveFrame(frame: NormalizedFrame, mask: CoverageMask): Record<LayerId, GridField> {
  const result = { 'usable-lift-msl': field(mask), 'usable-lift-agl': field(mask), 'precip-rate': field(mask) };
  const read = (values: Float32Array, missing: Uint8Array, i: number): number => missing[i] ? NaN : values[i];
  const levels = Array.from({ length: frame.pressureLevelsHpa.length }, () => ({ heightM: NaN, temperatureC: NaN }));
  for (let i = 0; i < frame.activeIndices.length; i++) {
    const index = frame.activeIndices[i];
    if (!getBit(mask.output, index) && !getBit(mask.halo, index)) throw new Error('Acquisition returned inactive index');
    const pressure = read(frame.surfacePressurePa, frame.missing.surfacePressure, i) / PA_PER_HPA;
    const terrain = read(frame.terrainM, frame.missing.terrain, i);
    let levelCount = 0;
    for (let j = 0; j < frame.pressureLevelsHpa.length; j++) {
      const p = frame.pressureLevelsHpa[j];
      const heightM = read(frame.hgtM[j], frame.missing.hgt[j], i);
      if (p >= pressure || (Number.isFinite(heightM) && heightM <= terrain)) continue;
      const level = levels[levelCount++];
      level.heightM = heightM;
      level.temperatureC = read(frame.tempK[j], frame.missing.temp[j], i) - KELVIN_OFFSET;
    }
    const lift = deriveColumn({
      terrainM: terrain,
      surfaceTemperatureC: read(frame.temp2mK, frame.missing.temp2m, i) - KELVIN_OFFSET,
      surfacePressureHpa: pressure,
      humidity: { specificHumidityKgKg: read(frame.specificHumidity2mKgKg, frame.missing.humidity2m, i) },
      sensibleHeatFluxWm2: read(frame.sensibleHeatFluxWm2, frame.missing.sensibleHeatFlux, i),
      latentHeatFluxWm2: read(frame.latentHeatFluxWm2, frame.missing.latentHeatFlux, i),
      pblHeightM: read(frame.pblHeightM, frame.missing.pbl, i),
      levels
    }, levelCount);
    result['usable-lift-msl'].values[index] = lift.msl.value ?? NaN;
    result['usable-lift-msl'].flags[index] = lift.msl.flags;
    result['usable-lift-agl'].values[index] = lift.agl.value ?? NaN;
    result['usable-lift-agl'].flags[index] = lift.agl.flags;
    const rain = read(frame.precipitationMmPerHour, frame.missing.precipitation, i);
    result['precip-rate'].values[index] = rain;
    result['precip-rate'].flags[index] = precipitationRateStatus(rain);
  }
  return result;
}

export interface BuildOptions { signal?: AbortSignal; out: string; cycle?: string; cacheDir?: string; onValidated?: (manifest: Manifest, path: string) => Promise<void> }
export async function buildSample(options: BuildOptions): Promise<string> {
  return buildForecast({ ...options, product: GFS_PRODUCT, mask: await loadCoverage(), provider: gfsProvider });
}

/** The pipeline knows normalized inputs and a trusted recipe; the adapter owns source discovery/decoding. */
export async function buildForecast(options: BuildOptions & { product: ProductDefinition; mask: CoverageMask; provider: ForecastProvider }): Promise<string> {
  const { product, mask, provider } = options;
  const started = Date.now(), created = new Date(started), buildId = `${created.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z-${randomUUID()}`;
  const root = resolve(options.out);
  const cacheDir = options.cacheDir ?? join(root, '.cache', provider.id);
  const requestedCycle = options.cycle;
  const { indices, layout, capacity } = prepareBuild(mask, product, { maxLevels: provider.maxLevels }), active = indices.active;
  const channelCount = product.frameHours.length * product.layers.length;
  let channel = 0;
  const prefix = `builds/${product.source.modelFamily}/${buildId}`, frames: Manifest['frames'] = [], artifacts: Manifest['artifacts'] = [], receipts: unknown[] = [], summaries: Record<string, ReturnType<typeof summarizeFields>> = {};
  const counts = { active: active.length, tiles: capacity.tilesByZoom };
  const coverageHash = await writeCoverage(root, mask, product);
  const identity = await buildIdentity(product, coverageHash);
  const renderer = createRenderer(mask, { signal: options.signal, rasterWorkers: capacity.rasterWorkers });
  await mkdir(localPath(root, prefix), { recursive: true });
  await writeFile(localPath(root, `${prefix}/progress.json`), JSON.stringify({ state: 'acquiring', buildId, startedAt: created.toISOString(), recipe: identity.recipe }));
  const pack = createSamplePackBuilder(layout, channelCount);
  let acquisition: ForecastSession | undefined;
  let completedFrames = 0, frameHour: number | null = null, phase = 'open-provider';
  try {
    acquisition = await provider.open({ cycle: requestedCycle, activeIndices: active, cacheDir, signal: options.signal });
    const cycle = new Date(acquisition.cycle).toISOString();
    let acquireMs = 0, deriveMs = 0, packMs = 0, renderMs = 0;
    for (const hour of product.frameHours) {
      frameHour = hour; phase = 'acquire';
      options.signal?.throwIfAborted();
      if (Date.now() - started > 6 * 3600000) throw new Error('Build exceeded six-hour publisher lifetime');
      const tAcquire = Date.now();
      const frame = await acquisition.acquire(hour);
      validateNormalizedFrame(frame, active, mask.grid, provider.maxLevels);
      acquireMs += Date.now() - tAcquire;
      const start = new Date(Date.parse(cycle) + (hour - product.intervalHours) * 3600000).toISOString(), end = new Date(Date.parse(cycle) + hour * 3600000).toISOString();
      const sameInstant = (actual: string, expected: string): boolean => Date.parse(actual) === Date.parse(expected);
      if (!sameInstant(frame.cycle, cycle) || frame.hour !== hour || !sameInstant(frame.validAt, end) || !sameInstant(frame.intervals.profileTime, end) || !sameInstant(frame.intervals.fluxWindow.start, start) || !sameInstant(frame.intervals.fluxWindow.end, end) || !sameInstant(frame.intervals.precipitationWindow.start, start) || !sameInstant(frame.intervals.precipitationWindow.end, end)) {
        throw new Error(`Acquisition interval mismatch f${hour}`);
      }
      const id = `f${String(hour).padStart(3, '0')}`;
      frames.push({ id, validTime: end, intervalStart: start, intervalEnd: end });
      receipts.push({ hour, intervals: frame.intervals, receipt: frame.receipt });
      const tDerive = Date.now();
      phase = 'derive';
      const fields = deriveFrame(frame, mask);
      summaries[id] = summarizeFields(fields, mask, indices.output);
      deriveMs += Date.now() - tDerive;
      phase = 'pack';
      const targets = product.layers.map(layer => {
        const tilesKey = `${prefix}/${layer}/${id}.pmtiles`;
        const tPack = Date.now();
        pack.writeChannel(channel++, fields[layer]);
        packMs += Date.now() - tPack;
        return { path: localPath(root, tilesKey), field: fields[layer], layer, tilesKey };
      });
      const tRender = Date.now();
      phase = 'render';
      await renderer.renderArchives(targets);
      phase = 'hash-artifacts';
      for (const { path, layer, tilesKey } of targets) {
        artifacts.push({ layer, frame: id, tilesKey, tilesSha256: await fileSha256(path) });
      }
      renderMs += Date.now() - tRender;
      completedFrames++;
      phase = 'write-progress';
      await writeFile(localPath(root, `${prefix}/progress.json`), JSON.stringify({ state: 'rendered-frame', buildId, hour, completedFrames, elapsedMs: Date.now() - started, phasesMs: { acquireMs, deriveMs, packMs, renderMs }, peakRssBytes: process.resourceUsage().maxRSS * 1024 }));
    }
    frameHour = null; phase = 'finalize-pack';
    const tTranspose = Date.now(), samplesKey = `${prefix}/samples.bin`;
    const packed = await pack.finish(localPath(root, samplesKey));
    packMs += Date.now() - tTranspose;
    const provenanceKey = `${prefix}/provenance.json`, provenancePath = localPath(root, provenanceKey);
    phase = 'provenance';
    const provenanceBytes = encodeBoundedJson({ version: 1, model: product.source.modelFamily, buildId, cycle, provider: provider.provider, temporalApproximation: 'interval flux with endpoint profile and PBL', frames: receipts }, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS);
    await mkdir(dirname(provenancePath), { recursive: true });
    await writeFile(provenancePath, provenanceBytes, { flag: 'wx' });
    const baseManifest = {
      version: 3 as const,
      descriptors: createProductDescriptors(product), recipe: identity.recipe,
      model: product.source.modelFamily,
      buildId,
      cycle,
      createdAt: created.toISOString(),
      expiresAt: new Date(started + RETENTION_DAYS * 86400000).toISOString(),
      method: { id: product.id, hash: identity.scienceHash },
      coverage: { id: product.coverageId, hash: coverageHash, maskKey: `coverage/${coverageHash}/manifest.json`, maxZoom: product.maxNativeZoom },
      grid: product.grid,
      frames,
      layers: [...product.layers],
      artifacts,
      samples: { format: 'cell-major-blocks-v1' as const, blockSize: SAMPLE_BLOCK_SIZE, storedCells: layout.storedCells, channelCount, bytes: packed.bytes, sha256: packed.sha256, key: samplesKey },
      source: {
        provider: provider.provider,
        model: product.source.modelFamily,
        temporalApproximation: 'interval flux with endpoint profile and PBL',
        frameCount: frames.length,
        provenanceKey,
        provenanceSha256: sha256(provenanceBytes)
      },
      tool: { components: identity.components, node: process.version, pmtiles: '1.31.2', tileFormat: 'webp', tileEncoder: WEBP_ENCODER, liftRenderStyle: LIFT_RENDER_STYLE },
      palettes: createProductDescriptors(product).palettes.map(p => p.id)
    };
    const tValidate = Date.now();
    phase = 'validate';
    const validated = await validateBuild(root, manifestSchema.parse({ ...baseManifest, metrics: {} }), mask, coverageHash, product);
    const validateMs = Date.now() - tValidate;
    const manifest = finalizeValidatedMetrics(root, validated, {
      ...counts,
      frames: summaries,
      phasesMs: { acquireMs, deriveMs, packMs, renderMs, validateMs },
      renderer: renderer.metrics(),
      acquisition: acquisition.stats,
      capacity,
      packing: { indexBytes: layout.indexBytes },
      elapsedMs: Date.now() - started,
      peakRssBytes: process.resourceUsage().maxRSS * 1024
    });
    const path = localPath(root, `${prefix}/manifest.json`);
    phase = 'write-manifest';
    await writeFile(path, encodeBoundedJson(manifest, MAX_MANIFEST_BYTES), { flag: 'wx' });
    await writeFile(localPath(root, `${prefix}/progress.json`), JSON.stringify({ state: 'validated', buildId, elapsedMs: Date.now() - started }));
    options.signal?.throwIfAborted();
    phase = 'on-validated';
    await options.onValidated?.(manifest, path);
    return path;
  } catch (error) {
    await writeFile(localPath(root, `${prefix}/failure.json`), JSON.stringify({ version: 1, state: 'failed', buildId, provider: provider.id, cycle: acquisition?.cycle ?? requestedCycle, phase, failedFrameHour: frameHour, completedFrames, elapsedMs: Date.now() - started, cancelled: options.signal?.aborted ?? false, error: failureReason(error) }));
    throw error;
  } finally {
    pack.close();
    await acquisition?.close();
  }
}
