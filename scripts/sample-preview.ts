import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { coverageDescriptorSchema, forecastObjects, getProvenanceReference, manifestSchema, modelPointerSchema, parseProvenance, validateArtifactRecords, type Manifest, type ModelPointer } from '@av/contracts';
import { readCoverage } from '../apps/batch/src/coverage.js';

export { validateArtifactRecords };
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const apiDir = join(root, 'apps', 'api');
const wranglerJs = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function invariant(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

export function buildLocalPointer(manifest: Manifest, manifestKey: string): ModelPointer {
  return modelPointerSchema.parse({ version: 1, model: manifest.model, latestBuildId: manifest.buildId, retained: [{ buildId: manifest.buildId, manifestKey, cycle: manifest.cycle, expiresAt: manifest.expiresAt }] });
}
export function shouldSeedAssets(markerExists: boolean, reseed: boolean): boolean { return reseed || !markerExists; }

export interface LocalPreviewStore {
  head(key: string): Promise<{ size: number; customMetadata?: Record<string, string> } | null>;
  put(key: string, bytes: Uint8Array, options: { httpMetadata: { contentType: string }; customMetadata: { sha256: string } }): Promise<unknown>;
  dispose(): Promise<void>;
}

/** One supported Wrangler proxy session, with remote bindings explicitly disabled. */
export async function openLocalPreviewStore(persistTo: string): Promise<LocalPreviewStore> {
  const { getPlatformProxy } = await import('wrangler');
  // Wrangler CLI adds /v3 to --persist-to; the public proxy API accepts that final path.
  const proxy = await getPlatformProxy<{ BUCKET: Omit<LocalPreviewStore, 'dispose'> }>({ configPath: join(apiDir, 'wrangler.jsonc'), persist: { path: join(persistTo, 'v3') }, remoteBindings: false, envFiles: [] });
  return { head: key => proxy.env.BUCKET.head(key), put: (key, bytes, options) => proxy.env.BUCKET.put(key, bytes, options), dispose: proxy.dispose };
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export interface PreviewOptions {
  manifestPath: string; persistTo?: string; port?: number; reseed?: boolean; fixture?: boolean; seedOnly?: boolean;
}

/** Validate every dependency before opening R2; publish the local pointer last. */
export async function seedLocalBuild(options: PreviewOptions, openStore = openLocalPreviewStore): Promise<{ manifest: Manifest; manifestPath: string; persistTo: string; uploadedObjects: number; reusedObjects: number }> {
  const manifestPath = resolve(options.manifestPath), persistTo = resolve(options.persistTo ?? join(root, '.wrangler', options.fixture ? 'fixture-state' : 'state'));
  const manifestBytes = await readFile(manifestPath), manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  invariant(Date.parse(manifest.expiresAt) > Date.now(), 'Build has expired; regenerate it before previewing');
  validateArtifactRecords(manifest);
  const outputRoot = dirname(dirname(dirname(dirname(manifestPath))));
  const manifestKey = `builds/${manifest.model}/${manifest.buildId}/manifest.json`;
  invariant(join(outputRoot, manifestKey) === manifestPath, 'Manifest path must match output/builds/{model}/{buildId}/manifest.json');
  const manifestSha = sha256(manifestBytes), coverageDir = `coverage/${manifest.coverage.hash}`;
  const mask = await readCoverage(outputRoot, manifest.coverage.hash);
  const coverageBytes = await readFile(join(outputRoot, manifest.coverage.maskKey));
  const coverage = coverageDescriptorSchema.parse(JSON.parse(coverageBytes.toString('utf8')));
  invariant(coverage.id === manifest.coverage.id && coverage.maxZoom === manifest.coverage.maxZoom && JSON.stringify(mask.grid) === JSON.stringify(manifest.grid), 'Coverage descriptor does not match manifest');
  const provenance = getProvenanceReference(manifest), provenanceBytes = await readFile(join(outputRoot, provenance.key));
  invariant(sha256(provenanceBytes) === provenance.sha256, `Provenance hash mismatch: ${provenance.key}`);
  parseProvenance(JSON.parse(provenanceBytes.toString('utf8')), manifest);
  const dependencies = [
    ...(['output', 'halo', 'tiles'] as const).map(name => ({ key: `${coverageDir}/${name}.bin`, sha256: coverage.files[name].sha256, contentType: 'application/octet-stream' })),
    { key: manifest.coverage.maskKey, sha256: manifest.coverage.hash, contentType: 'application/json' },
    { ...provenance, contentType: 'application/json' },
    ...forecastObjects(manifest)
  ];
  const objects = [];
  for (const object of dependencies) {
    const file = join(outputRoot, object.key), info = await stat(file);
    invariant(info.isFile() && info.size > 0, `Missing local artifact: ${object.key}`);
    invariant(await fileHash(file) === object.sha256, `Artifact hash mismatch: ${object.key}`);
    objects.push({ ...object, file, size: info.size });
  }
  const markerDir = join(persistTo, '.sample-preview'), marker = join(markerDir, `${manifest.buildId}-${manifestSha.slice(0, 16)}.json`);
  const markerExists = await stat(marker).then(() => true, () => false);
  const force = shouldSeedAssets(markerExists, options.reseed ?? false);
  let uploadedObjects = 0, reusedObjects = 0;
  const store = await openStore(persistTo);
  try {
    const put = async (key: string, bytes: Uint8Array, contentType: string, hash: string): Promise<void> => {
      invariant(sha256(bytes) === hash, `Local object changed after verification: ${key}`);
      await store.put(key, bytes, { httpMetadata: { contentType }, customMetadata: { sha256: hash } }); uploadedObjects++;
    };
    for (const object of objects) {
      const existing = force ? null : await store.head(object.key);
      if (existing?.size === object.size && existing.customMetadata?.sha256 === object.sha256) { reusedObjects++; continue; }
      // Sequential uploads keep memory to one local artifact plus the runtime transport.
      await put(object.key, await readFile(object.file), object.contentType, object.sha256);
    }
    const existingManifest = force ? null : await store.head(manifestKey);
    if (existingManifest?.size === manifestBytes.length && existingManifest.customMetadata?.sha256 === manifestSha) reusedObjects++;
    else await put(manifestKey, manifestBytes, 'application/json', manifestSha);
    const pointerBytes = Buffer.from(JSON.stringify(buildLocalPointer(manifest, manifestKey)));
    await put(`catalog/${manifest.model}/latest.json`, pointerBytes, 'application/json', sha256(pointerBytes));
    await mkdir(markerDir, { recursive: true });
    await writeFile(marker, JSON.stringify({ buildId: manifest.buildId, manifestSha, objects: objects.length }));
  } finally { await store.dispose(); }
  return { manifest, manifestPath, persistTo, uploadedObjects, reusedObjects };
}

export async function previewBuild(options: PreviewOptions): Promise<void> {
  const expectedNode = (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { engines: { node: string } }).engines.node;
  invariant(process.versions.node === expectedNode, `Use the pinned workspace runtime: pnpm sample-preview (expected Node ${expectedNode})`);
  const port = options.port ?? 8787;
  invariant(Number.isInteger(port) && port >= 1 && port <= 65535, '--port must be an integer between 1 and 65535');
  const seeded = await seedLocalBuild(options);
  console.log(`sample-preview: ${seeded.uploadedObjects} local objects written, ${seeded.reusedObjects} reused; selected ${seeded.manifest.buildId}`);
  if (options.seedOnly) return;
  const args = [wranglerJs, 'dev', ...(options.fixture ? [join(apiDir, 'test', 'fixture-worker.ts')] : []), '--local', '--var', 'AV_LOCAL_DEVELOPMENT:true', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', seeded.persistTo, '--log-level', 'info', '--show-interactive-dev-session=false'];
  console.log(`sample-preview: serving http://127.0.0.1:${port} from ${seeded.persistTo}`);
  const child = spawn(process.execPath, args, { cwd: apiDir, stdio: 'inherit', detached: process.platform !== 'win32' });
  const forward = (signal: NodeJS.Signals): void => {
    if (child.exitCode === null) {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch { child.kill(signal); }
    }
  };
  const onInt = (): void => forward('SIGINT'), onTerm = (): void => forward('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  try {
    await new Promise<void>((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); done(); });
    });
  } finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const manifestPath = arg('manifest');
  (async () => {
    invariant(manifestPath, '--manifest is required');
    await previewBuild({ manifestPath, port: Number(arg('port') ?? 8787), persistTo: arg('persist-to'), reseed: process.argv.includes('--reseed'), fixture: process.argv.includes('--fixture'), seedOnly: process.argv.includes('--seed-only') });
  })().catch(error => { console.error(`sample-preview: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
