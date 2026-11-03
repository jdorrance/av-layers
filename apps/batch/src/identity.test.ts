import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { GFS_PRODUCT } from '@av/contracts';
import { sha256 } from './terrain/contract.js';
import { buildIdentity, readProducerSourceState } from './identity.js';

it('records producer configuration edits while allowing unrelated client edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-source-state-'));
  const git = async (...args: string[]) => await promisify(execFile)('git', args, { cwd: root });
  try {
    await git('init', '--quiet');
    await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{}}\n');
    await git('add', 'tsconfig.json');
    await git('-c', 'user.name=Source test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    const clean = await readProducerSourceState(root);
    expect(clean).toEqual({ revision: (await git('rev-parse', 'HEAD')).stdout.trim(), dirty: false });

    await mkdir(join(root, 'apps/preview'), { recursive: true });
    await writeFile(join(root, 'apps/preview/local.ts'), 'export const label = "local UI";\n');
    expect(await readProducerSourceState(root)).toEqual(clean);

    await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{"paths":{"@av/forecast":["./local-science.ts"]}}}\n');
    expect(await readProducerSourceState(root)).toEqual({ ...clean, dirty: true });
    await git('add', 'tsconfig.json');
    expect(await readProducerSourceState(root)).toEqual({ ...clean, dirty: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps unstaged configuration identity stable and pins requested terrain without changing science', async () => {
  const coverageHash = 'a'.repeat(64);
  const baseline = await buildIdentity(GFS_PRODUCT, coverageHash);
  expect(baseline.components.configuration).toBe(sha256(JSON.stringify({ product: GFS_PRODUCT, coverageHash })));
  const terrain = { key: `terrain/prepared/${'b'.repeat(64)}/manifest.json`, bytes: 100, sha256: 'c'.repeat(64), arrayBytes: 20 };
  const staged = await buildIdentity(GFS_PRODUCT, coverageHash, terrain);
  const different = await buildIdentity(GFS_PRODUCT, coverageHash, { ...terrain, sha256: 'd'.repeat(64) });
  expect(staged.recipe.hash).not.toBe(baseline.recipe.hash);
  expect(different.recipe.hash).not.toBe(staged.recipe.hash);
  expect(staged.scienceHash).toBe(baseline.scienceHash);
});
