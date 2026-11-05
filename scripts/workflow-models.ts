import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PRODUCTS } from '@av/contracts';

interface WorkflowModel {
  modelId: string;
  execution: { parallelism: number; schedule: readonly string[] };
}

/** Resolve the workflow selector without loading a model adapter or weather data. */
export function selectWorkflowModels(selection = 'all', schedule?: string, products: readonly WorkflowModel[] = PRODUCTS) {
  let selected = products.filter(product => selection === 'all' || product.modelId === selection);
  if (!selected.length) throw new Error(`Unknown forecast model: ${selection}`);
  if (schedule) {
    selected = selected.filter(product => product.execution.schedule.includes(schedule));
    if (!selected.length) throw new Error(`Unknown forecast schedule: ${schedule}`);
  }
  return selected.map(product => ({ model: product.modelId, parallelism: product.execution.parallelism }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const forecast = process.argv.includes('--forecast');
  const selection = process.env.MODEL_SELECTION ?? 'all';
  const models = selectWorkflowModels(selection, forecast ? process.env.MODEL_SCHEDULE : undefined);
  const value = forecast ? { include: models } : models.map(model => model.model);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${forecast ? 'matrix' : 'models'}=${JSON.stringify(value)}\n`);
  console.log(`Selected forecast models: ${models.map(model => model.model).join(', ')}`);
}
