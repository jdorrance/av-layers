import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { forecastObjects, getProvenanceReference, manifestSchema, modelPointerSchema, parseProvenance, validateArtifactRecords, type Manifest, type ModelPointer } from '@av/contracts';

export { validateArtifactRecords };

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const apiDir = join(root, 'apps', 'api');
const wranglerJs = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildLocalPointer(manifest: Manifest, manifestKey: string): ModelPointer {
  return modelPointerSchema.parse({
    version: 1,
    model: manifest.model,
    latestBuildId: manifest.buildId,
    retained: [{ buildId: manifest.buildId, manifestKey, cycle: manifest.cycle, expiresAt: manifest.expiresAt }]
  });
}

export function shouldSeedAssets(markerExists: boolean, reseed: boolean): boolean {
  return reseed || !markerExists;
}

function node22(): string {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) return process.execPath;
  const result = spawnSync('npx', ['--yes', '--package=node@22.23.4', 'node', '-p', 'process.execPath'], { encoding: 'utf8' });
  invariant(result.status === 0 && result.stdout.trim(), 'Node 22 is required; npx could not resolve node@22.23.4');
  return result.stdout.trim();
}

function putObject(node: string, bucket: string, key: string, file: string, contentType: string, persistTo: string): void {
  const result = spawnSync(node, [wranglerJs, 'r2', 'object', 'put', `${bucket}/${key}`, '--file', file, '--content-type', contentType, '--local', '--persist-to', persistTo], { cwd: apiDir, stdio: 'inherit', timeout: 120_000 });
  if (result.error) throw result.error;
  invariant(result.status === 0, `local R2 upload failed for ${key}`);
}

async function main(): Promise<void> {
  const manifestPath = resolve(arg('manifest') ?? (() => { throw new Error('--manifest is required'); })());
  const port = Number(arg('port') ?? '8787');
  const persistTo = resolve(arg('persist-to') ?? join(root, '.wrangler', 'state'));
  const reseed = process.argv.includes('--reseed');

  invariant(Number.isInteger(port) && port >= 1 && port <= 65535, '--port must be an integer between 1 and 65535');
  invariant(existsSync(manifestPath), `manifest not found: ${manifestPath}`);
  invariant(existsSync(wranglerJs), 'wrangler is not installed; run pnpm install');

  const manifestBytes = readFileSync(manifestPath);
  const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  invariant(Date.parse(manifest.expiresAt) > Date.now(), 'the real build has expired; rebuild it before previewing');
  validateArtifactRecords(manifest);

  const parts = manifestPath.split(/[\\/]/);
  const buildsIndex = parts.lastIndexOf('builds');
  invariant(buildsIndex >= 0 && parts[buildsIndex + 1] === manifest.model && parts[buildsIndex + 2] === manifest.buildId, 'manifest path must match output/builds/{model}/{buildId}/manifest.json');
  const outputRoot = parts.slice(0, buildsIndex).join('/') || '/';
  const manifestKey = `builds/${manifest.model}/${manifest.buildId}/manifest.json`;
  const pointerKey = `catalog/${manifest.model}/latest.json`;
  const manifestSha = sha256(manifestBytes);
  const provenance = getProvenanceReference(manifest);
  if (provenance) {
    const bytes = readFileSync(join(outputRoot, provenance.key));
    invariant(sha256(bytes) === provenance.sha256, `provenance hash mismatch: ${provenance.key}`);
    parseProvenance(JSON.parse(bytes.toString('utf8')), manifest);
  }

  const config = JSON.parse(readFileSync(join(apiDir, 'wrangler.jsonc'), 'utf8'));
  const bucket = config.r2_buckets?.[0]?.bucket_name;
  invariant(typeof bucket === 'string' && bucket, 'apps/api/wrangler.jsonc must bind one private R2 bucket');

  for (const { key } of forecastObjects(manifest)) {
    const file = join(outputRoot, key);
    invariant(existsSync(file) && statSync(file).size > 0, `missing real artifact: ${key}`);
  }

  const node = node22();
  const markerDir = join(persistTo, '.sample-preview');
  const marker = join(markerDir, `${manifest.buildId}-${manifestSha.slice(0, 16)}.json`);
  mkdirSync(markerDir, { recursive: true });

  // Seed provenance independently of the immutable forecast payloads.
  if (provenance) putObject(node, bucket, provenance.key, join(outputRoot, provenance.key), 'application/json', persistTo);
  if (shouldSeedAssets(existsSync(marker), reseed)) {
    for (const { key, contentType } of forecastObjects(manifest)) {
      putObject(node, bucket, key, join(outputRoot, key), contentType, persistTo);
    }
    putObject(node, bucket, manifestKey, manifestPath, 'application/json', persistTo);
    writeFileSync(marker, JSON.stringify({ bucket, buildId: manifest.buildId, manifestSha, artifacts: manifest.artifacts.length }));
    console.log(`sample-preview: seeded real build ${manifest.buildId} into ${persistTo}`);
  } else {
    console.log(`sample-preview: real build ${manifest.buildId} assets already seeded`);
  }

  const pointer = buildLocalPointer(manifest, manifestKey);
  const pointerPath = join(markerDir, `pointer-${manifest.buildId}.json`);
  writeFileSync(pointerPath, JSON.stringify(pointer));
  putObject(node, bucket, pointerKey, pointerPath, 'application/json', persistTo);
  console.log(`sample-preview: local latest pointer now selects ${manifest.buildId}`);

  const args = [wranglerJs, 'dev', '--local', '--var', 'AV_LOCAL_DEVELOPMENT:true', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persistTo, '--log-level', 'info', '--show-interactive-dev-session=false'];
  console.log(`sample-preview: serving http://127.0.0.1:${port} from ${persistTo}`);
  const child = spawn(node, args, { cwd: apiDir, stdio: 'inherit', detached: process.platform !== 'win32' });

  const forward = (signal: NodeJS.Signals): void => {
    if (child.exitCode === null) {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    }
  };
  const onInt = (): void => forward('SIGINT');
  const onTerm = (): void => forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

  await new Promise<void>((resolveExit, rejectExit) => {
    child.on('error', rejectExit);
    child.on('close', (code, signal) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      if (signal) console.error(`sample-preview: wrangler stopped by ${signal}`);
      process.exitCode = code ?? (signal ? 1 : 0);
      resolveExit();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`sample-preview: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
