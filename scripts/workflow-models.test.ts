import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { FORECAST_PARALLELISM, MODEL_IDS, PRODUCTS } from '@av/contracts';
import { allocateWorkflowModels, forecastWorkflowMatrix, selectWorkflowModels } from './workflow-models.js';
import { projectWorkflow, workflowArtifacts } from './generate-workflows.js';
import { terrainCatalogInput } from './terrain-inputs.js';

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

  it('selects only configured models for each literal trigger, including shared schedules', () => {
    const models = [
      { modelId: 'first', execution: { parallelism: 2, schedule: ['17 5 * * *', '31 12 * * *'] } },
      { modelId: 'second', execution: { parallelism: 2, schedule: ['23 6 * * *', '31 12 * * *'] } },
      { modelId: 'manual', execution: { parallelism: 1, schedule: [] } }
    ];
    expect(selectWorkflowModels('all', '17 5 * * *', models)).toEqual(['first']);
    expect(selectWorkflowModels('all', '23 6 * * *', models)).toEqual(['second']);
    expect(selectWorkflowModels('all', '31 12 * * *', models)).toEqual(['first', 'second']);
    expect(selectWorkflowModels('all', undefined, models)).toEqual(['first', 'second', 'manual']);
    expect(selectWorkflowModels('manual', '', models)).toEqual(['manual']);
    expect(() => selectWorkflowModels('all', '59 23 * * *', models)).toThrow('Unknown forecast schedule');
  });

  it('keeps delayed scheduled selection tied to the trigger rather than the runner clock', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-05T10:00:00Z'));
      const models = [{ modelId: 'delayed-model', execution: { parallelism: 1, schedule: ['17 5 * * *'] } }];
      expect(selectWorkflowModels('all', '17 5 * * *', models)).toEqual(['delayed-model']);
    } finally { vi.useRealTimers(); }
  });

  it('writes the selected models as a runner output for the matrix', () => {
    const root = mkdtempSync(join(tmpdir(), 'av-workflow-models-')), output = join(root, 'github-output');
    try {
      execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./workflow-models.ts', import.meta.url))], {
        env: { ...process.env, MODEL_SELECTION: 'icon-eu', GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: 'schedule', MODEL_SCHEDULE: '41 * * * *' }
      });
      expect(readFileSync(output, 'utf8')).toBe('models=["icon-eu"]\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('writes the allocated forecast matrix and preserves manual all selection', () => {
    const root = mkdtempSync(join(tmpdir(), 'av-forecast-models-')), output = join(root, 'github-output');
    try {
      execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./workflow-models.ts', import.meta.url)), '--forecast'], {
        env: { ...process.env, MODEL_SELECTION: 'all', MODEL_SCHEDULE: '', GITHUB_OUTPUT: output }
      });
      const values = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => {
        const offset = line.indexOf('=');
        return [line.slice(0, offset), JSON.parse(line.slice(offset + 1))];
      }));
      expect(values).toEqual({ matrix: forecastWorkflowMatrix() });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects an unknown scheduled trigger before emitting a forecast matrix', () => {
    const root = mkdtempSync(join(tmpdir(), 'av-invalid-schedule-')), output = join(root, 'github-output');
    try {
      expect(() => execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./workflow-models.ts', import.meta.url)), '--forecast'], {
        env: { ...process.env, MODEL_SELECTION: 'all', MODEL_SCHEDULE: 'not-a-configured-trigger', GITHUB_OUTPUT: output }, stdio: 'pipe'
      })).toThrow('Unknown forecast schedule');
      expect(existsSync(output)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['forecast', 'health', 'maintenance'])('keeps %s dropdowns in sync with the production registry', name => {
    const model = record(record(record(record(workflow(name).on).workflow_dispatch).inputs).model);
    expect(model.type).toBe('choice');
    expect(model.options).toEqual(name === 'maintenance' ? MODEL_IDS : ['all', ...MODEL_IDS]);
    expect(model.default).toBe(name === 'maintenance' ? MODEL_IDS[0] : 'all');
  });
});

describe('global forecast job allocation', () => {
  const requests = [{ model: 'gfs', parallelism: 12 }, { model: 'icon-eu', parallelism: 8 }];
  it('preserves current model limits and fairly shares a smaller budget', () => {
    expect(allocateWorkflowModels(requests, 20).map(model => model.parallelism)).toEqual([12, 8]);
    expect(allocateWorkflowModels(requests, 10).map(model => model.parallelism)).toEqual([5, 5]);
    expect(allocateWorkflowModels([{ model: 'small', parallelism: 2 }, { model: 'large', parallelism: 8 }], 7).map(model => model.parallelism)).toEqual([2, 5]);
    expect(allocateWorkflowModels(requests).reduce((sum, model) => sum + model.parallelism, 0)).toBeLessThanOrEqual(FORECAST_PARALLELISM.jobs);
  });

  it('reserves the same shares for overlapping distinct schedules and manual runs', () => {
    const models = requests.map((model, i) => ({ modelId: model.model, execution: { parallelism: model.parallelism, schedule: [i ? '23 6 * * *' : '17 5 * * *'] } }));
    const gfs = forecastWorkflowMatrix('all', '17 5 * * *', models, 10);
    const icon = forecastWorkflowMatrix('all', '23 6 * * *', models, 10);
    expect(gfs.include).toEqual([{ model: 'gfs', parallelism: 5 }]);
    expect(icon.include).toEqual([{ model: 'icon-eu', parallelism: 5 }]);
    expect(forecastWorkflowMatrix('gfs', undefined, models, 10)).toEqual(gfs);
    expect([...gfs.include, ...icon.include].reduce((sum, model) => sum + model.parallelism, 0)).toBe(10);
    expect(() => allocateWorkflowModels(models.map(model => ({ model: model.modelId, parallelism: 1 })), 1)).toThrow('registered model');
  });

  it('bounds every possible active model subset, even at the matrix limit', () => {
    for (const count of [1, 2, 3, 256]) for (const jobs of [1, 2, 7, 20, 256].filter(jobs => jobs >= count)) {
      const limits = Array.from({ length: count }, (_, i) => ({ model: `model-${i}`, parallelism: 1 + i % 13 }));
      const allocations = allocateWorkflowModels(limits, jobs);
      expect(allocations).toHaveLength(count);
      allocations.forEach((model, i) => {
        expect(model.parallelism).toBeGreaterThanOrEqual(1);
        expect(model.parallelism).toBeLessThanOrEqual(limits[i].parallelism);
      });
      expect(allocations.reduce((sum, model) => sum + model.parallelism, 0)).toBeLessThanOrEqual(jobs);
    }
  });

  it('rejects invalid budgets, duplicate models and oversized matrices', () => {
    for (const jobs of [0, -1, 0.5, 257, Infinity, NaN]) expect(() => allocateWorkflowModels(requests, jobs)).toThrow('parallelism');
    for (const parallelism of [0, -1, 0.5, 257]) expect(() => allocateWorkflowModels([{ model: 'invalid', parallelism }], 20)).toThrow('parallelism');
    expect(() => allocateWorkflowModels([], 20)).toThrow('parallelism');
    expect(() => allocateWorkflowModels([requests[0], requests[0]], 20)).toThrow('parallelism');
    expect(() => allocateWorkflowModels(Array.from({ length: 257 }, (_, i) => ({ model: `model-${i}`, parallelism: 1 })), 20)).toThrow('parallelism');
  });
});

describe('generated workflow projections', () => {
  it('projects differing model schedules and choices while retaining executable jobs', () => {
    const models = PRODUCTS.map((product, i) => ({ ...product, execution: { ...product.execution, schedule: [i ? '23 6 * * *' : '17 5 * * *', '31 12 * * *'] } }));
    const source = readFileSync(new URL('../.github/workflows/forecast.yml', import.meta.url), 'utf8');
    const projected = projectWorkflow(source, 'forecast', models), parsed = record(parseYaml(projected));
    expect(record(parsed.on).schedule).toEqual([{ cron: '17 5 * * *' }, { cron: '31 12 * * *' }, { cron: '23 6 * * *' }]);
    expect(parsed.jobs).toEqual(workflow('forecast').jobs);
    expect(projectWorkflow(projected, 'forecast', models)).toBe(projected);
    const manual = record(parseYaml(projectWorkflow(source, 'forecast', models.map(product => ({ ...product, execution: { ...product.execution, schedule: [] } })))));
    expect(record(manual.on).schedule).toBeUndefined();
  });

  it('includes workflow projection drift in the existing reference check', async () => {
    const artifacts = await workflowArtifacts();
    expect(Object.keys(artifacts)).toEqual(['.github/workflows/forecast.yml', '.github/workflows/health.yml', '.github/workflows/maintenance.yml']);
    for (const [path, expected] of Object.entries(artifacts)) expect(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')).toBe(expected);
  });
});

describe('multi-model workflow isolation', () => {
  it('shares catalog overrides and the production pin across terrain preparation and planning', () => {
    const forecast = workflow('forecast'), model = workflow('forecast-model'), modelJobs = jobs('forecast-model');
    const input = record(record(record(record(forecast.on).workflow_dispatch).inputs)['terrain-catalog-ref']);
    expect(input).toMatchObject({ type: 'string', default: '' });
    expect(record(record(jobs('forecast').forecast).with)['terrain-catalog-ref']).toBe("${{ inputs['terrain-catalog-ref'] || '' }}");
    expect(record(record(record(model.on).workflow_call).inputs)['terrain-catalog-ref']).toEqual({ type: 'string', default: '' });
    const catalogExpression = String(record(record(modelJobs.prepare).env).TERRAIN_CATALOG_REF);
    const catalogJson = catalogExpression.match(/inputs.environment == 'production' && '([^']+)'/)?.[1];
    expect(catalogJson).toBeDefined();
    const catalog = terrainCatalogInput(catalogJson!);
    expect(catalog.key).toBe(`terrain/catalogs/${catalog.sha256}.json`);
    expect(catalogExpression).toBe(`\${{ inputs['terrain-catalog-ref'] || vars.TERRAIN_CATALOG_REF || (inputs.environment == 'production' && '${catalogJson}') || '' }}`);
    expect(record(record(modelJobs.terrain).env)).toEqual(record(record(modelJobs.prepare).env));
    for (const env of [record(model.env), record(record(modelJobs.shard).env), record(record(modelJobs['build-publish']).env)]) {
      expect(env.TERRAIN_CATALOG_REF).toBeUndefined();
      expect(env.TERRAIN_INPUTS).toBeUndefined();
    }
    const steps = record(modelJobs.prepare).steps as Record<string, unknown>[];
    const upload = steps.find(step => step.name === 'Share immutable build plan')!;
    expect(String(record(upload.with).path)).toContain('output/coverage/');
    expect(String(record(upload.with).path)).toContain('output/terrain/');
    const publisherSteps = record(modelJobs['build-publish']).steps as Record<string, unknown>[];
    const full = publisherSteps.find(step => step.name === 'Upload full build artifacts on request')!;
    expect(full.if).toBe("${{ always() && env.RETAIN_FULL_ARTIFACTS == 'true' }}");
    const resumable = publisherSteps.find(step => step.name === 'Upload resumable build records')!;
    expect(resumable.if).toBe('always()');
    const records = String(record(resumable.with).path);
    expect(records).toContain('output/plan.json');
    expect(records).toContain('output/shards/*/*.json');
    expect(records).not.toContain('output/builds/\n');
    const fullPath = String(record(full.with).path);
    expect(fullPath).toContain('output/plan.json');
    expect(fullPath).toContain('output/coverage/');
    expect(fullPath).toContain('output/terrain/');
    expect(fullPath).toContain('output/builds/');
  });

  it('prepares reusable terrain before admitting the forecast cycle and preserves resume skips', () => {
    const modelJobs = jobs('forecast-model'), terrain = record(modelJobs.terrain), prepare = record(modelJobs.prepare);
    const mainFreshRun = "${{ github.ref == 'refs/heads/main' && !inputs['resume-run-id'] }}";
    expect(terrain.name).toBe('Terrain ${{ inputs.model }}');
    expect(terrain.if).toBe(mainFreshRun);
    expect(prepare.if).toBe(mainFreshRun);
    expect(prepare.needs).toBe('terrain');
    expect(terrain['timeout-minutes']).toBe(160);
    expect(prepare['timeout-minutes']).toBe(15);
    const steps = terrain.steps as Record<string, unknown>[];
    expect(steps.some(step => step.run === 'pnpm operations forecast-terrain')).toBe(true);
    const uploads = steps.filter(step => step.uses === 'actions/upload-artifact@v4');
    expect(uploads).toHaveLength(1);
    expect(uploads[0].if).toBe('failure() || cancelled()');
    expect(record(uploads[0].with).path).toBe('output/failure.json');
    expect(terrain.outputs).toBeUndefined();
    expect(steps.find(step => step.uses === 'actions/checkout@v4')?.with).toEqual({ ref: '${{ github.sha }}', 'persist-credentials': false });
    expect(steps.some(step => step.uses === './.github/actions/setup')).toBe(true);
  });

  it('expands models before calling one independently serialized forecast per model', () => {
    const forecast = workflow('forecast'), job = record(jobs('forecast').forecast);
    expect(forecast.concurrency).toBeUndefined();
    expect(job.uses).toBe('./.github/workflows/forecast-model.yml');
    expect(job.needs).toBe('select');
    expect(record(job.strategy)['fail-fast']).toBe(false);
    expect(record(job.strategy)['max-parallel']).toBeUndefined();
    expect(record(job.strategy).matrix).toBe('${{ fromJSON(needs.select.outputs.matrix) }}');
    expect(record(job.with).model).toBe('${{ matrix.model }}');
    expect(record(job.with).parallelism).toBe('${{ matrix.parallelism }}');
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
