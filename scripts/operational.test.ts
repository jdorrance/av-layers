import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifestSchema, validateArtifactRecords, validateSampleFlags } from '@av/contracts';
import { GFS_DISCOVERY_LAG_HOURS, GFS_FORECAST_HOURS } from '../apps/batch/src/noaa/constants';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const manifestFixture = () => manifestSchema.parse(JSON.parse(readFileSync(fixture('manifest.contract.json'), 'utf8')));
const requireFromWrangler = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'));
const yaml = requireFromWrangler('yaml') as { parse(source: string): unknown };
const workflowText = (name: string): string => readFileSync(fileURLToPath(new URL(`../.github/workflows/${name}`, import.meta.url)), 'utf8');
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
  return value as Record<string, unknown>;
};
const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('expected array');
  return value;
};
const workflow = (name: string): Record<string, unknown> => record(yaml.parse(workflowText(name)));
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
    for (const name of ['forecast.yml', 'maintenance.yml']) {
      expect(record(workflow(name).concurrency)).toEqual({ group: "forecast-${{ inputs.environment || 'production' }}-gfs", 'cancel-in-progress': false });
      const job = record(Object.values(record(workflow(name).jobs))[0]);
      expect(job.environment).toBe("${{ inputs.environment || 'production' }}");
      expect(record(job.env).R2_SECRET_ACCESS_KEY).toBe('${{ secrets.R2_SECRET_ACCESS_KEY }}');
    }
    expect(record(record(record(workflow('bootstrap.yml').jobs).bootstrap).env).CLOUDFLARE_API_TOKEN).toBe('${{ secrets.CLOUDFLARE_BOOTSTRAP_TOKEN }}');
  });

  it('finishes the next scheduled job before the previous forecast horizon ends', () => {
    const forecast = workflow('forecast.yml');
    const [minute, hours, day, month, weekday] = String(record(list(record(forecast.on).schedule)[0]).cron).split(' ');
    expect([day, month, weekday]).toEqual(['*', '*', '*']);
    const starts = hours!.split(',').map(hour => Number(hour) * 60 + Number(minute)).sort((a, b) => a - b);
    const budget = Number(record(record(forecast.jobs)['build-publish'])['timeout-minutes']);
    for (let i = 0; i < starts.length; i++) {
      const cycle = Math.floor((starts[i]! - GFS_DISCOVERY_LAG_HOURS * 60) / 360) * 360;
      const nextStart = starts[(i + 1) % starts.length]! + (i + 1 === starts.length ? 1440 : 0);
      expect(nextStart + budget).toBeLessThan(cycle + Math.max(...GFS_FORECAST_HOURS) * 60);
    }
  });
});
