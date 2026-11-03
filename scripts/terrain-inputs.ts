import { getProduct, parseBoundedJson } from '@av/contracts';
import { preparedTerrainRefSchema } from '../apps/batch/src/terrain/prepare.js';
import { parseJson, terrainAssetSchema } from '../apps/batch/src/terrain/contract.js';

/** A single immutable catalog supplies every configured zone and selected model. */
export function terrainCatalogInput(json: string) {
  return parseJson(Buffer.from(json), terrainAssetSchema, 16 * 1024);
}

/** Optional model selections share the existing plan channel; absent models acquire no terrain. */
export function terrainInputForModel(json: string, model: string) {
  const bytes = Buffer.from(json);
  if (bytes.length > 64 * 1024) throw new Error('Terrain inputs exceed byte budget');
  const raw = parseBoundedJson(bytes);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Terrain inputs must map model IDs to prepared references');
  const inputs = new Map(Object.entries(raw).map(([id, value]) => {
    if (!getProduct(id)) throw new Error('Unknown terrain product');
    return [id, preparedTerrainRefSchema.parse(value)] as const;
  }));
  return inputs.get(model);
}
