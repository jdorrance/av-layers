import { describe, expect, it } from 'vitest';
import { dataIdentity, encodeJson, parseJson, terrainAssetSchema, terrainCatalogSchema, terrainGeometrySchema, terrainTileSourceSchema } from './contract.js';
import { terrainCatalogFixture } from './test-fixtures.js';

describe('terrain physical and storage identity', () => {
  it('retains data identity across lossless storage changes, but includes physical placement and source bytes', () => {
    const initial = terrainCatalogFixture(), repacked = structuredClone(initial);
    repacked.tiles[0].asset = { key: 'terrain/assets/new.tif', bytes: 200, sha256: 'd'.repeat(64) };
    expect(dataIdentity(repacked)).toBe(initial.dataId);
    repacked.tiles[0].sourceSha256 = 'e'.repeat(64);
    expect(dataIdentity(repacked)).not.toBe(initial.dataId);
    expect(() => terrainCatalogSchema.parse(repacked)).toThrow(/identity/);
  });
  it('rejects invalid geography, geocell aliases, unsafe keys, and oversize metadata before decoding', () => {
    expect(() => terrainGeometrySchema.parse({ width: 2, height: 2, lon0: 180, lat0: -90, dx: 1, dy: -1 })).toThrow();
    expect(() => terrainTileSourceSchema.parse({ id: 'Copernicus_DSM_COG_30_S00_00_E000_00_DEM', south: 0, west: 0 })).toThrow();
    for (const key of ['terrain/../secret', '/terrain/a', 'builds/gfs/file', 'https://example.com/a']) expect(() => terrainAssetSchema.parse({ key, bytes: 1, sha256: 'a'.repeat(64) })).toThrow();
    expect(() => encodeJson({ large: 'x'.repeat(100) }, 10)).toThrow(/budget/);
    expect(() => parseJson(new Uint8Array(11), terrainAssetSchema, 10)).toThrow(/budget/);
  });
});
