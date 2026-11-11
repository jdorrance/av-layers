import { planWholeDomainGrid, setBit, type CoverageMask, type Grid, type ProductDefinition } from '@av/contracts';
import { describeSparseCoverage } from '../../apps/batch/src/coverage.js';
import { sha256, TERRAIN_SOURCE } from '../../apps/batch/src/terrain/contract.js';
import { localTerrainStorage } from '../../apps/batch/src/terrain/local-store.js';
import { writeSparsePreparedTerrain } from '../../apps/batch/src/terrain/sparse.js';
import { nativeSparseMask } from '../../apps/batch/src/whole-domain/coverage.js';

export function denseFixtureMask(product: ProductDefinition, grid: Grid): CoverageMask {
  const cells = grid.width * grid.height, tileCount = (4 ** (product.maxNativeZoom + 1) - 1) / 3;
  const output = new Uint8Array(Math.ceil(cells / 8)), tiles = new Uint8Array(Math.ceil(tileCount / 8));
  for (let index = 0; index < cells; index++) setBit(output, index);
  for (let index = 0; index < tileCount; index++) setBit(tiles, index);
  return { grid, bounds: product.bounds, output, halo: new Uint8Array(output.length), tiles, maxZoom: product.maxNativeZoom };
}

/** Stage flat 100 m fixture terrain without fetching a source catalog. */
export async function syntheticWholeDomain(out: string, product: ProductDefinition) {
  if (product.terrainSubdivisionFactor === undefined) throw new Error('Synthetic whole-domain fixture requires a subdivision factor');
  const { fine: grid } = planWholeDomainGrid(product.grid, product.terrainSubdivisionFactor);
  const mask = nativeSparseMask(denseFixtureMask(product, grid)), fine = { mask, ...describeSparseCoverage(mask, product) };
  const cells = mask.coverage.offsets.at(-1)!, heights = new Uint8Array(cells * 4), valid = new Uint8Array(cells).fill(1);
  const view = new DataView(heights.buffer);
  for (let index = 0; index < cells; index++) view.setFloat32(index * 4, 100, true);
  const terrain = await writeSparsePreparedTerrain({ storage: localTerrainStorage(out), grid, coverage: mask.coverage,
    coverageDescriptor: fine.bytes, source: TERRAIN_SOURCE, dataId: sha256('synthetic flat terrain at 100 m'), heights, valid });
  return { fine, terrain };
}
