import gfs from '../config/gfs.json' with { type: 'json' };
import iconEu from '../config/icon-eu.json' with { type: 'json' };
import { regularLatLonGridSchema, type RegularLatLonGrid } from './geometry.js';
import { defineProduct, type ProductDefinition } from './product.js';
export * from './product.js';

/** Shared source facts consumed by adapters and the offline mask generator. */
export const GFS_SETTINGS = gfs;
export const ICON_EU_SETTINGS = iconEu;
export const GFS_PRODUCT = defineProduct(gfs);
export const ICON_EU_PRODUCT = defineProduct(iconEu);
export const GFS_GRID: RegularLatLonGrid = Object.freeze(regularLatLonGridSchema.parse(GFS_PRODUCT.grid));
export const ICON_EU_GRID: RegularLatLonGrid = Object.freeze(regularLatLonGridSchema.parse(ICON_EU_PRODUCT.grid));

/** Only production products belong here; fixtures are imported explicitly by tests/dev. */
export const PRODUCTS: readonly ProductDefinition[] = Object.freeze([GFS_PRODUCT, ICON_EU_PRODUCT]);
export const MODEL_IDS: readonly string[] = Object.freeze(PRODUCTS.map(product => product.modelId));
export function getProduct(modelId: string): ProductDefinition | undefined {
  return PRODUCTS.find(product => product.modelId === modelId);
}
