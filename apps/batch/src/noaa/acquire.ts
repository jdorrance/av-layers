import {
  GFS_CONTRACT_GRID,
  GFS_PRESSURE_LEVELS_HPA,
  GFS_PRODUCTS,
} from './constants.ts';
import { NoaaError } from './errors.ts';
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
import { NoaaTransport, selectGfsRecord, type NoaaTransportStats } from './transport.ts';
import { NoaaFieldSampler } from './sampling.ts';
import type {
  AcquireGfsFrameOptions,
  DecodedFieldReceipt,
  GfsFieldSpec,
  GfsFrameAcquisition,
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
  inspected: InspectedGfsField;
  receipt: DecodedFieldReceipt;
}

interface SampledColumn {
  values: Float64Array;
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

export async function acquireGfsFrame(options: AcquireGfsFrameOptions, stats?: NoaaTransportStats): Promise<GfsFrameAcquisition> {
  const { hour } = options;
  const cycle = validateCycle(options.cycle);
  validateHour(hour);
  const activeIndices = validateActiveIndices(options.activeIndices);
  const capturedAt = new Date().toISOString();
  const transport = new NoaaTransport({
    fetch: options.fetch,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    cacheDir: options.cacheDir,
    stats,
  });
  const stamp = cycleStamp(cycle);
  const currentStartHour = gfsWindowStart(hour);
  const primaryUrl = gfsFileUrl(cycle, hour, GFS_PRODUCTS.primary);
  const secondaryUrl = gfsFileUrl(cycle, hour, GFS_PRODUCTS.secondary);
  const primaryIndex = await transport.index(`${primaryUrl}.idx`, stamp);
  const secondaryIndex = await transport.index(`${secondaryUrl}.idx`, stamp);

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
    const selection = await selectGfsRecord(transport, url, index, spec);
    const selected = selection.selected;
    const bytes = selection.bytes ?? await transport.field(url, selected.record);
    const inspected = inspectGfsField(bytes.bytes, {
      cycle,
      spec,
      expectedStartHour: startHour,
      expectedEndHour: endHour,
      expectedGridKey,
    });
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
    return { inspected, receipt };
  };

  const sampler = new NoaaFieldSampler();
  const decode = async (loaded: LoadedField, nativeIndices: Uint32Array): Promise<SampledColumn> => {
    transport.abort();
    const sampled = await sampler.sample(loaded.inspected, nativeIndices);
    loaded.receipt.decodedMissingCount = sampled.missingCount;
    return sampled;
  };

  try {
    const specs = gfsCurrentSpecs(hour);
    const surfaceSpecs = specs.filter((spec) => spec.kind !== 'height' && spec.kind !== 'temperature');
    const terrainSpec = surfaceSpecs.find((spec) => spec.kind === 'terrain');
    if (!terrainSpec) throw new NoaaError('invalid-option', 'GFS terrain spec missing');
    const terrainField = await load(terrainSpec, hour, hour);
    const sourceGrid = terrainField.inspected.grid;
    if (sourceGrid.kind !== 'latlon') {
      throw new NoaaError('unsupported-grid', 'GFS terrain is not regular lat-lon');
    }
    const nativeIndices = Uint32Array.from(activeIndices, contractIndexToNativeIndex);
    const terrain = await decode(terrainField, nativeIndices);

    const receipts: DecodedFieldReceipt[] = [terrainField.receipt];
    const outputs: Partial<Record<'surfacePressure' | 'temp2m' | 'spfh2m' | 'pbl', SampledColumn>> = {};

    for (const spec of surfaceSpecs) {
      if (
        spec.kind === 'terrain' ||
        spec.kind === 'sensible-flux' ||
        spec.kind === 'latent-flux' ||
        spec.kind === 'precipitation'
      ) {
        continue;
      }
      const loaded = await load(spec, hour, hour, sourceGrid.gridKey);
      const sampled = await decode(loaded, nativeIndices);
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
        packingErrorCurrent: current.inspected.packingError,
        packingErrorPrevious: companion?.inspected.packingError ?? 0,
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
    for (const levelHpa of GFS_PRESSURE_LEVELS_HPA) {
      const heightSpec = specs.find((spec) => spec.key === `${levelHpa}.hgt`);
      const tempSpec = specs.find((spec) => spec.key === `${levelHpa}.tmp`);
      if (!heightSpec || !tempSpec) throw new NoaaError('invalid-option', `Missing GFS pressure spec ${levelHpa}`);
      const heightField = await load(heightSpec, hour, hour, sourceGrid.gridKey);
      const heightSampled = await decode(heightField, nativeIndices);
      receipts.push(heightField.receipt);
      hgtM.push(Float32Array.from(heightSampled.values));
      hgtMissing.push(heightSampled.missing);
      const tempField = await load(tempSpec, hour, hour, sourceGrid.gridKey);
      const tempSampled = await decode(tempField, nativeIndices);
      receipts.push(tempField.receipt);
      tempK.push(Float32Array.from(tempSampled.values));
      tempMissing.push(tempSampled.missing);
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

    return {
      schemaVersion: 1,
      model: 'gfs',
      cycle,
      hour,
      validAt: validAt(cycle, hour),
      capturedAt,
      grid: { ...GFS_CONTRACT_GRID, wrapLongitude: true },
      activeIndices,
      terrainM: Float32Array.from(terrain.values),
      surfacePressurePa: Float32Array.from(surfacePressure.values),
      temp2mK: Float32Array.from(temp2m.values),
      specificHumidity2mKgKg: Float32Array.from(spfh2m.values),
      pblHeightM: Float32Array.from(pbl.values),
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
  } finally {
    await sampler.close();
  }
}
