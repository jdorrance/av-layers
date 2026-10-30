import { execFile } from 'node:child_process';
import { appendFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { buildSample } from '../apps/batch/src/build.js';
import { checkPerformance } from '../apps/batch/src/capacity.js';
import { publish } from '../apps/batch/src/publication.js';
import { r2Storage } from '../apps/batch/src/storage.js';

/** CI keeps the validated build in one process; manual publication still performs full validation. */
export async function buildAndPublish(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY, revision = process.env.GITHUB_SHA;
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main' || !repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !revision || !/^[a-f0-9]{40}$/.test(revision) || process.env.MODEL !== 'gfs') {
    throw new Error('This entry point requires the forecast workflow on main');
  }
  const out = 'output';
  await buildSample({
    out,
    cycle: process.env.CYCLE || undefined,
    cacheDir: '.cache/gfs',
    onValidated: async (manifest, path) => {
      if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `MANIFEST=${path}\n`);
      const budget = checkPerformance(manifest);
      await writeFile(join(dirname(path), 'performance.json'), JSON.stringify(budget, null, 2));
      if (!budget.passed) throw new Error(`Performance budget failed: ${budget.failures.join('; ')}`);
      const { stdout } = await promisify(execFile)('gh', ['api', `repos/${repository}/git/ref/heads/main`, '--jq', '.object.sha']);
      if (stdout.trim() !== revision) throw new Error('This revision was superseded during the build; rerun the latest revision before publishing');
      const started = Date.now();
      await publish(r2Storage(), out, manifest);
      await writeFile(join(dirname(path), 'publication.json'), JSON.stringify({
        version: 1,
        buildId: manifest.buildId,
        elapsedMs: Date.now() - started,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
        validationReused: true
      }, null, 2));
      console.log(`Published ${manifest.buildId}`);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildAndPublish().catch(error => { console.error(error); process.exitCode = 1; });
}
