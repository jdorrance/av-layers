import type { Identification, ProductDefinition } from '@azohra/meteo.grib';
import type { NoaaIntervalReceipt, SourceAssetReceipt } from '../noaa/types.ts';

export type HrrrProduct = 'surface' | 'pressure';
export type HrrrFieldStatistic = 'instant' | 'accumulation';
export type HrrrFieldKind =
  | 'terrain'
  | 'surface-pressure'
  | 'temp-2m'
  | 'dewpoint-2m'
  | 'pbl'
  | 'sensible-flux'
  | 'latent-flux'
  | 'precipitation'
  | 'height'
  | 'temperature';

export interface HrrrFieldSpec {
  key: string;
  kind: HrrrFieldKind;
  product: HrrrProduct;
  variable: string;
  level: string;
  levelHpa?: number;
  forecast: string;
  statistic: HrrrFieldStatistic;
  unit: string;
  conversion: string;
}

export interface HrrrNativeGrid {
  kind: 'lambert';
  gridDefinitionTemplateNumber: 30;
  gridKey: string;
  ni: number;
  nj: number;
  numberOfDataPoints: number;
  scanningMode: number;
  iScansNegatively: boolean;
  jScansPositively: boolean;
  jPointsAreConsecutive: boolean;
  alternativeRowScanning: boolean;
  resolutionAndComponentFlags: number;
  uvRelativeToGrid: boolean;
  earthRadiusM: number;
  latitudeOfFirstGridPoint: number;
  longitudeOfFirstGridPoint: number;
  laD: number;
  loV: number;
  dxM: number;
  dyM: number;
  projectionCentreFlag: number;
  latin1: number;
  latin2: number;
  southPoleLatitude: number;
  southPoleLongitude: number;
  corners: readonly (readonly [number, number])[];
}

export interface HrrrCell {
  index: number;
  i: number;
  j: number;
  latitude: number;
  longitude: number;
  corners: readonly (readonly [number, number])[];
}

export interface HrrrBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface HrrrPoint {
  id: string;
  latitude: number;
  longitude: number;
}

export interface HrrrCellSelection {
  grid: HrrrNativeGrid;
  cells: readonly HrrrCell[];
  indexing: 'hrrr-native-lambert-storage';
}

export interface HrrrFieldReceipt {
  key: string;
  kind: HrrrFieldKind;
  product: HrrrProduct;
  productFile: string;
  variable: string;
  level: string;
  levelHpa: number | null;
  forecastLabel: string;
  statistic: HrrrFieldStatistic;
  unit: string;
  conversion: string;
  idxLine: string;
  idxLineNumber: number;
  asset: SourceAssetReceipt;
  identification: Identification;
  productMetadata: ProductDefinition;
  grid: {
    kind: 'lambert';
    gridKey: string;
    ni: number;
    nj: number;
    numberOfDataPoints: number;
    gridDefinitionTemplateNumber: number;
    scanningMode: number;
    earthRadiusM: number;
  };
  interval: NoaaIntervalReceipt;
  packing: number;
  packingError: number;
  codedCount: number;
  bitmapIndicator: number;
  metadataSha256: string;
  encodingSha256: string;
  decodedMissingCount: number;
}

export interface HrrrCoverage {
  gateId: string | null;
  gateVersion: string | null;
  gateHash: string | null;
  covered: Uint8Array | null;
  outsideCount: number;
  publicationReady: boolean;
}

export interface HrrrFrameIntervals {
  profileTime: string;
  flux: { kind: 'instant'; validAt: string };
  precipitation: {
    kind: 'window';
    start: string;
    end: string;
    durationHours: number;
    sourceLabel: string;
  };
}

export interface HrrrFrameAcquisition {
  schemaVersion: 1;
  model: 'hrrr-conus';
  adapterVersion: 'hrrr-conus-minimal-input-1';
  indexing: 'hrrr-native-lambert-storage';
  cycle: string;
  hour: number;
  validAt: string;
  capturedAt: string;
  grid: HrrrNativeGrid;
  cells: readonly HrrrCell[];
  activeIndices: Uint32Array;
  pressureLevelsHpa: readonly number[];
  terrainM: Float32Array;
  surfacePressurePa: Float32Array;
  temp2mK: Float32Array;
  dewPoint2mK: Float32Array;
  pblHeightM: Float32Array;
  sensibleHeatFluxWm2: Float32Array;
  latentHeatFluxWm2: Float32Array;
  precipitationMmPerHour: Float32Array;
  hgtM: Float32Array[];
  tempK: Float32Array[];
  missing: {
    terrain: Uint8Array;
    surfacePressure: Uint8Array;
    temp2m: Uint8Array;
    dewPoint2m: Uint8Array;
    pbl: Uint8Array;
    sensibleHeatFlux: Uint8Array;
    latentHeatFlux: Uint8Array;
    precipitation: Uint8Array;
    hgt: Uint8Array[];
    temp: Uint8Array[];
  };
  intervals: HrrrFrameIntervals;
  humidityRepresentation: 'dewpoint-2m';
  coverage: HrrrCoverage;
  receipt: {
    schemaVersion: 1;
    cycle: string;
    hour: number;
    validAt: string;
    capturedAt: string;
    activeCount: number;
    products: { surface: 'wrfsfc'; pressure: 'wrfprs' };
    fields: HrrrFieldReceipt[];
    assets: SourceAssetReceipt[];
  };
}

export interface HrrrCoverageGate {
  id: string;
  version: string;
  hash: string;
  isCovered(latitude: number, longitude: number): boolean;
}

export interface DiscoverHrrrRunOptions {
  now?: Date;
  cycle?: string;
  requiredHours?: readonly number[];
  maxHour?: number;
  candidateCount?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface DiscoveredHrrrRun {
  schemaVersion: 1;
  model: 'hrrr-conus';
  cycle: string;
  products: { surface: 'wrfsfc'; pressure: 'wrfprs' };
  requiredHours: readonly number[];
  availableHours: readonly number[];
  checkedAt: string;
  status: 'inventory-only';
  inventories: readonly DiscoveredHrrrRun['inventory'][];
  inventory: {
    hour: number;
    surfaceFields: readonly string[];
    pressureLevelsHpa: readonly number[];
    precipitationForecast: string;
    fluxStatistic: 'instant';
    humidityRepresentation: 'dewpoint-2m';
  };
}

export interface AcquireHrrrFrameOptions {
  cycle: string;
  hour: number;
  activeIndices: Uint32Array;
  coverage?: HrrrCoverageGate;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  now?: Date;
}

export interface ProveHrrrInputsOptions {
  now?: Date;
  cycle?: string;
  hour?: number;
  activeIndices?: Uint32Array;
  bounds?: HrrrBounds;
  points?: readonly HrrrPoint[];
  coverage?: HrrrCoverageGate;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface ProveHrrrInputsReport {
  ok: true;
  ticket: 'HRRR-INPUT-PROOF';
  model: 'hrrr-conus';
  discovery: DiscoveredHrrrRun;
  acquisition: {
    cycle: string;
    hour: number;
    validAt: string;
    indexing: 'hrrr-native-lambert-storage';
    grid: HrrrNativeGrid;
    activeCount: number;
    pressureLevelsHpa: readonly number[];
    intervals: HrrrFrameIntervals;
    coverage: {
      gateId: string | null;
      gateVersion: string | null;
      gateHash: string | null;
      outsideCount: number;
      publicationReady: boolean;
    };
    missingCounts: Record<string, number>;
    receipt: HrrrFrameAcquisition['receipt'];
  };
  publicationReady: boolean;
  remainingGates: readonly string[];
}
