import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CELL_BYTES, STATUS_MASK, SUPPORT_MASK, manifestSchema, type Manifest } from '@av/contracts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function validateArtifactRecords(manifest: Manifest): void {
  invariant(manifest.frames.length === 8, `expected 8 frames, found ${manifest.frames.length}`);
  invariant(manifest.layers.length === 3, `expected 3 layers, found ${manifest.layers.length}`);
  invariant(manifest.artifacts.length === 24, `expected 24 artifact records, found ${manifest.artifacts.length}`);
  const frames = new Set(manifest.frames.map(frame => frame.id));
  const layers = new Set(manifest.layers);
  const combinations = new Set<string>();
  const paths = new Set<string>();
  const prefix = `builds/${manifest.model}/${manifest.buildId}`;
  for (const artifact of manifest.artifacts) {
    invariant(frames.has(artifact.frame), `unknown artifact frame ${artifact.frame}`);
    invariant(layers.has(artifact.layer), `unknown artifact layer ${artifact.layer}`);
    const combination = `${artifact.layer}/${artifact.frame}`;
    invariant(!combinations.has(combination), `duplicate artifact record ${combination}`);
    combinations.add(combination);
    invariant(artifact.tilesKey === `${prefix}/${artifact.layer}/${artifact.frame}.pmtiles`, `unexpected tilesKey ${artifact.tilesKey}`);
    invariant(artifact.samplesKey === `${prefix}/samples/${artifact.layer}/${artifact.frame}.bin`, `unexpected samplesKey ${artifact.samplesKey}`);
    for (const key of [artifact.tilesKey, artifact.samplesKey]) {
      invariant(!paths.has(key), `duplicate object path ${key}`);
      paths.add(key);
    }
  }
  invariant(combinations.size === 24, `expected 24 layer/frame records, found ${combinations.size}`);
  invariant(paths.size === 48, `expected 48 unique object paths, found ${paths.size}`);
  for (const frame of manifest.frames) for (const layer of manifest.layers) invariant(combinations.has(`${layer}/${frame.id}`), `missing artifact record ${layer}/${frame.id}`);
}

export function validateSampleFlags(bytes: Uint8Array, expectedLength: number, layer?: string): void {
  invariant(bytes.length === expectedLength, `samples length ${bytes.length}, expected ${expectedLength}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < bytes.length; offset += CELL_BYTES) {
    const flags = bytes[offset + 4]!, status = flags & STATUS_MASK;
    invariant(status <= 3, `invalid status bits at offset ${offset}`);
    invariant((flags & ~(STATUS_MASK | SUPPORT_MASK)) === 0, `invalid support bits at offset ${offset}`);
    invariant(layer !== 'precip-rate' || (status !== 1 && (flags & SUPPORT_MASK) === 0), `invalid precip-rate lift flags at offset ${offset}`);
    invariant(status !== 3 || flags === 3, `invalid outside-domain support bits at offset ${offset}`);
    invariant(status >= 2 || Number.isFinite(view.getFloat32(offset, true)), `non-finite sample value at offset ${offset}`);
  }
}

async function main(): Promise<void> {
  const manifestPath = resolve(arg('manifest') ?? (() => { throw new Error('--manifest is required'); })());
  const pmtilesBin = resolve(arg('pmtiles-bin') ?? join(process.cwd(), '.tools', 'pmtiles'));
  invariant(existsSync(manifestPath), `manifest not found: ${manifestPath}`);
  invariant(existsSync(pmtilesBin), `pmtiles binary not found: ${pmtilesBin}; run pnpm tools:pmtiles`);

  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const root = dirname(dirname(dirname(dirname(manifestPath))));
  const expectedSamples = manifest.grid.width * manifest.grid.height * CELL_BYTES;
  validateArtifactRecords(manifest);

  for (const artifact of manifest.artifacts) {
    const tilesPath = join(root, artifact.tilesKey);
    const samplesPath = join(root, artifact.samplesKey);
    invariant(existsSync(tilesPath), `missing archive: ${artifact.tilesKey}`);
    invariant(existsSync(samplesPath), `missing samples: ${artifact.samplesKey}`);
    const tilesBytes = readFileSync(tilesPath);
    const samplesBytes = readFileSync(samplesPath);
    invariant(sha256(tilesBytes) === artifact.tilesSha256, `archive hash mismatch: ${artifact.tilesKey}`);
    invariant(sha256(samplesBytes) === artifact.samplesSha256, `samples hash mismatch: ${artifact.samplesKey}`);
    invariant(statSync(samplesPath).size === expectedSamples, `samples length ${samplesBytes.length}, expected ${expectedSamples}: ${artifact.samplesKey}`);
    validateSampleFlags(samplesBytes, expectedSamples, artifact.layer);
    execFileSync(pmtilesBin, ['verify', tilesPath], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  }

  console.log(`smoke-build: ok ${manifest.model} ${manifest.buildId} (${manifest.frames.length} frames, ${manifest.artifacts.length} artifact records, ${manifest.artifacts.length * 2} object paths)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`smoke-build: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
