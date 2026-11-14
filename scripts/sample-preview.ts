import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { storedModelPointerSchema, type ManifestV5, type StoredModelPointer, type ProductDefinition } from '@av/contracts';
import { readSparseCoverage } from '../apps/batch/src/coverage.js';
import { OFFLINE_PRODUCT } from '@av/contracts/fixture-product';
import { readLocalProvenance } from '../apps/batch/src/frame-provenance.js';
import { readLocalFile } from '../apps/batch/src/local-file.js';
import { BUILD_BUDGETS } from '../apps/batch/src/capacity.js';
import { PREPARED_DESCRIPTOR_MAX_BYTES } from '../apps/batch/src/terrain/prepare.js';
import { fileSha256 } from '../apps/batch/src/validate.js';
import { validateLocalBuild } from '../apps/batch/src/local-build.js';
import { forecastObjects, provenanceObjects } from '../apps/batch/src/publication-objects.js';
import { localWindData } from '../apps/batch/src/wind-data.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const apiDir = join(root, 'apps', 'api');
const wranglerJs = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function invariant(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

function buildLocalPointer(manifest: ManifestV5, manifestKey: string, mapData?: { bytes: number; sha256: string }): StoredModelPointer {
  return storedModelPointerSchema.parse({ version: 1, model: manifest.model, latestBuildId: manifest.buildId, retained: [{ buildId: manifest.buildId, manifestKey, cycle: manifest.cycle, expiresAt: manifest.expiresAt, ...(mapData ? { mapData } : {}) }] });
}

export interface LocalPreviewStore {
  head(key: string): Promise<{ size: number; customMetadata?: Record<string, string> } | null>;
  put(key: string, bytes: Uint8Array, options: { httpMetadata: { contentType: string }; customMetadata: { sha256: string } }): Promise<unknown>;
  dispose(): Promise<void>;
}

/** One supported Wrangler proxy session, with remote bindings explicitly disabled. */
export async function openLocalPreviewStore(persistTo: string): Promise<LocalPreviewStore> {
  const { getPlatformProxy } = await import('wrangler');
  // Wrangler CLI adds /v3 to --persist-to; the public proxy API accepts that final path.
  const proxy = await getPlatformProxy<{ BUCKET: Omit<LocalPreviewStore, 'dispose'> }>({ configPath: join(apiDir, 'wrangler.json'), persist: { path: join(persistTo, 'v3') }, remoteBindings: false, envFiles: [] });
  return { head: key => proxy.env.BUCKET.head(key), put: (key, bytes, options) => proxy.env.BUCKET.put(key, bytes, options), dispose: proxy.dispose };
}

interface ObjectDependency { key: string; sha256: string; contentType: string }

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

async function terrainDependencies(outputRoot: string, surface: ManifestV5['surfaces'][number]): Promise<ObjectDependency[]> {
  const terrain = surface.terrain;
  if (!terrain) return [];
  const bytes = await readLocalFile(join(outputRoot, terrain.key), PREPARED_DESCRIPTOR_MAX_BYTES);
  invariant(sha256(bytes) === terrain.sha256, `Terrain manifest hash mismatch: ${terrain.key}`);
  const files = record(record(JSON.parse(bytes.toString('utf8')), 'Terrain descriptor').files, 'Terrain files');
  const dependencies: ObjectDependency[] = [{ key: terrain.key, sha256: terrain.sha256, contentType: 'application/json' }];
  for (const name of ['elevationM', 'valid'] as const) {
    const assets = files[name];
    invariant(Array.isArray(assets) && assets.length > 0, `Terrain ${name} assets are missing`);
    for (const value of assets) {
      const asset = record(value, `Terrain ${name} asset`);
      invariant(typeof asset.key === 'string' && typeof asset.sha256 === 'string' && Number.isSafeInteger(asset.bytes) && (asset.bytes as number) > 0, `Invalid terrain ${name} asset`);
      dependencies.push({ key: asset.key, sha256: asset.sha256, contentType: 'application/octet-stream' });
    }
  }
  return dependencies;
}

async function previewDependencies(outputRoot: string, manifest: ManifestV5): Promise<ObjectDependency[]> {
  const dependencies: ObjectDependency[] = [];
  const coverages = new Set<string>();
  for (const surface of manifest.surfaces) {
    if (!coverages.has(surface.coverage.hash)) {
      coverages.add(surface.coverage.hash);
      const { descriptor } = await readSparseCoverage(outputRoot, surface.coverage.hash), prefix = `coverage/${surface.coverage.hash}`;
      invariant(surface.coverage.maskKey === `${prefix}/manifest.json`, `Surface coverage path differs: ${surface.coverage.maskKey}`);
      dependencies.push({ key: surface.coverage.maskKey, sha256: surface.coverage.hash, contentType: 'application/json' });
      for (const name of ['sparse', 'tiles'] as const) dependencies.push({ key: `${prefix}/${name}.bin`, sha256: descriptor.files[name].sha256, contentType: 'application/octet-stream' });
    }
    dependencies.push(...await terrainDependencies(outputRoot, surface));
  }
  return dependencies;
}

export interface PreviewOptions {
  manifestPath: string; persistTo?: string; port?: number; reseed?: boolean; fixture?: boolean; seedOnly?: boolean; trustedProduct?: ProductDefinition;
}

export async function seedLocalBuild(options: PreviewOptions, openStore = openLocalPreviewStore) {
  const manifestPath = resolve(options.manifestPath), persistTo = resolve(options.persistTo ?? join(root, '.wrangler', options.fixture ? 'fixture-state' : 'state'));
  const product = options.trustedProduct ?? (options.fixture ? OFFLINE_PRODUCT : undefined);
  const { bytes: manifestBytes, root: outputRoot, manifest } = await validateLocalBuild(manifestPath, product);
  invariant(manifest.version === 5, 'Local preview requires a v5 build');
  invariant(Date.parse(manifest.expiresAt) > Date.now(), 'Build has expired; regenerate it before previewing');
  const manifestKey = `builds/${manifest.model}/${manifest.buildId}/manifest.json`;
  invariant(join(outputRoot, manifestKey) === manifestPath, 'Manifest path must match output/builds/{model}/{buildId}/manifest.json');
  const manifestSha = sha256(manifestBytes), dependencies = await previewDependencies(outputRoot, manifest);
  const numeric = await localWindData(outputRoot, manifest);
  if (numeric) dependencies.push(...numeric.objects);
  const { reference, value: index } = await readLocalProvenance(outputRoot, manifest);
  dependencies.push({ ...reference, contentType: 'application/json' }, ...provenanceObjects(index), ...forecastObjects(manifest));
  const objects = [];
  for (const object of dependencies) {
    const file = join(outputRoot, object.key), info = await stat(file);
    invariant(info.isFile() && info.size > 0 && info.size <= BUILD_BUDGETS.samplePackBytes, `Missing local artifact: ${object.key}`);
    invariant(await fileSha256(file, info.size) === object.sha256, `Artifact hash mismatch: ${object.key}`);
    objects.push({ ...object, file, size: info.size });
  }
  const markerDir = join(persistTo, '.sample-preview'), marker = join(markerDir, `${manifest.buildId}-${manifestSha.slice(0, 16)}.json`);
  const markerExists = await stat(marker).then(() => true, () => false);
  const force = options.reseed || !markerExists;
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
      await put(object.key, await readLocalFile(object.file, object.size, object.size), object.contentType, object.sha256);
    }
    const existingManifest = force ? null : await store.head(manifestKey);
    if (existingManifest?.size === manifestBytes.length && existingManifest.customMetadata?.sha256 === manifestSha) reusedObjects++;
    else await put(manifestKey, manifestBytes, 'application/json', manifestSha);
    const pointerBytes = Buffer.from(JSON.stringify(buildLocalPointer(manifest, manifestKey, numeric?.reference)));
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
  const api = spawn(process.execPath, args, { cwd: apiDir, stdio: 'inherit', detached: process.platform !== 'win32' });
  const children = [api];
  const completion = (child: typeof api) => new Promise<number>((done, reject) => {
    child.once('error', reject);
    child.once('close', code => done(code ?? 0));
  });
  const completed = [completion(api)];
  const startup = new AbortController();
  const forward = (signal: NodeJS.Signals): void => {
    for (const child of children) {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch { child.kill(signal); }
    }
  };
  const onInt = (): void => { startup.abort(); forward('SIGINT'); }, onTerm = (): void => { startup.abort(); forward('SIGTERM'); };
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  try {
    // Start the browser app only after its API is ready.
    const ready = async () => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        startup.signal.throwIfAborted();
        try {
          const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.any([startup.signal, AbortSignal.timeout(500)]) });
          await response.body?.cancel();
          if (response.ok) return;
        } catch { /* The local listener is still starting. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Local API did not start within 15 seconds');
    };
    await Promise.race([ready(), completed[0].then(() => { throw new Error('Local API stopped before startup completed'); })]);
    const previewDir = join(root, 'apps', 'preview');
    const web = spawn(process.execPath, [join(previewDir, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1'], {
      cwd: previewDir, stdio: 'inherit', detached: process.platform !== 'win32',
      env: { ...process.env, AV_API_BASE: `http://127.0.0.1:${port}`, VITE_MODEL: seeded.manifest.model, VITE_OFFLINE_FIXTURE: String(options.fixture ?? false), VITE_BUILD_REVISION: 'development' }
    });
    children.push(web); completed.push(completion(web));
    process.exitCode = await Promise.race(completed);
  } finally {
    startup.abort();
    forward('SIGTERM');
    const force = setTimeout(() => forward('SIGKILL'), 5000).unref();
    await Promise.allSettled(completed);
    clearTimeout(force);
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const { values } = parseArgs({ strict: true, allowPositionals: false, options: { manifest: { type: 'string' }, 'persist-to': { type: 'string' }, port: { type: 'string' }, fixture: { type: 'boolean' }, 'seed-only': { type: 'boolean' }, reseed: { type: 'boolean' } } });
    const manifestPath = values.manifest;
    invariant(manifestPath, '--manifest is required');
    await previewBuild({ manifestPath, port: Number(values.port ?? 8787), persistTo: values['persist-to'], reseed: values.reseed, fixture: values.fixture, seedOnly: values['seed-only'] });
  })().catch(error => { console.error(`sample-preview: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
