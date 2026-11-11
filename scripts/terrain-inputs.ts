import { parseJson, terrainAssetSchema } from '../apps/batch/src/terrain/contract.js';

/** A single immutable catalog supplies every configured zone and selected model. */
export function terrainCatalogInput(json: string) {
  return parseJson(Buffer.from(json), terrainAssetSchema, 16 * 1024);
}
