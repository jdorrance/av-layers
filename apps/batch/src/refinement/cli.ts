import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getProduct, parseBoundedJson } from '@av/contracts';
import { readLocalFile } from '../local-file.js';
import { configuredRefinements } from './config.js';

export const REFINEMENT_OPTIONS = { model: { type: 'string' }, zones: { type: 'string' } } as const;

/** Inspect bounded grids without acquiring terrain or weather. */
export async function inspectRefinements(args: string[]) {
  const { values } = parseArgs({ args, options: REFINEMENT_OPTIONS, strict: true, allowPositionals: false });
  const product = values.model && getProduct(values.model);
  if (!product) throw new Error('Choose a registered --model');
  const raw = values.zones ? parseBoundedJson(await readLocalFile(values.zones, 128 * 1024)) : undefined;
  const zones = configuredRefinements(product, raw);
  return {
    model: product.modelId,
    zones: zones.map(zone => ({
      id: zone.id, bounds: zone.bounds, grid: zone.grid,
      cells: zone.grid.width * zone.grid.height,
      terrainBytes: zone.grid.width * zone.grid.height * 5
    }))
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  inspectRefinements(process.argv.slice(2)).then(result => console.log(JSON.stringify(result)), error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
