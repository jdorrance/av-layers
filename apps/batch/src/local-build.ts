import { dirname, resolve } from 'node:path';
import { manifestSchema, MAX_MANIFEST_BYTES, parseBoundedJson } from '@av/contracts';
import { readCoverage } from './coverage.js';
import { readLocalFile } from './local-file.js';
import { localPath, validateBuild } from './validate.js';

/** Read the bounded immutable manifest from its declared build tree. */
export async function readLocalManifest(manifestPath: string) {
  const path = resolve(manifestPath), root = resolve(dirname(path), '../../..');
  const manifest = manifestSchema.parse(parseBoundedJson(await readLocalFile(path, MAX_MANIFEST_BYTES)));
  if (localPath(root, `builds/${manifest.model}/${manifest.buildId}/manifest.json`) !== path) throw new Error('Manifest path differs from its declared build identity');
  return { root, manifest };
}

/** Operator validation resolves this build's actual local dependencies, never bundled coverage. */
export async function validateLocalBuild(manifestPath: string) {
  const { root, manifest } = await readLocalManifest(manifestPath);
  return { root, manifest: await validateBuild(root, manifest, await readCoverage(root, manifest.coverage.hash), manifest.coverage.hash) };
}
