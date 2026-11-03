import z from 'zod';
import { coverageDescriptorSchema, getBit, gridSchema, manifestSchema, MAX_GRID_CELLS, prepareCoverageTester, prepareGridGeometry, sameGrid, setBit, type CoverageMask, type GeographicBounds, type ProductDefinition } from '@av/contracts';
import { containsRefinement, MAX_REFINEMENT_ZONES, parseRefinementConfig, refinementGeometrySchema, REFINEMENT_SPACING_M, type RefinementPlan } from '@av/contracts/refinement';
import { readGridCoverage, writeCoverage } from '../coverage.js';
import { type TerrainAsset, type TerrainStorage } from '../terrain/contract.js';
import { prepareTerrain, preparedTerrainRefSchema, type PreparedTerrain } from '../terrain/prepare.js';
import { loadPreparedTerrain, loadTerrainCatalog, stagePreparedTerrain } from '../terrain/staging.js';
import { configuredRefinements } from './config.js';
import { validateRefinementCoverage } from './coverage.js';

/** Frozen metadata in the shared build plan; every referenced input is immutable. */
export const refinementInputSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), geometry: refinementGeometrySchema,
  bounds: coverageDescriptorSchema.shape.bounds, grid: gridSchema,
  coverage: manifestSchema.shape.coverage, terrain: preparedTerrainRefSchema
}).superRefine((input, context) => {
  const grid = input.grid, cells = grid.width * grid.height;
  if (grid.kind !== 'lambert-conformal' || grid.dxM !== REFINEMENT_SPACING_M || grid.dyM !== -REFINEMENT_SPACING_M
      || cells > MAX_GRID_CELLS || input.terrain.arrayBytes !== cells * 5
      || input.bounds[0] < -180 || input.bounds[2] > 180 || input.bounds[0] >= input.bounds[2] || input.bounds[1] >= input.bounds[3]
      || input.coverage.maskKey !== `coverage/${input.coverage.hash}/manifest.json`) {
    context.addIssue({ code: 'custom', message: 'Invalid refinement grid or pinned input layout' });
  }
});
export type RefinementInput = z.infer<typeof refinementInputSchema>;
export interface LoadedRefinement { input: RefinementInput; mask: CoverageMask; terrain: PreparedTerrain }

function admitCells(base: CoverageMask, grids: readonly { grid: CoverageMask['grid'] }[]): void {
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

/** Prepare configured polygons once, then stage only the pinned arrays needed by forecast workers. */
export async function prepareRefinements(options: { product: ProductDefinition; mask: CoverageMask; catalogRef: TerrainAsset; storage: TerrainStorage; out: string; signal?: AbortSignal; zones?: unknown }): Promise<RefinementInput[]> {
  const { product, mask: base, storage, out, signal } = options;
  signal?.throwIfAborted();
  if (!sameGrid(base.grid, product.grid) || base.maxZoom !== product.maxNativeZoom) throw new Error('Refinement base coverage does not match product');
  const plans = configuredRefinements(product, options.zones);
  admitCells(base, plans);
  const owned = plans.flatMap(plan => {
    const mask = ownedMask(plan, base, signal);
    return mask ? [{ plan, mask }] : [];
  });
  if (!owned.length) return [];
  const catalog = await loadTerrainCatalog(options.catalogRef, storage, signal), inputs: RefinementInput[] = [];
  for (const { plan, mask } of owned) {
    signal?.throwIfAborted();
    const coverageId = `refinement-${plan.id}`;
    const coverageHash = await writeCoverage(out, mask, { coverageId, coverageDescription: 'Configured polygon within base forecast coverage; one-cell interpolation halo', bounds: plan.bounds, supportHaloCells: 1 });
    const terrain = await prepareTerrain({ catalog, storage, grid: plan.grid, signal });
    await stagePreparedTerrain({ ref: terrain, storage, out, grid: plan.grid, signal });
    inputs.push(refinementInputSchema.parse({ id: plan.id, geometry: plan.geometry, bounds: plan.bounds, grid: plan.grid,
      coverage: { id: coverageId, hash: coverageHash, maskKey: `coverage/${coverageHash}/manifest.json`, maxZoom: base.maxZoom }, terrain }));
  }
  return inputs;
}

/** Load the frozen local inputs; no catalog, source tile or mutable configuration is consulted. */
export async function loadRefinements({ inputs: raw, out, baseMask, signal }: { inputs: readonly RefinementInput[]; out: string; baseMask: CoverageMask; signal?: AbortSignal }): Promise<LoadedRefinement[]> {
  signal?.throwIfAborted();
  if (raw.length > MAX_REFINEMENT_ZONES) throw new Error('Refinement zone budget exceeded');
  const inputs = raw.map(input => refinementInputSchema.parse(input));
  if (inputs.some((input, index) => index > 0 && inputs[index - 1].id >= input.id)) throw new Error('Refinement IDs must be sorted and unique');
  parseRefinementConfig({ type: 'FeatureCollection', features: inputs.map(input => ({ type: 'Feature', id: input.id, properties: {}, geometry: input.geometry })) });
  admitCells(baseMask, inputs);
  const loaded: LoadedRefinement[] = [];
  for (const input of inputs) {
    signal?.throwIfAborted();
    if (input.coverage.maxZoom !== baseMask.maxZoom) throw new Error('Refinement coverage zoom differs from base');
    const mask = await readGridCoverage(out, { grid: input.grid, coverage: input.coverage, descriptors: { bounds: input.bounds } });
    validateRefinementCoverage(baseMask, mask, input);
    if (mask.tiles.length !== baseMask.tiles.length || mask.tiles.some((byte, index) => (byte & ~baseMask.tiles[index]) !== 0)) throw new Error('Refinement tiles exceed base coverage');
    const terrain = await loadPreparedTerrain({ ref: input.terrain, out, grid: input.grid, signal });
    loaded.push({ input, mask, terrain });
  }
  return loaded;
}
