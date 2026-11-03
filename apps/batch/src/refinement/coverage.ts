import { getBit, MAX_GRID_CELLS, prepareCoverageTester, prepareGridGeometry, sameGrid, setBit, type CoverageMask, type GeographicBounds, type ProductDefinition } from '@av/contracts';
import { containsRefinement, type RefinementPlan } from '@av/contracts/refinement';
import { configuredRefinements } from './config.js';

/** Require polygon/base coverage and a one-cell halo around each fine output cell. */
export function validateRefinementCoverage(base: CoverageMask, mask: CoverageMask, patch: Parameters<typeof containsRefinement>[0]): void {
  const geometry = prepareGridGeometry(mask.grid), withinBase = prepareCoverageTester(base), { width, height } = mask.grid;
  let outputs = 0;
  for (let index = 0; index < width * height; index++) {
    if (!getBit(mask.output, index)) continue;
    outputs++;
    const x = index % width, y = Math.floor(index / width), point = geometry.gridToGeographic(x, y);
    if (!point || !containsRefinement(patch, point.lat, point.lon)
      || !withinBase(point.lat, point.lon)) throw new Error('Refinement output exceeds its polygon or base coverage');
    if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) throw new Error('Refinement output lacks an interior grid halo');
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const neighbor = (y + dy) * width + x + dx;
      if (!getBit(mask.output, neighbor) && !getBit(mask.halo, neighbor)) throw new Error('Refinement interpolation support is incomplete');
    }
  }
  if (!outputs) throw new Error('Refinement coverage is empty');
}

export function assertRefinementCellBudget(base: CoverageMask, grids: readonly { grid: CoverageMask['grid'] }[]): void {
  const cells = base.grid.width * base.grid.height + grids.reduce((total, item) => total + item.grid.width * item.grid.height, 0);
  if (!Number.isSafeInteger(cells) || cells > MAX_GRID_CELLS) throw new Error('Aggregate forecast grids exceed the cell budget');
}

/** Conservative geographic tile bounds, intersected with the existing publication's addresses. */
function patchTiles(base: CoverageMask, bounds: GeographicBounds): Uint8Array {
  const tiles = new Uint8Array(base.tiles.length), [west, south, east, north] = bounds;
  for (let z = 0; z <= base.maxZoom; z++) {
    const span = 2 ** z, clamp = (value: number) => Math.max(0, Math.min(span - 1, Math.floor(value)));
    const x0 = clamp((west + 180) / 360 * span), x1 = clamp((east + 180) / 360 * span);
    const row = (lat: number) => clamp((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * span);
    for (let y = row(north); y <= row(south); y++) for (let x = x0; x <= x1; x++) {
      const index = (4 ** z - 1) / 3 + y * span + x;
      if (getBit(base.tiles, index)) setBit(tiles, index);
    }
  }
  return tiles;
}

function ownedMask(plan: RefinementPlan, base: CoverageMask, signal?: AbortSignal): CoverageMask | null {
  const grid = plan.grid, cells = grid.width * grid.height, output = new Uint8Array(Math.ceil(cells / 8)), halo = new Uint8Array(output.length);
  const geometry = prepareGridGeometry(grid), withinBase = prepareCoverageTester(base);
  let count = 0;
  for (let index = 0; index < cells; index++) {
    if (index % 4096 === 0) signal?.throwIfAborted();
    const x = index % grid.width, y = Math.floor(index / grid.width), point = geometry.gridToGeographic(x, y);
    if (!point || !containsRefinement(plan, point.lat, point.lon) || !withinBase(point.lat, point.lon)) continue;
    if (x < 1 || y < 1 || x >= grid.width - 1 || y >= grid.height - 1) throw new Error('Refinement output lacks an interior grid halo');
    setBit(output, index); count++;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) setBit(halo, (y + dy) * grid.width + x + dx);
  }
  if (!count) return null;
  for (let index = 0; index < halo.length; index++) halo[index] &= ~output[index];
  const mask = { grid, bounds: plan.bounds, output, halo, tiles: patchTiles(base, plan.bounds), maxZoom: base.maxZoom };
  validateRefinementCoverage(base, mask, plan);
  return mask;
}

/** Plan polygon/base masks and halos for terrain preparation and capacity inspection. */
export function planRefinementCoverage({ product, mask: base, zones, signal }: { product: ProductDefinition; mask: CoverageMask; zones?: unknown; signal?: AbortSignal }) {
  signal?.throwIfAborted();
  if (!sameGrid(base.grid, product.grid) || base.maxZoom !== product.maxNativeZoom) throw new Error('Refinement base coverage does not match product');
  const plans = configuredRefinements(product, zones);
  assertRefinementCellBudget(base, plans);
  return plans.flatMap(plan => {
    const mask = ownedMask(plan, base, signal);
    return mask ? [{ plan, mask }] : [];
  });
}
