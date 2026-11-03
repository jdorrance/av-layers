import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MODEL_IDS, getProduct } from '@av/contracts';

/** Resolve the workflow selector without loading a model adapter or weather data. */
export function selectWorkflowModels(selection = 'all'): string[] {
  if (selection === 'all') return [...MODEL_IDS];
  if (!getProduct(selection)) throw new Error(`Unknown forecast model: ${selection}`);
  return [selection];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const models = selectWorkflowModels(process.env.MODEL_SELECTION ?? 'all');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `models=${JSON.stringify(models)}\n`);
  console.log(`Selected forecast models: ${models.join(', ')}`);
}
