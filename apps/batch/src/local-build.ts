import { dirname, resolve } from 'node:path';
import { getProduct } from '@av/contracts/models';
import { manifestV5Schema, MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS, parseBoundedJson, type ProductDefinition } from '@av/contracts';
import { loadCoverage, readSparseCoverage } from './coverage.js';
import { readLocalFile } from './local-file.js';
import { localPath, validateBuild } from './validate.js';
import { denseCoverageMask } from './whole-domain/prepare.js';
import type { ObjectStorage } from './storage.js';

/** Read the bounded immutable manifest from its declared build tree. */
async function readLocalManifest(manifestPath: string) {
  const path = resolve(manifestPath), root = resolve(dirname(path), '../../..');
  const bytes = await readLocalFile(path, MAX_MANIFEST_BYTES);
  const manifest = manifestV5Schema.parse(parseBoundedJson(bytes, MAX_MANIFEST_JSON_TOKENS));
  if (localPath(root, `builds/${manifest.model}/${manifest.buildId}/manifest.json`) !== path) throw new Error('Manifest path differs from its declared build identity');
  return { root, manifest, bytes };
}

export async function validateLocalBuild(manifestPath: string, trustedProduct?: ProductDefinition, remote?: { store: ObjectStorage; signal?: AbortSignal }) {
  const { root, manifest, bytes } = await readLocalManifest(manifestPath);
  const product = trustedProduct ?? getProduct(manifest.model);
  if (!product || product.modelId !== manifest.model || manifest.recipe.id !== product.id) throw new Error('Unsupported local build recipe or model');
  const objects = remote ? await (await import('./parallel.js')).verifyBuildReceipts(root, manifest, remote.store, remote.signal) : undefined;
  const native = trustedProduct && manifest.surfaces.find(surface => surface.kind === 'native');
  const mask = native ? denseCoverageMask((await readSparseCoverage(root, native.coverage.hash)).mask) : await loadCoverage(product);
  const validated = await validateBuild(root, manifest, mask, product, remote && objects ? { ...remote, objects } : undefined);
  return { root, manifest: validated.manifest, validated, bytes };
}
