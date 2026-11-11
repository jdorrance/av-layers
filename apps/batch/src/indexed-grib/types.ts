import type { IsobaricFrame } from '@av/forecast';
import type { IdxRecord } from '@azohra/meteo.grib';
import type { IndexedGribTransportStats } from './transport.ts';
import type { FieldSamplingStats } from './sampling.ts';
import type { ForecastSourcePin, ForecastSourceStore, NormalizedFrameTarget } from '../provider.js';

export interface IndexedGribFetchOptions {
  fetchImpl?: typeof fetch;
  offline?: boolean;
  signal?: AbortSignal;
  store?: ForecastSourceStore;
  sourcePin?: ForecastSourcePin;
  retry?: { maxAttempts?: number; deadlineMs?: number; attemptTimeoutMs?: number; baseDelayMs?: number; maxDelayMs?: number };
}

export interface DiscoverIndexedGribRunOptions extends IndexedGribFetchOptions {
  cycle?: string;
  now?: Date;
  cacheDir?: string;
}

export interface DiscoveredIndexedGribRun {
  cycle: string;
  products: Record<string, string>;
  availableHours: readonly number[];
  inventoryComplete: true;
  decodedAdmission: 'not-checked';
  duplicates: { key: string; role: 'current' | 'companion'; url: string; verification: IndexedGribDuplicateVerification }[];
  checkedAt: string;
}

export interface AcquireIndexedGribFrameOptions extends IndexedGribFetchOptions {
  cycle: string;
  hour: number;
  activeIndices: Uint32Array;
  cacheDir?: string;
}

export interface IndexedGribAcquisitionSessionOptions extends IndexedGribFetchOptions {
  cycle?: string;
  activeIndices: Uint32Array;
  cacheDir?: string;
  now?: Date;
  /** At most this many records fetched ahead; defaults to 2. */
  fetchConcurrency?: number;
  /** Worker jobs are independently bounded to 1..4; defaults to one. */
  decodeConcurrency?: number;
  /** Bound on compressed/transferred/decoded buffers plus estimated worker state; defaults to 128 MiB. */
  prefetchBytes?: number;
}

export interface IndexedGribAcquisitionStats {
  [key: string]: unknown;
  transport: IndexedGribTransportStats;
  byPacking: Record<string, FieldSamplingStats>;
  loadMs: number;
  admitMs: number;
  rawCompanionHits: number;
  peakPrefetchBytes: number;
}

/** One cycle/index ordering per session. Acquire frames sequentially; returned
 * fields/receipts belong to the caller. Always close the session in finally. */
export interface IndexedGribAcquisitionSession {
  readonly cycle: string;
  readonly stats: IndexedGribAcquisitionStats;
  acquire(hour: number, target?: NormalizedFrameTarget): Promise<IndexedGribFrameAcquisition>;
  close(): Promise<void>;
}

export type IndexedGribFieldKind =
  | 'terrain'
  | 'surface-pressure'
  | 'temp-2m'
  | 'spfh-2m'
  | 'sensible-flux'
  | 'latent-flux'
  | 'precipitation'
  | 'height'
  | 'temperature'
  | 'aux-surface'
  | 'aux-level';

export interface IndexedGribFieldSpec {
  key: string;
  kind: IndexedGribFieldKind;
  variable: string;
  level: string;
  product: string;
  forecast: string;
  statistic: 'instant' | 'mean' | 'accumulation';
  levelHpa?: number;
  role?: 'current' | 'companion';
  fixedSurface?: readonly [number, number | null];
  auxId?: string;
  scale?: number;
  conversion?: 'geometric-w-to-omega';
  outputUnit?: string;
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
  object?: { etag: string; bytes: number; sha256: string };
}

export interface IndexedGribDuplicateVerification {
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

export interface IndexedGribIntervalReceipt {
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
  kind: IndexedGribFieldKind;
  role: 'current' | 'companion';
  normalization?: { units: string; scale: number; conversion?: 'geometric-w-to-omega'; density?: 'same-level-specific-humidity-or-dry' };
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
  duplicates?: IndexedGribDuplicateVerification;
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
    uvRelativeToGrid?: boolean;
  };
  productMetadata: DecodedProductReceipt;
  interval: IndexedGribIntervalReceipt;
  packing: number;
  packingError: number;
  bitmapIndicator: number;
  codedCount: number;
  decodedMissingCount: number;
  unit: string;
}

export interface IndexedGribFrameAcquisition extends IsobaricFrame {
  schemaVersion: 1;
  model: string;
  precipitationMmPerHour: Float32Array;
  pressureLevelsHpa: readonly number[];
  missing: IsobaricFrame['missing'] & {
    precipitation: Uint8Array;
  };
  intervals: IsobaricFrame['intervals'] & {
    precipitationWindow: { start: string; end: string };
    precipitationSourceWindow: { start: string; end: string };
  };
  receipt: {
    schemaVersion: 1;
    cycle: string;
    hour: number;
    validAt: string;
    capturedAt: string;
    sourcePin?: ForecastSourcePin;
    sourceGrid: {
      ni: number;
      nj: number;
      lon0: number;
      lat0: number;
      earthRadiusM: number;
      gridKey: string;
      gridDefinitionTemplateNumber: number;
    } & ({ dlon: number; dlat: number } | {
      dxM: number; dyM: number;
      laD: number; loV: number; latin1: number; latin2: number;
      scanningMode: number; projectionCentreFlag: number;
    });
    activeCount: number;
    products: Record<string, string>;
    fields: DecodedFieldReceipt[];
    windows: {
      flux: { current: string; companion: string | null; tolerance: number };
      precipitation: { current: string; companion: string | null; tolerance: number };
    };
  };
}
