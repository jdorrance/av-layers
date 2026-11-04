import { expect, it } from 'vitest';
import { createProductDescriptors, createWholeDomainDescriptors, getProduct, MODEL_IDS, planWholeDomainGrid } from '@av/contracts';
import { referenceArtifacts } from './generate-reference.js';

it('documents configured terrain methods and fine grids from their owners', async () => {
  const reference = (await referenceArtifacts())['docs/reference.md']!;
  for (const model of MODEL_IDS) {
    const product = getProduct(model)!;
    const factor = product.terrainSubdivisionFactor;
    if (factor === undefined || product.grid.kind !== 'regular-latlon') throw new Error('Expected a configured terrain product');
    const section = reference.split(`### ${product.label} (${product.id})`)[1]!.split('\n### ')[0]!;
    const fine = planWholeDomainGrid(product.grid, factor).fine;
    expect(section).toContain(`Terrain subdivision factor: \`${factor}\`; fine grid: ${fine.width} columns × ${fine.height} rows.`);
    const methods = createWholeDomainDescriptors(product).methods;
    for (const method of Object.values(methods)) expect(section).toContain(`\`${method.id}\``);
    for (const method of Object.values(createProductDescriptors(product).methods)) {
      if (!(method.id in methods)) expect(section).not.toContain(`\`${method.id}\``);
    }
  }
});
