import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '1.31.2';
const RELEASE = `https://github.com/protomaps/go-pmtiles/releases/download/v${VERSION}`;
const TARGETS = {
  'darwin-arm64': { asset: `go-pmtiles-${VERSION}_Darwin_arm64.zip`, sha256: '40528f7f616fcbf91207cd48c8fc023d213f6d86c0cbf1f748732803d1880f3d', extract: 'zip' },
  'darwin-x64': { asset: `go-pmtiles-${VERSION}_Darwin_x86_64.zip`, sha256: '1f0dc02eee6c58312dd6c509faee1b5c32f0596568af1bf51f1b034e7a88a65b', extract: 'zip' },
  'linux-x64': { asset: `go-pmtiles_${VERSION}_Linux_x86_64.tar.gz`, sha256: '3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f', extract: 'tar' },
  'linux-arm64': { asset: `go-pmtiles_${VERSION}_Linux_arm64.tar.gz`, sha256: 'f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1', extract: 'tar' }
};

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const toolsDir = join(root, '.tools');
const binaryPath = join(toolsDir, 'pmtiles');
const force = process.argv.includes('--force');

function fail(message) {
  console.error(`setup-pmtiles: ${message}`);
  process.exit(1);
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
  if (!output.includes(VERSION)) fail(`installed binary reported "${output}", expected version ${VERSION}`);
  return output;
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) fail(`download failed ${response.status} ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) fail('downloaded archive is empty');
  return bytes;
}

function extract(archive, kind, destination) {
  if (kind === 'zip') {
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
  if (!force) {
    const current = installedVersion();
    if (current && current.includes(VERSION)) {
      console.log(`pmtiles ${VERSION} already installed at ${binaryPath}`);
      return;
    }
  }

  mkdirSync(toolsDir, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), 'pmtiles-setup-'));
  const archivePath = join(workDir, basename(spec.asset));
  const extractDir = join(workDir, 'extract');
  mkdirSync(extractDir);

  try {
    console.log(`downloading ${spec.asset}`);
    const bytes = await download(`${RELEASE}/${spec.asset}`);
    const actual = sha256(bytes);
    if (actual !== spec.sha256) fail(`checksum mismatch for ${spec.asset}: got ${actual}, expected ${spec.sha256}`);
    console.log(`checksum verified sha256:${actual}`);
    writeFileSync(archivePath, bytes);

    const candidate = extract(archivePath, spec.extract, extractDir);
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

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
