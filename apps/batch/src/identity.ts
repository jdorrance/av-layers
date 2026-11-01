import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createProductDescriptors, createRecipeIdentity, type ProductDefinition } from '@av/contracts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const digest = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');
async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [join(directory, entry.name)] : []))).flat().sort();
}
/** Content identity includes actual files, even in a dirty local checkout; Git SHA alone is not a recipe. */
export async function buildIdentity(product: ProductDefinition, coverageHash: string) {
  const groups = { adapter: ['apps/batch/src/noaa', 'apps/batch/src'], science: ['packages/forecast/src'], contracts: ['packages/contracts/src'] };
  const components: Record<string, string> = {};
  for (const [group, directories] of Object.entries(groups)) {
    const hash = createHash('sha256');
    const files = [...new Set((await Promise.all(directories.map(dir => sourceFiles(join(ROOT, dir))))).flat())].sort();
    for (const path of files) hash.update(relative(ROOT, path)).update('\0').update(await readFile(path)).update('\0');
    components[group] = hash.digest('hex');
  }
  const lockHash = digest(await readFile(join(ROOT, 'pnpm-lock.yaml')));
  const configurationHash = digest(JSON.stringify({ product, coverageHash }));
  const hash = digest(JSON.stringify({ components, lockHash, configurationHash }));
  const git = promisify(execFile);
  const [{ stdout: revision }, { stdout: dirty }] = await Promise.all([
    git('git', ['rev-parse', 'HEAD'], { cwd: ROOT }),
    git('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: ROOT })
  ]);
  const scienceHash = digest(JSON.stringify({ source: components.science, methods: createProductDescriptors(product).methods }));
  return { recipe: createRecipeIdentity(product, hash, revision.trim(), !!dirty.trim(), lockHash), components: { ...components, configuration: configurationHash }, scienceHash };
}
