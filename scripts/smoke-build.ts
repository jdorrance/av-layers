import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { forecastObjects, validateArtifactRecords, validateSampleFlags } from '@av/contracts';
import { localPath } from '../apps/batch/src/validate.js';
import { validateLocalBuild } from '../apps/batch/src/local-build.js';

export { validateArtifactRecords, validateSampleFlags };

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const manifestPath = resolve(arg('manifest') ?? (() => { throw new Error('--manifest is required'); })());
  const pmtilesBin = resolve(arg('pmtiles-bin') ?? join(process.cwd(), '.tools', 'pmtiles'));
  invariant(existsSync(manifestPath), `manifest not found: ${manifestPath}`);
  invariant(existsSync(pmtilesBin), `pmtiles binary not found: ${pmtilesBin}; run pnpm tools:pmtiles`);

  const { root, manifest } = await validateLocalBuild(manifestPath);

  for (const artifact of manifest.artifacts) {
    const tilesPath = localPath(root, artifact.tilesKey);
    invariant(existsSync(tilesPath), `missing archive: ${artifact.tilesKey}`);
    execFileSync(pmtilesBin, ['verify', tilesPath], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  }

  console.log(`smoke-build: ok ${manifest.model} ${manifest.buildId} (${manifest.frames.length} frames, ${manifest.artifacts.length} artifact records, ${forecastObjects(manifest).length} object paths)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`smoke-build: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
