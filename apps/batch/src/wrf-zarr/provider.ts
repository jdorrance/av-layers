import z from 'zod';
import type { ArrayMetadata } from 'zarrita';
import { modelIdSchema, type ModelDefinition } from '@av/contracts';
import type { AuxField, ModelLevelFrame } from '@av/forecast/inputs';
import contract from '../../../../packages/contracts/schemas/wrf-zarr-v3.schema.json' with { type: 'json' };
import { createAuxiliaryTargets, createNormalizedFrameTarget, type NormalizedFrameTarget, type ResolvableForecastProvider } from '../provider.js';
import { copySourceIndices } from '../source.js';
import { readRun, shardKey, type WrfRun } from './ready.js';
import { validateMetadata } from './metadata.js';
import { decodeShard } from './shard.js';

const surfaceIds = ['mslpPa', 'u10mMps', 'v10mMps', 'gust10mMps', 'pblHeightM', 'capeJkg', 'cloudTotalPct', 'cloudLowPct'] as const;
const levelIds = ['spfhKgKg', 'uWindMps', 'vWindMps', 'omegaPaS'] as const;

function fields(target: NormalizedFrameTarget): Record<string, readonly AuxField[]> {
  const pair = (values: Float32Array, missing: Uint8Array): AuxField => ({ values, missing });
  const { missing } = target;
  return {
    terrainM: [pair(target.terrainM, missing.terrain)], surfacePressurePa: [pair(target.surfacePressurePa, missing.surfacePressure)],
    temp2mK: [pair(target.temp2mK, missing.temp2m)], specificHumidity2mKgKg: [pair(target.specificHumidity2mKgKg, missing.humidity2m)],
    sensibleHeatFluxWm2: [pair(target.sensibleHeatFluxWm2, missing.sensibleHeatFlux)], latentHeatFluxWm2: [pair(target.latentHeatFluxWm2, missing.latentHeatFlux)],
    precipitationMmPerHour: [pair(target.precipitationMmPerHour!, missing.precipitation!)],
    pressurePa: target.pressurePa!.map((values, i) => pair(values, missing.pressure![i]!)),
    hgtM: target.hgtM.map((values, i) => pair(values, missing.hgt[i]!)), tempK: target.tempK.map((values, i) => pair(values, missing.temp[i]!)),
    ...Object.fromEntries(surfaceIds.map(id => [`auxSurface.${id}`, [target.auxSurface![id]!]])),
    ...Object.fromEntries(levelIds.map(id => [`auxLevels.${id}`, target.auxLevels![id]!]))
  };
}

async function readField(run: WrfRun, field: typeof contract.fields[number], indices: readonly number[], active: Uint32Array,
  targets: readonly AuxField[], metadata: ArrayMetadata<'float32'>, signal: AbortSignal): Promise<number> {
  const { grid } = run.receipt, [iy, ix] = contract.innerSpatialChunk;
  const tiles = Math.ceil(grid.height / iy!) * Math.ceil(grid.width / ix!), raw = targets.length * iy! * ix! * 4;
  const maximum = tiles * (raw + Math.ceil(raw / 256) + 128 + 16) + 4;
  const sums = indices.length > 1 ? new Float64Array(active.length) : undefined;
  let totalBytes = 0, duration = 0;
  for (const index of indices) {
    signal.throwIfAborted();
    // Authenticate each source shard before inflating selected chunks into the same target buffers.
    const bytes = await run.read(shardKey(field, index), maximum);
    totalBytes += bytes.length;
    await decodeShard(bytes, metadata, index, active, targets, signal);
    if (sums) {
      const seconds = (Date.parse(run.receipt.window_ends_utc[index]!) - Date.parse(run.receipt.window_starts_utc[index]!)) / 1000;
      duration += seconds;
      const target = targets[0]!;
      // NaN retains missingness across contributing intervals; rates and mean fluxes use duration weights.
      for (let cell = 0; cell < active.length; cell++) sums[cell] += target.missing[cell] ? NaN : target.values[cell]! * seconds;
    }
  }
  if (sums) {
    const target = targets[0]!;
    for (let cell = 0; cell < active.length; cell++) {
      target.values[cell] = sums[cell]! / duration;
      target.missing[cell] = Number(!Number.isFinite(target.values[cell]));
    }
  }
  return totalBytes;
}

/** Read committed av-wrf cycles into sparse SI model-level frames. Storage owns transport. */
export function createWrfZarrProvider(model: ModelDefinition): ResolvableForecastProvider {
  const upstream = z.strictObject({ protocol: z.literal('wrf-zarr-v3'), provider: z.string().min(1), modelId: modelIdSchema.optional() }).parse(model.upstream);
  if (model.capabilities.verticalCoordinate !== 'model-levels' || model.capabilities.maxVerticalLevels > contract.maxVerticalLevels) throw new Error('WRF requires model-level columns');
  return {
    id: model.source.configurationId, provider: upstream.provider, maxLevels: model.capabilities.maxVerticalLevels, directTargets: true,
    auxiliarySurfaceFields: surfaceIds.length, auxiliaryLevelFields: levelIds.length,
    async resolveRun(options) {
      const run = await readRun(model, options);
      await validateMetadata(run);
      return { cycle: run.cycle, sourcePin: run.pin };
    },
    async resolveCycle(options) { return (await this.resolveRun!(options)).cycle; },
    async proveInputs(options) { return (await import('../input-proof.js')).proveForecastInputs(model, this, options); },
    async open(options) {
      if (options.offline) throw new Error('WRF offline replay requires a local source store through --source-store-dir');
      const controller = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      const active = copySourceIndices(options.activeIndices, model.grid.width * model.grid.height);
      const run = await readRun(model, { ...options, signal });
      const metadata = await validateMetadata(run);
      let closed = false, pending: Promise<ModelLevelFrame> | undefined;
      const stats = { sourceBytes: 0, frames: 0 };
      const acquire = async (hour: number, target?: NormalizedFrameTarget): Promise<ModelLevelFrame> => {
        signal.throwIfAborted();
        const index = run.receipt.lead_hours.indexOf(hour), levels = run.receipt.exported_levels_k;
        if (!model.frameHours.includes(hour) || index < 0) throw new Error(`WRF forecast hour is unavailable: ${hour}`);
        target ??= createNormalizedFrameTarget(active.length, levels, true, true);
        createAuxiliaryTargets(active.length, levels, surfaceIds, levelIds, target);
        const outputs = fields(target), windowIndices = run.windowIndices.get(hour)!;
        for (const field of contract.fields) {
          const indices = field.timeSupport === 'window-mean' || field.timeSupport === 'window-rate' ? windowIndices : [index];
          stats.sourceBytes += await readField(run, field, indices, active, outputs[field.target]!, metadata.get(field.name)!, signal);
        }
        stats.frames++;
        const validAt = run.receipt.valid_times_utc[index]!, window = { start: run.receipt.window_starts_utc[windowIndices[0]!]!, end: validAt };
        // The producer has already rotated winds and recovered trailing mean fluxes and precipitation rates.
        return { ...target, pressurePa: target.pressurePa!, missing: { ...target.missing, pressure: target.missing.pressure! },
          cycle: run.cycle, hour, validAt, capturedAt: new Date().toISOString(), grid: model.grid, activeIndices: active,
          intervals: { profileTime: validAt, fluxWindow: window, fluxSourceWindow: window, precipitationWindow: window, precipitationSourceWindow: window, usedCompanion: windowIndices.length > 1 },
          receipt: { schemaId: contract.schemaId, schemaVersion: contract.schemaVersion, sourcePin: run.pin, attemptId: run.receipt.attempt_id,
            definitions: { verticalCoordinate: contract.verticalCoordinate, temperature: contract.temperatureDefinition,
              moistureSourceOfTruth: contract.moistureSourceOfTruth, capeParcel: contract.capeParcelDefinition, lowCloud: contract.lowCloudDefinition,
              windReference: 'earth-relative', gust: 'ifs-cy43r1-instantaneous-turbulent-gust', omega: 'moist-hydrostatic-proxy-minus-rho-g-w' } } };
      };
      return { cycle: run.cycle, stats,
        async acquire(hour, target) {
          if (closed || pending) throw new Error('WRF session is closed or acquisition is already running');
          pending = acquire(hour, target);
          try { return await pending; } finally { pending = undefined; }
        },
        async close() { closed = true; controller.abort(); await pending?.catch(() => {}); }
      };
    }
  };
}
