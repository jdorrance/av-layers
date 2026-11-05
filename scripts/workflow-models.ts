import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { FORECAST_PARALLELISM, PRODUCTS } from '@av/contracts';

interface WorkflowModel {
  modelId: string;
  execution: { parallelism: number; schedule: readonly string[] };
}
const MAX_MATRIX_JOBS = 256;

/** Resolve the workflow selector without loading a model adapter or weather data. */
export function selectWorkflowModels(selection = 'all', schedule?: string, products: readonly WorkflowModel[] = PRODUCTS): string[] {
  let selected = products.filter(product => selection === 'all' || product.modelId === selection);
  if (!selected.length) throw new Error(`Unknown forecast model: ${selection}`);
  if (schedule) {
    selected = selected.filter(product => product.execution.schedule.includes(schedule));
    if (!selected.length) throw new Error(`Unknown forecast schedule: ${schedule}`);
  }
  return selected.map(product => product.modelId);
}

/** Reserve fixed per-model shares so separately scheduled runs keep the same environment budget. */
export function allocateWorkflowModels(models: readonly { model: string; parallelism: number }[], jobs = FORECAST_PARALLELISM.jobs) {
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > MAX_MATRIX_JOBS || !models.length || models.length > MAX_MATRIX_JOBS
      || new Set(models.map(model => model.model)).size !== models.length
      || models.some(model => !Number.isSafeInteger(model.parallelism) || model.parallelism < 1 || model.parallelism > MAX_MATRIX_JOBS)) {
    throw new Error('Invalid workflow parallelism');
  }
  if (jobs < models.length) throw new Error('Forecast job budget must cover every registered model');
  const allocated = models.map(model => ({ model: model.model, parallelism: 1 }));
  let remaining = jobs - models.length;
  while (remaining) {
    let changed = false;
    for (let index = 0; index < allocated.length && remaining; index++) {
      if (allocated[index].parallelism >= models[index].parallelism) continue;
      allocated[index].parallelism++; remaining--; changed = true;
    }
    if (!changed) break;
  }
  return allocated;
}

export function forecastWorkflowMatrix(selection = 'all', schedule?: string, products: readonly WorkflowModel[] = PRODUCTS, jobs = FORECAST_PARALLELISM.jobs) {
  const selected = new Set(selectWorkflowModels(selection, schedule, products));
  const allocated = allocateWorkflowModels(products.map(product => ({ model: product.modelId, parallelism: product.execution.parallelism })), jobs);
  return { include: allocated.filter(model => selected.has(model.model)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const forecast = process.argv.includes('--forecast');
  const selection = process.env.MODEL_SELECTION ?? 'all';
  const outputs: { matrix: ReturnType<typeof forecastWorkflowMatrix> } | { models: string[] } = forecast
    ? { matrix: forecastWorkflowMatrix(selection, process.env.MODEL_SCHEDULE) } : { models: selectWorkflowModels(selection) };
  if (process.env.GITHUB_OUTPUT) for (const [name, value] of Object.entries(outputs)) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${JSON.stringify(value)}\n`);
  const models = 'matrix' in outputs ? outputs.matrix.include.map(model => model.model) : outputs.models;
  console.log(`Selected forecast models: ${models.join(', ')}`);
}
