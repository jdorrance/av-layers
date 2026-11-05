import { getProduct, regularLatLonGridSchema, renderedLayers } from '@av/contracts';
import models from '../scripts/fixtures/source-models.json' with { type: 'json' };

function source(protocol: keyof typeof models) {
  const product = getProduct(models[protocol]);
  if (!product || product.upstream.protocol !== protocol) throw new Error(`Missing ${protocol} test source`);
  const { auxSurface: _auxSurface, auxLevels: _auxLevels, ...upstream } = product.upstream;
  const layers = renderedLayers(product.layers).filter(layer => protocol === 'indexed-grib2' || layer !== 'precip-rate');
  const capabilities = { ...product.capabilities, daylightFrames: protocol === 'split-grib2' ? 'regional-daylight' as const : 'all-hours' as const };
  const frameHours = product.frameHours.filter(hour => hour <= 24);
  return { ...product, layers, upstream, capabilities, frameHours, mapEndHour: undefined, intervalChange: undefined,
    forecast: { ...product.forecast, hours: frameHours, mapEndHour: undefined, intervalChange: undefined } };
}

export const INDEXED_PRODUCT = source('indexed-grib2');
export const SPLIT_PRODUCT = source('split-grib2');
export const INDEXED_GRID = regularLatLonGridSchema.parse(INDEXED_PRODUCT.grid);
export const SPLIT_GRID = regularLatLonGridSchema.parse(SPLIT_PRODUCT.grid);
