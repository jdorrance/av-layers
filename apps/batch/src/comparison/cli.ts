/** Capture or replay fixed-site forecast comparisons. Raw responses remain in the output archive. */
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readLocalFile } from '../local-file.js';
import type { ComparisonSample, ParameterMapping } from './core.js';
import { buildReport } from './report.js';
import { parseSites } from './sites.js';
import { captureComparison, planComparison, readComparisonAnalysis, replayComparison } from './session.js';
import { captureSkySight, planSkySight, replaySkySight } from './skysight-session.js';

async function readArray(path: string, maxBytes: number, maxRows: number): Promise<Record<string, unknown>[]> {
  const value: unknown = JSON.parse((await readLocalFile(path, maxBytes)).toString('utf8'));
  if (!Array.isArray(value) || value.length > maxRows || value.some(row => row === null || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error(`Comparison input requires a bounded array of objects: ${path}`);
  }
  return value;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    out: { type: 'string' }, sites: { type: 'string' }, reference: { type: 'string' }, api: { type: 'string' }, provider: { type: 'string' },
    left: { type: 'string' }, right: { type: 'string' }, mappings: { type: 'string' }, baseline: { type: 'string' }, regions: { type: 'string' }
  } });
  const [command] = positionals;
  if (!values.out || positionals.length !== 1 || !['plan', 'capture', 'report', 'compare', 'skysight-plan', 'skysight-capture', 'skysight-report'].includes(command)) {
    throw new Error('Usage: pnpm comparison plan|capture|report|compare|skysight-plan|skysight-capture|skysight-report --out DIR');
  }
  if (command === 'skysight-plan') {
    if (!values.baseline || !values.regions) throw new Error('SkySight planning requires --baseline DIR --regions FILE');
    const plan = await planSkySight(values.out, { baseline: values.baseline, regions: values.regions, referenceTime: values.reference });
    console.log(JSON.stringify({ sites: plan.sites.length, requests: plan.requests.length, pins: plan.pins }));
  } else if (command === 'skysight-capture') {
    await captureSkySight(values.out, (done, total) => { if (done % 25 === 0 || done === total) console.log(`${done}/${total} captures`); });
  } else if (command === 'skysight-report') {
    const report = await replaySkySight(values.out);
    console.log(JSON.stringify({ counts: report.counts, failedCaptures: report.collection.failures.length }));
  } else if (command === 'plan') {
    const plan = await planComparison(values.out, { sites: values.sites, referenceTime: values.reference, apiBase: values.api });
    console.log(JSON.stringify({ sites: plan.sites.length, builds: plan.builds.length, requests: plan.requests.length }));
  } else if (command === 'capture') {
    await captureComparison(values.out, (done, total) => { if (done % 25 === 0 || done === total) console.log(`${done}/${total} captures`); }, values.provider);
  } else if (command === 'report') {
    const report = await replayComparison(values.out);
    console.log(JSON.stringify({ counts: report.counts, failedCaptures: report.collection.failures.length }));
  } else {
    if (!values.left || !values.right || !values.sites || !values.mappings) {
      throw new Error('Usage: pnpm comparison compare --left FILE --right FILE --sites FILE --mappings FILE --out DIR');
    }
    const path = join(values.out, 'report.json');
    if ([values.left, values.right, values.sites, values.mappings].some(input => resolve(input) === resolve(path))) {
      throw new Error('Comparison report must have a different path from its inputs');
    }
    const [left, right, sites, mappings] = await Promise.all([
      readArray(values.left, 64 * 1024 ** 2, 100_000), readArray(values.right, 64 * 1024 ** 2, 100_000),
      readArray(values.sites, 1024 ** 2, 256), readArray(values.mappings, 1024 ** 2, 1024)
    ]);
    const report = { ...buildReport(left as unknown as ComparisonSample[], right as unknown as ComparisonSample[],
      mappings as unknown as ParameterMapping[], parseSites(sites)), analysis: await readComparisonAnalysis() };
    await mkdir(values.out, { recursive: true });
    await writeFile(path, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ counts: report.counts, report: path }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
