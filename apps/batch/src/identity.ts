import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createProductDescriptors, createRecipeIdentity, PRODUCTS, type ProductDefinition } from '@av/contracts';
import { preparedTerrainRefSchema, type PreparedTerrainRef } from './terrain/prepare.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const digest = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

export async function readProducerSourceState(root = ROOT): Promise<{ revision: string; dirty: boolean }> {
  const git = promisify(execFile);
  const [{ stdout: revision }, { stdout: dirty }] = await Promise.all([
    git('git', ['rev-parse', 'HEAD'], { cwd: root }),
    git(
      'git',
      [
        'status',
        '--porcelain',
        '--untracked-files=normal',
        '--',
        'apps/batch',
        'packages/forecast',
        'packages/soaring',
        'packages/solar',
        'packages/thermodynamics',
        'packages/contracts',
        'scripts',
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'tsconfig.json'
      ],
      { cwd: root }
    )
  ]);
  return { revision: revision.trim(), dirty: !!dirty.trim() };
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [join(directory, entry.name)] : []))).flat().sort();
}
/** Content identity includes actual files, even in a dirty local checkout; Git SHA alone is not a recipe. */
export async function buildIdentity(product: ProductDefinition, coverageHash: string, terrain?: PreparedTerrainRef) {
  const contractConfigSettings = [...new Set(PRODUCTS.map(p => p.configPath))].sort();
  const groups = {
    adapter: { directories: ['apps/batch/src'], settings: ['apps/batch/pmtiles.json'] },
    science: {
      directories: [
        'packages/forecast/src',
        'packages/soaring/src',
        'packages/solar/src',
        'packages/thermodynamics/src'
      ],
      settings: []
    },
    contracts: { directories: ['packages/contracts/src'], settings: contractConfigSettings }
  };
  const components: Record<string, string> = {};
  for (const [group, { directories, settings }] of Object.entries(groups)) {
    const hash = createHash('sha256');
    const files = [...(await Promise.all(directories.map(dir => sourceFiles(join(ROOT, dir))))).flat(), ...settings.map(path => join(ROOT, path))].filter(path => {
      if (group !== 'contracts') return true;
      const name = basename(path);
      return name !== 'client.ts' && !name.startsWith('client-') && name !== 'fixture-product.ts';
    }).sort();
    for (const path of files) hash.update(relative(ROOT, path)).update('\0').update(await readFile(path)).update('\0');
    components[group] = hash.digest('hex');
  }
  const lockHash = digest(await readFile(join(ROOT, 'pnpm-lock.yaml')));
  const configurationHash = digest(JSON.stringify({ product, coverageHash, ...(terrain ? { terrain: preparedTerrainRefSchema.parse(terrain) } : {}) }));
  const hash = digest(JSON.stringify({ components, lockHash, configurationHash }));
  const { revision, dirty } = await readProducerSourceState();
  const scienceHash = digest(JSON.stringify({ source: components.science, methods: createProductDescriptors(product).methods }));
  return { recipe: createRecipeIdentity(product, hash, revision, dirty, lockHash), components: { ...components, configuration: configurationHash }, scienceHash };
}
