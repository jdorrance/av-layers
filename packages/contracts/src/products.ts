import gfs from '../config/gfs.json' with { type: 'json' };
import { regularLatLonGridSchema, type Grid, type RegularLatLonGrid } from './geometry.js';

/** Shared with the offline mask generator; these are source facts and product choices, not environment options. */
export const GFS_SETTINGS = gfs;
export const LAYER_IDS = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'] as const;
export type LayerId = typeof LAYER_IDS[number];
export const GFS_GRID: RegularLatLonGrid = Object.freeze(regularLatLonGridSchema.parse(gfs.grid));

export interface ProductDefinition {
  /** Public catalog/URL identity, independent of the upstream family and domain. */
  readonly modelId: string;
  readonly id: string;
  readonly source: { readonly modelFamily: string; readonly configurationId: string; readonly domainId: string };
  readonly label: string;
  readonly attribution: string;
  readonly bounds: readonly [number, number, number, number];
  readonly coverageDescription: string;
  readonly freshness: { readonly maxCycleAgeHours: number; readonly minHorizonHours: number };
  readonly grid: Grid;
  readonly coverageId: string;
  readonly maxNativeZoom: number;
  readonly supportHaloCells: number;
  readonly frameHours: readonly number[];
  readonly intervalHours: number;
  readonly layers: readonly LayerId[];
}

export const GFS_PRODUCT: ProductDefinition = Object.freeze({
  modelId: gfs.modelId, id: gfs.id, source: Object.freeze(gfs.source),
  label: gfs.label, attribution: gfs.attribution,
  bounds: [gfs.coverage.west, gfs.coverage.south, gfs.coverage.east, gfs.coverage.north] as const,
  coverageDescription: gfs.coverage.description, freshness: Object.freeze(gfs.freshness),
  grid: GFS_GRID, coverageId: gfs.coverage.id, maxNativeZoom: gfs.coverage.maxNativeZoom, supportHaloCells: gfs.coverage.interpolationHaloCells,
  frameHours: Object.freeze(gfs.forecast.hours), intervalHours: gfs.forecast.intervalHours, layers: LAYER_IDS
});

/** Only production products belong here; fixtures are imported explicitly by tests/dev. */
export const PRODUCTS: readonly ProductDefinition[] = Object.freeze([GFS_PRODUCT]);
export const MODEL_IDS: readonly string[] = Object.freeze(PRODUCTS.map(product => product.modelId));
export function getProduct(modelId: string): ProductDefinition | undefined {
  return PRODUCTS.find(product => product.modelId === modelId);
}
