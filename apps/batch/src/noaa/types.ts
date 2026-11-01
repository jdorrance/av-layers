import type { IdxRecord } from '@azohra/meteo.grib';
import type { NoaaTransportStats } from './transport.ts';
import type { FieldSamplingStats } from './sampling.ts';

export interface NoaaFetchOptions {
  fetch?: typeof fetch;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  retry?: { maxAttempts?: number; deadlineMs?: number; attemptTimeoutMs?: number; baseDelayMs?: number; maxDelayMs?: number };
}

export interface DiscoverGfsRunOptions extends NoaaFetchOptions {
  now?: Date;
  cacheDir?: string;
}

export interface DiscoveredGfsRun {
  cycle: string;
  products: { primary: string; secondary: string };
  availableHours: readonly number[];
  inventoryComplete: true;
  decodedAdmission: 'not-checked';
  duplicates: { key: string; role: 'current' | 'companion'; url: string; verification: GfsDuplicateVerification }[];
  checkedAt: string;
}

export interface AcquireGfsFrameOptions extends NoaaFetchOptions {
  cycle: string;
  hour: number;
  activeIndices: Uint32Array;
  cacheDir?: string;
}

export interface GfsAcquisitionSessionOptions extends NoaaFetchOptions {
  cycle?: string;
  activeIndices: Uint32Array;
  cacheDir?: string;
  now?: Date;
  /** At most this many records fetched ahead; defaults to 2. */
  fetchConcurrency?: number;
  /** Worker jobs are independently bounded to 1..4; defaults to at most two available CPUs. */
  decodeConcurrency?: number;
  /** Bound on compressed/transferred/decoded buffers plus estimated worker state; defaults to 128 MiB. */
  prefetchBytes?: number;
}

export interface GfsAcquisitionStats {
  transport: NoaaTransportStats;
  byPacking: Record<string, FieldSamplingStats>;
  loadMs: number;
  admitMs: number;
  rawCompanionHits: number;
  peakPrefetchBytes: number;
}

/** One cycle/index ordering per session. Acquire frames sequentially; returned
 * fields/receipts belong to the caller. Always close the session in finally. */
export interface GfsAcquisitionSession {
  readonly cycle: string;
  readonly stats: GfsAcquisitionStats;
  acquire(hour: number): Promise<GfsFrameAcquisition>;
  close(): Promise<void>;
}

export type GfsFieldKind =
  | 'terrain'
  | 'surface-pressure'
  | 'temp-2m'
  | 'spfh-2m'
  | 'pbl'
  | 'sensible-flux'
  | 'latent-flux'
  | 'precipitation'
  | 'height'
  | 'temperature';

export interface GfsFieldSpec {
  key: string;
  kind: GfsFieldKind;
  variable: string;
  level: string;
  product: 'primary' | 'secondary';
  forecast: string;
  statistic: 'instant' | 'mean' | 'accumulation';
  levelHpa?: number;
  role?: 'current' | 'companion';
}

export interface SelectedIdxRecord {
  record: IdxRecord;
  line: string;
  indexLine: number;
}

export interface SourceAssetReceipt {
  url: string;
  range: string | null;
  sha256: string;
  size: number;
  file: string | null;
}

export interface GfsDuplicateVerification {
  rule: 'full-grib-byte-identical-v1';
  selectedOffset: number;
  candidates: { offset: number; length: number; idxLine: string; idxLineNumber: number; asset: SourceAssetReceipt }[];
}

export interface DecodedProductReceipt {
  productDefinitionTemplateNumber: number;
  parameterCategory: number;
  parameterNumber: number;
  typeOfGeneratingProcess: number | undefined;
  indicatorOfUnitOfTimeRange: number | undefined;
  forecastTime: number | undefined;
  typeOfFirstFixedSurface: number | undefined;
  scaleFactorOfFirstFixedSurface: number | undefined;
  scaledValueOfFirstFixedSurface: number | undefined;
  typeOfSecondFixedSurface: number | undefined;
  numberOfCoordinateValues: number;
}

export interface NoaaIntervalReceipt {
  kind: 'instant' | 'window';
  start: string;
  end: string;
  process?: number;
  missingCount?: number;
  ranges?: readonly {
    process: number;
    incrementType: number;
    rangeUnit: number;
    rangeLength: number;
    incrementUnit: number;
    increment: number;
  }[];
}

export interface DecodedFieldReceipt {
  key: string;
  kind: GfsFieldKind;
  role: 'current' | 'companion';
  variable: string;
  level: string;
  levelHpa: number | null;
  product: string;
  productFile: string;
  url: string;
  idxLine: string;
  idxLineNumber: number;
  forecastLabel: string;
  asset: SourceAssetReceipt;
  duplicates?: GfsDuplicateVerification;
  metadataSha256: string;
  encodingSha256: string;
  identification: {
    centre: number;
    subCentre: number;
    significanceOfReferenceTime: number;
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    productionStatus: number;
    typeOfProcessedData: number;
  };
  grid: {
    kind: string;
    gridKey: string;
    ni: number;
    nj: number;
    numberOfDataPoints: number;
    gridDefinitionTemplateNumber: number;
    scanningMode: number;
    earthRadiusM: number;
  };
  productMetadata: DecodedProductReceipt;
  interval: NoaaIntervalReceipt;
  packing: number;
  packingError: number;
  bitmapIndicator: number;
  codedCount: number;
  decodedMissingCount: number;
  unit: string;
}

export interface GfsFrameAcquisition {
  schemaVersion: 1;
  model: 'gfs';
  cycle: string;
  hour: number;
  validAt: string;
  capturedAt: string;
  grid: {
    width: number;
    height: number;
    lon0: number;
    lat0: number;
    dx: number;
    dy: number;
    wrapLongitude: true;
  };
  activeIndices: Uint32Array;
  terrainM: Float32Array;
  surfacePressurePa: Float32Array;
  temp2mK: Float32Array;
  specificHumidity2mKgKg: Float32Array;
  pblHeightM: Float32Array;
  sensibleHeatFluxWm2: Float32Array;
  latentHeatFluxWm2: Float32Array;
  precipitationMmPerHour: Float32Array;
  pressureLevelsHpa: readonly number[];
  hgtM: Float32Array[];
  tempK: Float32Array[];
  missing: {
    terrain: Uint8Array;
    surfacePressure: Uint8Array;
    temp2m: Uint8Array;
    humidity2m: Uint8Array;
    pbl: Uint8Array;
    sensibleHeatFlux: Uint8Array;
    latentHeatFlux: Uint8Array;
    precipitation: Uint8Array;
    hgt: Uint8Array[];
    temp: Uint8Array[];
  };
  intervals: {
    profileTime: string;
    fluxWindow: { start: string; end: string };
    precipitationWindow: { start: string; end: string };
    fluxSourceWindow: { start: string; end: string };
    precipitationSourceWindow: { start: string; end: string };
    usedCompanion: boolean;
  };
  receipt: {
    schemaVersion: 1;
    cycle: string;
    hour: number;
    validAt: string;
    capturedAt: string;
    sourceGrid: {
      ni: number;
      nj: number;
      lon0: number;
      lat0: number;
      dlon: number;
      dlat: number;
      earthRadiusM: number;
      gridKey: string;
      gridDefinitionTemplateNumber: number;
    };
    activeCount: number;
    products: { primary: string; secondary: string };
    fields: DecodedFieldReceipt[];
    windows: {
      flux: { current: string; companion: string | null; tolerance: number };
      precipitation: { current: string; companion: string | null; tolerance: number };
    };
  };
}

export interface ProveGfsInputsOptions extends NoaaFetchOptions {
  cycle?: string;
  hour?: number;
  activeIndices?: Uint32Array;
  cacheDir?: string;
  now?: Date;
  logger?: (line: string) => void;
  diagnostic?: false;
}

export interface DiagnoseGfsInputsOptions extends Omit<ProveGfsInputsOptions, 'diagnostic' | 'cycle'> {
  diagnostic: true;
  cycle: string;
}

export interface DiagnoseGfsInputsReport {
  ok: boolean;
  ticket: 'GFS-INPUT-DIAGNOSTIC';
  publicationEligible: false;
  cycle: string;
  hour: number;
  activeIndices: number[];
  nativeIndices: number[];
  pressureLevelsHpa: readonly number[];
  transport: NoaaTransportStats;
  fields: ({ spec: GfsFieldSpec; status: 'admitted'; receipt: DecodedFieldReceipt; values: (number | null)[]; missing: number[] } |
    { spec: GfsFieldSpec; status: 'failed'; error: { name: string; message: string; code?: string; details?: Readonly<Record<string, unknown>> } })[];
  pairs: { key: string; status: 'admitted' | 'failed'; error?: string }[];
}

export interface ProveGfsInputsReport {
  ok: true;
  ticket: 'GFS-INPUT-PROOF';
  discovered: DiscoveredGfsRun | null;
  acquisition: {
    cycle: string;
    hour: number;
    validAt: string;
    grid: GfsFrameAcquisition['grid'];
    activeIndices: number[];
    pressureLevelsHpa: readonly number[];
    intervals: GfsFrameAcquisition['intervals'];
    fieldCount: number;
    missingCounts: Record<string, number>;
    sourceBytes: number;
    requestCount: number;
    transport: NoaaTransportStats;
    receipt: GfsFrameAcquisition['receipt'];
  };
}
