import { getBit, prepareCoverageTester, prepareGridGeometry, type CoverageMask } from '@av/contracts';
import { containsRefinement } from '@av/contracts/refinement';

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
