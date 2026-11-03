import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { MODEL_IDS } from '@av/contracts';
import { selectWorkflowModels } from './workflow-models.js';

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
};
const workflow = (name: string) => record(parseYaml(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8')));
const jobs = (name: string) => record(workflow(name).jobs);

describe('workflow model selection', () => {
  it('expands all from the production registry and returns an independent list', () => {
    const models = selectWorkflowModels();
    expect(models).toEqual(MODEL_IDS);
    models.pop();
    expect(selectWorkflowModels('all')).toEqual(MODEL_IDS);
    expect(MODEL_IDS).not.toContain('all');
  });

  it.each(MODEL_IDS)('selects only %s when requested', model => {
    expect(selectWorkflowModels(model)).toEqual([model]);
  });

  it.each(['', 'unknown', 'constructor', 'toString', 'gfs,icon-eu'])('rejects invalid selection %j', value => {
    expect(() => selectWorkflowModels(value)).toThrow('Unknown forecast model');
  });

  it('writes the selected models as a runner output for the matrix', () => {
    const root = mkdtempSync(join(tmpdir(), 'av-workflow-models-')), output = join(root, 'github-output');
    try {
      execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./workflow-models.ts', import.meta.url))], {
        env: { ...process.env, MODEL_SELECTION: 'icon-eu', GITHUB_OUTPUT: output }
      });
      expect(readFileSync(output, 'utf8')).toBe('models=["icon-eu"]\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['forecast', 'health', 'maintenance'])('keeps %s dropdowns in sync with the production registry', name => {
    const model = record(record(record(record(workflow(name).on).workflow_dispatch).inputs).model);
    expect(model.type).toBe('choice');
    expect(model.options).toEqual(name === 'maintenance' ? MODEL_IDS : ['all', ...MODEL_IDS]);
    expect(model.default).toBe(name === 'maintenance' ? MODEL_IDS[0] : 'all');
  });
});

describe('multi-model workflow isolation', () => {
  it('expands models before calling one independently serialized forecast per model', () => {
    const forecast = workflow('forecast'), job = record(jobs('forecast').forecast);
    expect(forecast.concurrency).toBeUndefined();
    expect(job.uses).toBe('./.github/workflows/forecast-model.yml');
    expect(job.needs).toBe('select');
    expect(record(job.strategy)['fail-fast']).toBe(false);
    expect(record(job.strategy)['max-parallel']).toBeUndefined();
    expect(record(record(job.strategy).matrix).model).toBe('${{ fromJSON(needs.select.outputs.models) }}');
    expect(record(job.with).model).toBe('${{ matrix.model }}');
    expect(record(job.concurrency)).toEqual({ group: "forecast-${{ inputs.environment || 'production' }}-${{ matrix.model }}", 'cancel-in-progress': false });
    expect(workflow('forecast-model').concurrency).toBeUndefined();
    expect(record(workflow('maintenance').concurrency)).toEqual({ group: "forecast-${{ inputs.environment || 'production' }}-${{ inputs.model || 'gfs' }}", 'cancel-in-progress': false });
  });

  it('shows actual hour batches and names publisher jobs for model-specific health checks', () => {
    const modelJobs = jobs('forecast-model'), shard = record(modelJobs.shard);
    expect(shard.name).toBe('Build ${{ inputs.model }}: ${{ matrix.shard.hours }}');
    expect(record(shard.env).SHARD_ID).toBe('${{ matrix.shard.id }}');
    expect(record(modelJobs['build-publish']).name).toBe('Publish ${{ inputs.model }}');
  });

  it('runs independent health checks and retains model-specific results', () => {
    const check = record(jobs('health').check);
    expect(record(check.strategy)['fail-fast']).toBe(false);
    expect(record(check.strategy)['max-parallel']).toBeUndefined();
    const steps = check.steps as Record<string, unknown>[];
    expect(record(steps.find(step => step.run === 'pnpm health')!.env).MODEL).toBe('${{ matrix.model }}');
    expect(record(steps.find(step => step.uses === 'actions/upload-artifact@v4')!.with).name).toBe("health-${{ inputs.environment || 'production' }}-${{ matrix.model }}-${{ github.run_id }}");
  });
});
