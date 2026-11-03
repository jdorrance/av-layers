import configured from '../../../../packages/contracts/config/refinement.json' with { type: 'json' };
import { type ProductDefinition } from '@av/contracts';
import { planRefinements } from '@av/contracts/refinement';

/** Resolve the shared polygons against a model's admitted source domain. */
export function configuredRefinements(product: ProductDefinition, raw: unknown = configured) {
  return planRefinements(raw, {
    sourceGrid: product.grid,
    bounds: product.bounds,
    haloCells: Math.max(1, product.supportHaloCells)
  });
}
