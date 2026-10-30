import {
  GFS_CONTRACT_GRID,
  GFS_PRESSURE_LEVELS_HPA,
  GFS_PRODUCTS,
} from './constants.ts';
import { NoaaError } from './errors.ts';
import { discoverGfsRunWithTransport } from './discover.ts';
import { prefetchFields } from './prefetch.ts';
import { inspectGfsField, type InspectedGfsField } from './admission.ts';
import {
  gfsCompanionSpecs,
  gfsCurrentSpecs,
  gfsFileUrl,
  gfsProductName,
  gfsWindowNeedsCompanion,
  cycleStamp,
} from './fields.ts';
import {
  admitNoaaWindowPair,
  gfsWindowStart,
  recoverTrailingWindow,
  validAt,
} from './intervals.ts';
import { NoaaTransport, gfsRecordWorkingBytes, selectGfsRecord, type NoaaTransportStats } from './transport.ts';
import { NoaaFieldSampler } from './sampling.ts';
import type {
  AcquireGfsFrameOptions,
  DecodedFieldReceipt,
  GfsFieldSpec,
  GfsFrameAcquisition,
  GfsAcquisitionSession, GfsAcquisitionSessionOptions, GfsAcquisitionStats,
} from './types.ts';

const TOTAL_CELLS = GFS_CONTRACT_GRID.width * GFS_CONTRACT_GRID.height;
const CONTRACT_TO_NATIVE_COLUMN_OFFSET = GFS_CONTRACT_GRID.width / 2;

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new NoaaError('invalid-option', message, details);
}

export function validateCycle(cycle: string): string {
  const normalized = cycle.replace(/\.000Z$/, 'Z');
  if (
    !/^\d{4}-\d{2}-\d{2}T(00|06|12|18):00:00Z$/.test(normalized) ||
    !Number.isFinite(Date.parse(normalized)) || new Date(normalized).toISOString().replace('.000Z', 'Z') !== normalized
  ) {
    invalid('GFS cycle must be an exact ISO UTC one of 00/06/12/18Z', { cycle });
  }
  return normalized;
}

export function validateHour(hour: number): void {
  if (!Number.isInteger(hour) || hour < 3 || hour > 24 || hour % 3 !== 0) {
    invalid('GFS forecast hour must be an integer in 3..24 divisible by 3', { hour });
  }
}

export function validateActiveIndices(input: Uint32Array): Uint32Array {
  if (!(input instanceof Uint32Array) || input.length === 0) {
    invalid('activeIndices must be a non-empty Uint32Array');
  }
  const seen = new Set<number>();
  const copy = new Uint32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const index = input[i]!;
    if (!Number.isInteger(index) || index < 0 || index >= TOTAL_CELLS) {
      invalid(`Active index ${index} is outside the GFS contract grid`);
    }
    if (seen.has(index)) invalid(`Duplicate active index ${index}`);
    seen.add(index);
    copy[i] = index;
  }
  return copy;
}

export function contractIndexToNativeIndex(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= TOTAL_CELLS) {
    throw new NoaaError('invalid-option', `Contract index ${index} is outside the GFS grid`);
  }
  const row = Math.floor(index / GFS_CONTRACT_GRID.width);
  const column = index - row * GFS_CONTRACT_GRID.width;
  const nativeColumn = (column + CONTRACT_TO_NATIVE_COLUMN_OFFSET) % GFS_CONTRACT_GRID.width;
  return row * GFS_CONTRACT_GRID.width + nativeColumn;
}

interface LoadedField {
  inspected?: InspectedGfsField;
  grid: InspectedGfsField['grid'];
  packingError: number;
  receipt: DecodedFieldReceipt;
  indexSha256: string;
  sampled?: SampledColumn;
}

interface SampledColumn<T extends Float32Array | Float64Array = Float64Array> {
  values: T;
  missing: Uint8Array;
  missingCount: number;
}

function windowFromReceipt(receipt: DecodedFieldReceipt): { start: string; end: string } {
  if (receipt.interval.kind !== 'window') throw new NoaaError('source-conflict', `Expected window for ${receipt.key}`);
  return { start: receipt.interval.start, end: receipt.interval.end };
}

function hoursInWindow(receipt: DecodedFieldReceipt): number {
  const window = windowFromReceipt(receipt);
  return (Date.parse(window.end) - Date.parse(window.start)) / 3_600_000;
}

interface AcquisitionContext {
  cycle: string; activeIndices: Uint32Array; nativeIndices: Uint32Array;
  transport: NoaaTransport; sampler: NoaaFieldSampler; signal: AbortSignal;
  fail: (reason: unknown) => void; fetchConcurrency: number; prefetchBytes: number;
  stats: GfsAcquisitionStats; raw: Map<string, Omit<LoadedField, 'inspected'>>;
}

export async function createGfsAcquisitionSession(options: GfsAcquisitionSessionOptions, transportStats?: NoaaTransportStats): Promise<GfsAcquisitionSession> {
  const activeIndices = validateActiveIndices(options.activeIndices);
  const fetchConcurrency = options.fetchConcurrency ?? 2, prefetchBytes = options.prefetchBytes ?? 64 * 1024 * 1024;
  if (!Number.isInteger(fetchConcurrency) || fetchConcurrency < 1 || fetchConcurrency > 8 || !Number.isSafeInteger(prefetchBytes) || prefetchBytes < 1) invalid('Invalid acquisition prefetch budget');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const transport = new NoaaTransport({ ...options, signal, stats: transportStats });
  const sampler = new NoaaFieldSampler();
  const cancelDecoder = () => { void sampler.close().catch(() => {}); };
  signal.addEventListener('abort', cancelDecoder, { once: true });
  let cycle: string;
  try { cycle = validateCycle(options.cycle ?? (await discoverGfsRunWithTransport({ ...options, signal }, transport)).cycle); }
  catch (error) { controller.abort(error); signal.removeEventListener('abort', cancelDecoder); await sampler.close(); throw error; }
  const stats: GfsAcquisitionStats = { transport: transport.stats, byPacking: sampler.stats, loadMs: 0, admitMs: 0, rawCompanionHits: 0, peakPrefetchBytes: 0 };
  const context: AcquisitionContext = {
    cycle, activeIndices, nativeIndices: Uint32Array.from(activeIndices, contractIndexToNativeIndex), transport, sampler, signal,
    fail: reason => controller.abort(reason), fetchConcurrency, prefetchBytes, stats, raw: new Map(),
  };
  let closed = false, active: Promise<GfsFrameAcquisition> | undefined, closing: Promise<void> | undefined;
  return {
    cycle, stats,
    async acquire(hour) {
      if (closed) invalid('GFS acquisition session is closed');
      if (active) invalid('Acquire frames sequentially within a GFS session');
      validateHour(hour); signal.throwIfAborted();
      active = acquireFrame(context, hour);
      try { return await active; }
      catch (error) { closed = true; controller.abort(error); context.raw.clear(); await sampler.close(); throw error; }
      finally { active = undefined; }
    },
    close() {
      closing ??= (async () => {
        closed = true; controller.abort(new NoaaError('invalid-option', 'GFS acquisition session is closed'));
        context.raw.clear(); signal.removeEventListener('abort', cancelDecoder);
        const [decoder] = await Promise.allSettled([sampler.close(), active]);
        if (decoder.status === 'rejected') throw decoder.reason;
      })();
      return closing;
    },
  };
}

export async function acquireGfsFrame(options: AcquireGfsFrameOptions, stats?: NoaaTransportStats): Promise<GfsFrameAcquisition> {
  validateHour(options.hour);
  const session = await createGfsAcquisitionSession(options, stats);
  try { return await session.acquire(options.hour); }
  finally { await session.close(); }
}

async function acquireFrame(context: AcquisitionContext, hour: number): Promise<GfsFrameAcquisition> {
  const { cycle, activeIndices, nativeIndices, transport, sampler } = context;
  const capturedAt = new Date().toISOString();
  const nextRaw = new Map<string, Omit<LoadedField, 'inspected'>>();
  const stamp = cycleStamp(cycle);
  const currentStartHour = gfsWindowStart(hour);
  const primaryUrl = gfsFileUrl(cycle, hour, GFS_PRODUCTS.primary);
  const secondaryUrl = gfsFileUrl(cycle, hour, GFS_PRODUCTS.secondary);
  const indexRequests = [transport.index(`${primaryUrl}.idx`, stamp), transport.index(`${secondaryUrl}.idx`, stamp)] as const;
  const [primaryIndex, secondaryIndex] = await Promise.all(indexRequests).catch(async error => {
    context.fail(error);
    await Promise.allSettled(indexRequests);
    throw error;
  });

  const load = async (
    spec: GfsFieldSpec,
    startHour: number,
    endHour: number,
    expectedGridKey?: string,
  ): Promise<LoadedField> => {
    transport.abort();
    const productName = gfsProductName(spec.product);
    const url = gfsFileUrl(cycle, spec.role === 'companion' ? hour - 3 : hour, productName);
    const index = spec.role === 'companion'
      ? await transport.index(`${url}.idx`, stamp)
      : spec.product === 'primary' ? primaryIndex : secondaryIndex;
    if (gfsRecordWorkingBytes(index, spec) > context.prefetchBytes) throw new NoaaError('transport', 'GRIB record exceeds acquisition byte budget');
    const rawKey = `${url}\n${spec.key}`;
    const prior = spec.role === 'companion' ? context.raw.get(rawKey) : undefined;
    if (prior && prior.indexSha256 === index.asset.sha256 && prior.receipt.forecastLabel === spec.forecast && prior.grid.gridKey === expectedGridKey) {
      context.stats.rawCompanionHits++;
      return { ...prior, receipt: { ...structuredClone(prior.receipt), role: 'companion' } };
    }
    const started = performance.now();
    const selection = await selectGfsRecord(transport, url, index, spec);
    const selected = selection.selected;
    const bytes = selection.bytes ?? await transport.field(url, selected.record);
    context.stats.loadMs += performance.now() - started;
    const admittedAt = performance.now();
    const inspected = inspectGfsField(bytes.bytes, {
      cycle,
      spec,
      expectedStartHour: startHour,
      expectedEndHour: endHour,
      expectedGridKey,
    });
    context.stats.admitMs += performance.now() - admittedAt;
    const receipt: DecodedFieldReceipt = {
      ...inspected.receipt,
      product: spec.product,
      productFile: productName,
      url,
      idxLine: selected.line,
      idxLineNumber: selected.indexLine,
      asset: bytes.asset,
      ...(selection.duplicates ? { duplicates: selection.duplicates } : {}),
    };
    return { inspected, grid: inspected.grid, packingError: inspected.packingError, receipt, indexSha256: index.asset.sha256 };
  };

  const decode = async <T extends Float32Array | Float64Array = Float64Array>(loaded: LoadedField, nativeIndices: Uint32Array, destination?: T): Promise<SampledColumn<T>> => {
    transport.abort();
    if (loaded.sampled) return loaded.sampled as SampledColumn<T>;
    if (!loaded.inspected) throw new NoaaError('decode', 'Admitted field is missing');
    const sampled = await sampler.sample(loaded.inspected, nativeIndices, destination);
    loaded.inspected = undefined; // Do not retain compressed bytes after sampling.
    loaded.receipt.decodedMissingCount = sampled.missingCount;
    return sampled;
  };

  const prefetch = (specs: readonly GfsFieldSpec[], gridKey: string) => prefetchFields(
    specs,
    spec => gfsRecordWorkingBytes(spec.product === 'primary' ? primaryIndex : secondaryIndex, spec),
    spec => load(spec, hour, hour, gridKey),
    { concurrency: context.fetchConcurrency, maxBytes: context.prefetchBytes, signal: context.signal, fail: context.fail,
      peak: bytes => { context.stats.peakPrefetchBytes = Math.max(context.stats.peakPrefetchBytes, bytes); } },
  );
  const instant = (loaded: LoadedField) => decode(loaded, nativeIndices, new Float32Array(activeIndices.length));
  try {
    const specs = gfsCurrentSpecs(hour);
    const surfaceSpecs = specs.filter((spec) => spec.kind !== 'height' && spec.kind !== 'temperature');
    const terrainSpec = surfaceSpecs.find((spec) => spec.kind === 'terrain');
    if (!terrainSpec) throw new NoaaError('invalid-option', 'GFS terrain spec missing');
    const terrainField = await load(terrainSpec, hour, hour);
    const sourceGrid = terrainField.grid;
    if (sourceGrid.kind !== 'latlon') {
      throw new NoaaError('unsupported-grid', 'GFS terrain is not regular lat-lon');
    }
    const terrain = await instant(terrainField);

    const receipts: DecodedFieldReceipt[] = [terrainField.receipt];
    const outputs: Partial<Record<'surfacePressure' | 'temp2m' | 'spfh2m' | 'pbl', SampledColumn<Float32Array>>> = {};

    const instantSpecs = surfaceSpecs.filter(spec => spec.statistic === 'instant' && spec.kind !== 'terrain');
    let surfaceIndex = 0;
    for await (const loaded of prefetch(instantSpecs, sourceGrid.gridKey)) {
      const spec = instantSpecs[surfaceIndex++]!;
      const sampled = await instant(loaded);
      receipts.push(loaded.receipt);
      if (spec.kind === 'surface-pressure') outputs.surfacePressure = sampled;
      else if (spec.kind === 'temp-2m') outputs.temp2m = sampled;
      else if (spec.kind === 'spfh-2m') outputs.spfh2m = sampled;
      else if (spec.kind === 'pbl') outputs.pbl = sampled;
    }

    const intervalSpecs = surfaceSpecs.filter(
      (spec) =>
        spec.kind === 'sensible-flux' ||
        spec.kind === 'latent-flux' ||
        spec.kind === 'precipitation',
    );
    const intervalOutputs = new Map<string, { values: Float32Array; missing: Uint8Array; missingCount: number }>();
    const windowReceipts = new Map<string, { current: DecodedFieldReceipt; companion: DecodedFieldReceipt | null }>();
    const needsCompanion = gfsWindowNeedsCompanion(hour);
    const companionSpecs = gfsCompanionSpecs(hour);
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
        if (!companionSpec) throw new NoaaError('source-conflict', `Missing companion spec for ${spec.key}`);
        companion = await load(companionSpec, currentStartHour, hour - 3, sourceGrid.gridKey);
        companionSampled = await decode(companion, nativeIndices);
        receipts.push(companion.receipt);
        admitNoaaWindowPair(current.receipt, companion.receipt);
      } else if (hoursInWindow(current.receipt) !== 3) {
        throw new NoaaError('source-conflict', `Direct GFS window is not three hours for ${spec.key}`);
      }
      const recovered = recoverTrailingWindow({
        currentValues: currentSampled.values,
        currentMissing: currentSampled.missing,
        companionValues: companionSampled?.values ?? null,
        companionMissing: companionSampled?.missing ?? null,
        currentHours: hoursInWindow(current.receipt),
        previousHours: companion ? hoursInWindow(companion.receipt) : 0,
        statistic: spec.statistic === 'accumulation' ? 'accumulation' : 'mean',
        packingErrorCurrent: current.packingError,
        packingErrorPrevious: companion?.packingError ?? 0,
      });
      intervalOutputs.set(spec.kind, recovered);
      windowReceipts.set(spec.key, { current: current.receipt, companion: companion?.receipt ?? null });
    }

    const currentWindowRefs = ['sensibleHeatFlux', 'latentHeatFlux', 'precipitation'].map((key) => {
      const pair = windowReceipts.get(key);
      if (!pair) throw new NoaaError('source-conflict', `Missing GFS interval receipt ${key}`);
      return windowFromReceipt(pair.current);
    });
    if (
      currentWindowRefs.some(
        (window) =>
          window.start !== currentWindowRefs[0]!.start ||
          window.end !== currentWindowRefs[0]!.end,
      )
    ) {
      throw new NoaaError('source-conflict', 'GFS flux and precipitation source windows differ');
    }

    const hgtM: Float32Array[] = [];
    const tempK: Float32Array[] = [];
    const hgtMissing: Uint8Array[] = [];
    const tempMissing: Uint8Array[] = [];
    const pressureSpecs = specs.filter(spec => spec.kind === 'height' || spec.kind === 'temperature');
    let pressureIndex = 0;
    for await (const loaded of prefetch(pressureSpecs, sourceGrid.gridKey)) {
      const spec = pressureSpecs[pressureIndex++]!;
      const sampled = await instant(loaded);
      receipts.push(loaded.receipt);
      if (spec.kind === 'height') { hgtM.push(sampled.values); hgtMissing.push(sampled.missing); }
      else { tempK.push(sampled.values); tempMissing.push(sampled.missing); }
    }

    const surfacePressure = outputs.surfacePressure;
    const temp2m = outputs.temp2m;
    const spfh2m = outputs.spfh2m;
    const pbl = outputs.pbl;
    const sensible = intervalOutputs.get('sensible-flux');
    const latent = intervalOutputs.get('latent-flux');
    const precipitation = intervalOutputs.get('precipitation');
    if (!surfacePressure || !temp2m || !spfh2m || !pbl || !sensible || !latent || !precipitation) {
      throw new NoaaError('decode', 'Incomplete GFS surface acquisition');
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
      model: 'gfs',
      cycle,
      hour,
      validAt: validAt(cycle, hour),
      capturedAt,
      grid: { ...GFS_CONTRACT_GRID, wrapLongitude: true },
      activeIndices: new Uint32Array(activeIndices),
      terrainM: terrain.values,
      surfacePressurePa: surfacePressure.values,
      temp2mK: temp2m.values,
      specificHumidity2mKgKg: spfh2m.values,
      pblHeightM: pbl.values,
      sensibleHeatFluxWm2: sensible.values,
      latentHeatFluxWm2: latent.values,
      precipitationMmPerHour: precipitation.values,
      pressureLevelsHpa: GFS_PRESSURE_LEVELS_HPA,
      hgtM,
      tempK,
      missing: {
        terrain: terrain.missing,
        surfacePressure: surfacePressure.missing,
        temp2m: temp2m.missing,
        humidity2m: spfh2m.missing,
        pbl: pbl.missing,
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
          lon0: sourceGrid.kind === 'latlon' ? sourceGrid.longitudeOfFirstGridPoint : 0,
          lat0: sourceGrid.kind === 'latlon' ? sourceGrid.latitudeOfFirstGridPoint : 90,
          dlon: sourceGrid.kind === 'latlon' ? sourceGrid.iDirectionIncrement : 0.25,
          dlat: sourceGrid.kind === 'latlon' ? -sourceGrid.jDirectionIncrement : -0.25,
          earthRadiusM: sourceGrid.earthRadiusM,
          gridKey: sourceGrid.gridKey,
          gridDefinitionTemplateNumber: sourceGrid.gridDefinitionTemplateNumber,
        },
        activeCount: activeIndices.length,
        products: { ...GFS_PRODUCTS },
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
