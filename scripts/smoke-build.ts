import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CELL_BYTES, manifestSchema, validateArtifactRecords, validateSampleFlags } from '@av/contracts';

export { validateArtifactRecords, validateSampleFlags };

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
