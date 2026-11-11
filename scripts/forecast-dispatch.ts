import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PRODUCTS } from '@av/contracts/models';

type DispatchModel = Pick<(typeof PRODUCTS)[number], 'modelId' | 'execution' | 'forecast'>;

export function forecastDispatch(payload: unknown, products: readonly DispatchModel[] = PRODUCTS) {
  if (!payload || typeof payload !== 'object') throw new Error('External forecast dispatch requires a payload');
  const { environment, model, cycle } = payload as Record<string, unknown>;
  if (environment !== 'staging' && environment !== 'production') throw new Error('External forecast dispatch requires a valid environment');
  const product = products.find(item => item.modelId === model);
  if (!product || product.execution.schedule.length !== 0) throw new Error('External forecast dispatch requires a registered event-driven model');
  if (typeof cycle !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(cycle) || !Number.isFinite(Date.parse(cycle))) {
    throw new Error('External forecast dispatch requires a canonical UTC cycle');
  }
  const date = new Date(cycle);
  if (date.toISOString().replace('.000Z', 'Z') !== cycle || !product.forecast.cycleHoursUtc.includes(date.getUTCHours())) {
    throw new Error('External forecast dispatch cycle is outside the model schedule');
  }
  return { environment, model: product.modelId, cycle };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.env.GITHUB_EVENT_PATH, output = process.env.GITHUB_OUTPUT;
  if (!path || !output) throw new Error('GitHub dispatch event and output paths are required');
  const { client_payload } = JSON.parse(readFileSync(path, 'utf8')) as { client_payload?: unknown };
  const { environment, model, cycle } = forecastDispatch(client_payload);
  appendFileSync(output, `environment=${environment}\nmodel=${model}\ncycle=${cycle}\n`);
}
