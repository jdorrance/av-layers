import type { Grid } from '@av/contracts';

export interface IconBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export type IconSourceAsset = {
  sourceKind: 'source';
  url: string;
  sha256: string;
  bytes: number;
  range?: readonly [number, number] | null;
  lastModified?: string | null;
} | { sourceKind: 'fixture'; url: string; sha256: null; bytes: null; range: null; lastModified: null };

export interface IconFieldMetadata {
  shortName: string;
  units: string;
  stepType: string;
  startHour: number;
  endHour: number;
  packingError?: number;
  gridType?: string;
  numberOfDataPoints?: number;
  numberOfGridUsed?: number;
  uuidOfHGrid?: string;
  dataDate?: number;
  dataTime?: number;
  validityDate?: number;
  validityTime?: number;
  typeOfFirstFixedSurface?: number;
  scaledValueOfFirstFixedSurface?: number;
  scaleFactorOfFirstFixedSurface?: number;
  packingType?: string;
  [key: string]: unknown;
}

export interface IconRecord {
  field: string;
  hour: number;
  level: number | null;
  metadata: IconFieldMetadata;
  values: readonly (number | null)[];
  source?: IconSourceAsset;
}

export interface IconGrid {
  type: 'icon-native-triangular';
  uuid: string;
  number: number;
  pointCount: number;
  geometrySource?: unknown;
  coordinateSources?: Record<string, IconSourceAsset>;
}

export interface IconNativeCell {
  index: number;
  id: string;
  latitude: number;
  longitude: number;
  terrainM: number;
}

export interface IconProvenance {
  sourceSynthetic: boolean;
  publicationReady: false;
  provider: string;
  accessProduct: string;
  attribution: string;
  downloadedBytes?: number;
  downloads?: number;
  retries?: number;
  elapsedSeconds?: number;
  decoder?: Record<string, unknown>;
  capturedAt: string;
}

export interface IconExtract {
  model: 'icon-eu';
  referenceTime: string;
  levels: readonly number[];
  forecastHours: readonly number[];
  intervalHours: number;
  bbox: IconBounds;
  grid: IconGrid;
  cells: IconNativeCell[];
  records: Record<string, IconRecord>;
  recordManifest?: Record<string, Omit<IconRecord, 'values'>>;
  recordFiles?: Record<string, string>;
  provenance: IconProvenance;
}

export interface IconNativeGeometry {
  type: 'icon-native-triangular';
  uuid: string;
  number: number;
  pointCount: number;
  selectedCount: number;
  spacingDegEstimate: number;
  levelCount: number;
  levelNumbers: readonly number[];
  levelHeightsM: Float32Array;
}

export interface IconExportMapping {
  policy: 'nearest-native';
  grid: Grid;
  activeIndices: Uint32Array;
  nativeForExport: Uint32Array;
  distanceDeg: Float32Array;
  maxDistanceDeg: number;
  distanceP95Deg: number;
  nativeSpacingDeg: number;
  exportSpacingDeg: number;
}

export interface IconIntervalWindow {
  start: string;
  end: string;
  sourceStart: string;
  sourceEnd: string;
}

export interface IconMissingMask {
  surface: Uint8Array;
  temp2m: Uint8Array;
  dewPoint2m: Uint8Array;
  pbl: Uint8Array;
  sensible: Uint8Array;
  latent: Uint8Array;
  precipitation: Uint8Array;
  level: Uint8Array;
}

export interface IconArmeniaFrame {
  schemaVersion: 1;
  hour: number;
  validAt: string;
  capturedAt: string;
  cellIndices: Uint32Array;
  terrainM: Float32Array;
  surfacePressurePa: Float32Array;
  temp2mK: Float32Array;
  dewPoint2mK: Float32Array;
  pblHeightM: Float32Array;
  sensibleHeatFluxWm2: Float32Array;
  latentHeatFluxWm2: Float32Array;
  precipitationMmPerHour: Float32Array;
  levelPressurePa: Float32Array;
  levelTemperatureK: Float32Array;
  missing: IconMissingMask;
  intervals: {
    flux: IconIntervalWindow;
    precipitation: IconIntervalWindow;
  };
  receipt: {
    sourceSynthetic: boolean;
    publicationReady: false;
    fields: readonly {
      field: string;
      hour: number | null;
      level: number | null;
      units: string;
      stepType: string;
      startHour: number;
      endHour: number;
      asset: IconSourceAsset | null;
    }[];
  };
}

export interface IconArmeniaAcquisition {
  schemaVersion: 1;
  model: 'icon-armenia';
  cycle: string;
  capturedAt: string;
  bbox: IconBounds;
  forecastHours: readonly number[];
  intervalHours: number;
  native: IconNativeGeometry & { cells: IconNativeCell[] };
  frames: IconArmeniaFrame[];
  mapping: IconExportMapping;
  receipt: {
    schemaVersion: 1;
    model: 'icon-armenia';
    cycle: string;
    capturedAt: string;
    bbox: IconBounds;
    native: {
      type: 'icon-native-triangular';
      uuid: string;
      number: number;
      pointCount: number;
      selectedCount: number;
      spacingDegEstimate: number;
      levelCount: number;
      levelNumbers: readonly number[];
    };
    export: {
      width: number;
      height: number;
      dx: number;
      dy: number;
      cellCount: number;
      activeCount: number;
      spacingDeg: number;
    };
    mapping: {
      policy: 'nearest-native';
      maxDistanceDeg: number;
      distanceP95Deg: number;
      spacingRatio: number;
    };
    fields: readonly {
      field: string;
      hour: number | null;
      level: number | null;
      units: string;
      stepType: string;
      startHour: number;
      endHour: number;
      asset: IconSourceAsset | null;
    }[];
    provenance: IconProvenance;
    attribution: Omit<typeof import('./constants.ts').ICON_ATTRIBUTION, 'data'> & { data: { provider: string; product: string; access: string; attribution: string } };
    gating: {
      regionalPublication: 'gated';
      publicationReady: false;
      reason: string;
    };
  };
}

export interface DiscoveredIconArmeniaRun {
  referenceTime: string;
  forecastHours: readonly number[];
  completionUrls: readonly string[];
  status: 'asset-heads-only';
  checkedAt: string;
}

export interface DiscoverIconArmeniaRunOptions {
  now?: Date;
  fetchFn?: typeof fetch;
  lastForecastHour?: number;
  forecastHours?: readonly number[];
  intervalHours?: number;
  signal?: AbortSignal;
}

export interface AcquireIconArmeniaOptions {
  referenceTime?: string;
  forecastHours?: readonly number[];
  intervalHours?: number;
  bbox?: IconBounds;
  cacheDir: string;
  python?: string;
  concurrency?: number;
  maxDownloadBytes?: number;
  extractPath?: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface IconPrecipitationWindow {
  mm: number;
  mmPerHour: number;
}

export interface IconExportFrame {
  activeIndices: Uint32Array;
  nativeForExport: Uint32Array;
  levelCount: number;
  terrainM: Float32Array;
  levelHeightsM: Float32Array;
  surfacePressurePa: Float32Array;
  temp2mK: Float32Array;
  dewPoint2mK: Float32Array;
  pblHeightM: Float32Array;
  sensibleHeatFluxWm2: Float32Array;
  latentHeatFluxWm2: Float32Array;
  precipitationMmPerHour: Float32Array;
  levelPressurePa: Float32Array;
  levelTemperatureK: Float32Array;
  missing: IconMissingMask;
}
