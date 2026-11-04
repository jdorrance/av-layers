import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { MODEL_IDS } from '@av/contracts';
import { selectWorkflowModels } from './workflow-models.js';
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
    expect(terrain['timeout-minutes']).toBe(60);
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
