import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeBuildRuns } from './benchmark-builds.js';

it('reports paired medians, observed noise and mandatory candidate budget failures', () => {
  const runs = Array.from({ length: 5 }, (_, index) => (['baseline', 'candidate'] as const).map(variant => ({ variant, repetition: index + 1, elapsedMs: (variant === 'baseline' ? 2000 : 1000) + index * 2, peakRssBytes: 1000, diskBytes: 1000, performance: { version: 1, buildId: 'fixture', cycle: 'fixture', observed: {} as never, budgets: {} as never, passed: variant === 'candidate', failures: [] } }))).flat();
  const summary = summarizeBuildRuns(runs);
  expect(summary.variants.baseline.elapsedMs).toEqual({ median: 2004, min: 2000, max: 2008, rangeFractionOfMedian: 8 / 2004 });
  expect(summary.pairedElapsedReduction).toHaveLength(5);
  expect(summary.decision).toBe('adopt-measured-improvement');
  runs[1].performance.passed = false;
  expect(summarizeBuildRuns(runs).decision).toBe('reject-budget-exceeded');
  expect(summarizeBuildRuns(runs.slice(0, 8)).decision).toBe('incomplete');
});

it('retains a failed child receipt and preserves interrupted outputs when resuming', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-benchmark-smoke-'));
  try {
    for (const variant of ['baseline', 'candidate']) {
      const source = join(root, variant);
      await mkdir(join(source, 'apps/batch/src'), { recursive: true });
      await mkdir(join(source, '.tools'));
      await writeFile(join(source, '.tools/pmtiles'), 'unused smoke fixture');
      await writeFile(join(source, 'apps/batch/src/cli.ts'), 'console.error("intentional smoke failure"); process.exitCode = 1;');
      await symlink(resolve('node_modules'), join(source, 'node_modules'), 'dir');
    }
    const args = ['--import', 'tsx', fileURLToPath(new URL('./benchmark-builds.ts', import.meta.url)), '--baseline-source', join(root, 'baseline'), '--candidate-source', join(root, 'candidate'), '--cache-dir', join(root, 'cache'), '--cycle', '2026-10-30T00:00:00Z', '--out', join(root, 'runs')];
    expect(() => execFileSync(process.execPath, args, { stdio: 'pipe', timeout: 10_000 })).toThrow();
    const receipt = JSON.parse(await readFile(join(root, 'runs/receipt.json'), 'utf8'));
    expect(receipt).toMatchObject({ state: 'failed', runs: [] });
    expect(receipt.error).toContain('baseline repetition 1 exited 1');
    expect(() => execFileSync(process.execPath, [...args, '--resume'], { stdio: 'pipe', timeout: 10_000 })).toThrow();
    const paths = await readdir(join(root, 'runs'));
    expect(paths.some(path => path.startsWith('1-baseline.interrupted-'))).toBe(true);
    expect(paths.some(path => path.startsWith('1-baseline.log.interrupted-'))).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
