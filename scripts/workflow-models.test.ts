import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { PRODUCTS } from '@av/contracts/models';
import { selectWorkflowModels } from './workflow-models.js';

it('selects registered models with their fixed configured caps', () => {
  const all = PRODUCTS.map(product => ({ model: product.modelId, parallelism: product.execution.parallelism }));
  expect(selectWorkflowModels()).toEqual(all.filter(model => PRODUCTS.find(product => product.modelId === model.model)!.execution.schedule.length));
  expect(selectWorkflowModels({ kind: 'health' })).toEqual(all);
  for (const model of all) expect(selectWorkflowModels({ selection: model.model })).toEqual([model]);
  for (const value of ['', 'unknown', 'constructor', 'toString', all.map(model => model.model).join(',')]) {
    expect(() => selectWorkflowModels({ selection: value })).toThrow('Unknown forecast model');
  }
});

it('uses literal cron triggers for distinct/shared schedules and keeps health and explicit selection complete', () => {
  const models = [
    { modelId: 'first', execution: { parallelism: 3, schedule: ['17 5 * * *', '31 12 * * *'] } },
    { modelId: 'second', execution: { parallelism: 2, schedule: ['23 6 * * *', '31 12 * * *'] } },
    { modelId: 'manual', execution: { parallelism: 1, schedule: [] } }
  ];
  const all = selectWorkflowModels({ products: models });
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-11-05T10:00:00Z'));
    expect(selectWorkflowModels({ schedule: '17 5 * * *', products: models })).toEqual([all[0]]);
    expect(selectWorkflowModels({ schedule: '23 6 * * *', products: models })).toEqual([all[1]]);
    expect(selectWorkflowModels({ schedule: '31 12 * * *', products: models })).toEqual(all.slice(0, 2));
    expect(selectWorkflowModels({ selection: 'first', products: models })).toEqual([all[0]]);
    expect(all.map(model => model.model)).toEqual(['first', 'second']);
    expect(selectWorkflowModels({ selection: 'manual', products: models })).toEqual([{ model: 'manual', parallelism: 1 }]);
    expect(selectWorkflowModels({ products: models, kind: 'health' }).map(model => model.model)).toEqual(['first', 'second', 'manual']);
    expect(() => selectWorkflowModels({ products: [models[2]!] })).toThrow('No scheduled forecast models');
    expect(() => selectWorkflowModels({ schedule: '59 23 * * *', products: models })).toThrow('Unknown forecast schedule');
  } finally { vi.useRealTimers(); }
});

it.each([undefined, '', ...new Set(PRODUCTS.flatMap(product => product.execution.schedule))])('writes the runner output for cron=%s, leaving health independent', schedule => {
  const forecast = schedule !== undefined;
  const root = mkdtempSync(join(tmpdir(), 'av-workflow-models-')), output = join(root, 'github-output');
  try {
    execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./workflow-models.ts', import.meta.url)), ...(forecast ? ['--forecast'] : [])], {
      env: { ...process.env, MODEL_SELECTION: 'all', MODEL_SCHEDULE: forecast ? schedule : '41 * * * *', GITHUB_OUTPUT: output }
    });
    const models = selectWorkflowModels({ schedule, kind: forecast ? 'forecast' : 'health' });
    expect(readFileSync(output, 'utf8')).toBe(forecast
      ? `matrix=${JSON.stringify({ include: models })}\nmodel-parallelism=${schedule ? models.length : 1}\n`
      : `models=${JSON.stringify(models.map(model => model.model))}\n`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
