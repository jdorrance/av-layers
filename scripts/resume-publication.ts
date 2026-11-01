import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getProduct, manifestSchema, MAX_MANIFEST_BYTES, parseBoundedJson } from '@av/contracts';
import { buildIdentity } from '../apps/batch/src/identity.js';
import { readLocalFile } from '../apps/batch/src/local-file.js';
import { publicationWorkflow } from './publication-workflow.js';

/** Revalidate an existing artifact under the same authority, without repeating acquisition or science. */
export async function resumePublication(): Promise<void> {
  await publicationWorkflow(async ({ root, signal, commit }) => {
    const runId = process.env.RESUME_RUN_ID;
    if (!/^\d+$/.test(runId ?? '')) throw new Error('Invalid resume workflow identity');
    const builds = await readdir(join(root, 'builds', 'gfs'), { withFileTypes: true });
    if (builds.length !== 1 || !builds[0].isDirectory() || !/^\d{8}T\d{6}Z-[a-f0-9-]{36}$/.test(builds[0].name)) throw new Error('Resume artifact must contain exactly one build');
    const path = join(root, 'builds', 'gfs', builds[0].name, 'manifest.json');
    const manifest = manifestSchema.parse(parseBoundedJson(await readLocalFile(path, MAX_MANIFEST_BYTES)));
    if (manifest.model !== 'gfs' || manifest.buildId !== builds[0].name) throw new Error('Resume manifest differs from its artifact path');
    if (!/^[a-f0-9]{40}$/.test(process.env.SOURCE_BUILD_REVISION ?? '') || manifest.recipe.sourceRevision !== process.env.SOURCE_BUILD_REVISION || manifest.recipe.sourceDirty) throw new Error('Resume source does not match the verified workflow artifact');
    const product = getProduct(manifest.model);
    if (!product || manifest.recipe.hash !== (await buildIdentity(product, manifest.coverage.hash)).recipe.hash) throw new Error('Resume recipe differs from current code/configuration; build a fresh forecast');
    signal.throwIfAborted();
    await commit(manifest, path, runId);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  resumePublication().catch(error => { console.error(error); process.exitCode = 1; });
}
