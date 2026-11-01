import { spawn } from 'node:child_process';
import { observeBuildResources } from './build-resource-observer.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkPerformance } from '../apps/batch/src/capacity.js';
import type { Manifest } from '@av/contracts';

type Variant = 'baseline' | 'candidate';
interface Run {
  variant: Variant; repetition: number; manifest: string; processElapsedMs: number; elapsedMs: number;
  peakRssBytes: number; diskBytes: number; archiveBytes: number; sampleSha256: string;
  processObservations?: Record<string, unknown>;
  resourceObservations?: Awaited<ReturnType<ReturnType<typeof observeBuildResources>['stop']>>;
  artifacts: Record<string, string>; metrics: Record<string, unknown>; performance: ReturnType<typeof checkPerformance>;
}
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
function spread(values: number[]) { const mid = median(values), min = Math.min(...values), max = Math.max(...values); return { median: mid, min, max, rangeFractionOfMedian: (max - min) / mid }; }
export function summarizeBuildRuns(runs: Pick<Run, 'variant' | 'repetition' | 'elapsedMs' | 'peakRssBytes' | 'diskBytes' | 'performance'>[]) {
  const variants = Object.fromEntries((['baseline', 'candidate'] as const).map(variant => {
    const selected = runs.filter(run => run.variant === variant);
    return [variant, { count: selected.length, elapsedMs: spread(selected.map(run => run.elapsedMs)), peakRssBytes: spread(selected.map(run => run.peakRssBytes)), diskBytes: spread(selected.map(run => run.diskBytes)) }];
  })) as Record<Variant, { count: number; elapsedMs: ReturnType<typeof spread>; peakRssBytes: ReturnType<typeof spread>; diskBytes: ReturnType<typeof spread> }>;
  const pairedElapsedReduction = runs.filter(run => run.variant === 'baseline').flatMap(baseline => {
    const candidate = runs.find(run => run.variant === 'candidate' && run.repetition === baseline.repetition);
    return candidate ? [1 - candidate.elapsedMs / baseline.elapsedMs] : [];
  });
  const medianElapsedReduction = 1 - variants.candidate.elapsedMs.median / variants.baseline.elapsedMs.median;
  const noiseFraction = Math.max(variants.baseline.elapsedMs.rangeFractionOfMedian, variants.candidate.elapsedMs.rangeFractionOfMedian);
  const complete = variants.baseline.count === 5 && variants.candidate.count === 5;
  const candidateWithinBudgets = runs.filter(run => run.variant === 'candidate').every(run => run.performance.passed);
  return { variants, pairedElapsedReduction, medianElapsedReduction, noiseFraction, complete, candidateWithinBudgets,
    decision: !complete ? 'incomplete' : !candidateWithinBudgets ? 'reject-budget-exceeded' : medianElapsedReduction <= noiseFraction ? 'inconclusive-within-observed-range' : 'adopt-measured-improvement' };
}
async function hashFile(path: string): Promise<string> { const hash = createHash('sha256'); for await (const part of createReadStream(path)) hash.update(part); return hash.digest('hex'); }
async function files(root: string, excluded: Set<string> = new Set()): Promise<string[]> {
  const names = new Set(['.git', 'node_modules', '.cache', '.tools', '.wrangler', '.codex', '.agents', '.aws', '.DS_Store', 'output', 'dist']);
  const result: string[] = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (names.has(item.name) || excluded.has(resolve(path)) || (/^\.(?:env|dev\.vars)(?:\.|$)/.test(item.name) && !item.name.endsWith('.example'))) continue;
    if (item.isDirectory()) result.push(...await files(path, excluded));
    else if (item.isFile()) result.push(path);
  }
  return result.sort();
}
async function sourceHash(root: string, excluded: Set<string>): Promise<string> {
  const hash = createHash('sha256');
  for (const path of await files(root, excluded)) hash.update(`${relative(root, path)}\0${await hashFile(path)}\n`);
  hash.update(`pmtiles\0${await hashFile(join(root, '.tools/pmtiles'))}`);
  return hash.digest('hex');
}
const signature = (manifest: Manifest) => Object.fromEntries(manifest.artifacts.map(item => [`${item.frame}/${item.layer}`, item.tilesSha256]).sort(([a], [b]) => a.localeCompare(b)));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main(): Promise<void> {
  const usage = 'Usage: --baseline-source DIR --candidate-source DIR --cache-dir DIR --cycle ISO --out DIR [--pixel-proof FILE] [--resume] [--timeout-minutes 45]\nRuns five paired warm builds sequentially, alternating order. Sources must remain frozen. Outputs and logs are retained; receipt.json is updated after each run. No builds run with --help.';
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, 'baseline-source': { type: 'string' }, 'candidate-source': { type: 'string' }, 'cache-dir': { type: 'string' }, cycle: { type: 'string' }, out: { type: 'string' }, 'pixel-proof': { type: 'string' }, resume: { type: 'boolean', default: false }, 'timeout-minutes': { type: 'string', default: '45' } } });
  if (values.help) { console.log(usage); return; }
  if (!values['baseline-source'] || !values['candidate-source'] || !values['cache-dir'] || !values.cycle || !values.out) throw new Error(usage);
  if (!['darwin', 'linux'].includes(platform())) throw new Error('Build qualification requires macOS or Linux process observation');
  if (process.version !== 'v22.23.4') throw new Error(`Use pinned Node 22.23.4; running ${process.version}`);
  const timeoutMs = Number(values['timeout-minutes']) * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 60 * 60_000) throw new Error('Timeout must be 1..60 minutes');
  const sources = { baseline: resolve(values['baseline-source']), candidate: resolve(values['candidate-source']) }, cacheDir = resolve(values['cache-dir']), output = resolve(values.out), excluded = new Set([output, cacheDir]);
  const sourceHashes = { baseline: await sourceHash(sources.baseline, excluded), candidate: await sourceHash(sources.candidate, excluded) };
  const config = { sources, sourceHashes, cacheDir, cycle: values.cycle, node: process.version, executable: process.execPath, timeoutMs, pixelProof: values['pixel-proof'] ? resolve(values['pixel-proof']) : null };
  const references: Partial<Record<Variant, { samples: string; artifacts: Record<string, string> }>> = {};
  if (config.pixelProof) {
    const proof = JSON.parse(await readFile(config.pixelProof, 'utf8'));
    if (proof.passed !== true || proof.samples?.byteExact !== true || proof.sourceFrames?.equalExcludingCapturedAt !== true) throw new Error('A successful exhaustive comparison receipt is required');
    for (const variant of ['baseline', 'candidate'] as const) {
      if (await hashFile(proof[`${variant}Manifest`]) !== proof[`${variant}ManifestSha256`]) throw new Error('Pixel-qualified manifest changed');
      const manifest = JSON.parse(await readFile(proof[`${variant}Manifest`], 'utf8')) as Manifest;
      if (Date.parse(manifest.cycle) !== Date.parse(config.cycle)) throw new Error('Pixel proof cycle differs');
      references[variant] = { samples: manifest.samples.sha256, artifacts: signature(manifest) };
    }
  }
  await mkdir(output, { recursive: true });
  const receiptPath = join(output, 'receipt.json');
  let runs: Run[] = [];
  if (values.resume) {
    const prior = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (!same(prior.config, config) || !Array.isArray(prior.runs)) throw new Error('Resume configuration/source identity differs');
    runs = prior.runs;
    if (runs.some(run => run.variant === 'candidate' && !run.performance.passed)) throw new Error('Cannot resume a candidate that failed a mandatory performance gate');
    for (const run of runs) { if (!references[run.variant]) references[run.variant] = { samples: run.sampleSha256, artifacts: run.artifacts }; }
  } else {
    const reservation = await open(receiptPath, 'wx'); await reservation.close();
  }
  const writeReceipt = async (state: string, extra: Record<string, unknown> = {}) => {
    const value = { version: 1, kind: 'paired-warm-full-builds', state, config, host: { platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model }, updatedAt: new Date().toISOString(), runs, ...(runs.some(run => run.variant === 'baseline') && runs.some(run => run.variant === 'candidate') ? { summary: summarizeBuildRuns(runs) } : {}), ...extra };
    await writeFile(`${receiptPath}.tmp`, JSON.stringify(value, null, 2)); await rename(`${receiptPath}.tmp`, receiptPath);
  };
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    await writeReceipt('running');
    for (let repetition = 1; repetition <= 5; repetition++) for (const variant of (repetition % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) as Variant[]) {
      if (runs.some(run => run.variant === variant && run.repetition === repetition)) continue;
      if (interrupted) throw new Error('Benchmark interrupted');
      if (await sourceHash(sources[variant], excluded) !== sourceHashes[variant]) throw new Error(`${variant} source changed during qualification`);
      const runRoot = join(output, `${repetition}-${variant}`), logPath = join(output, `${repetition}-${variant}.log`);
      if (values.resume) {
        const suffix = `.interrupted-${Date.now()}`;
        try { await rename(runRoot, `${runRoot}${suffix}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        try { await rename(logPath, `${logPath}${suffix}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      await mkdir(runRoot); const temporary = join(runRoot, '.tmp'); await mkdir(temporary);
      const log = await open(logPath, 'wx'), started = performance.now();
      const child = spawn(process.execPath, ['--import', new URL('./build-process-observer.mjs', import.meta.url).href, '--import', 'tsx', join(sources[variant], 'apps/batch/src/cli.ts'), 'build:sample', '--model', 'gfs', '--cycle', config.cycle, '--cache-dir', cacheDir, '--out', runRoot], { detached: true, cwd: sources[variant], stdio: ['ignore', log.fd, log.fd], env: { ...process.env, AV_BUILD_OBSERVER_OUTPUT: join(runRoot, 'process-observations.json'), TMPDIR: temporary, TMP: temporary, TEMP: temporary, PMTILES_BIN: join(sources[variant], '.tools/pmtiles') } });
      const resourceObserver = observeBuildResources(child.pid!, runRoot, temporary);
      console.log(JSON.stringify({ event: 'run-started', variant, repetition, pid: child.pid, runRoot, logPath }));
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const killGroup = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      };
      const stop = () => { killGroup('SIGTERM'); killTimer ??= setTimeout(() => killGroup('SIGKILL'), 10_000); };
      const timeout = setTimeout(stop, timeoutMs), heartbeat = setInterval(() => { console.log(JSON.stringify({ event: 'run-active', variant, repetition, elapsedMs: performance.now() - started, logPath })); if (interrupted) stop(); }, 30_000);
      let code: number | null;
      let resourceObservations: Awaited<ReturnType<typeof resourceObserver.stop>>;
      try { code = await new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('close', accept); }); }
      finally {
        clearTimeout(timeout); clearInterval(heartbeat); if (killTimer) clearTimeout(killTimer);
        killGroup('SIGKILL');
        resourceObservations = await resourceObserver.stop();
        await writeFile(join(runRoot, 'resource-observations.json'), JSON.stringify(resourceObservations, null, 2));
        await log.close();
      }
      const processElapsedMs = performance.now() - started;
      if (code !== 0) throw new Error(`${variant} repetition ${repetition} exited ${code}; see ${logPath}`);
      if (await sourceHash(sources[variant], excluded) !== sourceHashes[variant]) throw new Error(`${variant} source changed during the build`);
      const outputFiles = await files(runRoot, new Set([temporary])), manifests = outputFiles.filter(path => /builds\/gfs\/[^/]+\/manifest\.json$/.test(path));
      if (manifests.length !== 1) throw new Error('Expected one completed build manifest');
      const manifest = JSON.parse(await readFile(manifests[0], 'utf8')) as Manifest;
      if (Date.parse(manifest.cycle) !== Date.parse(config.cycle) || (manifest.metrics.acquisition as { transport?: { networkRequests?: number } })?.transport?.networkRequests !== 0) throw new Error('Warm build changed cycle or performed network acquisition');
      if (['elapsedMs', 'peakRssBytes'].some(key => typeof manifest.metrics[key] !== 'number' || !Number.isFinite(manifest.metrics[key]) || (manifest.metrics[key] as number) <= 0)) throw new Error('Build is missing usable timing or memory evidence');
      const pathFor = (key: string) => { const path = resolve(runRoot, key); if (!path.startsWith(`${runRoot}${sep}`)) throw new Error('Unsafe output key'); return path; };
      const sampleSha256 = await hashFile(pathFor(manifest.samples.key));
      if (sampleSha256 !== manifest.samples.sha256) throw new Error('Sample digest differs from manifest');
      const artifacts: Record<string, string> = {}; let archiveBytes = 0;
      for (const item of [...manifest.artifacts].sort((a, b) => `${a.frame}/${a.layer}`.localeCompare(`${b.frame}/${b.layer}`))) {
        const path = pathFor(item.tilesKey), hash = await hashFile(path);
        if (hash !== item.tilesSha256) throw new Error('Archive digest differs from manifest');
        artifacts[`${item.frame}/${item.layer}`] = hash; archiveBytes += (await stat(path)).size;
      }
      const reference = references[variant];
      if (reference && (reference.samples !== sampleSha256 || !same(reference.artifacts, artifacts))) throw new Error(`${variant} artifacts are not deterministic or differ from the pixel-qualified build`);
      references[variant] = { samples: sampleSha256, artifacts };
      if (references.baseline && references.candidate && references.baseline.samples !== references.candidate.samples) throw new Error('Baseline and candidate numeric packs differ');
      let diskBytes = 0; for (const path of outputFiles) diskBytes += (await stat(path)).size;
      const performanceReceipt = checkPerformance(manifest);
      if (!resourceObservations.observations || resourceObservations.errors.length) throw new Error(`Resource observation failed: ${resourceObservations.errors.join('; ')}`);
      if (variant === 'candidate' && resourceObservations.peakObservedProcessTreeRssBytes > performanceReceipt.budgets.peakRssBytes) throw new Error('Observed complete process tree exceeds RSS budget');
      const processObservations = JSON.parse(await readFile(join(runRoot, 'process-observations.json'), 'utf8')) as Record<string, unknown>;
      if (processObservations.exitCode !== 0 || !processObservations.cpuMicroseconds || !processObservations.gc) throw new Error('Missing process CPU/GC observations');
      runs.push({ processObservations, resourceObservations, variant, repetition, manifest: manifests[0], processElapsedMs, elapsedMs: Number(manifest.metrics.elapsedMs), peakRssBytes: Number(manifest.metrics.peakRssBytes), diskBytes, archiveBytes, sampleSha256, artifacts, metrics: manifest.metrics, performance: performanceReceipt });
      await writeReceipt('running'); console.log(JSON.stringify({ event: 'run-complete', variant, repetition, elapsedMs: manifest.metrics.elapsedMs, peakRssBytes: manifest.metrics.peakRssBytes, performancePassed: performanceReceipt.passed }));
      if (variant === 'candidate' && !performanceReceipt.passed) throw new Error(`Candidate failed mandatory performance gate: ${performanceReceipt.failures.join('; ')}`);
    }
    const summary = summarizeBuildRuns(runs);
    await writeReceipt('complete', { passed: summary.complete && summary.candidateWithinBudgets, deterministic: true, pixelProofBound: !!config.pixelProof });
  } catch (error) { await writeReceipt('failed', { error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exitCode = 1; });
