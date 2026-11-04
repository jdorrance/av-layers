import { dirname, resolve } from 'node:path';
import { getProduct, publishedManifestSchema, MAX_MANIFEST_BYTES, parseBoundedJson, type ProductDefinition } from '@av/contracts';
import { loadCoverage, readCoverage } from './coverage.js';
import { readLocalFile } from './local-file.js';
import { localPath, validateBuild } from './validate.js';
import type { ObjectStorage } from './storage.js';

/** Read the bounded immutable manifest from its declared build tree. */
export async function readLocalManifest(manifestPath: string) {
  const path = resolve(manifestPath), root = resolve(dirname(path), '../../..');
  const manifest = publishedManifestSchema.parse(parseBoundedJson(await readLocalFile(path, MAX_MANIFEST_BYTES)));
  if (localPath(root, `builds/${manifest.model}/${manifest.buildId}/manifest.json`) !== path) throw new Error('Manifest path differs from its declared build identity');
  return { root, manifest };
}

export async function validateLocalBuild(manifestPath: string, trustedProduct?: ProductDefinition, remote?: { store: ObjectStorage; signal?: AbortSignal }) {
  const { root, manifest } = await readLocalManifest(manifestPath);
  const product = trustedProduct ?? getProduct(manifest.model);
  if (!product || product.modelId !== manifest.model || manifest.recipe.id !== product.id) throw new Error('Unsupported local build recipe or model');
  if (manifest.version === 5) {
    const objects = remote ? await (await import('./parallel.js')).verifyBuildReceipts(root, manifest, remote.store, remote.signal) : undefined;
    const validated = await validateBuild(root, manifest, await loadCoverage(product), undefined, product, remote && objects ? { ...remote, objects } : undefined);
    return { root, manifest: validated.manifest, validated };
  }
  if (remote) throw new Error('Receipt validation requires a v5 manifest');
  const validated = await validateBuild(root, manifest, await readCoverage(root, manifest.coverage.hash), manifest.coverage.hash, product);
  return { root, manifest: validated.manifest, validated };
}
