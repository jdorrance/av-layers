import { pathToFileURL } from 'node:url';
import { buildSample } from '../apps/batch/src/build.js';
import { publicationWorkflow } from './publication-workflow.js';

/** The one writer workflow retains validation and owns exclusion through publication and cleanup. */
export async function buildAndPublish(): Promise<void> {
  await publicationWorkflow(async ({ root, signal, commit }) => {
    await buildSample({ out: root, signal, cycle: process.env.CYCLE || undefined, cacheDir: '.cache/gfs', onValidated: commit });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildAndPublish().catch(error => { console.error(error); process.exitCode = 1; });
}
