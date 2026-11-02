import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { manifestSchema, validateArtifactRecords, validateSampleFlags } from '@av/contracts';
import { MAX_FORECAST_SHARDS } from '../apps/batch/src/parallel';
import { GFS_DISCOVERY_LAG_HOURS, GFS_FORECAST_HOURS } from '../apps/batch/src/noaa/constants';

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
    wrongPath.artifacts[0]!.tilesKey = 'builds/gfs/other/usable-lift-msl/f003.pmtiles';
    expect(() => validateArtifactRecords(wrongPath)).toThrow(/unexpected tilesKey/);
  });

  it('rejects invalid packed values and unsupported status flags', () => {
    const flags = Uint8Array.from([0, 0, 0, 0, 4, 0, 0, 0, 0, 16]);
    expect(() => validateSampleFlags(flags, 10)).not.toThrow();
    expect(() => validateSampleFlags(flags, 10, 'precip-rate')).toThrow(/precip-rate lift flags/);
    expect(() => validateSampleFlags(Uint8Array.from([0, 0, 192, 127, 0]), 5)).toThrow(/non-finite sample value/);
    expect(() => validateSampleFlags(Uint8Array.from([0, 0, 0, 0, 32]), 5)).toThrow(/support bits/);
    expect(() => validateSampleFlags(new Uint8Array(5), 10)).toThrow(/length/);
  });

});

describe('declarative workflows', () => {
  it('retains shared writer serialization and environment-scoped credentials', () => {
    expect(workflow('forecast.yml')['run-name']).toBe("Forecast ${{ inputs.environment || 'production' }} ${{ inputs.model || 'gfs' }}");
    expect(workflow('maintenance.yml')['run-name']).toBe("Maintenance ${{ inputs.environment || 'production' }} ${{ inputs.model || 'gfs' }} ${{ inputs.action }}");
    for (const name of ['forecast.yml', 'maintenance.yml']) {
      expect(record(workflow(name).concurrency)).toEqual({ group: "forecast-${{ inputs.environment || 'production' }}-${{ inputs.model || 'gfs' }}", 'cancel-in-progress': false });
      const job = record(Object.values(record(workflow(name).jobs))[0]);
      expect(job.environment).toBe("${{ inputs.environment || 'production' }}");
      expect(record(job.env).R2_SECRET_ACCESS_KEY).toBe('${{ secrets.R2_SECRET_ACCESS_KEY }}');
    }
  });

  it('isolates four compute workers from publication credentials and preserves the resume path', () => {
    const forecast = workflow('forecast.yml'), jobs = record(forecast.jobs), shard = record(jobs.shard), publisher = record(jobs['build-publish']);
    expect(record(shard.strategy)['max-parallel']).toBe(MAX_FORECAST_SHARDS);
    expect(record(shard.strategy)['fail-fast']).toBe(false);
    expect(shard.needs).toBe('prepare');
    expect(shard.environment).toBeUndefined();
    for (const env of [record(forecast.env), record(shard.env)]) for (const key of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'CLOUDFLARE_ACCOUNT_ID']) expect(env[key]).toBeUndefined();
    expect(publisher.needs).toEqual(['prepare', 'shard']);
    expect(String(publisher.if)).toContain("needs.shard.result == 'success'");
    expect(String(publisher.if)).toContain("inputs['resume-run-id']");
    expect(record(publisher.env).R2_SECRET_ACCESS_KEY).toBe('${{ secrets.R2_SECRET_ACCESS_KEY }}');
    const steps = list(publisher.steps).map(record);
    expect(steps.find(step => step.run === 'pnpm operations forecast')?.if).toBeUndefined();
    const download = steps.find(step => step.name === 'Download forecast shards')!;
    expect(download.uses).toBe('actions/download-artifact@v4');
    expect(download.if).toBe("${{ !inputs['resume-run-id'] }}");
    expect(record(download.with)).toEqual({ pattern: '${{ needs.prepare.outputs.artifact }}-shard-*', 'merge-multiple': true, path: 'output' });
    for (const [job, command] of [[record(jobs.prepare), 'forecast-plan'], [shard, 'forecast-shard']] as const) {
      expect(list(job.steps).map(record).some(step => step.run === `pnpm operations ${command}`)).toBe(true);
    }
  });

  it('finishes the next scheduled job before the previous forecast horizon ends', () => {
    const forecast = workflow('forecast.yml');
    const [minute, hours, day, month, weekday] = String(record(list(record(forecast.on).schedule)[0]).cron).split(' ');
    expect([day, month, weekday]).toEqual(['*', '*', '*']);
    const starts = hours!.split(',').map(hour => Number(hour) * 60 + Number(minute)).sort((a, b) => a - b);
    const jobs = record(forecast.jobs);
    const budget = ['prepare', 'shard', 'build-publish'].reduce((total, name) => total + Number(record(jobs[name])['timeout-minutes']), 0);
    for (let i = 0; i < starts.length; i++) {
      const cycle = Math.floor((starts[i]! - GFS_DISCOVERY_LAG_HOURS * 60) / 360) * 360;
      const nextStart = starts[(i + 1) % starts.length]! + (i + 1 === starts.length ? 1440 : 0);
      expect(nextStart + budget).toBeLessThan(cycle + Math.max(...GFS_FORECAST_HOURS) * 60);
    }
  });
});
