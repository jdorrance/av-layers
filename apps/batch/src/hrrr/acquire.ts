import { sampleFieldValuesAsync, type LambertGrid } from '@azohra/meteo.grib';
import { createNodeJ2kDecoderPool } from '@azohra/meteo.grib/j2k-node';
import { HRRR_CYCLE_CANDIDATES, HRRR_CYCLE_LAG_HOURS, HRRR_INDEXING, HRRR_MAX_DISCOVERY_HOUR, HRRR_MIN_FORECAST_HOUR, HRRR_PRESSURE_LEVELS_HPA } from './constants.ts';
import { hrrrFieldSpecs, hrrrFileUrl, hrrrFrameIntervals, hrrrIndexUrl, hrrrCycleStamp } from './fields.ts';
import { hrrrProductFile, inspectHrrrField, type InspectedHrrrField } from './admission.ts';
import { hrrrNativeGrid, selectHrrrCells } from './grid.ts';
import { NoaaError } from '../noaa/errors.ts';
import { NoaaTransport, selectUniqueRecord, type IndexResult } from '../noaa/transport.ts';
import type { SelectedIdxRecord, SourceAssetReceipt } from '../noaa/types.ts';
import { validAt } from '../noaa/intervals.ts';
import type {
  AcquireHrrrFrameOptions,
  DiscoverHrrrRunOptions,
  DiscoveredHrrrRun,
  HrrrCellSelection,
  HrrrCoverage,
  HrrrFieldReceipt,
  HrrrFieldSpec,
  HrrrFrameAcquisition,
  ProveHrrrInputsOptions,
  ProveHrrrInputsReport,
} from './types.ts';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/;

function iso(date: Date): string {
  return date.toISOString().replace('.000Z', 'Z');
}

function assertCycle(cycle: string): void {
  if (!ISO.test(cycle) || !Number.isFinite(Date.parse(cycle)) || iso(new Date(cycle)) !== cycle) {
    throw new NoaaError('invalid-option', 'HRRR cycle must be an exact ISO UTC hour');
  }
}

function assertHour(hour: number): void {
  if (!Number.isInteger(hour) || hour < HRRR_MIN_FORECAST_HOUR || hour > HRRR_MAX_DISCOVERY_HOUR) {
    throw new NoaaError('invalid-option', `HRRR hour must be an integer ${HRRR_MIN_FORECAST_HOUR}..${HRRR_MAX_DISCOVERY_HOUR}`);
  }
}

function assertIndices(indices: Uint32Array): void {
  if (!indices.length) throw new NoaaError('invalid-option', 'HRRR acquisition requires native active indices');
  for (let i = 0; i < indices.length; i++) {
    if (indices[i]! >= 1905141) throw new NoaaError('invalid-option', `HRRR native index out of range: ${indices[i]}`);
    if (i > 0 && indices[i]! <= indices[i - 1]!) throw new NoaaError('invalid-option', 'HRRR native indices must be unique and ascending');
  }
}

function selectedRecords(indexes: readonly IndexResult[], specs: readonly HrrrFieldSpec[], product: 'surface' | 'pressure'): Map<string, SelectedIdxRecord> {
  const index = product === 'surface' ? indexes[0]! : indexes[1]!;
  return new Map(specs.map((spec) => [spec.key, selectUniqueRecord(index.records, index.text, spec)]));
}

function uniqueAssets(assets: readonly SourceAssetReceipt[]): SourceAssetReceipt[] {
  return [...new Map(assets.map((asset) => [`${asset.url}\n${asset.range}`, asset])).values()];
}

function inventoryFor(hour: number, indexes: readonly IndexResult[]): DiscoveredHrrrRun['inventory'] {
  const surface = hrrrFieldSpecs(hour, 'surface'), pressure = hrrrFieldSpecs(hour, 'pressure');
  selectedRecords(indexes, surface, 'surface');
  selectedRecords(indexes, pressure, 'pressure');
  return {
    hour,
    surfaceFields: surface.map((spec) => spec.key),
    pressureLevelsHpa: HRRR_PRESSURE_LEVELS_HPA,
    precipitationForecast: surface.find((spec) => spec.kind === 'precipitation')!.forecast,
    fluxStatistic: 'instant',
    humidityRepresentation: 'dewpoint-2m',
  };
}

export async function discoverHrrrRun(options: DiscoverHrrrRunOptions = {}): Promise<DiscoveredHrrrRun> {
  const now = options.now ?? new Date();
  const requiredHours = [...(options.requiredHours ?? [1])];
  if (!requiredHours.length || requiredHours.some((hour, i) => !Number.isInteger(hour) || hour < 1 || hour > HRRR_MAX_DISCOVERY_HOUR || (i > 0 && hour <= requiredHours[i - 1]))) {
    throw new NoaaError('invalid-option', 'HRRR requiredHours must be unique ascending supported leads');
  }
  if (options.maxHour !== undefined && (!Number.isInteger(options.maxHour) || options.maxHour < requiredHours[requiredHours.length - 1]! || options.maxHour > HRRR_MAX_DISCOVERY_HOUR)) {
    throw new NoaaError('invalid-option', 'HRRR maxHour is invalid');
  }
  const cycles = options.cycle
    ? [options.cycle]
    : Array.from({ length: options.candidateCount ?? HRRR_CYCLE_CANDIDATES }, (_, offset) => {
        const at = new Date(now);
        at.setUTCMinutes(0, 0, 0);
        at.setUTCHours(at.getUTCHours() - HRRR_CYCLE_LAG_HOURS - offset);
        return iso(at);
      });
  const transport = new NoaaTransport({ fetchImpl: options.fetchImpl, signal: options.signal });
  let lastError: unknown;
  for (const cycle of cycles) {
    try {
      assertCycle(cycle);
      const stamp = hrrrCycleStamp(cycle);
      const hours = options.maxHour === undefined ? requiredHours : Array.from({ length: options.maxHour }, (_, i) => i + 1);
      const inventories: DiscoveredHrrrRun['inventory'][] = [];
      for (const hour of hours) {
        try {
          const indexes = await Promise.all((['surface', 'pressure'] as const).map((product) => transport.index(hrrrIndexUrl(cycle, hour, product), stamp)));
          inventories.push(inventoryFor(hour, indexes));
        } catch (error) {
          options.signal?.throwIfAborted();
          if (requiredHours.includes(hour) || !(error instanceof NoaaError) || !['transport', 'run-unavailable', 'record-missing', 'record-ambiguous', 'source-conflict'].includes(error.code)) throw error;
        }
      }
      const availableHours = inventories.map((entry) => entry.hour);
      const inventory = inventories.find((entry) => entry.hour === requiredHours[0])!;
      return {
        schemaVersion: 1,
        model: 'hrrr-conus',
        cycle,
        products: { surface: 'wrfsfc', pressure: 'wrfprs' },
        requiredHours,
        availableHours,
        checkedAt: iso(now),
        inventory,
        inventories,
        status: 'inventory-only',
      };
    } catch (error) {
      lastError = error;
      if (options.cycle) throw error;
      if (!(error instanceof NoaaError) || !['transport', 'run-unavailable', 'record-missing', 'record-ambiguous', 'source-conflict'].includes(error.code)) throw error;
    }
  }
  throw new NoaaError('run-unavailable', 'No complete admissible HRRR CONUS run found', { lastError: lastError instanceof Error ? lastError.message : String(lastError) });
}

export function activeFieldValues(values: Float64Array, missingMask: Uint8Array | undefined, count: number): { values: Float32Array; missing: Uint8Array; missingCount: number } {
  if (values.length !== count) throw new NoaaError('decode', `HRRR sampled value count ${values.length} != ${count}`);
  const result = new Float32Array(count), missing = new Uint8Array(count);
  let missingCount = 0;
  for (let i = 0; i < count; i++) {
    if (missingMask?.[i] || !Number.isFinite(values[i]!)) {
      result[i] = Number.NaN;
      missing[i] = 1;
      missingCount++;
    } else {
      result[i] = values[i]!;
    }
  }
  return { values: result, missing, missingCount };
}

async function readGrid(transport: NoaaTransport, cycle: string, hour: number): Promise<LambertGrid> {
  const stamp = hrrrCycleStamp(cycle);
  const index = await transport.index(hrrrIndexUrl(cycle, hour, 'surface'), stamp);
  const spec = hrrrFieldSpecs(hour, 'surface')[0]!;
  const selected = selectUniqueRecord(index.records, index.text, spec);
  const fetched = await transport.field(hrrrFileUrl(cycle, hour, 'surface'), selected.record);
  return inspectHrrrField(fetched.bytes, { cycle, hour, spec }).grid as LambertGrid;
}

export function precipitationRate(values: Float32Array, missing: Uint8Array, durationHours: number): Float32Array {
  if (!Number.isFinite(durationHours) || durationHours <= 0) throw new NoaaError('invalid-option', 'HRRR precipitation duration must be positive');
  if (values.length !== missing.length) throw new NoaaError('decode', 'HRRR precipitation values/missing lengths differ');
  const result = new Float32Array(values.length);
  for (let i = 0; i < result.length; i++) result[i] = missing[i] ? Number.NaN : values[i]! / durationHours;
  return result;
}

export async function acquireHrrrFrame(options: AcquireHrrrFrameOptions): Promise<HrrrFrameAcquisition> {
  assertCycle(options.cycle);
  assertHour(options.hour);
  assertIndices(options.activeIndices);
  const capturedAt = iso(options.now ?? new Date());
  const transport = new NoaaTransport({ fetchImpl: options.fetchImpl, signal: options.signal, cacheDir: options.cacheDir });
  const stamp = hrrrCycleStamp(options.cycle);
  const surfaceIndex = await transport.index(hrrrIndexUrl(options.cycle, options.hour, 'surface'), stamp);
  const pressureIndex = await transport.index(hrrrIndexUrl(options.cycle, options.hour, 'pressure'), stamp);
  const specs = hrrrFieldSpecs(options.hour);
  const surfaceSpecs = specs.filter((spec) => spec.product === 'surface');
  const pressureSpecs = specs.filter((spec) => spec.product === 'pressure');
  const selections = new Map<string, { spec: HrrrFieldSpec; selected: SelectedIdxRecord }>();
  for (const spec of surfaceSpecs) selections.set(spec.key, { spec, selected: selectUniqueRecord(surfaceIndex.records, surfaceIndex.text, spec) });
  for (const spec of pressureSpecs) selections.set(spec.key, { spec, selected: selectUniqueRecord(pressureIndex.records, pressureIndex.text, spec) });
  const assets: SourceAssetReceipt[] = [surfaceIndex.asset, pressureIndex.asset];
  const decoded = new Map<string, { values: Float32Array; missing: Uint8Array; missingCount: number; inspected: InspectedHrrrField; spec: HrrrFieldSpec; asset: SourceAssetReceipt }>();
  let pool: Awaited<ReturnType<typeof createNodeJ2kDecoderPool>> | undefined;
  let gridKey: string | undefined;
  let terrainGrid: LambertGrid | undefined;
  try {
    for (const spec of specs) {
      options.signal?.throwIfAborted();
      const { selected } = selections.get(spec.key)!;
      const fetched = await transport.field(hrrrFileUrl(options.cycle, options.hour, spec.product), selected.record);
      assets.push(fetched.asset);
      const inspected = inspectHrrrField(fetched.bytes, { cycle: options.cycle, hour: options.hour, spec, expectedGridKey: gridKey });
      gridKey ??= inspected.grid.gridKey;
      if (spec.kind === 'terrain') terrainGrid = inspected.grid as LambertGrid;
      if (inspected.packing === 40) pool ??= await createNodeJ2kDecoderPool({ size: 2 });
      const sampled = await sampleFieldValuesAsync(
        inspected.field,
        options.activeIndices,
        inspected.packing === 40 && pool ? { decodeJ2k: pool.decode, decodeJ2kSampled: pool.decodeSampled } : {},
      );
      decoded.set(spec.key, { ...activeFieldValues(sampled.values, sampled.missingMask, options.activeIndices.length), inspected, spec, asset: fetched.asset });
    }
  } finally {
    if (pool) await pool.close();
  }
  if (!terrainGrid) throw new NoaaError('decode', 'Missing HRRR terrain grid');
  const grid = terrainGrid;
  const selection: HrrrCellSelection = selectHrrrCells(grid, { indices: [...options.activeIndices], maxCells: options.activeIndices.length });
  const pick = (key: string) => {
    const item = decoded.get(key);
    if (!item) throw new NoaaError('decode', `Missing decoded HRRR field ${key}`);
    return item;
  };
  const terrain = pick('terrain'), surfacePressure = pick('surfacePressure'), temp2m = pick('temp2m'), dewPoint2m = pick('dewPoint2m');
  const pbl = pick('pbl'), sensible = pick('sensibleHeatFlux'), latent = pick('latentHeatFlux'), precipitation = pick('precipitation');
  const precipitationMmPerHour = precipitationRate(precipitation.values, precipitation.missing, 1);
  const covers = options.coverage;
  let covered: Uint8Array | null = null;
  let outsideCount = 0;
  if (covers) {
    if (!covers.id || !covers.version || !/^[a-f0-9]{64}$/.test(covers.hash)) {
      throw new NoaaError('invalid-option', 'HRRR coverage gate requires id, version and lowercase SHA-256 hash');
    }
    covered = new Uint8Array(selection.cells.length);
    for (let i = 0; i < selection.cells.length; i++) {
      const cell = selection.cells[i]!;
      covered[i] = covers.isCovered(cell.latitude, cell.longitude) ? 1 : 0;
      if (!covered[i]) outsideCount++;
    }
  }
  const coverage: HrrrCoverage = {
    gateId: covers?.id ?? null,
    gateVersion: covers?.version ?? null,
    gateHash: covers?.hash ?? null,
    covered,
    outsideCount,
    publicationReady: false,
  };
  const fields: HrrrFieldReceipt[] = specs.map((spec) => {
    const item = pick(spec.key);
    return {
      ...item.inspected.receipt,
      productFile: hrrrProductFile(spec),
      idxLine: selections.get(spec.key)!.selected.line,
      idxLineNumber: selections.get(spec.key)!.selected.indexLine,
      asset: item.asset,
      decodedMissingCount: item.missingCount,
    };
  });
  const hgtM = HRRR_PRESSURE_LEVELS_HPA.map((level) => pick(`${level}.hgt`).values);
  const tempK = HRRR_PRESSURE_LEVELS_HPA.map((level) => pick(`${level}.tmp`).values);
  return {
    schemaVersion: 1,
    model: 'hrrr-conus',
    adapterVersion: 'hrrr-conus-minimal-input-1',
    indexing: HRRR_INDEXING,
    cycle: options.cycle,
    hour: options.hour,
    validAt: validAt(options.cycle, options.hour),
    capturedAt,
    grid: hrrrNativeGrid(grid),
    cells: selection.cells,
    activeIndices: options.activeIndices,
    pressureLevelsHpa: HRRR_PRESSURE_LEVELS_HPA,
    terrainM: terrain.values,
    surfacePressurePa: surfacePressure.values,
    temp2mK: temp2m.values,
    dewPoint2mK: dewPoint2m.values,
    pblHeightM: pbl.values,
    sensibleHeatFluxWm2: sensible.values,
    latentHeatFluxWm2: latent.values,
    precipitationMmPerHour,
    hgtM,
    tempK,
    missing: {
      terrain: terrain.missing,
      surfacePressure: surfacePressure.missing,
      temp2m: temp2m.missing,
      dewPoint2m: dewPoint2m.missing,
      pbl: pbl.missing,
      sensibleHeatFlux: sensible.missing,
      latentHeatFlux: latent.missing,
      precipitation: precipitation.missing,
      hgt: HRRR_PRESSURE_LEVELS_HPA.map((level) => pick(`${level}.hgt`).missing),
      temp: HRRR_PRESSURE_LEVELS_HPA.map((level) => pick(`${level}.tmp`).missing),
    },
    intervals: hrrrFrameIntervals(options.cycle, options.hour),
    humidityRepresentation: 'dewpoint-2m',
    coverage,
    receipt: {
      schemaVersion: 1,
      cycle: options.cycle,
      hour: options.hour,
      validAt: validAt(options.cycle, options.hour),
      capturedAt,
      activeCount: options.activeIndices.length,
      products: { surface: 'wrfsfc', pressure: 'wrfprs' },
      fields,
      assets: uniqueAssets(assets),
    },
  };
}

export async function proveHrrrInputs(options: ProveHrrrInputsOptions = {}): Promise<ProveHrrrInputsReport> {
  const hour = options.hour ?? 1;
  assertHour(hour);
  const discovery = await discoverHrrrRun({ now: options.now, cycle: options.cycle, requiredHours: [hour], fetchImpl: options.fetchImpl, signal: options.signal });
  const transport = new NoaaTransport({ fetchImpl: options.fetchImpl, signal: options.signal, cacheDir: options.cacheDir });
  const grid = await readGrid(transport, discovery.cycle, hour);
  const selection = selectHrrrCells(grid, {
    indices: options.activeIndices ? [...options.activeIndices] : undefined,
    bounds: options.activeIndices ? undefined : options.bounds ?? { west: -117.45, south: 32.75, east: -117.05, north: 33.05 },
    points: options.points,
    maxCells: options.activeIndices?.length ?? 2_000,
  });
  const frame = await acquireHrrrFrame({
    cycle: discovery.cycle,
    hour,
    activeIndices: Uint32Array.from(selection.cells.map((cell) => cell.index)),
    coverage: options.coverage,
    cacheDir: options.cacheDir,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    now: options.now,
  });
  const count = (missing: Uint8Array) => missing.reduce((total, value) => total + value, 0);
  return {
    ok: true,
    ticket: 'HRRR-INPUT-PROOF',
    model: 'hrrr-conus',
    discovery,
    acquisition: {
      cycle: frame.cycle,
      hour: frame.hour,
      validAt: frame.validAt,
      indexing: frame.indexing,
      grid: frame.grid,
      activeCount: frame.activeIndices.length,
      pressureLevelsHpa: frame.pressureLevelsHpa,
      intervals: frame.intervals,
      coverage: {
        gateId: frame.coverage.gateId,
        gateVersion: frame.coverage.gateVersion,
        gateHash: frame.coverage.gateHash,
        outsideCount: frame.coverage.outsideCount,
        publicationReady: frame.coverage.publicationReady,
      },
      missingCounts: {
        terrain: count(frame.missing.terrain),
        surfacePressure: count(frame.missing.surfacePressure),
        temp2m: count(frame.missing.temp2m),
        dewPoint2m: count(frame.missing.dewPoint2m),
        pbl: count(frame.missing.pbl),
        sensibleHeatFlux: count(frame.missing.sensibleHeatFlux),
        latentHeatFlux: count(frame.missing.latentHeatFlux),
        precipitation: count(frame.missing.precipitation),
        hgt: frame.missing.hgt.reduce((total, missing) => total + count(missing), 0),
        temp: frame.missing.temp.reduce((total, missing) => total + count(missing), 0),
      },
      receipt: frame.receipt,
    },
    publicationReady: false,
    remainingGates: [
      'versioned-regional-coverage-mask',
      'native-export-mask-hash',
      'publication-adapter',
      'live-proof-using-versioned-mask',
    ],
  };
}
