import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PRODUCTS } from '@av/contracts/models';
import { sourceCycle } from '../apps/batch/src/source.js';

type DispatchModel = Pick<(typeof PRODUCTS)[number], 'modelId' | 'execution' | 'forecast'>;

export function forecastDispatch(payload: unknown, products: readonly DispatchModel[] = PRODUCTS) {
  if (!payload || typeof payload !== 'object') throw new Error('External forecast dispatch requires a payload');
  const { environment, model, cycle } = payload as Record<string, unknown>;
  if (environment !== 'staging' && environment !== 'production') throw new Error('External forecast dispatch requires a valid environment');
  const product = products.find(item => item.modelId === model);
  if (!product || product.execution.schedule.length !== 0) throw new Error('External forecast dispatch requires a registered event-driven model');
  if (typeof cycle !== 'string') throw new Error('External forecast dispatch requires an explicit UTC cycle');
  return { environment, model: product.modelId, cycle: sourceCycle(cycle, product.forecast.cycleHoursUtc) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.env.GITHUB_EVENT_PATH, output = process.env.GITHUB_OUTPUT;
  if (!path || !output) throw new Error('GitHub dispatch event and output paths are required');
  const { client_payload } = JSON.parse(readFileSync(path, 'utf8')) as { client_payload?: unknown };
  const { environment, model, cycle } = forecastDispatch(client_payload);
  appendFileSync(output, `environment=${environment}\nmodel=${model}\ncycle=${cycle}\n`);
}
