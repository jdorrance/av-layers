import { copySourceIndices } from '../source.js';
import type { IndexedSource } from './source.js';
import { IndexedGribError } from './errors.ts';
import { discoverIndexedGribRunWithTransport } from './discover.ts';
import { prefetchFields } from './prefetch.ts';
import { loadAndInspectIndexedGribField, type AdmittedIndexedGribField } from './load.ts';
import {
  indexedGribCompanionSpecs,
  indexedGribCurrentSpecs,
  indexedGribFileUrl,
  indexedGribProductName,
  indexedGribWindowNeedsCompanion,
  cycleStamp,
  validateCycle,
} from './fields.ts';
import {
  admitIndexedGribWindowPair,
  indexedGribWindowStart,
  recoverTrailingWindow,
  validAt,
} from './intervals.ts';
import { IndexedGribTransport, indexedGribRecordWorkingBytes, type IndexedGribTransportStats } from './transport.ts';
import { IndexedGribFieldSampler } from './sampling.ts';
import type { NormalizedFrameTarget } from '../provider.js';
import type {
  AcquireIndexedGribFrameOptions,
  DecodedFieldReceipt,
  IndexedGribFieldSpec,
  IndexedGribFrameAcquisition,
  IndexedGribAcquisitionSession, IndexedGribAcquisitionSessionOptions, IndexedGribAcquisitionStats,
} from './types.ts';

/** Conservative reservation per in-flight decode, including worker state, copied source/indices and result arrays.
 * Completed results retain this reservation until consumed; full-frame output storage is a separate build budget. */
export function estimateDecodeWorkingBytes(source: IndexedSource, compressedBytes: number, activeCells: number): number {
  if (!Number.isSafeInteger(compressedBytes) || compressedBytes < 1 || !Number.isSafeInteger(activeCells) || activeCells < 1 || activeCells > (source.grid.width * source.grid.height)) throw new RangeError('Invalid decode reservation');
  return compressedBytes * 2 + activeCells * 17 + (source.grid.width * source.grid.height) * 32 + 16 * 1024 * 1024;
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new IndexedGribError('invalid-option', message, details);
}

export function validateHour(source: IndexedSource, hour: number): void {
  if (!Number.isInteger(hour) || !source.model.forecast.hours.includes(hour)) {
    invalid('Source forecast hour is outside configured hours', { hour });
  }
}

export function validateActiveIndices(source: IndexedSource, input: Uint32Array): Uint32Array {
  try { return copySourceIndices(input, source.grid.width * source.grid.height); }
  catch (error) { throw new IndexedGribError('invalid-option', (error as Error).message); }
}

export function contractIndexToNativeIndex(source: IndexedSource, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= (source.grid.width * source.grid.height)) {
    throw new IndexedGribError('invalid-option', `Contract index ${index} is outside the Indexed GRIB grid`);
  }
  const row = Math.floor(index / source.grid.width);
  const column = index - row * source.grid.width;
  const nativeColumn = (column + source.columnOffset + source.grid.width) % source.grid.width;
  return row * source.grid.width + nativeColumn;
}

interface LoadedField extends AdmittedIndexedGribField {
  sampled?: SampledColumn<Float32Array | Float64Array>;
}

interface SampledColumn<T extends Float32Array | Float64Array = Float64Array> {
  values: T;
  missing: Uint8Array;
  missingCount: number;
}

function windowFromReceipt(receipt: DecodedFieldReceipt): { start: string; end: string } {
  if (receipt.interval.kind !== 'window') throw new IndexedGribError('source-conflict', `Expected window for ${receipt.key}`);
  return { start: receipt.interval.start, end: receipt.interval.end };
}

function hoursInWindow(receipt: DecodedFieldReceipt): number {
  const window = windowFromReceipt(receipt);
  return (Date.parse(window.end) - Date.parse(window.start)) / 3_600_000;
}

interface AcquisitionContext {
  source: IndexedSource;
  cycle: string; activeIndices: Uint32Array; nativeIndices: Uint32Array;
  transport: IndexedGribTransport; sampler: IndexedGribFieldSampler; signal: AbortSignal;
  fail: (reason: unknown) => void; fetchConcurrency: number; prefetchBytes: number;
  stats: IndexedGribAcquisitionStats; raw: Map<string, Omit<LoadedField, 'inspected'>>;
}

export async function createIndexedGribAcquisitionSession(source: IndexedSource, options: IndexedGribAcquisitionSessionOptions, transportStats?: IndexedGribTransportStats): Promise<IndexedGribAcquisitionSession> {
  options.signal?.throwIfAborted();
  const activeIndices = validateActiveIndices(source, options.activeIndices);
  const fetchConcurrency = options.fetchConcurrency ?? 2, prefetchBytes = options.prefetchBytes ?? 128 * 1024 * 1024;
  if (!Number.isInteger(fetchConcurrency) || fetchConcurrency < 1 || fetchConcurrency > 8 || !Number.isSafeInteger(prefetchBytes) || prefetchBytes < 1) invalid('Invalid acquisition prefetch budget');
  const decodeConcurrency = options.decodeConcurrency ?? 1;
  if (!Number.isInteger(decodeConcurrency) || decodeConcurrency < 1 || decodeConcurrency > 4) invalid('Invalid decode concurrency');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const transport = new IndexedGribTransport({ ...options, signal, stats: transportStats });
  const sampler = new IndexedGribFieldSampler(decodeConcurrency);
  const cancelDecoder = () => { void sampler.close().catch(() => {}); };
  signal.addEventListener('abort', cancelDecoder, { once: true });
  let cycle: string;
  try { cycle = validateCycle(source, options.cycle ?? (await discoverIndexedGribRunWithTransport(source, { ...options, signal }, transport)).cycle); }
  catch (error) { controller.abort(error); signal.removeEventListener('abort', cancelDecoder); await sampler.close(); throw error; }
  const stats: IndexedGribAcquisitionStats = { transport: transport.stats, byPacking: sampler.stats, loadMs: 0, admitMs: 0, rawCompanionHits: 0, peakPrefetchBytes: 0 };
  const context: AcquisitionContext = {
    source, cycle, activeIndices, nativeIndices: Uint32Array.from(activeIndices, index => contractIndexToNativeIndex(source, index)), transport, sampler, signal,
    fail: reason => controller.abort(reason), fetchConcurrency, prefetchBytes, stats, raw: new Map(),
  };
  let closed = false, active: Promise<IndexedGribFrameAcquisition> | undefined, closing: Promise<void> | undefined;
  return {
    cycle, stats,
    async acquire(hour, target) {
      if (closed) invalid('Indexed GRIB acquisition session is closed');
      if (active) invalid('Acquire frames sequentially within a Indexed GRIB session');
      validateHour(source, hour); signal.throwIfAborted();
      active = acquireFrame(context, hour, target);
      try { return await active; }
      catch (error) { closed = true; controller.abort(error); context.raw.clear(); await sampler.close(); throw error; }
      finally { active = undefined; }
    },
    close() {
      closing ??= (async () => {
        closed = true; controller.abort(new IndexedGribError('invalid-option', 'Indexed GRIB acquisition session is closed'));
        context.raw.clear(); signal.removeEventListener('abort', cancelDecoder);
        const [decoder] = await Promise.allSettled([sampler.close(), active]);
        if (decoder.status === 'rejected') throw decoder.reason;
      })();
      return closing;
    },
  };
}

export async function acquireIndexedGribFrame(source: IndexedSource, options: AcquireIndexedGribFrameOptions, stats?: IndexedGribTransportStats): Promise<IndexedGribFrameAcquisition> {
  validateHour(source, options.hour);
  const session = await createIndexedGribAcquisitionSession(source, options, stats);
  try { return await session.acquire(options.hour); }
  finally { await session.close(); }
}

async function acquireFrame(context: AcquisitionContext, hour: number, target?: NormalizedFrameTarget): Promise<IndexedGribFrameAcquisition> {
  const { source, cycle, activeIndices, nativeIndices, transport, sampler } = context;
  const capturedAt = new Date().toISOString();
  const nextRaw = new Map<string, Omit<LoadedField, 'inspected'>>();
  const stamp = cycleStamp(cycle);
  const currentStartHour = indexedGribWindowStart(source, hour);
  const indexRequests = Object.entries(source.upstream.products).map(async ([product, file]) =>
    [product, await transport.index(`${indexedGribFileUrl(source, cycle, hour, file)}.idx`, stamp)] as const);
  const indexes = new Map(await Promise.all(indexRequests).catch(async error => {
    context.fail(error);
    await Promise.allSettled(indexRequests);
    throw error;
  }));

  const load = async (
    spec: IndexedGribFieldSpec,
    startHour: number,
    endHour: number,
    expectedGridKey?: string,
  ): Promise<LoadedField> => {
    transport.abort();
    const productName = indexedGribProductName(source, spec.product);
    const url = indexedGribFileUrl(source, cycle, spec.role === 'companion' ? hour - source.model.forecast.intervalHours : hour, productName);
    const index = spec.role === 'companion'
      ? await transport.index(`${url}.idx`, stamp)
      : indexes.get(spec.product)!;
    if (estimateDecodeWorkingBytes(source, indexedGribRecordWorkingBytes(index, spec), activeIndices.length) > context.prefetchBytes) throw new IndexedGribError('transport', 'GRIB record exceeds acquisition byte budget');
    const rawKey = `${url}\n${spec.key}`;
    const prior = spec.role === 'companion' ? context.raw.get(rawKey) : undefined;
    if (prior && prior.indexSha256 === index.asset.sha256 && prior.receipt.forecastLabel === spec.forecast && prior.grid.gridKey === expectedGridKey) {
      context.stats.rawCompanionHits++;
      return { ...prior, receipt: { ...structuredClone(prior.receipt), role: 'companion' } };
    }
    return loadAndInspectIndexedGribField(source, transport, {
      cycle, spec, sourceHour: spec.role === 'companion' ? hour - source.model.forecast.intervalHours : hour, startHour, endHour,
      expectedGridKey, index, timings: context.stats,
    });
  };

  const decode = async <T extends Float32Array | Float64Array = Float64Array>(loaded: LoadedField, nativeIndices: Uint32Array, destination?: T, missing?: Uint8Array): Promise<SampledColumn<T>> => {
    transport.abort();
    if (loaded.sampled) return loaded.sampled as SampledColumn<T>;
    if (!loaded.inspected) throw new IndexedGribError('decode', 'Admitted field is missing');
    const sampled = await sampler.sample(loaded.inspected, nativeIndices, destination, missing);
    loaded.inspected = undefined; // Do not retain compressed bytes after sampling.
    loaded.receipt.decodedMissingCount = sampled.missingCount;
    return sampled;
  };

  const prefetch = (specs: readonly IndexedGribFieldSpec[], gridKey: string) => prefetchFields(
    specs,
    spec => estimateDecodeWorkingBytes(source, indexedGribRecordWorkingBytes(indexes.get(spec.product)!, spec), activeIndices.length),
    async spec => {
      const loaded = await load(spec, hour, hour, gridKey);
      const index = source.pressureLevels.indexOf(spec.levelHpa!);
      const values = spec.kind === 'height' ? target?.hgtM[index] : spec.kind === 'temperature' ? target?.tempK[index]
        : spec.kind === 'surface-pressure' ? target?.surfacePressurePa : spec.kind === 'temp-2m' ? target?.temp2mK : target?.specificHumidity2mKgKg;
      const missing = spec.kind === 'height' ? target?.missing.hgt[index] : spec.kind === 'temperature' ? target?.missing.temp[index]
        : spec.kind === 'surface-pressure' ? target?.missing.surfacePressure : spec.kind === 'temp-2m' ? target?.missing.temp2m : target?.missing.humidity2m;
      loaded.sampled = await instant(loaded, values, missing);
      return loaded;
    },
    { concurrency: context.fetchConcurrency, maxBytes: context.prefetchBytes, signal: context.signal, fail: context.fail,
      peak: bytes => { context.stats.peakPrefetchBytes = Math.max(context.stats.peakPrefetchBytes, bytes); } },
  );
  const instant = (loaded: LoadedField, values?: Float32Array, missing?: Uint8Array) => decode(loaded, nativeIndices, values ?? new Float32Array(activeIndices.length), missing);
  try {
    const specs = indexedGribCurrentSpecs(source, hour);
    const surfaceSpecs = specs.filter((spec) => spec.kind !== 'height' && spec.kind !== 'temperature');
    const terrainSpec = surfaceSpecs.find((spec) => spec.kind === 'terrain');
    if (!terrainSpec) throw new IndexedGribError('invalid-option', 'Indexed GRIB terrain spec missing');
    const terrainField = await load(terrainSpec, hour, hour);
    const sourceGrid = terrainField.grid;
    if (sourceGrid.kind !== 'latlon') {
      throw new IndexedGribError('unsupported-grid', 'Indexed GRIB terrain is not regular lat-lon');
    }
    const terrain = await instant(terrainField, target?.terrainM, target?.missing.terrain);

    const receipts: DecodedFieldReceipt[] = [terrainField.receipt];
    const outputs: Partial<Record<'surfacePressure' | 'temp2m' | 'spfh2m', SampledColumn<Float32Array>>> = {};

    const instantSpecs = surfaceSpecs.filter(spec => spec.statistic === 'instant' && spec.kind !== 'terrain');
    let surfaceIndex = 0;
    for await (const loaded of prefetch(instantSpecs, sourceGrid.gridKey)) {
      const spec = instantSpecs[surfaceIndex++]!;
      const sampled = await instant(loaded,
        spec.kind === 'surface-pressure' ? target?.surfacePressurePa : spec.kind === 'temp-2m' ? target?.temp2mK : target?.specificHumidity2mKgKg,
        spec.kind === 'surface-pressure' ? target?.missing.surfacePressure : spec.kind === 'temp-2m' ? target?.missing.temp2m : target?.missing.humidity2m);
      receipts.push(loaded.receipt);
      if (spec.kind === 'surface-pressure') outputs.surfacePressure = sampled;
      else if (spec.kind === 'temp-2m') outputs.temp2m = sampled;
      else if (spec.kind === 'spfh-2m') outputs.spfh2m = sampled;
    }

    const intervalSpecs = surfaceSpecs.filter(
      (spec) =>
        spec.kind === 'sensible-flux' ||
        spec.kind === 'latent-flux' ||
        spec.kind === 'precipitation',
    );
    const intervalOutputs = new Map<string, { values: Float32Array; missing: Uint8Array; missingCount: number }>();
    const windowReceipts = new Map<string, { current: DecodedFieldReceipt; companion: DecodedFieldReceipt | null }>();
    const needsCompanion = indexedGribWindowNeedsCompanion(source, hour);
    const companionSpecs = indexedGribCompanionSpecs(source, hour);
    const companionByKind = new Map(companionSpecs.map((spec) => [spec.kind, spec]));

    for (const spec of intervalSpecs) {
      const current = await load(spec, currentStartHour, hour, sourceGrid.gridKey);
      const currentSampled = await decode(current, nativeIndices);
      if (!needsCompanion) nextRaw.set(`${current.receipt.url}\n${spec.key}`, {
        grid: current.grid, packingError: current.packingError, receipt: structuredClone(current.receipt),
        indexSha256: current.indexSha256, sampled: currentSampled,
      });
      receipts.push(current.receipt);
      let companion: LoadedField | null = null;
      let companionSampled: SampledColumn | null = null;
      if (needsCompanion) {
        const companionSpec = companionByKind.get(spec.kind);
        if (!companionSpec) throw new IndexedGribError('source-conflict', `Missing companion spec for ${spec.key}`);
        companion = await load(companionSpec, currentStartHour, hour - source.model.forecast.intervalHours, sourceGrid.gridKey);
        companionSampled = await decode(companion, nativeIndices);
        receipts.push(companion.receipt);
        admitIndexedGribWindowPair(source, current.receipt, companion.receipt);
      } else if (hoursInWindow(current.receipt) !== source.model.forecast.intervalHours) {
        throw new IndexedGribError('source-conflict', `Direct Indexed GRIB window is not three hours for ${spec.key}`);
      }
      const recovered = recoverTrailingWindow({
        currentValues: currentSampled.values,
        currentMissing: currentSampled.missing,
        companionValues: companionSampled?.values ?? null,
        companionMissing: companionSampled?.missing ?? null,
        currentHours: hoursInWindow(current.receipt),
        previousHours: companion ? hoursInWindow(companion.receipt) : 0,
        statistic: spec.statistic === 'accumulation' ? 'accumulation' : 'mean',
        outputSign: spec.kind === 'sensible-flux' ? source.fluxScales.sensibleHeatFlux : spec.kind === 'latent-flux' ? source.fluxScales.latentHeatFlux : 1,
        packingErrorCurrent: current.packingError,
        packingErrorPrevious: companion?.packingError ?? 0,
      });
      const destination = spec.kind === 'sensible-flux' ? target?.sensibleHeatFluxWm2 : spec.kind === 'latent-flux' ? target?.latentHeatFluxWm2 : target?.precipitationMmPerHour;
      const destinationMissing = spec.kind === 'sensible-flux' ? target?.missing.sensibleHeatFlux : spec.kind === 'latent-flux' ? target?.missing.latentHeatFlux : target?.missing.precipitation;
      if (destination && destinationMissing) {
        destination.set(recovered.values); destinationMissing.set(recovered.missing);
        recovered.values = destination; recovered.missing = destinationMissing;
      }
      intervalOutputs.set(spec.kind, recovered);
      windowReceipts.set(spec.key, { current: current.receipt, companion: companion?.receipt ?? null });
    }

    const currentWindowRefs = ['sensibleHeatFlux', 'latentHeatFlux', 'precipitation'].map((key) => {
      const pair = windowReceipts.get(key);
      if (!pair) throw new IndexedGribError('source-conflict', `Missing Indexed GRIB interval receipt ${key}`);
      return windowFromReceipt(pair.current);
    });
    if (
      currentWindowRefs.some(
        (window) =>
          window.start !== currentWindowRefs[0]!.start ||
          window.end !== currentWindowRefs[0]!.end,
      )
    ) {
      throw new IndexedGribError('source-conflict', 'Indexed GRIB flux and precipitation source windows differ');
    }

    const hgtM: Float32Array[] = [];
    const tempK: Float32Array[] = [];
    const hgtMissing: Uint8Array[] = [];
    const tempMissing: Uint8Array[] = [];
    const pressureSpecs = specs.filter(spec => spec.kind === 'height' || spec.kind === 'temperature');
    let pressureIndex = 0;
    for await (const loaded of prefetch(pressureSpecs, sourceGrid.gridKey)) {
      const spec = pressureSpecs[pressureIndex++]!;
      const levelIndex = spec.kind === 'height' ? hgtM.length : tempK.length;
      const sampled = await instant(loaded, spec.kind === 'height' ? target?.hgtM[levelIndex] : target?.tempK[levelIndex],
        spec.kind === 'height' ? target?.missing.hgt[levelIndex] : target?.missing.temp[levelIndex]);
      receipts.push(loaded.receipt);
      if (spec.kind === 'height') { hgtM.push(sampled.values); hgtMissing.push(sampled.missing); }
      else { tempK.push(sampled.values); tempMissing.push(sampled.missing); }
    }

    const surfacePressure = outputs.surfacePressure;
    const temp2m = outputs.temp2m;
    const spfh2m = outputs.spfh2m;
    const sensible = intervalOutputs.get('sensible-flux');
    const latent = intervalOutputs.get('latent-flux');
    const precipitation = intervalOutputs.get('precipitation');
    if (!surfacePressure || !temp2m || !spfh2m || !sensible || !latent || !precipitation) {
      throw new IndexedGribError('decode', 'Incomplete Indexed GRIB surface acquisition');
    }

    const fluxPair = windowReceipts.get('sensibleHeatFlux')!;
    const precipPair = windowReceipts.get('precipitation')!;
    const fluxSource = windowFromReceipt(fluxPair.current);
    const precipSource = windowFromReceipt(precipPair.current);
    const fluxActual = {
      start: fluxPair.companion ? windowFromReceipt(fluxPair.companion).end : fluxSource.start,
      end: fluxSource.end,
    };
    const precipActual = {
      start: precipPair.companion ? windowFromReceipt(precipPair.companion).end : precipSource.start,
      end: precipSource.end,
    };
    const fluxTolerance =
      fluxPair.current.packingError +
      (fluxPair.companion?.packingError ?? 0) +
      1e-9;
    const precipTolerance =
      precipPair.current.packingError +
      (precipPair.companion?.packingError ?? 0) +
      1e-9;

    context.raw = nextRaw;
    return {
      schemaVersion: 1,
      model: source.model.modelId,
      cycle,
      hour,
      validAt: validAt(cycle, hour),
      capturedAt,
      grid: source.grid,
      activeIndices: new Uint32Array(activeIndices),
      terrainM: terrain.values,
      surfacePressurePa: surfacePressure.values,
      temp2mK: temp2m.values,
      specificHumidity2mKgKg: spfh2m.values,
      sensibleHeatFluxWm2: sensible.values,
      latentHeatFluxWm2: latent.values,
      precipitationMmPerHour: precipitation.values,
      pressureLevelsHpa: source.pressureLevels,
      hgtM,
      tempK,
      missing: {
        terrain: terrain.missing,
        surfacePressure: surfacePressure.missing,
        temp2m: temp2m.missing,
        humidity2m: spfh2m.missing,
        sensibleHeatFlux: sensible.missing,
        latentHeatFlux: latent.missing,
        precipitation: precipitation.missing,
        hgt: hgtMissing,
        temp: tempMissing,
      },
      intervals: {
        profileTime: validAt(cycle, hour),
        fluxWindow: fluxActual,
        precipitationWindow: precipActual,
        fluxSourceWindow: fluxSource,
        precipitationSourceWindow: precipSource,
        usedCompanion: needsCompanion,
      },
      receipt: {
        schemaVersion: 1,
        cycle,
        hour,
        validAt: validAt(cycle, hour),
        capturedAt,
        sourceGrid: {
          ni: sourceGrid.ni,
          nj: sourceGrid.nj,
          lon0: sourceGrid.longitudeOfFirstGridPoint,
          lat0: sourceGrid.latitudeOfFirstGridPoint,
          dlon: sourceGrid.iDirectionIncrement,
          dlat: -sourceGrid.jDirectionIncrement,
          earthRadiusM: sourceGrid.earthRadiusM,
          gridKey: sourceGrid.gridKey,
          gridDefinitionTemplateNumber: sourceGrid.gridDefinitionTemplateNumber,
        },
        activeCount: activeIndices.length,
        products: { ...source.upstream.products },
        fields: receipts,
        windows: {
          flux: {
            current: fluxPair.current.idxLine,
            companion: fluxPair.companion?.idxLine ?? null,
            tolerance: fluxTolerance,
          },
          precipitation: {
            current: precipPair.current.idxLine,
            companion: precipPair.companion?.idxLine ?? null,
            tolerance: precipTolerance,
          },
        },
      },
    };
  } catch (error) {
    context.fail(error);
    throw error;
  }
}
