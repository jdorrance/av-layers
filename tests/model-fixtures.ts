import { getProduct, regularLatLonGridSchema } from '@av/contracts';
import models from '../scripts/fixtures/source-models.json' with { type: 'json' };

function source(protocol: keyof typeof models) {
  const product = getProduct(models[protocol]);
  if (!product || product.upstream.protocol !== protocol) throw new Error(`Missing ${protocol} test source`);
  return product;
}

export const INDEXED_PRODUCT = source('indexed-grib2');
export const SPLIT_PRODUCT = source('split-grib2');
export const INDEXED_GRID = regularLatLonGridSchema.parse(INDEXED_PRODUCT.grid);
export const SPLIT_GRID = regularLatLonGridSchema.parse(SPLIT_PRODUCT.grid);
