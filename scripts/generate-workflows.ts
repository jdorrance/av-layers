import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { PRODUCTS } from '@av/contracts';

/** Project model choices and literal cron triggers into GitHub's static workflow fields. */
export async function workflowArtifacts(models = PRODUCTS): Promise<Record<string, string>> {
  const generated: Record<string, string> = {};
  for (const name of ['forecast', 'health', 'maintenance'] as const) {
    const path = `.github/workflows/${name}.yml`;
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    generated[path] = projectWorkflow(source, name, models);
  }
  return generated;
}

export function projectWorkflow(source: string, name: 'forecast' | 'health' | 'maintenance', models: readonly Pick<typeof PRODUCTS[number], 'modelId' | 'execution'>[] = PRODUCTS): string {
  const document = parseDocument(source);
  if (document.errors.length) throw new Error(`Invalid workflow: ${document.errors[0].message}`);
  const choices = [...(name === 'maintenance' ? [] : ['all']), ...models.map(model => model.modelId)];
  const options = ['on', 'workflow_dispatch', 'inputs', 'model', 'options'];
  document.setIn(options, document.createNode(choices, { flow: true }));
  document.setIn(['on', 'workflow_dispatch', 'inputs', 'model', 'default'], choices[0]);
  if (name === 'forecast') {
    const schedules = [...new Set(models.flatMap(model => model.execution.schedule))];
    if (schedules.length) document.setIn(['on', 'schedule'], schedules.map(cron => ({ cron })));
    else document.deleteIn(['on', 'schedule']);
  }
  return document.toString({ lineWidth: 0, flowCollectionPadding: false });
}
