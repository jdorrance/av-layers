import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pmtiles from '../apps/batch/pmtiles.json' with { type: 'json' };

const { version: VERSION, targets: TARGETS } = pmtiles;
const RELEASE = `https://github.com/protomaps/go-pmtiles/releases/download/v${VERSION}`;

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const toolsDir = join(root, '.tools');
const binaryPath = join(toolsDir, 'pmtiles');
const force = process.argv.includes('--force');

function fail(message) {
  throw new Error(message);
}

function hostTarget() {
  const platform = process.platform;
  const arch = process.arch;
  if ((platform !== 'darwin' && platform !== 'linux') || (arch !== 'arm64' && arch !== 'x64')) {
    fail(`unsupported platform ${platform}-${arch}; pinned targets: ${Object.keys(TARGETS).join(', ')}`);
  }
  return `${platform}-${arch}`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function installedVersion() {
  if (!existsSync(binaryPath)) return null;
  try {
    return execFileSync(binaryPath, ['version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function verifyBinary(path) {
  chmodSync(path, 0o755);
  const output = execFileSync(path, ['version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (output.split(/[\s,]+/)[1] !== VERSION) fail(`installed binary reported "${output}", expected version ${VERSION}`);
  return output;
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) fail(`download failed ${response.status} ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) fail('downloaded archive is empty');
  return bytes;
}

function extract(archive, destination) {
  if (archive.endsWith('.zip')) {
    execFileSync('unzip', ['-q', '-o', archive, '-d', destination], { stdio: 'inherit', timeout: 120_000 });
  } else {
    execFileSync('tar', ['-xzf', archive, '-C', destination], { stdio: 'inherit', timeout: 120_000 });
  }
  const candidate = join(destination, 'pmtiles');
  if (!existsSync(candidate)) fail('archive does not contain a pmtiles binary at its root');
  return candidate;
}

async function main() {
  const target = hostTarget();
  const spec = TARGETS[target];
  const asset = spec.asset.replace('{version}', VERSION);
  if (!force) {
    const current = installedVersion();
    if (current?.split(/[\s,]+/)[1] === VERSION) {
      console.log(`pmtiles ${VERSION} already installed at ${binaryPath}`);
      return;
    }
  }

  mkdirSync(toolsDir, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), 'pmtiles-setup-'));
  const archivePath = join(workDir, basename(asset));
  const extractDir = join(workDir, 'extract');
  mkdirSync(extractDir);

  try {
    console.log(`downloading ${asset}`);
    const bytes = await download(`${RELEASE}/${asset}`);
    const actual = sha256(bytes);
    if (actual !== spec.sha256) fail(`checksum mismatch for ${asset}: got ${actual}, expected ${spec.sha256}`);
    console.log(`checksum verified sha256:${actual}`);
    writeFileSync(archivePath, bytes);

    const candidate = extract(archivePath, extractDir);
    if (!statSync(candidate).isFile()) fail('extracted pmtiles entry is not a regular file');
    const version = verifyBinary(candidate);
    console.log(`verified binary version ${version}`);

    copyFileSync(candidate, binaryPath);
    chmodSync(binaryPath, 0o755);
    verifyBinary(binaryPath);
    console.log(`installed pinned pmtiles ${VERSION} at ${binaryPath}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`setup-pmtiles: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
