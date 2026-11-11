import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { manifestSchema, validateArtifactRecords, validateSampleFlags } from '@av/contracts';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const manifestFixture = () => manifestSchema.parse(JSON.parse(readFileSync(fixture('manifest.contract.json'), 'utf8')));
const workflowText = (name: string): string => readFileSync(fileURLToPath(new URL(`../.github/workflows/${name}`, import.meta.url)), 'utf8');
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
  return value as Record<string, unknown>;
};
const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('expected array');
  return value;
};
const workflow = (name: string): Record<string, unknown> => record(parseYaml(workflowText(name)));
describe('project runtime', () => {
  const project = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    engines: { node: string };
  };

  it('executes tests using the project Node runtime with real SQLite support', async () => {
    expect(process.versions.node).toBe(project.engines.node);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try { expect(db.prepare('SELECT 1 AS value').get()?.value).toBe(1); }
    finally { db.close(); }
  });
});

describe('real contract-shaped fixtures', () => {
  it('rejects missing, duplicate and noncanonical artifact records', () => {
    const missing = structuredClone(manifestFixture());
    missing.artifacts.pop();
    expect(() => validateArtifactRecords(missing)).toThrow(/artifact records/);

    const duplicate = structuredClone(manifestFixture());
    duplicate.artifacts[1] = structuredClone(duplicate.artifacts[0]!);
    expect(() => validateArtifactRecords(duplicate)).toThrow(/duplicate artifact record/);

    const wrongPath = structuredClone(manifestFixture());
    wrongPath.artifacts[0]!.tilesKey = `builds/${wrongPath.model}/other/usable-lift-msl/f003.pmtiles`;
    expect(() => validateArtifactRecords(wrongPath)).toThrow(/unexpected tilesKey/);
  });

  it('rejects invalid packed values and layer-incompatible support flags', () => {
    const flags = Uint8Array.from([0, 0, 0, 0, 4, 0, 0, 0, 0, 16]);
    expect(() => validateSampleFlags(flags, 10)).not.toThrow();
    expect(() => validateSampleFlags(flags, 10, 'precip-rate')).toThrow(/precip-rate lift flags/);
    expect(() => validateSampleFlags(Uint8Array.from([0, 0, 192, 127, 0]), 5)).toThrow(/non-finite sample value/);
    expect(() => validateSampleFlags(Uint8Array.from([0, 0, 0, 0, 32]), 5)).not.toThrow();
    expect(() => validateSampleFlags(Uint8Array.from([0, 0, 0, 0, 32]), 5, 'precip-rate')).toThrow(/lift flags/);
    expect(() => validateSampleFlags(new Uint8Array(5), 10)).toThrow(/length/);
  });

});

describe('declarative workflows', () => {
  it('verifies code before global terrain writes and requires every fixed shard before publication', () => {
    const terrain = workflow('terrain.yml'), jobs = record(terrain.jobs);
    expect(Object.keys(record(terrain.on))).toEqual(['workflow_dispatch']);
    expect(record(terrain.concurrency)['cancel-in-progress']).toBe(false);
    expect(record(jobs.verify).uses).toBe('./.github/workflows/ci.yml');
    expect(record(jobs.inventory).needs).toBe('verify');
    const sync = record(jobs.sync), strategy = record(sync.strategy);
    expect(sync.needs).toBe('inventory');
    expect(strategy['fail-fast']).toBe(false);
    const shards = list(record(strategy.matrix).shard);
    expect(shards).toEqual(Array.from({ length: shards.length }, (_, index) => index));
    expect(shards.length).toBeGreaterThan(1);
    expect(shards.length).toBeLessThanOrEqual(64);
    expect(record(sync.env).SHARDS).toBe('${{ strategy.job-total }}');
    expect(record(jobs.publish).needs).toEqual(['inventory', 'sync']);
    expect(record(jobs.publish).if).toBeUndefined();
    for (const name of ['inventory', 'sync', 'publish']) {
      const job = record(jobs[name]);
      expect(job['runs-on']).toBe('ubuntu-24.04');
      for (const step of list(job.steps).map(record)) {
        if (step.uses === 'actions/upload-artifact@v4') expect(record(step.with).overwrite).toBe(true);
        if (typeof step.run === 'string') expect(step.run).not.toMatch(/operations forecast|operations deploy|pnpm forecast/);
      }
    }
    const verification = list(record(record(workflow('ci.yml').jobs).verify).steps).map(record);
    expect(verification.some(step => step.run === 'pnpm verify')).toBe(true);
    expect(verification.some(step => typeof step.run === 'string' && step.run.includes('--with rasterio==1.4.3 --with numpy==2.2.6'))).toBe(true);
  });

  it('scopes terrain, planning, publication and maintenance credentials to the selected environment', () => {
    const forecast = workflow('forecast.yml');
    expect(record(forecast.on).repository_dispatch).toEqual({ types: ['upstream-cycle-ready'] });
    const dispatch = list(record(record(forecast.jobs).select).steps).map(record).find(step => step.id === 'dispatch');
    expect(dispatch).toMatchObject({ if: "github.event_name == 'repository_dispatch'", run: 'node --import tsx scripts/forecast-dispatch.ts' });
    expect(workflow('maintenance.yml')['run-name']).toBe("Maintenance ${{ inputs.environment || 'production' }} ${{ inputs.model }} ${{ inputs.action }}");
    const forecastJobs = record(workflow('forecast-model.yml').jobs);
    for (const name of ['terrain', 'prepare', 'build-publish']) {
      const job = record(forecastJobs[name]);
      expect(job.environment).toBe('${{ inputs.environment }}');
      expect(record(job.env).R2_SECRET_ACCESS_KEY).toBe('${{ secrets.R2_SECRET_ACCESS_KEY }}');
    }
    const maintenance = record(record(workflow('maintenance.yml').jobs).maintain);
    expect(maintenance.environment).toBe("${{ inputs.environment || 'production' }}");
    expect(record(maintenance.env).R2_SECRET_ACCESS_KEY).toBe('${{ secrets.R2_SECRET_ACCESS_KEY }}');
    const caller = record(record(workflow('forecast.yml').jobs).forecast), lock = record(caller.concurrency);
    expect(workflow('forecast.yml').concurrency).toBeUndefined();
    expect(workflow('forecast-model.yml').concurrency).toBeUndefined();
    expect(lock.group).toBe('forecast-${{ needs.select.outputs.environment }}-${{ matrix.model }}');
    expect(workflow('maintenance.yml').concurrency).toEqual({ ...lock, group: "forecast-${{ inputs.environment || 'production' }}-${{ inputs.model }}" });
    for (const name of ['forecast.yml', 'health.yml', 'maintenance.yml']) {
      const model = record(record(record(record(workflow(name).on).workflow_dispatch).inputs).model);
      expect(model).toMatchObject({ type: 'string', required: true });
      expect(model.default).toBe(name === 'maintenance.yml' ? undefined : 'all');
    }
  });

  it('isolates forecast shards from publication credentials and preserves the resume path', () => {
    const forecast = workflow('forecast-model.yml'), jobs = record(forecast.jobs), shard = record(jobs.shard), publisher = record(jobs['build-publish']);
    const terrain = record(jobs.terrain), prepare = record(jobs.prepare);
    expect(prepare.needs).toBe('terrain');
    expect(terrain.if).toBe("${{ github.ref == 'refs/heads/main' && !inputs['resume-run-id'] }}");
    expect(prepare.if).toBe(terrain.if);
    expect(terrain.env).toEqual(prepare.env);
    expect(list(terrain.steps).map(record).some(step => step.run === 'pnpm operations forecast-terrain')).toBe(true);
    expect(record(shard.strategy)['max-parallel']).toBe('${{ inputs.parallelism }}');
    expect(record(shard.strategy)['fail-fast']).toBe(false);
    expect(shard.needs).toBe('prepare');
    expect(shard.environment).toBe('${{ inputs.environment }}');
    expect(shard.permissions).toEqual({ contents: 'read' });
    const caller = record(record(workflow('forecast.yml').jobs).forecast);
    expect(caller.concurrency).toEqual({ group: 'forecast-${{ needs.select.outputs.environment }}-${{ matrix.model }}', 'cancel-in-progress': false });
    expect(record(caller.with).parallelism).toBe('${{ matrix.parallelism }}');
    const selection = list(record(record(workflow('forecast.yml').jobs).select).steps).map(record).find(step => step.id === 'models')!;
    expect(record(selection.env).MODEL_SCHEDULE).toBe("${{ github.event.schedule || '' }}");
    for (const env of [record(forecast.env), record(shard.env)]) for (const key of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) expect(env[key]).toBeUndefined();
    for (const env of [record(forecast.env), record(shard.env)]) for (const key of ['R2_SHARD_ACCESS_KEY_ID', 'R2_SHARD_SECRET_ACCESS_KEY', 'FORECAST_SHARD_CREDENTIAL_KEY']) expect(env[key]).toBeUndefined();
    const shardBuild = list(shard.steps).map(record).find(step => step.run === 'pnpm operations forecast-shard')!;
    const selected = '${{ secrets.FORECAST_SHARD_CREDENTIAL_KEY }}';
    expect(record(shardBuild.env)).toEqual({ FORECAST_SHARD_CREDENTIAL_KEY: selected });
    const prepareStep = list(record(jobs.prepare).steps).map(record).find(step => step.run === 'pnpm operations forecast-plan')!;
    expect(record(prepareStep.env)).toEqual({ CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}', FORECAST_SHARD_CREDENTIAL_KEY: selected });
    for (const env of [record(forecast.env), record(shard.env), record(publisher.env), record(prepare.env)]) {
      for (const key of ['CLOUDFLARE_API_TOKEN', 'GH_CREDENTIAL_ISSUER_TOKEN']) expect(env[key]).toBeUndefined();
      expect(Object.keys(env).filter(key => /^FORECAST_.+_SHARD_CREDENTIAL_KEY$/.test(key))).toEqual([]);
    }
    expect(record(jobs.prepare).outputs).toEqual({ ready: '${{ steps.plan.outputs.ready }}', shards: '${{ steps.plan.outputs.shards }}', artifact: '${{ steps.plan.outputs.artifact }}' });
    expect(record(publisher.env).FORECAST_SHARD_CREDENTIAL_KEY).toBeUndefined();
    for (const step of list(publisher.steps).map(record)) expect(step.env && record(step.env).FORECAST_SHARD_CREDENTIAL_KEY).toBeFalsy();
    expect(publisher.needs).toEqual(['prepare', 'shard']);
    expect(String(publisher.if)).toContain("needs.shard.result == 'success'");
    expect(String(publisher.if)).toContain("inputs['resume-run-id']");
    expect(record(publisher.env).R2_SECRET_ACCESS_KEY).toBe('${{ secrets.R2_SECRET_ACCESS_KEY }}');
    const steps = list(publisher.steps).map(record);
    expect(steps.find(step => step.run === 'pnpm operations forecast')?.if).toBeUndefined();
    expect(steps.filter(step => step.uses === 'actions/download-artifact@v4' && step.name !== 'Download retained shard payloads').map(step => step.name)).toEqual(['Download build plan']);
    expect(list(shard.steps).map(record).some(step => step.name === 'Upload completed shard')).toBe(false);
    const plan = list(record(jobs.prepare).steps).map(record).find(step => step.uses === 'actions/upload-artifact@v4' && step.if === "steps.plan.outputs.ready == 'true'")!;
    expect(String(record(plan.with).path)).toContain('output/coverage/');
    expect(String(record(plan.with).path)).toContain('output/shard-credentials.json');
    expect(String(record(plan.with).path)).toContain('output/terrain/prepared/*/manifest.json');
    const bundle = steps.find(step => step.name === 'Upload resumable build records')!;
    expect(bundle.if).toBe('always()');
    expect(record(bundle.with).name).toBe('forecast-${{ env.MODEL }}-${{ github.run_id }}');
    for (const part of ['output/plan.json', 'output/workflow.json', 'output/shards/*/*.json', 'output/builds/*/*/*.json', 'output/coverage/']) expect(String(record(bundle.with).path)).toContain(part);
    const full = steps.find(step => String(step.name).startsWith('Upload full build artifacts'))!;
    expect(full.if).toBe("${{ always() && env.RETAIN_FULL_ARTIFACTS == 'true' }}");
    for (const step of [...list(shard.steps).map(record), ...steps]) if (step.uses === 'actions/upload-artifact@v4') expect(String(record(step.with).path)).not.toContain('shard-credentials.json');
    expect(String(record(full.with).path)).toContain('output/coverage/');
    expect(String(record(full.with).path)).toContain('output/terrain/');
    for (const [job, command] of [[record(jobs.prepare), 'forecast-plan'], [shard, 'forecast-shard']] as const) {
      expect(list(job.steps).map(record).some(step => step.run === `pnpm operations ${command}`)).toBe(true);
    }
  });

  it('checks all selected models independently and retains separate health records', () => {
    const check = record(record(workflow('health.yml').jobs).check);
    expect(record(check.strategy)['fail-fast']).toBe(false);
    const steps = list(check.steps).map(record);
    expect(record(steps.find(step => step.run === 'pnpm health')!.env).MODEL).toBe('${{ matrix.model }}');
    expect(record(steps.find(step => step.uses === 'actions/upload-artifact@v4')!.with).name).toBe("health-${{ inputs.environment || 'production' }}-${{ matrix.model }}-${{ github.run_id }}");
  });

});
