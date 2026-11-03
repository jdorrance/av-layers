import z from 'zod';
import { coverageDescriptorSchema, gridSchema, manifestSchema, MAX_GRID_CELLS, type CoverageMask, type ProductDefinition } from '@av/contracts';
import { MAX_REFINEMENT_ZONES, parseRefinementConfig, refinementGeometrySchema, REFINEMENT_SPACING_M } from '@av/contracts/refinement';
import { readGridCoverage, writeCoverage } from '../coverage.js';
import { type TerrainAsset, type TerrainStorage } from '../terrain/contract.js';
import { prepareTerrain, preparedTerrainRefSchema, PREPARED_TERRAIN_CELL_BYTES, type PreparedTerrain } from '../terrain/prepare.js';
import { loadPreparedTerrain, loadTerrainCatalog, stagePreparedTerrain } from '../terrain/staging.js';
import { assertRefinementCellBudget, planRefinementCoverage, validateRefinementCoverage } from './coverage.js';

/** Frozen metadata in the shared build plan; every referenced input is immutable. */
export const refinementInputSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), geometry: refinementGeometrySchema,
  bounds: coverageDescriptorSchema.shape.bounds, grid: gridSchema,
  coverage: manifestSchema.shape.coverage, terrain: preparedTerrainRefSchema
}).superRefine((input, context) => {
  const grid = input.grid, cells = grid.width * grid.height;
  if (grid.kind !== 'lambert-conformal' || grid.dxM !== REFINEMENT_SPACING_M || grid.dyM !== -REFINEMENT_SPACING_M
      || cells > MAX_GRID_CELLS || input.terrain.arrayBytes !== cells * PREPARED_TERRAIN_CELL_BYTES
      || input.bounds[0] < -180 || input.bounds[2] > 180 || input.bounds[0] >= input.bounds[2] || input.bounds[1] >= input.bounds[3]
      || input.coverage.maskKey !== `coverage/${input.coverage.hash}/manifest.json`) {
    context.addIssue({ code: 'custom', message: 'Invalid refinement grid or pinned input layout' });
  }
});
export type RefinementInput = z.infer<typeof refinementInputSchema>;
export interface LoadedRefinement { input: RefinementInput; mask: CoverageMask; terrain: PreparedTerrain }

/** Prepare configured polygons once, then stage only the pinned arrays needed by forecast workers. */
export async function prepareRefinements(options: { product: ProductDefinition; mask: CoverageMask; catalogRef: TerrainAsset; storage: TerrainStorage; out: string; signal?: AbortSignal; zones?: unknown }): Promise<RefinementInput[]> {
  const { mask: base, storage, out, signal } = options;
  const owned = planRefinementCoverage(options);
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
  assertRefinementCellBudget(baseMask, inputs);
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
